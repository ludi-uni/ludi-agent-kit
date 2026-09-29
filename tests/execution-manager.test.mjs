// Execution manager (Phase 4): pure deterministic post-run decision policy.
// complete > continue > split > reassign > retry > stop; hard guards first.
// No store, runner or model calls here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideExecution, classifyExecutionFailure, buildSplitTasks, reassignTarget,
  DECISION_ACTIONS, FAILURE_CLASSES, POLICY_RULES, DEFAULT_LIMITS, DECISION_CODES,
} from '../lib/orchestrator/execution-manager.mjs';
import { newTask } from '../lib/orchestrator/task-store.mjs';
import { createTaskBudget } from '../lib/orchestrator/budget-policy.mjs';

const report = (extra = {}) => ({
  task_id: 'W-IMPL',
  status: 'partial',
  termination_reason: 'turn_limit',
  completed_acceptance: [{ acceptance_id: 'AC-IMPL', evidence: ['runtime mutates seeds deterministically'] }],
  completed_steps: ['modified runtime'],
  remaining_work: [
    { id: 'RW1', description: 'Finish comparison framework', acceptance_ids: ['AC-IMPL'], estimated_complexity: 'medium' },
    { id: 'RW2', description: 'Run multi-seed experiments', acceptance_ids: ['AC-EXP'], estimated_complexity: 'small' },
  ],
  blocked_work: [],
  files_touched: ['src/strategy_evolution_lab/runtime/runner.py'],
  tests_run: [{ command: 'pytest tests/test_pipeline.py', result: 'pass' }],
  artifacts: [],
  environment_constraints: [],
  handoff_notes: [],
  ...extra,
});

const task = (extra = {}) => ({
  id: 'W-IMPL', title: 'Modify runtime and storage', goal: 'g',
  assignedAgent: 'coder', recommendedRole: 'coder', kind: 'implement',
  artifact_type: 'code_change', acceptanceIds: ['AC-IMPL', 'AC-EXP'],
  ...extra,
});

const coverage = (statuses = {}) => Object.fromEntries(
  ['AC-IMPL', 'AC-EXP'].map(id => [id, { status: statuses[id] ?? 'pending', description: `Criterion ${id}` }]));

// --- enums & pure shape -----------------------------------------------------

test('enums are explicit, frozen, and every decision has the full structured shape', () => {
  assert.deepEqual([...DECISION_ACTIONS], ['complete', 'extend', 'continue', 'split', 'reassign', 'retry', 'escalate', 'approval_required', 'stop']);
  assert.deepEqual([...FAILURE_CLASSES], [
    'transient_error', 'environment_limitation', 'task_too_large', 'agent_capability_mismatch',
    'implementation_defect', 'test_failure', 'no_progress', 'invalid_output',
    'external_blocker', 'requirement_ambiguity', 'unknown']);
  assert.equal(DEFAULT_LIMITS.maxRetries, 2);
  assert.equal(DEFAULT_LIMITS.maxReassignments, 2);
  const d = decideExecution({ task: task(), run: { ok: true }, progressReport: report() });
  for (const k of ['action', 'reason', 'confidence', 'source_task_id', 'next_role', 'split_plan', 'retry_policy', 'notes', 'failureClassification', 'policyRule', 'inputsSnapshot']) {
    assert.ok(Object.hasOwn(d, k), `decision missing ${k}`);
  }
  assert.equal(d.source_task_id, 'W-IMPL');
  assert.ok(d.confidence >= 0 && d.confidence <= 1);
});

// --- classifyExecutionFailure ------------------------------------------------

test('classifyExecutionFailure: explicit blocked classes and structured signals win', () => {
  assert.equal(classifyExecutionFailure({ progressReport: report({ blocked_work: [{ description: 'db gone', reason: 'sandbox', classification: 'environment_limitation' }] }) }).class, 'environment_limitation');
  assert.equal(classifyExecutionFailure({ progressReport: report({ tests_run: [{ command: 'pytest x', result: 'fail' }] }) }).class, 'test_failure');
  // Same transient socket failure, different wording -> identical signature.
  const a = classifyExecutionFailure({ run: { ok: false, error: 'UND_ERR_SOCKET: remote side closed' }, terminationReason: 'process_error' });
  const b = classifyExecutionFailure({ run: { ok: false, error: 'socket hang up, different words entirely' }, terminationReason: 'process_error' });
  assert.equal(a.class, 'transient_error');
  assert.equal(b.class, 'transient_error');
  assert.equal(a.signature, b.signature, 'transient socket failures collide regardless of wording');
  assert.equal(classifyExecutionFailure({ run: { ok: false, failureClass: 'MALFORMED_RESULT' }, terminationReason: 'validation_failure' }).class, 'invalid_output');
  assert.equal(classifyExecutionFailure({ progressReport: report({ status: 'blocked', completed_steps: [], completed_acceptance: [], files_touched: [], tests_run: [] }) }).class, 'no_progress');
  // A turn_limit with real progress and remaining work is a size problem.
  assert.equal(classifyExecutionFailure({ progressReport: report(), terminationReason: 'turn_limit' }).class, 'task_too_large');
  assert.equal(classifyExecutionFailure({}).class, 'unknown');
});

// --- hard guards --------------------------------------------------------------

test('guard: user_stop beats every action including a healthy partial', () => {
  const r = report();
  for (const inputs of [
    { task: task(), run: { ok: true }, progressReport: r, terminationReason: 'user_stop' },
    { task: task(), run: { ok: true, abort: true }, progressReport: r },
    { task: task(), run: { ok: true }, progressReport: r, explicitUserDecisions: ['stop this task'] },
    { task: task(), run: { ok: false, error: 'UND_ERR_SOCKET' }, terminationReason: 'process_error', explicitUserDecisions: ['do not retry'] },
  ]) {
    const d = decideExecution(inputs);
    assert.equal(d.action, 'stop');
    assert.equal(d.policyRule, POLICY_RULES.STOP_USER);
    assert.equal(d.confidence, 1);
  }
});

test('guard: destructive ambiguity and environment limitation always stop', () => {
  const destructive = decideExecution({ task: task(), run: { ok: true }, progressReport: report({ handoff_notes: ['ran git reset --hard to recover'] }) });
  assert.equal(destructive.action, 'stop');
  assert.equal(destructive.policyRule, POLICY_RULES.STOP_DESTRUCTIVE);
  for (const inputs of [
    { task: task(), run: { ok: false, error: 'missing binary: ffmpeg not installed' } },
    { task: task(), run: { ok: true }, progressReport: report(), terminationReason: 'environment_block' },
    { task: task(), run: { ok: false }, progressReport: report({ blocked_work: [{ description: 'no ffmpeg', reason: 'env', classification: 'environment_limitation' }] }) },
  ]) {
    const d = decideExecution(inputs);
    assert.equal(d.action, 'stop', d.reason);
    assert.equal(d.policyRule, POLICY_RULES.STOP_ENVIRONMENT);
  }
});

test('guard: no_progress never continues, retries or splits', () => {
  const d = decideExecution({
    task: task(), run: { ok: false },
    progressReport: report({ status: 'blocked', completed_steps: [], completed_acceptance: [], files_touched: [], tests_run: [] }),
  });
  assert.equal(d.action, 'stop');
  assert.equal(d.policyRule, POLICY_RULES.STOP_NO_PROGRESS);
  assert.equal(d.failureClassification.class, 'no_progress');
});

// --- priority A-E regression --------------------------------------------------

// A: complete wins over everything once completion is evidenced.
test('A: complete — evidenced completed report wins over retry/continue signals', () => {
  const d = decideExecution({
    task: task(), run: { ok: true },
    progressReport: report({ status: 'completed', remaining_work: [], termination_reason: 'completed' }),
    terminationReason: 'completed',
    acceptanceCoverage: coverage({ 'AC-IMPL': 'satisfied', 'AC-EXP': 'satisfied' }),
  });
  assert.equal(d.action, 'complete');
  assert.equal(d.policyRule, POLICY_RULES.COMPLETE_EVIDENCED);
  assert.equal(d.split_plan, null);
  // A completion claim with an unevidenced criterion stops for review — the
  // policy never auto-continues on an unverified 'completed'.
  const unverified = decideExecution({
    task: task(), run: { ok: true },
    progressReport: report({ status: 'completed', remaining_work: [], termination_reason: 'completed' }),
    terminationReason: 'completed', acceptanceCoverage: coverage(),
  });
  assert.equal(unverified.action, 'stop');
});

// B: continue — partial with progress and a small/medium remainder.
test('measured budget input can emit extend distinctly from retry and continuation', () => {
  const t = task();
  const budget = createTaskBudget(t, { max_turns: 32, max_tool_calls: 40, absolute_max_turns: 64, absolute_max_tool_calls: 80 });
  budget.turns.used = 32;
  const decision = decideExecution({ task: t, run: { ok: false, failureClass: 'PROGRESS_TIMEOUT' }, terminationReason: 'turn_limit',
    progressReport: report(), budget, budgetTelemetry: { turns: 32, toolCalls: 5, lastProgressTurn: 30 },
    budgetMetrics: { progressMade: true, completedWorkCount: 2, remainingWorkCount: 2, lastProgressTurn: 30 } });
  assert.equal(decision.action, 'extend');
  assert.equal(decision.previousBudget.turns.current_limit, 32);
  assert.equal(decision.newBudget.turns.current_limit, 48);
  assert.equal(decision.retry_policy, null);
});

test('B: continue — partial progress with bounded remaining work', () => {
  const d = decideExecution({
    task: task(), run: { ok: true },
    progressReport: report({ remaining_work: [{ id: 'RW1', description: 'finish', acceptance_ids: ['AC-IMPL'], estimated_complexity: 'small' }] }),
    terminationReason: 'turn_limit',
    acceptanceCoverage: coverage(),
  });
  assert.equal(d.action, 'continue');
  assert.equal(d.policyRule, POLICY_RULES.CONTINUE_PARTIAL);
  assert.equal(d.split_plan, null);
});

// C: split — 2+ independent remaining items become focused tasks; the parent's
// goal is never re-cloned and every unsatisfied criterion stays covered.
test('C: split — two independent remaining_work items emit focused tasks preserving acceptance', () => {
  // A completed run can still carry remaining work the planner must decompose.
  const d = decideExecution({
    task: task(), run: { ok: true },
    progressReport: report({ status: 'failed', completed_steps: [], completed_acceptance: [], files_touched: ['a.py'] }),
    terminationReason: 'turn_limit',
    acceptanceCoverage: coverage(),
  });
  assert.equal(d.action, 'split', d.reason);
  assert.equal(d.split_plan.length, 2);
  assert.deepEqual(d.split_plan.map(t => t.id), ['W-IMPL.s1-1', 'W-IMPL.s1-2']);
  assert.equal(d.split_plan[0].assignedAgent, 'coder');
  assert.deepEqual(d.split_plan[0].acceptanceIds, ['AC-IMPL']);
  assert.deepEqual(d.split_plan[1].acceptanceIds, ['AC-EXP']);
  assert.equal(d.split_plan[0].sourceTaskId, 'W-IMPL');
  // Specs are newTask-compatible.
  const row = newTask({ ...d.split_plan[0], dependencies: [] });
  assert.equal(row.id, 'W-IMPL.s1-1');
});

test('C2: split validation — single remainder, unknown acceptance, uncovered criteria, large residual, depth limit', () => {
  // A single remaining item is continuation work, never a split.
  const single = buildSplitTasks({ task: task(), report: report({ remaining_work: [{ id: 'RW1', description: 'd', acceptance_ids: ['AC-IMPL'], estimated_complexity: 'small' }] }) });
  assert.equal(single.ok, false);
  assert.match(single.errors[0], /SPLIT_NOT_APPLICABLE/);
  // Unknown acceptance id.
  const unknown = buildSplitTasks({ task: task(), report: report({ remaining_work: [
    { id: 'R1', description: 'a', acceptance_ids: ['AC-NOPE'], estimated_complexity: 'small' },
    { id: 'R2', description: 'b', acceptance_ids: ['AC-IMPL'], estimated_complexity: 'small' }] }) });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some(e => /AC-NOPE/.test(e)));
  // Unsatisfied criterion left uncovered by any child.
  const uncovered = buildSplitTasks({ task: task(), report: report({ remaining_work: [
    { id: 'R1', description: 'a', acceptance_ids: ['AC-IMPL'], estimated_complexity: 'small' },
    { id: 'R2', description: 'b', acceptance_ids: [], artifact_type: 'documentation', estimated_complexity: 'small' }] }),
    acceptanceCoverage: coverage() });
  assert.equal(uncovered.ok, false);
  assert.ok(uncovered.errors.some(e => /SPLIT_UNCOVERED_ACCEPTANCE.*AC-EXP/.test(e)));
  // A 'large' residual needs re-planning, never an execution split.
  const large = buildSplitTasks({ task: task(), report: report({ remaining_work: [
    { id: 'R1', description: 'a', acceptance_ids: ['AC-IMPL'], estimated_complexity: 'large' },
    { id: 'R2', description: 'b', acceptance_ids: ['AC-EXP'], estimated_complexity: 'small' }] }) });
  assert.equal(large.ok, false);
  assert.ok(large.errors.some(e => /large/.test(e)));
  // Split depth limit is a guard, not silent truncation.
  const deep = decideExecution({ task: task(), run: { ok: true },
    progressReport: report({ status: 'failed', files_touched: ['a.py'] }), terminationReason: 'turn_limit',
    acceptanceCoverage: coverage(), counters: { splitDepth: 1 }, limits: { maxSplitDepth: 1 } });
  assert.equal(deep.action, 'stop');
  assert.equal(deep.policyRule, POLICY_RULES.STOP_LIMITS);
});

// D: reassign — explicit mismatch hints map to a new ROLE (never a new model);
// history bounds it at 2 and re-targeting an already-tried role is rejected.
test('D: reassign — explicit mismatch hint moves role; max 2, no oscillation, no model change', () => {
  const hinted = () => report({
    status: 'failed', completed_steps: [], completed_acceptance: [], files_touched: ['a.py'],
    remaining_work: [],
    handoff_notes: ['cannot run tests here; verification needed by a tester'],
  });
  const base = { task: task(), run: { ok: false, error: 'verify' }, terminationReason: 'process_error', acceptanceCoverage: coverage() };
  const d = decideExecution({ ...base, progressReport: hinted() });
  assert.equal(d.action, 'reassign', d.reason);
  assert.equal(d.next_role, 'tester');
  assert.equal(d.policyRule, POLICY_RULES.REASSIGN_MISMATCH);
  assert.equal(d.retry_policy, null, 'reassign never carries a model retry policy');
  // Oscillation: history shows the hinted role was already tried.
  const osc = decideExecution({ ...base, progressReport: hinted(), history: [{ action: 'reassign', next_role: 'tester' }] });
  assert.equal(osc.action, 'stop');
  assert.equal(osc.policyRule, POLICY_RULES.STOP_LIMITS);
  // Cap: two prior reassignments -> stop, never a third.
  const capped = decideExecution({ ...base, progressReport: hinted(), counters: { reassignments: 2 }, limits: { maxReassignments: 2 } });
  assert.equal(capped.action, 'stop');
  assert.equal(capped.policyRule, POLICY_RULES.STOP_LIMITS);
  // The hint probe maps explicit wording to roles.
  assert.equal(reassignTarget({ task: task(), report: hinted() }), 'tester');
  assert.equal(reassignTarget({ task: task(), report: report() }), null, 'no hint -> no reassign');
});

// E: retry — ONLY transient/process-level failures; max 2; identical signature
// repeated -> suppressed to stop; never a model/provider escalation.
test('E: retry — transient socket/process error retries under the limit; identical signature suppressed', () => {
  const transient = {
    task: task(), run: { ok: false, error: 'UND_ERR_SOCKET: remote side closed', failureClass: 'MODEL_FAILURE' },
    terminationReason: 'process_error',
    progressReport: report({ status: 'failed', completed_steps: [], completed_acceptance: [], remaining_work: [], files_touched: [], tests_run: [] }),
  };
  const d = decideExecution({ ...transient, counters: { retries: 0 } });
  assert.equal(d.action, 'retry');
  assert.equal(d.failureClassification.class, 'transient_error');
  assert.equal(d.policyRule, POLICY_RULES.RETRY_TRANSIENT);
  assert.equal(d.retry_policy.maxRetries, 2);
  assert.equal(d.retry_policy.attempt, 1);
  assert.equal(d.retry_policy.escalateModel, false);
  // At the limit -> stop, not a third retry.
  const atLimit = decideExecution({ ...transient, counters: { retries: 2 }, limits: { maxRetries: 2 } });
  assert.equal(atLimit.action, 'stop');
  assert.equal(atLimit.policyRule, POLICY_RULES.STOP_LIMITS);
  // Identical signature seen before -> suppression, never another retry.
  const sig = d.failureClassification.signature;
  const dup = decideExecution({ ...transient, counters: { retries: 0 }, failureSignature: sig });
  assert.equal(dup.action, 'stop');
  assert.equal(dup.policyRule, POLICY_RULES.STOP_LIMITS);
  assert.ok(dup.notes.some(n => /identical signature|suppression/.test(n)));
  // A test failure is NEVER retried — it is a project defect, not transient.
  const testFail = decideExecution({
    task: task(), run: { ok: false, error: 'assertion failed' },
    progressReport: report({ status: 'failed', tests_run: [{ command: 'pytest x', result: 'fail' }], completed_steps: [], completed_acceptance: [], remaining_work: [], files_touched: [] }),
  });
  assert.notEqual(testFail.action, 'retry');
  assert.equal(testFail.failureClassification.class, 'test_failure');
});

// --- validation / limit cases -------------------------------------------------

test('invalid inputs degrade to stop with data, never throw; inputs are not mutated', () => {
  const before = structuredClone({ task: task(), run: { ok: true }, progressReport: report() });
  const input = structuredClone(before);
  const d = decideExecution(input);
  assert.ok(DECISION_ACTIONS.includes(d.action));
  assert.deepEqual(input, before);
  assert.equal(DECISION_CODES.INVALID_INPUT, 'INVALID_INPUT');
  const empty = decideExecution({});
  assert.equal(empty.action, 'stop');
  assert.equal(empty.failureClassification.class, 'unknown');
});

test('split_plan children keep existing task deps and never re-clone the parent scope', () => {
  const split = buildSplitTasks({
    task: task({ artifact_type: 'code_change' }),
    report: report({ remaining_work: [
      { id: 'R1', description: 'finish compare', acceptance_ids: ['AC-IMPL'], estimated_complexity: 'medium' },
      { id: 'R2', description: 'run experiments', acceptance_ids: ['AC-EXP'], estimated_complexity: 'small', depends_on: ['R1'] }] }),
    acceptanceCoverage: coverage(),
  });
  assert.equal(split.ok, true);
  // Internal dep rewritten to the sibling id — never dangling.
  assert.deepEqual(split.tasks[1].dependencies, [split.tasks[0].id]);
  // Cycle inside split deps is rejected.
  const cyc = buildSplitTasks({ task: task(), report: report({ remaining_work: [
    { id: 'R1', description: 'a', acceptance_ids: ['AC-IMPL'], estimated_complexity: 'small', depends_on: ['R2'] },
    { id: 'R2', description: 'b', acceptance_ids: ['AC-EXP'], estimated_complexity: 'small', depends_on: ['R1'] }] }), acceptanceCoverage: coverage() });
  assert.equal(cyc.ok, false);
  assert.ok(cyc.errors.some(e => /cycle/.test(e)));
  // dep on a task outside {parent} ∪ siblings is rejected.
  const ghost = buildSplitTasks({ task: task(), report: report({ remaining_work: [
    { id: 'R1', description: 'a', acceptance_ids: ['AC-IMPL'], estimated_complexity: 'small', depends_on: ['W-GHOST'] },
    { id: 'R2', description: 'b', acceptance_ids: ['AC-EXP'], estimated_complexity: 'small' }] }), acceptanceCoverage: coverage() });
  assert.equal(ghost.ok, false);
});
