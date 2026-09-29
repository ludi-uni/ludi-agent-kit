import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { DEFAULT_POLICY, mergePolicy } from '../lib/orchestrator/policy.mjs';
import { openStore } from '../lib/orchestrator/store.mjs';
import { orchestrate } from '../lib/orchestrator/orchestrator.mjs';
import { createAgentRunner } from '../lib/orchestrator/runner.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = structuredClone(loadRouting(join(kit, 'routing/routing.json')));
for (const [id, cls, cost] of [['a', 'standard', 'free'], ['b', 'strong', 'free'], ['c', 'expert', 'paid']])
  routing.backends[id] = { tier: cost === 'paid' ? 'high' : 'free', capability_class: cls, cost_class: cost,
    availability_class: 'available', roles: ['coder', 'design-planner'], vision: false };
routing.capabilities['strong-code'] = { primary: 'a', fallback: ['b', 'c'] };
routing.capabilities['cheap-code'] = { primary: 'a', fallback: [] };
const registry = { version: 1, backends: Object.fromEntries(['a', 'b', 'c'].map(id => [id, { provider: 'fixture', model: id }])) };
const { agents } = loadAgents(join(kit, 'agents'), routing);
const path = () => join(mkdtempSync(join(tmpdir(), 'ludi-esc-')), 'run.db');
const criterion = { id: 'AC1', description: 'implementation verified', source: 'user_request' };
const plan = () => ({ goal_summary: 'Implement fixture', current_state: 'baseline', acceptance_criteria: [{ ...criterion, status: 'pending' }],
  work_items: [{ id: 't2', title: 'Implement fixture', description: 'Implement fixture', depends_on: [], acceptance_ids: ['AC1'],
    estimated_complexity: 'medium', recommended_role: 'coder', artifact_type: 'code_change', likely_files: [] }], risks: [], environment_constraints: [], unknowns: [] });
const failure = task => ({ ok: true, structured: true, modelId: task.executionRoute.modelId, backend: task.executionRoute.backend, error: 'same implementation failure',
  result: { status: 'failed', summary: 'same implementation failure', progressReport: { task_id: 't2', status: 'failed', termination_reason: 'unknown',
    completed_acceptance: [], completed_steps: [], remaining_work: [], blocked_work: [], files_touched: [], tests_run: [], artifacts: [], environment_constraints: [], handoff_notes: [] } } });
const success = task => ({ ok: true, structured: true, modelId: task.executionRoute.modelId, backend: task.executionRoute.backend,
  worktree: { before: { source: 'git' }, agentChanges: [{ path: 'fixture.js' }] },
  result: { status: 'completed', summary: 'test passed', acceptance: [{ id: 'A1', met: true, evidence: 'test passed' }], remainingIssues: [] } });
const opts = (session, run, extra = {}) => ({ request: 'Implement fixture', planner: 'adaptive', acceptanceCriteria: [criterion], agents, routing, registry,
  policy: DEFAULT_POLICY, session, runner: { async run(task) { return task.kind === 'design-plan' ? { ok: true, structured: true,
    result: { status: 'completed', planningReport: plan() } } : run(task); } }, ...extra });

test('A failure -> safe retry on A -> same failure -> B free escalation -> success; provenance/history survive restart', async () => {
  const db = path(); const session = openStore(db); const visited = []; let runId;
  try {
    const out = await orchestrate(opts(session, task => { visited.push(task.executionRoute.modelId); return visited.length < 3 ? failure(task) : success(task); }));
    runId = out.runId;
    assert.equal(out.status, 'completed');
    assert.deepEqual(visited, ['fixture/a', 'fixture/a', 'fixture/b']);
    assert.deepEqual(session.listExecutionDecisions(runId).map(d => d.action), ['retry', 'escalate', 'complete']);
    const row = session.loadTasks(runId)[0];
    assert.equal(row.assignedAgent, 'coder');
    assert.deepEqual(row.routeHistory.map(r => r.modelId), ['fixture/a', 'fixture/b']);
    assert.equal(row.escalationCount, 1);
    assert.equal(row.lastEscalationReason.includes('repeated'), true);
    const decision = session.listExecutionDecisions(runId)[1];
    assert.equal(decision.sourceTaskId, 't2');
    assert.equal(decision.currentCapability, 'standard');
    assert.equal(decision.proposedCapability, 'strong');
    assert.equal(decision.proposedRoute.modelId, 'fixture/b');
    assert.deepEqual(decision.costClassChange, { from: 'free', to: 'free' });
    assert.equal(decision.failureHistory.length, 2);
    assert.equal(session.getRun(runId).counters.runBudget.escalations, 1);
  } finally { session.close(); }
  const reopened = openStore(db);
  try {
    assert.deepEqual(reopened.loadTasks(runId)[0].routeHistory.map(r => r.modelId), ['fixture/a', 'fixture/b']);
    const duplicate = reopened.recordExecutionDecision(runId, 't2:2', { source_task_id: 't2', action: 'escalate', reason: 'duplicate', policyRule: 'test', inputsSnapshot: {} }, ['t2']);
    assert.equal(duplicate.decisionId, reopened.getExecutionDecision(runId, 't2:2').decisionId);
    const out = await orchestrate(opts(reopened, () => { throw Error('replay must not run another route'); }, { resumeRunId: runId }));
    assert.equal(out.status, 'completed');
    assert.equal(reopened.getRun(runId).counters.runBudget.escalations, 1);
  } finally { reopened.close(); }
});

test('A -> B -> C paid only: approval_required with no paid invocation and a persisted waiting request', async () => {
  const db = path(); const session = openStore(db); const visited = []; let runId;
  try {
    const out = await orchestrate(opts(session, task => { visited.push(task.executionRoute.modelId); return failure(task); }));
    runId = out.runId;
    assert.equal(out.status, 'needs-user');
    assert.equal(out.runStatus, 'waiting_for_user');
    assert.deepEqual(visited, ['fixture/a', 'fixture/a', 'fixture/b']);
    const decisions = session.listExecutionDecisions(runId);
    assert.deepEqual(decisions.map(d => d.action), ['retry', 'escalate', 'approval_required']);
    const t = session.loadTasks(runId)[0];
    assert.equal(t.status, 'waiting_for_user');
    assert.equal(t.executionRoute.modelId, 'fixture/b');
    assert.equal(t.escalationRequest.proposed_route.modelId, 'fixture/c');
    assert.deepEqual(t.escalationRequest.cost_class_change, { from: 'free', to: 'paid' });
  } finally { session.close(); }
  const reopened = openStore(db);
  try {
    assert.equal(reopened.loadTasks(runId)[0].status, 'waiting_for_user');
    const out = await orchestrate(opts(reopened, () => { throw Error('paid route must not run'); }, { resumeRunId: runId }));
    assert.equal(out.status, 'needs-user');
    assert.equal(reopened.listExecutionDecisions(runId).filter(d => d.action === 'approval_required').length, 1);
  } finally { reopened.close(); }
});

test('run cap, route locks and paid prohibition prevent automatic model changes', async () => {
  for (const variant of ['run-cap', 'root-cap', 'task-cap', 'lock', 'no-paid']) {
    const session = openStore(path()); const visited = [];
    try {
      const extra = variant === 'run-cap' ? { policy: mergePolicy(DEFAULT_POLICY, { limits: { max_escalations_per_run: 0 } }) }
        : variant === 'root-cap' ? { policy: mergePolicy(DEFAULT_POLICY, { limits: { max_escalations_per_root_task: 0 } }) }
        : variant === 'task-cap' ? { policy: mergePolicy(DEFAULT_POLICY, { limits: { max_escalations_per_task: 0 } }) }
        : variant === 'lock' ? { routeLocks: { t2: { backend: 'a' } } }
          : { routing: { ...routing, capabilities: { ...routing.capabilities, 'strong-code': { primary: 'a', fallback: ['c'] } } }, routeLocks: { t2: { prohibitPaid: true } } };
      const out = await orchestrate(opts(session, task => { visited.push(task.executionRoute.modelId); return failure(task); }, extra));
      assert.equal(out.status, 'incomplete');
      assert.deepEqual(visited, ['fixture/a', 'fixture/a']);
      const d = session.listExecutionDecisions(out.runId).at(-1);
      assert.equal(d.action, 'stop');
      if (variant.endsWith('-cap')) assert.match(d.reason, /ESCALATION_LIMIT_EXCEEDED/);
      assert.equal(session.loadTasks(out.runId)[0].escalationCount, 0);
    } finally { session.close(); }
  }
});

test('explicit request locking an unbound provider slot fails closed before task invocation', async () => {
  const session = openStore(path()); let called = 0;
  try {
    const out = await orchestrate(opts(session, () => { called++; return failure({ executionRoute: { modelId: 'fixture/a' } }); },
      { request: 'Implement fixture using only Qoder' }));
    assert.equal(called, 0);
    assert.equal(out.status, 'incomplete');
    assert.match(session.loadTasks(out.runId)[0].blockedReason, /route lock/);
  } finally { session.close(); }
});

test('live quota exhaustion skips the stronger free route and requires approval for the paid route', async () => {
  const session = openStore(path()); const visited = [];
  try {
    const out = await orchestrate(opts(session, task => { visited.push(task.executionRoute.modelId); return failure(task); },
      { health: { skip: c => c.backend === 'b' ? 'quota exhausted' : null } }));
    assert.equal(out.status, 'needs-user');
    assert.deepEqual(visited, ['fixture/a', 'fixture/a']);
    assert.equal(session.loadTasks(out.runId)[0].escalationRequest.proposed_route.modelId, 'fixture/c');
  } finally { session.close(); }
});

test('real runner pins one exact provider/model route (no implicit paid fallback on invalid output)', async () => {
  const calls = [];
  const runner = createAgentRunner({ agents, routing, registry, policy: DEFAULT_POLICY, invoke: async () => { throw Error('oneshot'); },
    runSubagent: async c => { calls.push(c.modelId); return { ok: false, error: 'invalid response', failureClass: 'MALFORMED_RESULT', text: '', child: { turns: 1, toolCalls: 1 } }; } });
  const task = { id: 't2', title: 'Implement fixture', goal: 'Implement fixture', kind: 'implement', assignedAgent: 'coder',
    capability: 'strong-code', acceptance: ['done'], dependencies: [], outputs: [], planningRef: 'p1',
    executionRoute: { backend: 'a', modelId: 'fixture/a' } };
  const result = await runner.run(task, { dependencyResults: [] });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['fixture/a']);
});
