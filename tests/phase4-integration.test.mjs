import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { DEFAULT_POLICY } from '../lib/orchestrator/policy.mjs';
import { openStore } from '../lib/orchestrator/store.mjs';
import { orchestrate } from '../lib/orchestrator/orchestrator.mjs';
import { parseProgressReport } from '../lib/orchestrator/progress-contract.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const registry = { version: 1, backends: { local: { provider: 'p', model: 'm' }, cheap: { provider: 'p', model: 'm' }, sol: { provider: 'p', model: 'm' }, astra: { provider: 'p', model: 'm', vision: true }, codex: { provider: 'p', model: 'm' } } };
const file = () => join(mkdtempSync(join(tmpdir(), 'ludi-phase4-')), 'state.db');
const criteria = [
  { id: 'AC1', description: 'comparison CLI', source: 'user_request' },
  { id: 'AC2', description: 'multi-seed tests', source: 'user_request' },
];
const planning = () => ({ goal_summary: 'Strategy evolution', current_state: 'baseline', acceptance_criteria: criteria.map(c => ({ ...c, status: 'pending' })),
  work_items: [{ id: 't2', title: 'Comparison/resume/experiment', description: 'Implement strategy evolution', depends_on: [], acceptance_ids: ['AC1', 'AC2'], estimated_complexity: 'medium', recommended_role: 'coder', artifact_type: 'code_change', likely_files: [] }],
  risks: [], environment_constraints: [], unknowns: [] });
const remaining = [
  { id: 'cli', description: 'Finish CLI integration', acceptance_ids: ['AC1'], estimated_complexity: 'small' },
  { id: 'seed', description: 'Finish multi-seed integration tests', acceptance_ids: ['AC2'], estimated_complexity: 'small' },
];
const report = (overrides = {}) => ({ task_id: 't2', status: 'failed', termination_reason: 'turn_limit', completed_acceptance: [], completed_steps: ['storage implemented'], remaining_work: remaining,
  blocked_work: [], files_touched: ['sqlite.py'], tests_run: [], artifacts: [{ type: 'code_change', location: 'sqlite.py', description: 'existing storage' }], environment_constraints: [], handoff_notes: [], ...overrides });
const opts = (session, run) => ({ request: 'Strategy evolution', planner: 'adaptive', acceptanceCriteria: criteria, agents, routing, registry, policy: DEFAULT_POLICY, session,
  runner: { async run(task, ctx) {
    if (task.kind === 'design-plan') return { ok: true, structured: true, result: { status: 'completed', planningReport: planning() } };
    return run(task, ctx);
  } } });
const success = task => ({ ok: true, structured: true,
  worktree: { before: { source: 'git' }, agentChanges: task.artifact_type === 'code_change' ? [{ path: `${task.id}.py` }] : [] },
  result: { status: 'completed', summary: 'verified', verification: [{ command: 'pytest integration', result: 'pass' }],
    evidence: task.acceptance.map((_, i) => ({ type: 'command_result', source: 'verification', result: 'pass', related_acceptance: `A${i + 1}`, command: 'pytest integration' })),
    acceptance: task.acceptance.map((_, i) => ({ id: `A${i + 1}`, met: true, evidence: 'pytest integration' })), remainingIssues: [], newTasks: [] } });

test('transient socket process error retries once, then completes; decisions persist and resume is idempotent', async () => {
  const path = file(); const session = openStore(path); let count = 0; let runId;
  try {
    const out = await orchestrate(opts(session, task => { count++; return count === 1
      ? { ok: false, error: 'UND_ERR_SOCKET: remote side closed', failureClass: 'TOOL_FAILURE' }
      : success(task); }));
    runId = out.runId;
    assert.equal(out.status, 'completed');
    assert.equal(count, 2);
    const task = session.loadTasks(runId)[0];
    assert.equal(task.retryCount, 1);
    assert.equal(task.lastFailureSignature, 'transient_error');
    const decisions = session.listExecutionDecisions(runId);
    assert.deepEqual(decisions.map(d => d.action), ['retry', 'complete']);
    assert.equal(decisions[0].policyRule, 'retry.transient-signature');
    assert.deepEqual(decisions[0].resultingTaskIds, ['t2']);
    assert.ok(decisions[0].decisionId && decisions[0].inputsSnapshot);
  } finally { session.close(); }
  const reopened = openStore(path);
  try {
    assert.equal(reopened.listExecutionDecisions(runId).length, 2);
    const existing = reopened.getExecutionDecision(runId, 't2:1');
    const duplicate = reopened.recordExecutionDecision(runId, 't2:1', { source_task_id: 't2', action: 'retry', reason: 'duplicate', policyRule: 'test', inputsSnapshot: {} }, ['t2']);
    assert.equal(duplicate.decisionId, existing.decisionId);
    const resumed = await orchestrate({ ...opts(reopened, () => { throw new Error('should not run'); }), resumeRunId: runId, planner: 'rules' });
    assert.equal(resumed.status, 'completed');
    assert.equal(reopened.listExecutionDecisions(runId).length, 2);
    assert.equal(reopened.loadTasks(runId).length, 1);
  } finally { reopened.close(); }
});

test('repeated identical socket failure stops blind retry before the retry limit', async () => {
  const session = openStore(file()); let count = 0;
  try {
    const out = await orchestrate(opts(session, () => { count++; return { ok: false, error: 'UND_ERR_SOCKET remote side closed', failureClass: 'TOOL_FAILURE' }; }));
    assert.equal(count, 2);
    assert.equal(out.status, 'incomplete');
    assert.deepEqual(session.listExecutionDecisions(out.runId).map(d => d.action), ['retry', 'stop']);
    assert.equal(session.loadTasks(out.runId)[0].retryCount, 1);
  } finally { session.close(); }
});

test('task-too-large split creates focused tasks, rewires lineage and preserves acceptance after restart', async () => {
  const path = file(); const session = openStore(path); const executed = []; let runId;
  try {
    const out = await orchestrate(opts(session, task => {
      executed.push(task.id);
      return task.id === 't2' ? { ok: false, failureClass: 'PROGRESS_TIMEOUT', child: { stopReason: 'absolute-turn-limit' },
        result: { status: 'failed', summary: 'scope too large', progressReport: report() } }
        : success(task);
    }));
    runId = out.runId;
    assert.equal(out.status, 'completed');
    assert.deepEqual(executed, ['t2', 't2.s1-1', 't2.s1-2']);
    const rows = session.loadTasks(runId);
    assert.deepEqual(rows[0].splitInto, ['t2.s1-1', 't2.s1-2']);
    assert.equal(rows[0].status, 'partial');
    assert.equal(rows[1].sourceTaskId, 't2');
    assert.equal(rows[1].rootTaskId, 't2');
    assert.equal(rows[1].splitDepth, 1);
    assert.deepEqual(rows.slice(1).flatMap(t => t.acceptanceIds).sort(), ['AC1', 'AC2']);
    assert.equal(rows[1].goal, 'Finish CLI integration');
    assert.equal(rows[2].goal, 'Finish multi-seed integration tests');
    const decision = session.listExecutionDecisions(runId).find(d => d.action === 'split');
    assert.deepEqual(decision.resultingTaskIds, ['t2.s1-1', 't2.s1-2']);
  } finally { session.close(); }
  const reopened = openStore(path);
  try {
    assert.equal(reopened.listExecutionDecisions(runId).filter(d => d.action === 'split').length, 1);
    assert.equal(reopened.loadTasks(runId).length, 3);
  } finally { reopened.close(); }
});

test('role mismatch reassigns without changing capability/model route, saves history', async () => {
  const session = openStore(file()); let count = 0;
  try {
    const out = await orchestrate(opts(session, task => {
      count++;
      if (count === 1) return { ok: false, error: 'test diagnosis needed', result: { status: 'failed', summary: 'cannot run tests here; should be a tester',
        progressReport: report({ remaining_work: [], handoff_notes: ['cannot run tests here; should be a tester'] }) } };
      assert.equal(task.assignedAgent, 'tester');
      assert.equal(task.capability, 'strong-code', 'no model route escalation');
      assert.equal(task.kind, 'verify');
      return success(task);
    }));
    assert.equal(count, 2);
    assert.equal(out.status, 'completed');
    assert.deepEqual(session.listExecutionDecisions(out.runId).map(d => d.action), ['reassign', 'complete']);
    const row = session.loadTasks(out.runId)[0];
    assert.equal(row.reassignmentCount, 1);
    assert.equal(row.assignmentHistory[0].to, 'tester');
  } finally { session.close(); }
});

test('shell allowlist and user stop safely stop without repair, retry or workspace reset', async () => {
  for (const kind of ['shell', 'user']) {
    const session = openStore(file()); let calls = 0;
    try {
      const out = await orchestrate(opts(session, () => { calls++; return { ok: false, error: kind === 'shell' ? 'shell allowlist restricted' : 'user stopped',
        child: { stopReason: kind === 'user' ? 'user-stop' : 'environment-block' }, result: { status: 'failed',
          progressReport: report({ status: 'blocked', remaining_work: [], blocked_work: kind === 'shell' ? [{ description: 'shell allowlist', reason: 'sandbox', classification: 'environment_limitation' }] : [] }) } }; }));
      assert.equal(calls, 1);
      assert.deepEqual(session.listExecutionDecisions(out.runId).map(d => d.action), ['stop']);
      assert.equal(session.loadTasks(out.runId).length, 1);
      assert.equal(session.listExecutionDecisions(out.runId)[0].policyRule, kind === 'shell' ? 'guard.environment_limitation' : 'guard.user_stop');
    } finally { session.close(); }
  }
});
