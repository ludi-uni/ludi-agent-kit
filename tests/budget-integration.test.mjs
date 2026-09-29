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
import { createTaskBudget } from '../lib/orchestrator/budget-policy.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const registry = { version: 1, backends: { local: { provider: 'p', model: 'm' }, cheap: { provider: 'p', model: 'm' }, sol: { provider: 'p', model: 'm' }, astra: { provider: 'p', model: 'm', vision: true }, codex: { provider: 'p', model: 'm' } } };
const policy = mergePolicy(DEFAULT_POLICY, { agent_runtime: { max_turns: 32, max_tool_calls: 40, absolute_max_turns: 64, absolute_max_tool_calls: 80,
  max_extensions: 2, turn_budgets: { coder: { simple: 32, normal: 32, heavy: 32, 'repo-history-heavy': 32 } } } });
const file = () => join(mkdtempSync(join(tmpdir(), 'ludi-budget-')), 'state.db');
const criterion = { id: 'AC1', description: 'integration test passes', source: 'user_request' };
const plan = () => ({ goal_summary: 'Finish comparison', current_state: 'partial', acceptance_criteria: [{ ...criterion, status: 'pending' }],
  work_items: [{ id: 't2', title: 'Comparison', description: 'Implement comparison', depends_on: [], acceptance_ids: ['AC1'], estimated_complexity: 'medium', recommended_role: 'coder', artifact_type: 'code_change', likely_files: [] }], risks: [], environment_constraints: [], unknowns: [] });
const rem = [{ id: 'final-test', description: 'Run final integration test', acceptance_ids: ['AC1'], estimated_complexity: 'small' }];
const progress = (id, rest = {}) => ({ task_id: id, status: 'partial', termination_reason: 'turn_limit', completed_acceptance: [], completed_steps: ['comparison runner implemented'],
  remaining_work: rem, blocked_work: [], files_touched: ['compare.py'], tests_run: [], artifacts: [{ type: 'code_change', location: 'compare.py', description: 'existing runner' }],
  environment_constraints: [], handoff_notes: [], ...rest });
const options = (session, runner, extra = {}) => ({ request: 'Finish comparison', planner: 'adaptive', acceptanceCriteria: [criterion], agents, routing, registry, policy, session,
  runner: { async run(task, ctx) {
    if (task.kind === 'design-plan') return { ok: true, structured: true, result: { status: 'completed', planningReport: plan() } };
    return runner(task, ctx);
  } }, ...extra });
const finish = task => ({ ok: true, structured: true, child: { turns: 16, toolCalls: 4, stopReason: 'completed' },
  result: { status: 'completed', summary: 'test passed', acceptance: [{ id: 'A1', met: true, evidence: 'pytest integration' }],
    verification: [{ command: 'pytest integration', result: 'pass' }],
    evidence: [{ type: 'test_result', source: 'verification', result: 'pass', related_acceptance: 'A1', command: 'pytest integration' }],
    progressReport: progress(task.id, { status: 'completed', termination_reason: 'completed', remaining_work: [], completed_acceptance: [{ acceptance_id: 'AC1', evidence: [{ type: 'test_result', command: 'pytest integration', result: 'pass' }] }], tests_run: [{ command: 'pytest integration', result: 'pass' }] }), remainingIssues: [], newTasks: [] } });

test('32 turns + recent progress -> persisted +16 extension residual -> completion; restart is idempotent', async () => {
  const path = file(); const session = openStore(path); let count = 0; let runId;
  try {
    const out = await orchestrate(options(session, task => {
      count++;
      if (task.id === 't2') {
        assert.equal(task.budget.turns.current_limit, 32);
        assert.equal(task.budget.turns.used, 0);
        return { ok: false, failureClass: 'PROGRESS_TIMEOUT', child: { stopReason: 'absolute-turn-limit', turns: 32, toolCalls: 5, lastProgressTurn: 30, lastProgressToolCall: 5 },
          result: { status: 'partial', summary: 'almost done', progressReport: progress('t2') } };
      }
      assert.equal(task.id, 't2.c1');
      assert.equal(task.budget.turns.current_limit, 48);
      assert.equal(task.budget.turns.used, 32);
      assert.equal(task.budget.extensions.count, 1);
      assert.equal(task.goal.includes('Run final integration test'), true);
      return finish(task);
    }));
    runId = out.runId;
    assert.equal(out.status, 'completed');
    assert.equal(count, 2);
    const rows = session.loadTasks(runId);
    assert.equal(rows[0].budget.turns.initial, 32);
    assert.equal(rows[0].budget.turns.used, 32);
    assert.equal(rows[1].budget.turns.used, 48);
    assert.equal(rows[1].extensionOf, 't2');
    assert.equal(rows[1].budget.continuation_depth, 1);
    assert.equal(session.listExecutionDecisions(runId)[0].action, 'extend');
    const decision = session.listExecutionDecisions(runId)[0];
    assert.equal(decision.previousBudget.turns.current_limit, 32);
    assert.equal(decision.newBudget.turns.current_limit, 48);
    assert.equal(decision.progressSnapshot.lastProgressTurn, 30);
    assert.deepEqual(decision.remainingWorkSnapshot.ids, ['final-test']);
    assert.equal(session.getRun(runId).counters.runBudget.task_extensions, 1);
  } finally { session.close(); }
  const reopened = openStore(path);
  try {
    assert.equal(reopened.loadTasks(runId)[1].budget.turns.current_limit, 48);
    assert.equal(reopened.getRun(runId).counters.runBudget.task_extensions, 1);
    const resumed = await orchestrate(options(reopened, () => { throw new Error('must not grant another +16'); }, { resumeRunId: runId, planner: 'rules' }));
    assert.equal(resumed.status, 'completed');
    assert.equal(reopened.listExecutionDecisions(runId).filter(d => d.action === 'extend').length, 1);
  } finally { reopened.close(); }
});

test('tool-call limit with healthy recent progress extends tool budget incrementally', async () => {
  const session = openStore(file());
  try {
    const out = await orchestrate(options(session, task => task.id === 't2' ? {
      ok: false, failureClass: 'PROGRESS_TIMEOUT', child: { stopReason: 'tool-call-limit', turns: 5, toolCalls: 40, lastProgressToolCall: 38 },
      result: { status: 'partial', summary: 'almost done', progressReport: progress('t2', { termination_reason: 'tool_limit' }) },
    } : finish(task)));
    assert.equal(out.status, 'completed');
    const child = session.loadTasks(out.runId)[1];
    assert.equal(child.budget.tool_calls.current_limit, 52);
    assert.equal(child.budget.tool_calls.used, 44);
    assert.equal(session.listExecutionDecisions(out.runId)[0].newBudget.tool_calls.used, 40);
    assert.equal(session.listExecutionDecisions(out.runId)[0].action, 'extend');
  } finally { session.close(); }
});

test('stalled 32-turn task stops without extension or continuation', async () => {
  const session = openStore(file()); let calls = 0;
  try {
    const out = await orchestrate(options(session, () => {
      calls++;
      return { ok: false, failureClass: 'NO_PROGRESS_TIMEOUT', child: { stopReason: 'no-progress-turn-limit', turns: 32, toolCalls: 0 },
        result: { status: 'partial', summary: 'stalled', progressReport: progress('t2', { completed_steps: [], completed_acceptance: [], files_touched: [], tests_run: [], artifacts: [] }) } };
    }));
    assert.equal(calls, 1);
    assert.equal(out.status, 'incomplete');
    assert.equal(session.loadTasks(out.runId).length, 1);
    assert.equal(session.listExecutionDecisions(out.runId)[0].action, 'stop');
    assert.equal(session.getRun(out.runId).counters.runBudget.task_extensions, 0);
  } finally { session.close(); }
});

test('run extension cap zero stops with RUN_BUDGET_EXCEEDED without generating a task', async () => {
  const session = openStore(file());
  try {
    const out = await orchestrate(options(session, () => ({ ok: false, failureClass: 'PROGRESS_TIMEOUT', child: { stopReason: 'absolute-turn-limit', turns: 32, toolCalls: 5, lastProgressTurn: 30 },
      result: { status: 'partial', progressReport: progress('t2') } }), { runBudgetCaps: { maxExtensionsPerRun: 0 } }));
    assert.equal(out.status, 'incomplete');
    assert.equal(session.loadTasks(out.runId).length, 1);
    assert.equal(session.listExecutionDecisions(out.runId)[0].action, 'stop');
    assert.match(session.listExecutionDecisions(out.runId)[0].reason, /RUN_BUDGET_EXCEEDED/);
    assert.ok(out.limitsHit.includes('RUN_BUDGET_EXCEEDED'));
    assert.equal(session.getRun(out.runId).counters.runBudgetCaps.maxExtensionsPerRun, 0);
  } finally { session.close(); }
});

test('stale historical progress and repeated tool failure do not buy more budget', async () => {
  for (const variant of ['stale', 'tool-failure']) {
    const session = openStore(file()); let count = 0;
    try {
      const out = await orchestrate(options(session, () => {
        count++;
        return { ok: false, failureClass: 'PROGRESS_TIMEOUT', child: { stopReason: variant === 'stale' ? 'absolute-turn-limit' : 'tool-call-limit',
          turns: variant === 'stale' ? 32 : 5, toolCalls: variant === 'stale' ? 5 : 40,
          lastProgressTurn: variant === 'stale' ? 10 : null, lastProgressToolCall: variant === 'stale' ? 2 : 39,
          repeatedToolFailure: variant === 'tool-failure' },
          result: { status: 'partial', progressReport: progress('t2', { termination_reason: variant === 'stale' ? 'turn_limit' : 'tool_limit' }) } };
      }));
      assert.equal(count, 1);
      assert.equal(out.status, 'incomplete');
      assert.equal(session.loadTasks(out.runId).length, 1);
      const d = session.listExecutionDecisions(out.runId)[0];
      assert.equal(d.action, 'stop');
      assert.equal(d.policyRule, variant === 'stale' ? 'budget.stop.stale-progress' : 'budget.stop.repeated-failure-signature');
    } finally { session.close(); }
  }
});

test('five independent remaining items split instead of receiving more turns', async () => {
  const session = openStore(file()); let calls = 0;
  const items = ['CLI', 'experiment runner', 'DB migration', 'documentation', 'audit'].map((name, i) => ({ id: `R${i + 1}`, description: `Finish ${name}`, acceptance_ids: ['AC1'], estimated_complexity: 'small' }));
  try {
    const out = await orchestrate(options(session, task => {
      calls++;
      if (task.id === 't2') return { ok: false, failureClass: 'PROGRESS_TIMEOUT', child: { stopReason: 'absolute-turn-limit', turns: 32, toolCalls: 8, lastProgressTurn: 30 },
        result: { status: 'partial', progressReport: progress('t2', { remaining_work: items }) } };
      return { ok: true, structured: true, worktree: { before: { source: 'git' }, agentChanges: [{ path: `${task.id}.py` }] },
        result: { status: 'completed', summary: 'done', acceptance: [{ id: 'A1', met: true, evidence: 'checked' }], remainingIssues: [] } };
    }));
    assert.equal(out.status, 'completed');
    assert.equal(calls, 6);
    const decision = session.listExecutionDecisions(out.runId)[0];
    assert.equal(decision.action, 'split');
    assert.equal(decision.policyRule, 'budget.split.residual-too-large');
    assert.equal(session.getRun(out.runId).counters.runBudget.generated_tasks, 5);
    assert.equal(session.getRun(out.runId).counters.runBudget.task_extensions, 0);
  } finally { session.close(); }
});

test('run generated-task hard cap stops a would-be extension atomically', async () => {
  const session = openStore(file());
  try {
    const out = await orchestrate(options(session, () => ({ ok: false, failureClass: 'PROGRESS_TIMEOUT', child: { stopReason: 'absolute-turn-limit', turns: 32, toolCalls: 5, lastProgressTurn: 30 },
      result: { status: 'partial', progressReport: progress('t2') } }), { runBudgetCaps: { maxGeneratedTasksPerRun: 0 } }));
    assert.equal(out.status, 'incomplete');
    assert.equal(session.loadTasks(out.runId).length, 1);
    assert.equal(session.listExecutionDecisions(out.runId)[0].policyRule, 'guard.RUN_BUDGET_EXCEEDED');
    assert.equal(session.getRun(out.runId).counters.runBudget.generated_tasks, 0);
  } finally { session.close(); }
});

test('runner grants typed budget remainder and disables untracked adapter extensions; legacy stays fixed', async () => {
  const seen = [];
  const runner = createAgentRunner({ invoke: async () => { throw new Error('unexpected oneshot'); }, runSubagent: async req => {
    seen.push(req.limits);
    return { ok: true, text: '```json\n' + JSON.stringify({ status: 'completed', summary: 'done', acceptance: [{ id: 'A1', met: true, evidence: 'tested' }] }) + '\n```', child: { turns: 1, toolCalls: 1 } };
  }, agents, routing, registry, policy });
  const base = { id: 't2.c1', title: 'test', goal: 'test', kind: 'implement', assignedAgent: 'coder', capability: 'strong-code', acceptance: ['done'], dependencies: [], outputs: [], planningRef: 'p1' };
  const budget = createTaskBudget(base, policy.agent_runtime); budget.turns.used = 32; budget.turns.current_limit = 48;
  budget.tool_calls.used = 40; budget.tool_calls.current_limit = 52;
  await runner.run({ ...base, budget }, { dependencyResults: [] });
  assert.equal(seen[0].max_turns, 16);
  assert.equal(seen[0].max_tool_calls, 12);
  assert.equal(seen[0].max_extensions, 0);
  assert.equal(seen[0].max_tool_extensions, 0);
  const blocked = await runner.run({ ...base, budget: { ...budget, turns: { ...budget.turns, used: 48 } } }, { dependencyResults: [] });
  assert.equal(blocked.failureClass, 'BUDGET_EXHAUSTED');
  assert.equal(seen.length, 1);
  await runner.run({ ...base, budget: undefined }, { dependencyResults: [] });
  assert.equal(seen[1].max_extensions, policy.agent_runtime.max_extensions);
  assert.equal(seen[1].max_tool_calls, policy.agent_runtime.max_tool_calls);
});
