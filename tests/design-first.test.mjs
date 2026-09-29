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

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const registry = { version: 1, backends: { local: { provider: 'p', model: 'm' }, cheap: { provider: 'p', model: 'm' }, sol: { provider: 'p', model: 'm' }, astra: { provider: 'p', model: 'm', vision: true }, codex: { provider: 'p', model: 'm' } } };
const file = () => join(mkdtempSync(join(tmpdir(), 'ludi-design-')), 'state.db');
const item = (id, role, type, complexity, depends = [], acceptance = ['AC1']) => ({ id, title: id, description: `Deliver ${id}`, depends_on: depends, acceptance_ids: acceptance, estimated_complexity: complexity, recommended_role: role, artifact_type: type, likely_files: [] });
const report = () => ({ goal_summary: 'Build a bounded change', current_state: 'Needs inspection', acceptance_criteria: [
  { id: 'AC1', description: 'Behavior verified', source: 'user_request', status: 'pending' },
  { id: 'AC2', description: 'Documentation written', source: 'user_request', status: 'pending' },
], work_items: [item('inspect', 'investigator', 'investigation', 'small'), item('implement', 'coder', 'code_change', 'medium', ['inspect']), item('docs', 'documentation', 'documentation', 'small', ['implement'], ['AC2'])], risks: [], environment_constraints: ['shell unavailable'], unknowns: [], findings: [{ classification: 'environment_limitation', summary: 'shell unavailable' }] });
const opts = (session, runner, extras = {}) => ({ request: 'Build a bounded change', planner: 'adaptive', agents, routing, registry, policy: DEFAULT_POLICY, session, runner,
  acceptanceCriteria: [{ id: 'AC1', description: 'Behavior verified', source: 'user_request' }, { id: 'AC2', description: 'Documentation written', source: 'user_request' }], ...extras });
const completion = task => ({ ok: true, structured: true,
  worktree: { before: { source: 'git' }, agentChanges: task.artifact_type === 'code_change' ? [{ path: `${task.id}.js` }] : [] },
  result: { status: 'completed', summary: task.title, artifacts: task.artifact_type === 'documentation' ? [`${task.id}.md`] : [],
    verification: [{ command: `check ${task.id}`, result: 'pass' }],
    evidence: task.acceptance.map((_, i) => ({ type: 'command_result', source: 'verification', result: 'pass', related_acceptance: `A${i + 1}`, command: `check ${task.id}` })),
    acceptance: task.acceptance.map((_, i) => ({ id: `A${i + 1}`, met: true, evidence: `check ${task.id}` })), remainingIssues: [], newTasks: [] } });

test('design child receives canonical goal, ledger, workspace context and emits a persistent DAG with provenance', async () => {
  const path = file(); const session = openStore(path);
  let planningCalls = 0;
  const runner = { async run(task) {
    if (task.kind === 'design-plan') {
      planningCalls++;
      assert.equal(task.assignedAgent, 'design-planner');
      assert.equal(task.planningContext.canonicalGoal.originalRequest, 'Build a bounded change');
      assert.deepEqual(task.planningContext.acceptanceLedger.map(c => c.id), ['AC1', 'AC2']);
      assert.ok(task.planningContext.workspace.path);
      assert.equal(task.planningContext.dirtyWorktree.source, null);
      const prompt = buildTaskContract(task);
      assert.match(prompt, /CANONICAL CONTEXT/);
      assert.match(prompt, /AC2/);
      return { ok: true, structured: true, raw: JSON.stringify({ planningReport: report() }), result: { status: 'completed', planningReport: report() } };
    }
    return completion(task);
  } };
  try {
    const result = await orchestrate(opts(session, runner));
    assert.equal(result.status, 'completed');
    assert.equal(planningCalls, 1);
    assert.deepEqual(result.tasks.map(t => t.id), ['inspect', 'implement', 'docs']);
    assert.deepEqual(result.tasks.find(t => t.id === 'implement').dependencies, ['inspect']);
    assert.equal(result.tasks.find(t => t.id === 'implement').estimatedComplexity, 'medium');
    assert.equal(result.tasks.find(t => t.id === 'implement').assignedAgent, 'coder');
    assert.equal(result.tasks.find(t => t.id === 'implement').artifact_type, 'code_change');
    assert.deepEqual(result.tasks.find(t => t.id === 'docs').acceptanceIds, ['AC2']);
    const planning = session.listPlanningAttempts(result.runId)[0];
    assert.equal(planning.status, 'valid');
    assert.equal(planning.childTaskId, 'design-planner-1');
    assert.equal(JSON.parse(planning.rawReport).planningReport.work_items.length, 3);
    assert.equal(planning.validation.coverage.AC1.count, 2);
    assert.equal(session.loadTasks(result.runId)[0].planningRef, planning.id);
    assert.equal(session.loadTasks(result.runId)[0].sourceWorkItemId, 'inspect');
    assert.equal(session.loadTasks(result.runId)[0].outputs.length, 0);
    assert.equal(session.getAcceptanceLedger(result.runId).length, 2);
  } finally { session.close(); }
  const reopened = openStore(path);
  try {
    const run = reopened.listRuns()[0];
    assert.equal(reopened.loadTasks(run.id)[1].planningRef, reopened.listPlanningAttempts(run.id)[0].id);
  } finally { reopened.close(); }
});

test('invalid, incomplete, uncovered, large and failed planning stop without legacy fallback', async () => {
  const cases = [
    { name: 'child failed', output: { ok: false, error: 'read failure' }, status: 'PLANNING_FAILED' },
    { name: 'missing report', output: { ok: true, structured: true, result: { status: 'completed' } }, status: 'PLANNING_INCOMPLETE' },
    { name: 'invalid report', output: { ok: true, structured: true, result: { status: 'completed', planningReport: { work_items: [] } } }, status: 'INVALID_REPORT' },
    { name: 'coverage gap', output: { ok: true, structured: true, result: { status: 'completed', planningReport: { ...report(), work_items: report().work_items.filter(w => w.id !== 'docs') } } }, status: 'UNCOVERED_ACCEPTANCE' },
    { name: 'large item', output: { ok: true, structured: true, result: { status: 'completed', planningReport: { ...report(), work_items: report().work_items.map(w => w.id === 'implement' ? { ...w, estimated_complexity: 'large' } : w) } } }, status: 'UNRESOLVED_LARGE_WORK_ITEM' },
  ];
  for (const scenario of cases) {
    const session = openStore(file());
    let executions = 0;
    try {
      const result = await orchestrate(opts(session, { async run(task) { if (task.kind !== 'design-plan') executions++; return scenario.output; } }));
      assert.equal(result.status, scenario.status, scenario.name);
      assert.equal(result.runStatus, 'failed');
      assert.equal(result.tasks.length, 0);
      assert.equal(executions, 0);
      assert.equal(session.listPlanningAttempts(result.runId)[0].status, scenario.status === 'PLANNING_INCOMPLETE' ? 'incomplete' : 'invalid');
      assert.equal(session.listPlanningAttempts(result.runId)[0].validation.code, scenario.status);
      const again = await orchestrate(opts(session, { async run() { executions++; throw new Error('must not fallback or retry planning'); } }, { resumeRunId: result.runId, planner: 'rules' }));
      assert.equal(again.status, scenario.status);
      assert.equal(executions, 0);
      assert.equal(session.listPlanningAttempts(result.runId).length, 1);
    } finally { session.close(); }
  }
});
