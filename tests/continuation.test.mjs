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
import { buildTaskContract } from '../lib/orchestrator/contract.mjs';
import { parseStructuredResult, createAgentRunner } from '../lib/orchestrator/runner.mjs';
import { evaluateResult } from '../lib/orchestrator/evaluator.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const registry = { version: 1, backends: { local: { provider: 'p', model: 'm' }, cheap: { provider: 'p', model: 'm' }, sol: { provider: 'p', model: 'm' }, astra: { provider: 'p', model: 'm', vision: true }, codex: { provider: 'p', model: 'm' } } };
const file = () => join(mkdtempSync(join(tmpdir(), 'ludi-continuation-')), 'state.db');
const criteria = [
  { id: 'AC1', description: 'Storage and comparison runner', source: 'user_request' },
  { id: 'AC2', description: 'CLI, multi-seed hook and integration tests', source: 'user_request' },
];
const work = [{ id: 't2', title: 'Comparison / resume / experiment implementation', description: 'Implement comparison, resume and multi-seed experiments', depends_on: [], acceptance_ids: ['AC1', 'AC2'], estimated_complexity: 'medium', recommended_role: 'coder', artifact_type: 'code_change', likely_files: ['compare.py'] }];
const plan = () => ({ goal_summary: 'Evolve strategy execution', current_state: 'baseline exists', acceptance_criteria: criteria.map(c => ({ ...c, status: 'pending' })), work_items: work, risks: [], environment_constraints: [], unknowns: [] });
const touched = ['config.example.toml', 'compare.py', 'runner.py', 'sqlite.py', 'tests/test_pipeline.py', 'config.compare.toml'];
const remaining = [
  { id: 'CLI', description: 'Finish CLI integration', acceptance_ids: ['AC2'], estimated_complexity: 'small' },
  { id: 'SEED', description: 'Wire multi-seed execution hook', acceptance_ids: ['AC2'], estimated_complexity: 'small' },
  { id: 'TEST', description: 'Finish integration tests', acceptance_ids: ['AC2'], estimated_complexity: 'small' },
];
const progress = (id, overrides = {}) => ({ task_id: id, status: 'partial', termination_reason: 'turn_limit', completed_acceptance: [
  { acceptance_id: 'AC1', evidence: [{ type: 'file_path', location: 'compare.py', detail: 'runner implemented' }] },
], completed_steps: ['storage changes', 'resume loader', 'comparison runner'], remaining_work: remaining,
  blocked_work: [], files_touched: touched, tests_run: [{ command: 'pytest tests/test_pipeline.py', result: 'fail' }],
  artifacts: [{ type: 'code_change', location: 'compare.py', description: 'existing comparison runner' }],
  environment_constraints: [], handoff_notes: ['Do not reset or discard existing changes'], ...overrides });
const options = (session, runner, extra = {}) => ({ request: 'Evolve strategy execution', planner: 'adaptive', agents, routing, registry, policy: DEFAULT_POLICY,
  session, runner, acceptanceCriteria: criteria, ...extra });
const completed = (task, progressReport = undefined) => ({ ok: true, structured: true,
  worktree: { before: { source: 'git' }, agentChanges: [{ path: 'tests/test_pipeline.py' }] },
  result: { status: 'completed', summary: 'remaining scope completed', acceptance: task.acceptance.map((_, i) => ({ id: `A${i + 1}`, met: true, evidence: 'pytest tests/test_pipeline.py' })),
    verification: [{ command: 'pytest tests/test_pipeline.py', result: 'pass' }], progressReport, remainingIssues: [], newTasks: [] } });

test('strategy regression: turn limit with progress produces only residual work; evidence and lineage survive restart', async () => {
  const path = file(); const session = openStore(path);
  let calls = 0;
  const runner = { async run(task, ctx) {
    if (task.kind === 'design-plan') return { ok: true, structured: true, result: { status: 'completed', planningReport: plan() } };
    calls++;
    if (task.id === 't2') {
      // Reviewable evidence can be promoted by a separate authority, not the child claim.
      session.setAcceptanceStatus(ctx.runId, 'AC1', 'satisfied');
      return { ok: false, structured: true, failureClass: 'PROGRESS_TIMEOUT', child: { stopReason: 'absolute-turn-limit' },
        worktree: { after: { source: 'git', entries: Object.fromEntries(touched.map(p => [p, {}])) }, agentChanges: touched.map(path => ({ path })) },
        result: { status: 'partial', summary: 'storage/resume/comparison complete', progressReport: progress('t2'), acceptance: [] } };
    }
    assert.equal(task.id, 't2.c1');
    assert.deepEqual(task.remainingWorkIds, ['CLI', 'SEED', 'TEST']);
    assert.deepEqual(task.acceptanceIds, ['AC2']);
    assert.ok(!task.goal.includes('Implement comparison, resume'));
    assert.ok(task.goal.includes('CLI integration'));
    assert.deepEqual(task.continuationContext.workspaceState.paths, touched.slice().sort());
    const prompt = buildTaskContract(task);
    assert.match(prompt, /Previous work may already exist; inspect/);
    assert.match(prompt, /Continue ONLY remaining scope/);
    assert.match(prompt, /config\.compare\.toml/);
    const final = completed(task, progress('t2.c1', { status: 'completed', termination_reason: 'completed',
      completed_acceptance: [{ acceptance_id: 'AC2', evidence: [{ type: 'test_result', command: 'pytest tests/test_pipeline.py', result: 'pass' }] }],
      remaining_work: [], completed_steps: ['CLI', 'multi-seed', 'tests'], tests_run: [{ command: 'pytest tests/test_pipeline.py', result: 'pass' }] }));
    final.result.acceptance = []; // progress evidence is independently checked by the parent
    final.worktree.agentChanges = []; // inherited code artifacts need no new diff
    return final;
  } };
  let runId;
  try {
    const outcome = await orchestrate(options(session, runner));
    runId = outcome.runId;
    assert.equal(outcome.status, 'completed');
    assert.equal(calls, 2, 'original task is never re-run');
    const parent = session.loadTasks(runId).find(t => t.id === 't2');
    const residual = session.loadTasks(runId).find(t => t.id === 't2.c1');
    assert.equal(parent.status, 'partial');
    assert.equal(parent.taskStatus, 'TASK_PARTIAL');
    assert.equal(parent.terminationReason, 'turn_limit');
    assert.equal(parent.continuedBy, residual.id);
    assert.deepEqual(session.listExecutionDecisions(runId).map(d => d.action), ['continue', 'complete']);
    assert.equal(session.listExecutionDecisions(runId)[0].sourceTaskId, 't2');
    assert.equal(parent.progressMetrics.completedWorkCount, 4);
    assert.equal(parent.progressMetrics.remainingWorkCount, 3);
    assert.equal(residual.status, 'completed');
    assert.equal(residual.rootTaskId, 't2');
    assert.equal(residual.parentTaskId, 't2');
    assert.equal(residual.continuationIndex, 1);
    assert.equal(residual.sourceProgressReport, 't2');
    assert.equal(residual.workspaceStateReference.dirty, true);
    assert.ok(residual.inheritedArtifacts.some(a => a.location === 'compare.py'));
    assert.equal(residual.inheritedEvidence[0].acceptance_id, 'AC1');
    assert.deepEqual(session.getAcceptanceLedger(runId).find(c => c.id === 'AC1').evidence.map(e => e.taskId), ['t2']);
    assert.equal(JSON.parse(session.getAcceptanceLedger(runId).find(c => c.id === 'AC1').evidence[0].detail).type, 'file_path');
    assert.equal(session.getAcceptanceLedger(runId).find(c => c.id === 'AC2').status, 'satisfied', 'parent-checked test evidence satisfies the criterion');
  } finally { session.close(); }
  const reopened = openStore(path);
  try {
    const [parent, child] = reopened.loadTasks(runId);
    assert.equal(parent.continuedBy, child.id);
    assert.equal(child.continuationIndex, 1);
    assert.equal(child.rootTaskId, 't2');
    assert.equal(child.sourceProgressReport, parent.id);
    assert.deepEqual(child.remainingWorkIds, ['CLI', 'SEED', 'TEST']);
    assert.equal(reopened.loadTasks(runId).length, 2, 'restart does not create a duplicate residual');
    const resumed = await orchestrate(options(reopened, { async run() { throw new Error('completed lineage must not run again'); } }, { resumeRunId: runId, planner: 'rules' }));
    assert.equal(resumed.status, 'completed');
    assert.equal(reopened.loadTasks(runId).length, 2, 'resume is idempotent');
  } finally { reopened.close(); }
});

test('a dependent task waits for the continuation rather than a partial parent', async () => {
  const session = openStore(file());
  const order = [];
  try {
    const out = await orchestrate(options(session, { async run(task) {
      if (task.kind === 'design-plan') return { ok: true, structured: true, result: { status: 'completed', planningReport: {
        ...plan(), work_items: [...work, { id: 'verify', title: 'Verify', description: 'Run tests', depends_on: ['t2'], acceptance_ids: ['AC2'], estimated_complexity: 'small', recommended_role: 'tester', artifact_type: 'test_result', likely_files: [] }],
      } } };
      order.push(task.id);
      if (task.id === 't2') return { ok: false, structured: true, failureClass: 'PROGRESS_TIMEOUT', child: { stopReason: 'absolute-turn-limit' }, result: { status: 'partial', progressReport: progress('t2') } };
      return completed(task);
    } }));
    assert.equal(out.status, 'completed');
    assert.deepEqual(order, ['t2', 't2.c1', 'verify']);
    assert.deepEqual(session.loadTasks(out.runId).find(t => t.id === 'verify').dependencies, ['t2.c1']);
  } finally { session.close(); }
});

test('no progress, invalid report, contradiction and user stop cannot create a residual', async () => {
  const scenarios = [
    { name: 'no progress', value: progress('t2', { completed_steps: [], completed_acceptance: [], files_touched: [], tests_run: [] }), reason: 'turn_limit' },
    { name: 'invalid', value: { status: 'partial' }, reason: 'turn_limit' },
    { name: 'contradiction', value: progress('t2', { status: 'completed' }), reason: 'completed' },
    { name: 'user stop', value: progress('t2', { termination_reason: 'user_stop' }), reason: 'user_stop' },
  ];
  for (const scenario of scenarios) {
    const session = openStore(file()); let executionCalls = 0;
    try {
      const out = await orchestrate(options(session, { async run(task) {
        if (task.kind === 'design-plan') return { ok: true, structured: true, result: { status: 'completed', planningReport: plan() } };
        executionCalls++;
        return { ok: false, structured: true, child: { stopReason: scenario.reason }, result: { status: 'partial', progressReport: scenario.value } };
      } }));
      assert.equal(out.runStatus, 'failed', scenario.name);
      assert.equal(executionCalls, 1);
      assert.equal(session.loadTasks(out.runId).length, 1);
    } finally { session.close(); }
  }
});

test('real runner preserves structured progress on a failed turn-limit child without invoking another candidate', async () => {
  let invocations = 0;
  const runner = createAgentRunner({ invoke: async () => { throw new Error('unexpected oneshot'); }, agents, routing, registry,
    runSubagent: async () => { invocations++; return { ok: false, error: 'turn limit', failureClass: 'PROGRESS_TIMEOUT', text: '```json\n' + JSON.stringify({ status: 'partial', summary: 'partial work', progressReport: progress('t2') }) + '\n```', child: { stopReason: 'absolute-turn-limit', turns: 49, toolCalls: 5 } }; } });
  const task = { id: 't2', title: 'comparison', goal: 'original', kind: 'implement', planningRef: 'planning-1', assignedAgent: 'coder', capability: 'strong-code', acceptance: ['AC1'], outputs: [], dependencies: [] };
  const result = await runner.run(task, { dependencyResults: [], runId: 'run-test' });
  assert.equal(invocations, 1);
  assert.equal(result.ok, false);
  assert.equal(result.structured, true);
  assert.equal(result.result.progressReport.remaining_work.length, 3);
  assert.equal(result.child.stopReason, 'absolute-turn-limit');
});

test('continuation can verify inherited code artifacts without producing a fresh diff', () => {
  const task = { id: 't2.c1', title: 'verify remainder', kind: 'implement', artifact_type: 'code_change', parentTaskId: 't2',
    inheritedArtifacts: [{ type: 'code_change', location: 'compare.py', description: 'from parent' }], acceptance: ['AC2'] };
  const run = completed(task, progress('t2.c1', { status: 'completed', remaining_work: [], tests_run: [{ command: 'pytest tests/test_pipeline.py', result: 'pass' }], completed_acceptance: [{ acceptance_id: 'AC2', evidence: ['pytest passed'] }] }));
  run.worktree.agentChanges = [];
  assert.equal(evaluateResult(task, run).verdict, 'success');
  assert.match(evaluateResult({ ...task, parentTaskId: undefined }, run).reasons.join(' '), /no file changes/);
});

test('structured runner result retains the progress payload without interpreting prose', () => {
  const block = '```json\n' + JSON.stringify({ status: 'partial', summary: 'progress', progressReport: progress('t2') }) + '\n```';
  assert.equal(parseStructuredResult(block).result.progressReport.task_id, 't2');
  assert.equal(parseStructuredResult('prose only').structured, false);
});
