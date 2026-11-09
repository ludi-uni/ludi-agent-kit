// Offline only: native results are fixtures. Never launches a model or resumes a live run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { DEFAULT_POLICY } from '../lib/orchestrator/policy.mjs';
import { planRulesHandoff } from '../lib/orchestrator/rules-handoff.mjs';
import { orchestrate } from '../lib/orchestrator/orchestrator.mjs';
import { openStore } from '../lib/orchestrator/store.mjs';

const routing = loadRouting(resolve('routing/routing.json'));
const { agents } = loadAgents(resolve('agents'), routing);
const registry = { version: 1, backends: { cheap: { provider: 'pc', model: 'mc' } } };
const task = () => ({ id: 't1', title: 'Inspect', goal: 'Inspect scoped files', kind: 'investigate',
  assignedAgent: 'scout', artifact_type: 'investigation', capability: 'cheap-code', acceptance: ['identify files'],
  acceptanceIds: [], dependencies: [], totalModelAttempts: 1 });
const report = (id = 't1', marker = 'read entry point') => ({ task_id: id, status: 'partial',
  completed_acceptance: [], completed_steps: [marker],
  remaining_work: [{ id: 'rest', description: 'Inspect the config resolver only', acceptance_ids: [], estimated_complexity: 'small' }],
  blocked_work: [], files_touched: [], tests_run: [], artifacts: [], environment_constraints: [], handoff_notes: [] });
const run = (id = 't1', marker) => ({ ok: true, structured: true, modelId: 'pc/mc', child: {
  transport: 'native', guardQuiescent: true, terminalStatus: 'completed', stopReason: null, turns: 3, toolCalls: 10,
}, counters: { invocationsStarted: 1 }, result: { status: 'partial', summary: 'scoped findings',
  evidence: [{ type: 'file_reference', source: 'src/main.rs:1-20' }], progressReport: report(id, marker), decisions: [] } });
const plan = (t = task(), r = run(), over = {}) => planRulesHandoff({ task: t, run: r,
  runtime: DEFAULT_POLICY.agent_runtime, maxAttempts: 4, ...over });

test('clean and confirmed hard-limit handoffs create only bounded residual investigations', () => {
  const soft = plan();
  assert.equal(soft.ok, true);
  assert.equal(soft.task.goal.includes('Inspect the config resolver only'), true);
  assert.deepEqual(soft.task.acceptance, task().acceptance);
  assert.equal(soft.task.rulesContinuation.toolCallsUsed, 10);
  const hard = run();
  Object.assign(hard, { ok: false, abort: true, failureClass: 'TOOL_BUDGET_EXHAUSTED', partialHandoff: { status: 'unaccepted', claimedStatus: 'partial' } });
  Object.assign(hard.child, { terminalStatus: 'tool_budget_exhausted', stopReason: 'tool-call-limit' });
  assert.equal(plan(task(), hard).ok, true);
});

test('rules handoff fails closed on unsafe stops, missing evidence, completed claims and repeated work', () => {
  const mutations = [
    r => { r.child.guardQuiescent = false; },
    r => { r.child.cancelRequested = true; },
    r => { r.retainWorkspaceUntil = Promise.resolve(); },
    r => { r.child.stopReason = 'guard-tool-not-allowed'; },
    r => { r.child.terminalStatus = 'cancelled'; },
    r => { r.ok = false; r.failureClass = 'TIMEOUT'; },
    r => { r.abort = true; },
    r => { r.structured = false; },
    r => { r.child.terminalStatus = 'failed'; },
    r => { delete r.child.toolCalls; },
    r => { r.result.evidence = []; },
    r => { r.gate = { action: 'block' }; },
    r => { r.worktree = { agentChanges: [{ path: 'src/main.rs' }] }; },
    r => { r.result.remainingIssues = [{ summary: 'unsafe', blocking: true }]; },
    r => { r.result.verification = [{ command: 'check', result: 'fail' }]; },
    r => { r.result.progressReport.task_id = 'foreign'; },
    r => { r.result.progressReport.remaining_work = []; },
    r => { r.result.progressReport.remaining_work[0].acceptance_ids = ['foreign']; },
    r => { r.result.progressReport.status = 'completed'; },
    r => { r.result.decisions = [{ question: 'Approval?' }]; },
    r => { r.partialHandoff = { claimedStatus: 'completed' }; },
    r => { r.result.progressReport.handoff_notes = ['git reset required']; },
  ];
  for (const mutate of mutations) { const r = run(); mutate(r); assert.equal(plan(task(), r).ok, false, mutate.toString()); }
  assert.equal(plan(task(), run(), { evaluator: { verdict: 'blocked' } }).ok, false);
  const prior = plan().task;
  prior.totalModelAttempts = 2;
  assert.match(plan(prior, run(prior.id)).reason, /no new progress/);
});

test('lineage tool/turn/invocation/depth caps are finite and never reset per residual', () => {
  for (const [field, value] of [['toolCallsUsed', 75], ['turnsUsed', 47]]) {
    const t = plan().task;
    t.rulesContinuation[field] = value;
    assert.match(plan(t, run(t.id, 'new evidence')).reason, /cumulative/);
  }
  const attempts = task(); attempts.totalModelAttempts = 4;
  assert.match(plan(attempts).reason, /cumulative/);
  const depth = task(); depth.continuationIndex = 3;
  assert.match(plan(depth).reason, /depth/);
});

test('rules/native partial investigation persists evidence, rewires dependencies, and pins a finite continuation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ludi-rules-handoff-'));
  const session = openStore(join(dir, 'state.db'));
  t.after(() => { session.close(); rmSync(dir, { recursive: true, force: true }); });
  const calls = [];
  const result = await orchestrate({ request: 'Inspect then implement', agents, routing, registry,
    policy: DEFAULT_POLICY, session,
    plan: [{ ...task(), agent: 'scout' }, { id: 't2', title: 'Inspect dependent', goal: 'Inspect dependent', kind: 'investigate', agent: 'scout', capability: 'cheap-code', dependencies: ['t1'], acceptance: ['identify files'] }],
    runner: { async run(t) {
      calls.push(t.id);
      if (t.id === 't1') {
        const r = run(t.id);
        Object.assign(r, { ok: false, abort: true, failureClass: 'TOOL_BUDGET_EXHAUSTED',
          partialHandoff: { status: 'unaccepted', claimedStatus: 'partial', source: 'native-guard', text: 'saved output' } });
        Object.assign(r.child, { terminalStatus: 'tool_budget_exhausted', stopReason: 'tool-call-limit' });
        return r;
      }
      if (t.parentTaskId) {
        assert.equal(t.executionRoute.modelId, 'pc/mc');
        assert.equal(t.rulesContinuation.toolCallsUsed, 10);
        assert.equal(t.totalModelAttempts, 1);
        assert.deepEqual(t.acceptance, ['identify files']);
      }
      return { ok: true, structured: true, modelId: 'pc/mc', counters: { invocationsStarted: 1 },
        result: { status: 'completed', summary: 'inspected', acceptance: [{ id: 'A1', met: true, evidence: 'git status --short' }], verification: [{ command: 'git status --short', result: 'pass' }], decisions: [], remainingIssues: [] } };
    } } });
  assert.deepEqual(calls, ['t1', 't1.c1', 't2']);
  assert.equal(result.status, 'completed');
  const parent = session.loadTasks(result.runId).find(x => x.id === 't1');
  assert.equal(parent.partialHandoff.status, 'unaccepted');
  assert.equal(parent.partialHandoff.text, 'saved output');
  assert.match(parent.partialHandoff.location, /^sqlite:tasks\//);
  assert.equal(parent.handoffAcceptance, 'unaccepted');
  assert.equal(session.listExecutionDecisions(result.runId)[0].action, 'continue');
});

test('unmanaged native writer partial is saved without completion or automatic full-scope retry', async () => {
  let calls = 0;
  const result = await orchestrate({ request: 'implement scoped change', agents, routing, registry, policy: DEFAULT_POLICY,
    plan: [{ id: 'writer', title: 'Scoped implementation', goal: 'Scoped implementation', kind: 'implement',
      agent: 'coder', capability: 'cheap-code', acceptance: ['check the slice'], dependencies: [] }],
    runner: { async run(t) {
      calls++;
      const partial = run(t.id);
      partial.result.acceptance = [{ id: 'A1', met: true, evidence: 'a completed slice is not the whole task' }];
      return partial;
    } } });
  assert.equal(calls, 1);
  assert.notEqual(result.status, 'completed');
  assert.equal(result.tasks[0].status, 'partial');
  assert.equal(result.tasks[0].handoffAcceptance, 'unaccepted');
  assert.equal(result.tasks[0].partialHandoff.source, 'native-normal-partial');
  assert.match(result.tasks[0].blockedReason, /no automatic retry/);
});

test('hard-stop completed claims are retained but never accepted or continued', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ludi-rules-claim-'));
  const session = openStore(join(dir, 'state.db'));
  t.after(() => { session.close(); rmSync(dir, { recursive: true, force: true }); });
  let calls = 0;
  const result = await orchestrate({ request: 'inspect', agents, routing, registry, policy: DEFAULT_POLICY, session,
    plan: [{ ...task(), agent: 'scout' }], runner: { async run() {
      calls++;
      const r = run();
      Object.assign(r, { ok: false, abort: true, failureClass: 'TOOL_BUDGET_EXHAUSTED',
        partialHandoff: { status: 'unaccepted', claimedStatus: 'completed', text: 'child claimed completed' } });
      Object.assign(r.child, { terminalStatus: 'tool_budget_exhausted', stopReason: 'tool-call-limit' });
      return r;
    } } });
  assert.equal(calls, 1);
  assert.notEqual(result.status, 'completed');
  assert.equal(session.loadTasks(result.runId)[0].partialHandoff.text, 'child claimed completed');
});
