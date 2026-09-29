import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateResult } from '../lib/orchestrator/evaluator.mjs';
import { classifyRun } from '../lib/orchestrator/failures.mjs';
import { classifyExecutionFailure } from '../lib/orchestrator/execution-manager.mjs';
import { normalizeLegacyReviewIssue, decideReviewFinding, focusedRepairSpec } from '../lib/orchestrator/review-policy.mjs';
import { newTask } from '../lib/orchestrator/task-store.mjs';
import { parseStructuredResult } from '../lib/orchestrator/runner.mjs';
import { orchestrate } from '../lib/orchestrator/orchestrator.mjs';
import { openStore } from '../lib/orchestrator/store.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { loadRouting } from '../lib/routing.mjs';
import { DEFAULT_POLICY } from '../lib/orchestrator/policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(root, 'routing/routing.json'));
const { agents } = loadAgents(join(root, 'agents'), routing);
const registry = { version: 1, backends: Object.fromEntries(['local', 'cheap', 'sol', 'astra', 'codex'].map(x => [x, { provider: 'fixture', model: x }])) };
const db = () => join(mkdtempSync(join(tmpdir(), 'ludi-outcome-')), 'state.db');
const t2 = (outcome = 'evidence_or_change') => newTask({ id: 't2', title: 'Rework after review t1', goal: 'Fix OR refute with evidence',
  kind: 'implement', artifact_type: 'code_change', expected_outcome: outcome, assignedAgent: 'coder', capability: 'strong-code',
  acceptance: ['fix finding OR explicitly refute it with evidence', 'run tests and report result'] });
const run = () => ({ ok: true, structured: true, worktree: { before: { source: 'git' }, agentChanges: [] }, result: {
  status: 'completed', summary: 'Previous POLICY_BLOCK did not recur; python/git/pytest succeeded; 39 tests passed.', filesChanged: [],
  commandsRun: ['python --version', 'git status --porcelain', 'python -m pytest tests/ -q'],
  verification: [{ command: 'python --version', result: 'pass' }, { command: 'git status --porcelain', result: 'pass' },
    { command: 'python -m pytest tests/ -q', result: 'pass' }],
  evidence: [{ type: 'command_result', source: 'verification', result: 'pass', related_acceptance: 'A1', command: 'git status --porcelain' },
    { type: 'test_result', source: 'verification', result: 'pass', related_acceptance: 'A2', command: 'python -m pytest tests/ -q' }],
  acceptance: [{ id: 'A1', met: true, evidence: 'git status --porcelain confirmed commands work; finding not reproduced' },
    { id: 'A2', met: true, evidence: 'python -m pytest tests/ -q: 39 passed' }], remainingIssues: [], artifacts: [] } });

test('run-mujsfddv-89fcd7 t2: valid refutation without diff, with persisted evidence references', () => {
  const ev = evaluateResult(t2(), run());
  assert.equal(ev.verdict, 'success');
  assert.deepEqual(ev.reasonCodes, ['VALID_EVIDENCE_REFUTATION']);
  assert.equal(ev.evidenceReferences.length, 2);
  assert.notEqual(classifyRun(run()), 'POLICY_BLOCK');
  assert.equal(parseStructuredResult('```json\n' + JSON.stringify(run().result) + '\n```').result.evidence.length, 2);
});

test('explicit required code change fails without actual diff even if tests pass; legacy fallback remains', () => {
  assert.deepEqual(evaluateResult(t2('code_change_required'), run()).reasonCodes, ['MISSING_REQUIRED_CODE_CHANGE']);
  const legacy = { ...t2(), expected_outcome: undefined };
  assert.equal(evaluateResult(legacy, run()).verdict, 'failure');
  assert.equal(classifyRun({ ...run(), evaluatorReasonCodes: ['MISSING_REQUIRED_CODE_CHANGE'] }), 'TEST_FAILURE');
  assert.equal(classifyExecutionFailure({ task: t2(), run: { ...run(), evaluatorReasonCodes: ['MISSING_REQUIRED_CODE_CHANGE'] }, terminationReason: 'completed' }).class, 'implementation_defect');
});

test('artifact overrides implement kind; evidence-only and artifact-required do not require source diff', () => {
  const investigation = { ...t2('evidence_only'), artifact_type: 'investigation' };
  assert.equal(evaluateResult(investigation, run()).verdict, 'success');
  const doc = { ...t2('artifact_required'), artifact_type: 'documentation' };
  assert.equal(evaluateResult(doc, { ...run(), result: { ...run().result, artifacts: ['docs/report.md'] } }).verdict, 'success');
  assert.equal(evaluateResult(doc, run()).reasonCodes.includes('INVALID_ARTIFACT'), true);
});

test('unlinked/self-claimed evidence and contradictory saved tools cannot pass', () => {
  const invalid = run(); invalid.result.evidence = [{ type: 'claim', source: 'agent', result: 'pass', related_acceptance: 'A1' }];
  assert.equal(evaluateResult(t2(), invalid).reasonCodes.includes('INSUFFICIENT_EVIDENCE'), true);
  const contradictory = { ...run(), toolResults: [{ command: 'python -m pytest tests/ -q', status: 'failed', exitCode: 1 }] };
  assert.equal(evaluateResult(t2(), contradictory).reasonCodes.includes('CONTRADICTORY_EVIDENCE'), true);
});

test('legacy blocking shell issue normalizes as environment limitation and cannot generate generic repair', () => {
  const issue = normalizeLegacyReviewIssue({ summary: 'shell commands were POLICY_BLOCKed and verification could not run', blocking: true },
    { id: 't1', acceptanceIds: ['AC1'] });
  assert.equal(issue.classification, 'environment_limitation');
  assert.deepEqual(issue.affected_files, []);
  assert.equal(issue.suggested_action, 'investigate');
  assert.ok(issue.evidence[0].source);
  assert.equal(decideReviewFinding(issue).action, 'blocked');
  const defect = { ...issue, id: 'DEFECT', classification: 'project_defect', affected_files: ['runner.py'],
    suggested_scope: { summary: 'Fix runner.py', affected_files: ['runner.py'], affected_acceptance_ids: ['AC1'], subsystems: ['runtime'] } };
  assert.equal(decideReviewFinding(defect).action, 'repair');
  assert.equal(newTask({ id: 'adaptive', title: 'investigate', goal: 'prove', kind: 'investigate', artifact_type: 'investigation', planningRef: 'plan-1' }).expected_outcome, 'evidence_only');
  assert.equal(focusedRepairSpec(defect, { id: 'review' }, 1).expected_outcome, 'code_change_required');
  assert.equal(focusedRepairSpec({ ...defect, suggested_scope: { ...defect.suggested_scope, allow_refutation: true } }, { id: 'review' }, 1).expected_outcome, 'evidence_or_change');
});

test('legacy remainingIssues in an actual run create an environment finding, never a code repair', async () => {
  const out = await orchestrate({ request: 'Investigate shell availability', agents, routing, registry, policy: DEFAULT_POLICY,
    plan: [{ id: 't1', title: 'Investigate', goal: 'Report tool availability', kind: 'investigate', agent: 'scout', acceptance: ['report status'] }],
    runner: { async run() { return { ok: true, structured: true, result: { status: 'completed', summary: 'commands refused',
      acceptance: [{ id: 'A1', met: true, evidence: 'tool refusal observed' }],
      remainingIssues: [{ blocking: true, summary: 'shell commands POLICY_BLOCKed; verification could not run' }] } }; } } });
  assert.equal(out.status, 'incomplete');
  assert.equal(out.reviewFindings[0].classification, 'environment_limitation');
  assert.equal(out.findingDecisions[0].action, 'blocked');
  assert.equal(out.tasks.filter(t => t.repairScope).length, 0);
});

test('historical POLICY_BLOCK prose is not current policy denial, structured current denial is', () => {
  assert.notEqual(classifyRun(run()), 'POLICY_BLOCK');
  assert.equal(classifyRun({ ...run(), toolResults: [{ status: 'POLICY_BLOCK' }] }), 'POLICY_BLOCK');
  assert.equal(classifyRun({ ...run(), failureClass: 'POLICY_BLOCK' }), 'POLICY_BLOCK');
  assert.notEqual(classifyRun({ ...run(), error: 'UND_ERR_SOCKET' }), 'POLICY_BLOCK');
});

test('evidence-based t2 completes and downstream t3 review executes; store/restart/replay retain contract and decision', async () => {
  const path = db(), session = openStore(path); let calls = [];
  const plan = [{ id: 't2', title: 'Refute or fix', goal: 'Fix OR refute with evidence', kind: 'implement', artifact_type: 'code_change',
    expected_outcome: 'evidence_or_change', agent: 'coder', acceptance: t2().acceptance },
  { id: 't3', title: 'Re-review', goal: 'Verify the refutation', kind: 'review', artifact_type: 'audit_report', expected_outcome: 'artifact_required',
    agent: 'reviewer', dependencies: ['t2'], acceptance: ['verify result'] }];
  let id;
  try {
    const out = await orchestrate({ request: 'Fix OR refute', plan, agents, routing, registry, policy: DEFAULT_POLICY, session,
      runner: { async run(task) { calls.push(task.id); if (task.id === 't2') return run();
        return { ok: true, structured: true, result: { status: 'completed', summary: 'verified', artifacts: ['audit/report.json'],
          acceptance: [{ id: 'A1', met: true, evidence: 'audit/report.json' }], remainingIssues: [], reviewFindings: [] } }; } } });
    id = out.runId;
    assert.deepEqual(calls, ['t2', 't3']);
    assert.equal(out.status, 'completed');
    assert.equal(session.loadTasks(id).find(x => x.id === 't2').expected_outcome, 'evidence_or_change');
    assert.equal(session.loadTasks(id).find(x => x.id === 't3').expected_outcome, 'artifact_required');
    assert.deepEqual(session.loadTasks(id).find(x => x.id === 't2').evaluatorReasonCodes, ['VALID_EVIDENCE_REFUTATION']);
    assert.equal(session.loadTasks(id).find(x => x.id === 't2').evidenceReferences.length, 2);
  } finally { session.close(); }
  const again = openStore(path);
  try {
    const task = again.loadTasks(id).find(x => x.id === 't2');
    assert.equal(evaluateResult(task, run()).verdict, 'success');
    const out = await orchestrate({ request: '', resumeRunId: id, agents, routing, registry, policy: DEFAULT_POLICY, session: again,
      runner: { async run() { throw Error('replay must not invoke workers'); } } });
    assert.equal(out.status, 'completed'); assert.equal(again.loadTasks(id).length, 2);
    assert.deepEqual(calls, ['t2', 't3']);
  } finally { again.close(); }
});
