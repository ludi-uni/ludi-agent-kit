// ResultEvaluator: a task succeeds only with a structured result whose status is "completed",
// a non-empty summary, every required output present, and every acceptance criterion met with evidence.
import { existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { dangerousCommands } from './shell-policy.mjs';
import { artifactTypeFor } from './task-store.mjs';

const passed = v => ['pass', 'passed', 'verified', 'not_reproduced'].includes(String(v ?? '').toLowerCase());
const failed = v => ['fail', 'failed', 'error', 'POLICY_BLOCK'].includes(String(v ?? ''));
const actualChanges = run => run.worktree?.agentChanges ?? [];

function evidenceFor(r, run, id) {
  const entry = (r.acceptance ?? []).find(a => a?.id === id);
  const checks = [...(r.verification ?? []), ...(r.progressReport?.tests_run ?? [])];
  const evidence = (r.evidence ?? []).filter(e => e?.related_acceptance === id && typeof e.type === 'string'
    && ['verification', 'tool_result', 'progressReport.tests_run'].includes(e.source) && passed(e.result ?? e.status));
  const progress = r.progressReport?.completed_acceptance?.find(c => c.acceptance_id === run.taskAcceptanceId);
  const progressPass = progress?.evidence?.some(e => e.type === 'test_result' && e.result === 'pass'
    && (r.progressReport?.tests_run ?? []).some(v => v.command === e.command && passed(v.result)));
  const linked = evidence.some(e => e.command
    ? checks.some(v => v.command === e.command && passed(v.result))
    : e.location && (r.artifacts ?? []).includes(e.location));
  // Existing persisted results used verification + acceptance prose before the
  // typed evidence field existed. A named passing command still supplies a
  // provenance-bearing candidate, not an unsupported "I checked it" claim.
  const legacy = !r.evidence?.length && checks.some(v => v.command && passed(v.result)
    && String(entry?.evidence ?? '').includes(v.command));
  return { valid: linked || legacy || progressPass, refs: linked ? evidence : legacy ? checks.filter(v => v.command && passed(v.result)
    && String(entry?.evidence ?? '').includes(v.command)).map(v => ({ type: 'command_result', source: 'verification',
      result: 'pass', related_acceptance: id, command: v.command })) : progressPass
      ? progress.evidence.filter(e => e.type === 'test_result' && e.result === 'pass').map(e => ({
        type: 'test_result', source: 'progressReport.tests_run', result: 'pass', related_acceptance: id, command: e.command })) : [] };
}

const isBlocking = i => i?.blocking === true || ['high', 'critical', 'blocking'].includes(String(i?.severity ?? '').toLowerCase());

// Issues that mean "the work itself cannot proceed safely" — these still fail
// or gate even on investigation. Advisory findings (open questions, multiple
// valid directions, repo observations) are the deliverable of an investigation,
// not a failure.
const SAFETY_RE = /destructive|overwrite|uncommitted|conflict|mutually exclusive|不可逆|破壊|上書き|衝突|排他|未コミット.*(上書き|破壊|衝突)|overwrite.*uncommitted/i;
const DECISION_RE = /choose|select|which|pick|decide|ambiguous|unclear|不明|未定|未指定|選択|判断|どちら|いずれ|候補|option/i;

/** Classify a blocking issue: 'safety' gates the run, 'decision' needs user input, 'advisory' is a note. */
export function classifyBlockingIssue(issue) {
  const text = `${issue?.summary ?? ''} ${issue?.detail ?? ''}`;
  if (SAFETY_RE.test(text)) return 'safety';
  if (DECISION_RE.test(text)) return 'decision';
  return 'advisory';
}

/** @returns {{ verdict: 'success'|'failure'|'blocked', reasons: string[], decisions: object[], newTasks: object[], blockingIssues: object[] }} */
export function evaluateResult(task, run, { repoRoot = null } = {}) {
  const out = (verdict, reasons, extra = {}) => ({ verdict, reasons, reasonCodes: [], evidenceReferences: [], decisions: [], newTasks: [], blockingIssues: [], ...extra });
  if (!run?.ok) {
    // A runner-level decision request (e.g. dirty-worktree safety gate) bypasses
    // the structured-result check — it never reached the model.
    if (run?.decision) return out('blocked', [run.error ?? 'decision required'], { decisions: [run.decision] });
    return out('failure', [`agent run failed: ${run?.error ?? 'unknown error'}`]);
  }
  if (!run.structured) return out('failure', ['no structured result block; a bare completion claim is not accepted']);
  const r = run.result;
  if (['review', 'verify', 'reverify'].includes(task.kind) && r.reviewFindings != null && !Array.isArray(r.reviewFindings))
    return out('failure', ['reviewFindings must be an array']);
  const newTasks = r.newTasks ?? [];
  if (r.status === 'blocked') {
    return r.decisions?.length ? out('blocked', ['agent needs a decision'], { decisions: r.decisions, newTasks }) : out('failure', ['agent reported blocked without a decision request']);
  }
  const reasons = [], reasonCodes = [], evidenceReferences = [];
  const reason = (code, detail) => { reasonCodes.push(code); reasons.push(detail); };
  const artifact = task.artifact_type ?? artifactTypeFor(task);
  const outcome = task.expected_outcome ?? (artifact === 'code_change' && task.kind === 'implement' ? 'legacy_implement' : null);
  const contradictory = [...(run.toolResults ?? []), ...(r.verification ?? []), ...(r.progressReport?.tests_run ?? [])]
    .some(v => failed(v.result ?? v.status) || v.exitCode > 0);
  if (contradictory && r.status === 'completed') reason('CONTRADICTORY_EVIDENCE', 'current verification/tool result contradicts completion');
  if (r.status === 'failed') reasons.push(`agent reported failure: ${r.summary || 'no summary'}`);
  if (!r.summary?.trim()) reasons.push('summary is empty');
  if (repoRoot) for (const o of task.outputs ?? []) if (!existsSync(resolve(repoRoot, o))) reasons.push(`required output missing: ${o}`);
  const criteria = task.acceptance?.length ? task.acceptance : ['the goal is achieved and verified'];
  criteria.forEach((c, i) => {
    const id = `A${i + 1}`;
    const entry = (r.acceptance ?? []).find(a => a?.id === id);
    if (!entry) reason('ACCEPTANCE_NOT_MET', `acceptance ${id} not reported (${c})`);
    else if (entry.met !== true) reason('ACCEPTANCE_NOT_MET', `acceptance ${id} not met (${c})${entry.evidence ? `: ${entry.evidence}` : ''}`);
    else if (!String(entry.evidence ?? '').trim()) reason('INSUFFICIENT_EVIDENCE', `acceptance ${id} claimed without evidence`);
    if (entry?.met === true && ['evidence_or_change', 'evidence_only'].includes(outcome)) {
      const proof = evidenceFor(r, { ...run, taskAcceptanceId: task.acceptanceIds?.[i] }, id);
      evidenceReferences.push(...proof.refs);
      if (!proof.valid && !(outcome === 'evidence_or_change' && actualChanges(run).length))
        reason('INSUFFICIENT_EVIDENCE', `acceptance ${id} lacks linked structured verification evidence`);
    }
  });
  const denied = dangerousCommands(r.commandsRun, { shell: 'true', network: false });
  if (denied.length) {
    return out('blocked', denied.map(d => `command refused: ${d.command} (${d.reason})`), {
      decisions: denied.map(d => ({ key: `shell:${d.command}`, question: `Run \`${d.command}\`?`, flags: d.flags ?? ['destructive_action'], options: [{ id: 'no', summary: 'do not run it', reversible: true }, { id: 'yes', summary: d.command, reversible: false, flags: d.flags ?? ['destructive_action'] }] })),
      newTasks,
    });
  }
  const changes = run.worktree?.agentChanges ?? [];
  // An explicit outcome overrides kind. Only a code-change contract requires
  // fresh source changes; legacy implement keeps its former snapshot behavior.
  if (artifact === 'code_change' && outcome === 'code_change_required' && !changes.length && r.status === 'completed')
    reason('MISSING_REQUIRED_CODE_CHANGE', 'no file changes detected against the workspace baseline');
  else if (outcome === 'legacy_implement' && run.worktree?.before?.source && !changes.length && r.status === 'completed'
    && !(task.parentTaskId && task.inheritedArtifacts?.length))
    reason('MISSING_REQUIRED_CODE_CHANGE', 'no file changes detected against the workspace baseline');
  if (outcome === 'artifact_required' && !r.planningReport
    && ![...(r.artifacts ?? []), ...(r.progressReport?.artifacts ?? []).map(a => a.location), ...(task.outputs ?? [])]
      .some(p => typeof p === 'string' && p.trim() && (!repoRoot ||
        (!relative(repoRoot, resolve(repoRoot, p)).startsWith('..') && !isAbsolute(relative(repoRoot, resolve(repoRoot, p)))
          && existsSync(resolve(repoRoot, p))))))
    reason('INVALID_ARTIFACT', 'required document/report artifact missing');
  if (changes.some(c => String(c.path).includes('..'))) reason('INVALID_ARTIFACT', 'change escaped the workspace');
  const blockingIssues = (r.remainingIssues ?? []).filter(isBlocking);
  // A review's job is to report blocking issues; for other tasks they mean the work is not done —
  // EXCEPT investigations, where reporting open questions / multiple valid directions IS the work.
  if (blockingIssues.length && task.kind !== 'review') {
    if (task.kind === 'investigate') {
      // Safety issues still gate; decision-shaped issues become a user decision;
      // advisory issues are the deliverable and do not fail the task.
      const safety = blockingIssues.filter(i => classifyBlockingIssue(i) === 'safety');
      const decisionIssues = blockingIssues.filter(i => classifyBlockingIssue(i) === 'decision');
      if (safety.length) {
        reasons.push(...safety.map(i => `blocking issue: ${i.summary}`));
      } else if (decisionIssues.length && r.status === 'completed') {
        // Investigation surfaced a genuine either/or choice -> needs_decision, not failure.
        return out('blocked', decisionIssues.map(i => `blocking issue: ${i.summary}`), {
          decisions: decisionIssues.map(i => ({
            key: `investigate:${i.summary}`,
            question: i.summary,
            flags: i.flags ?? [],
            options: i.options ?? [{ id: 'proceed', summary: 'proceed with the recommended interpretation', reversible: true }, { id: 'clarify', summary: 'ask the user to clarify', reversible: true }],
            recommended: i.recommended,
          })),
          newTasks,
        });
      }
      // advisory blockingIssues fall through to success
    } else {
      reasons.push(...blockingIssues.map(i => `blocking issue: ${i.summary}`));
    }
  }
  if (reasons.length) return out('failure', reasons, { newTasks, reasonCodes, evidenceReferences });
  return out('success', [], { newTasks, blockingIssues, reasonCodes: outcome === 'evidence_or_change' && !changes.length ? ['VALID_EVIDENCE_REFUTATION'] : [], evidenceReferences });
}
