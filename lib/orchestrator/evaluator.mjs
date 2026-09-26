// ResultEvaluator: a task succeeds only with a structured result whose status is "completed",
// a non-empty summary, every required output present, and every acceptance criterion met with evidence.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { dangerousCommands } from './shell-policy.mjs';

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
  const out = (verdict, reasons, extra = {}) => ({ verdict, reasons, decisions: [], newTasks: [], blockingIssues: [], ...extra });
  if (!run?.ok) {
    // A runner-level decision request (e.g. dirty-worktree safety gate) bypasses
    // the structured-result check — it never reached the model.
    if (run?.decision) return out('blocked', [run.error ?? 'decision required'], { decisions: [run.decision] });
    return out('failure', [`agent run failed: ${run?.error ?? 'unknown error'}`]);
  }
  if (!run.structured) return out('failure', ['no structured result block; a bare completion claim is not accepted']);
  const r = run.result;
  const newTasks = r.newTasks ?? [];
  if (r.status === 'blocked') {
    return r.decisions?.length ? out('blocked', ['agent needs a decision'], { decisions: r.decisions, newTasks }) : out('failure', ['agent reported blocked without a decision request']);
  }
  const reasons = [];
  if (r.status === 'failed') reasons.push(`agent reported failure: ${r.summary || 'no summary'}`);
  if (!r.summary?.trim()) reasons.push('summary is empty');
  if (repoRoot) for (const o of task.outputs ?? []) if (!existsSync(resolve(repoRoot, o))) reasons.push(`required output missing: ${o}`);
  const criteria = task.acceptance?.length ? task.acceptance : ['the goal is achieved and verified'];
  criteria.forEach((c, i) => {
    const id = `A${i + 1}`;
    const entry = (r.acceptance ?? []).find(a => a?.id === id);
    if (!entry) reasons.push(`acceptance ${id} not reported (${c})`);
    else if (entry.met !== true) reasons.push(`acceptance ${id} not met (${c})${entry.evidence ? `: ${entry.evidence}` : ''}`);
    else if (!String(entry.evidence ?? '').trim()) reasons.push(`acceptance ${id} claimed without evidence`);
  });
  const denied = dangerousCommands(r.commandsRun, { shell: 'true', network: false });
  if (denied.length) {
    return out('blocked', denied.map(d => `command refused: ${d.command} (${d.reason})`), {
      decisions: denied.map(d => ({ key: `shell:${d.command}`, question: `Run \`${d.command}\`?`, flags: d.flags ?? ['destructive_action'], options: [{ id: 'no', summary: 'do not run it', reversible: true }, { id: 'yes', summary: d.command, reversible: false, flags: d.flags ?? ['destructive_action'] }] })),
      newTasks,
    });
  }
  const changes = run.worktree?.agentChanges ?? [];
  if (task.kind === 'implement' && run.worktree?.before?.source && !changes.length && r.status === 'completed') reasons.push('no file changes detected against the workspace baseline');
  if (changes.some(c => String(c.path).includes('..'))) reasons.push('change escaped the workspace');
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
  if (reasons.length) return out('failure', reasons, { newTasks });
  return out('success', [], { newTasks, blockingIssues });
}
