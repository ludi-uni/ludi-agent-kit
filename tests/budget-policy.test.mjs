// Adaptive task budget policy (Phase 5, BOUNDED PURE): typed budget creation,
// legacy fallback, and the deterministic extend | split | stop | continue
// decision — including user regressions A-F.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTaskBudget, budgetForLegacy, decideBudgetExtension,
  BUDGET_ACTIONS, BUDGET_CAPS, BUDGET_POLICY_RULES,
} from '../lib/orchestrator/budget-policy.mjs';

// Runtime mirroring the default policy's bounded-extension knobs but with a
// 32-turn initial budget so the 32->48 regression exercises the absolute cap.
const RT = {
  max_turns: 32, max_tool_calls: 40,
  absolute_max_turns: 48, absolute_max_tool_calls: 80,
  max_extensions: 2,
};

// Runtime mirroring the role+complexity turn_budgets table used by the runner.
const RT_ROLE = {
  max_turns: 12, max_tool_calls: 40, absolute_max_turns: 48, absolute_max_tool_calls: 80,
  extension_turns: 8, max_extensions: 3,
  turn_budgets: {
    default: { simple: 12, normal: 16, heavy: 20, 'repo-history-heavy': 24 },
    coder:   { simple: 16, normal: 20, heavy: 24, 'repo-history-heavy': 24 },
  },
};

const TASK = {
  id: 'T1', title: 'bounded task', goal: 'edit lib/x.mjs', kind: 'implement',
  assignedAgent: 'coder', artifact_type: 'code_change', acceptanceIds: ['A1'],
};

/** Validated-shape progress report with N small remaining items. */
const reportWith = items => ({
  task_id: 'T1', status: 'partial', termination_reason: 'turn_limit',
  completed_acceptance: [], completed_steps: ['edited lib/x.mjs'],
  remaining_work: items.map((w, i) => ({
    id: w.id ?? `rw${i + 1}`, description: w.description ?? `remaining item ${i + 1}`,
    acceptance_ids: w.acceptance_ids ?? ['A1'],
    estimated_complexity: w.estimated_complexity ?? 'small',
    ...(w.artifact_type ? { artifact_type: w.artifact_type } : {}),
  })),
  blocked_work: [], files_touched: ['lib/x.mjs'], tests_run: [],
  artifacts: [], environment_constraints: [], handoff_notes: [],
});

const healthyMetrics = over => ({
  progressMade: true, lastProgressMarker: 'edited lib/x.mjs',
  completedWorkCount: 1, remainingWorkCount: 2,
  lastProgressTurn: 30, lastProgressToolCall: 38,
  repeatedFailureSignature: null, ...over,
});

// ---------- createTaskBudget --------------------------------------------------

test('createTaskBudget: typed shape seeded from runtime limits', () => {
  const b = createTaskBudget(TASK, RT);
  assert.equal(b.version, 1);
  assert.deepEqual(b.turns, { initial: 32, used: 0, current_limit: 32, max_limit: 48 });
  assert.deepEqual(b.tool_calls, { initial: 40, used: 0, current_limit: 40, max_limit: 80 });
  assert.deepEqual(b.extensions, { count: 0, max_count: 2 });
  assert.equal(b.continuation_depth, 0);
  assert.equal(b.retry_count, 0);
  assert.equal(b.reassignment_count, 0);
});

test('createTaskBudget: role+complexity uses existing initialTurnBudget resolution', () => {
  const heavy = { ...TASK, goal: 'survey across the whole repo and integrate multiple modules' };
  const b = createTaskBudget(heavy, RT_ROLE);
  assert.equal(b.complexity, 'heavy');
  assert.equal(b.turns.initial, 24); // turn_budgets.coder.heavy
  assert.equal(b.turns.current_limit, 24);
  assert.equal(b.turns.max_limit, 48); // absolute_max_turns
});

test('createTaskBudget never mutates the task and counters are seeded', () => {
  const task = { ...TASK, continuationIndex: 1, retryCount: 1, reassignmentCount: 1 };
  const before = JSON.stringify(task);
  const b = createTaskBudget(task, RT);
  assert.equal(b.continuation_depth, 1);
  assert.equal(b.retry_count, 1);
  assert.equal(b.reassignment_count, 1);
  assert.equal(JSON.stringify(task), before);
});

// ---------- budgetForLegacy ---------------------------------------------------

test('budgetForLegacy: no budget -> synthesized with recorded telemetry', () => {
  const t = { ...TASK, telemetry: { turns: 10, toolCalls: 12 }, child: { extensionsGranted: 1 } };
  const b = budgetForLegacy(t, RT);
  assert.equal(b.turns.used, 10);
  assert.equal(b.tool_calls.used, 12);
  assert.equal(b.extensions.count, 1);
});

test('budgetForLegacy: existing budget returned unchanged', () => {
  const existing = createTaskBudget(TASK, RT);
  const t = { ...TASK, budget: existing };
  assert.equal(budgetForLegacy(t, RT), existing);
});

test('decideBudgetExtension: legacy task without budget continues unchanged', () => {
  const out = decideBudgetExtension({ task: { ...TASK }, terminationReason: 'turn_limit' });
  assert.equal(out.action, 'continue');
  assert.equal(out.policyRule, BUDGET_POLICY_RULES.CONTINUE_LEGACY);
  assert.equal(out.previousBudget, null);
  assert.equal(out.newBudget, null);
});

// ---------- hard guards --------------------------------------------------------

test('guards: user_stop / destructive / environment / run budget never extend', () => {
  const budget = createTaskBudget(TASK, RT);
  const base = { task: TASK, budget, progressMetrics: healthyMetrics() };
  const stop = (over) => {
    const o = decideBudgetExtension({ ...base, ...over });
    assert.equal(o.action, 'stop');
    assert.equal(o.eligible, false);
    assert.deepEqual(o.newBudget, o.previousBudget);
    return o;
  };
  assert.equal(stop({ terminationReason: 'user_stop' }).policyRule, BUDGET_POLICY_RULES.STOP_USER);
  assert.equal(stop({ terminationReason: 'environment_block' }).policyRule, BUDGET_POLICY_RULES.STOP_ENVIRONMENT);
  assert.equal(stop({ terminationReason: 'turn_limit', runBudget: { exhausted: true } }).policyRule, BUDGET_POLICY_RULES.STOP_RUN_BUDGET);
  const destructive = reportWith([{}]);
  destructive.handoff_notes = ['considered git reset --hard to start over'];
  assert.equal(stop({ terminationReason: 'turn_limit', progressReport: destructive }).policyRule, BUDGET_POLICY_RULES.STOP_DESTRUCTIVE);
  assert.equal(stop({ terminationReason: 'completed', progressReport: { ...reportWith([]), status: 'completed', termination_reason: 'completed' } }).policyRule, BUDGET_POLICY_RULES.STOP_COMPLETED);
});

// ---------- regression A-F -----------------------------------------------------

test('regression A: 32 -> 48 turns on healthy recent progress', () => {
  const budget = createTaskBudget(TASK, RT);
  budget.turns.used = 32;
  const out = decideBudgetExtension({
    task: TASK, budget, terminationReason: 'turn_limit',
    progressReport: reportWith([{}, {}]),
    progressMetrics: healthyMetrics({ lastProgressTurn: 30, remainingWorkCount: 2 }),
    telemetry: { turns: 32, toolCalls: 38 },
  });
  assert.equal(out.action, 'extend');
  assert.equal(out.eligible, true);
  assert.equal(out.policyRule, BUDGET_POLICY_RULES.EXTEND_HEALTHY_PROGRESS);
  assert.equal(out.newBudget.turns.current_limit, 48);        // +16 capped at absolute_max_turns
  assert.equal(out.newBudget.turns.max_limit, 48);
  assert.equal(out.newBudget.extensions.count, 1);
  assert.equal(out.newBudget.turns.used, 32);                 // fresh snapshot, not mutation
  assert.equal(out.previousBudget.turns.current_limit, 32);   // input untouched
});

test('a turn-only extension cannot bypass an exhausted tool-call cap', () => {
  const budget = createTaskBudget(TASK, RT);
  budget.turns.used = 32;
  budget.tool_calls.used = 40;
  const out = decideBudgetExtension({ task: TASK, budget, terminationReason: 'turn_limit',
    progressReport: reportWith([{}]), progressMetrics: healthyMetrics({ lastProgressTurn: 31 }),
    telemetry: { turns: 32, toolCalls: 40 } });
  assert.equal(out.action, 'stop');
  assert.equal(out.policyRule, BUDGET_POLICY_RULES.STOP_LIMITS);
});

test('regression B: stale progress marker (turn 10 of 48 used) stops', () => {
  const budget = createTaskBudget(TASK, RT);
  budget.turns.used = 48; budget.turns.current_limit = 48;
  const out = decideBudgetExtension({
    task: TASK, budget, terminationReason: 'turn_limit',
    progressReport: reportWith([{}]),
    progressMetrics: healthyMetrics({ lastProgressTurn: 10, lastProgressToolCall: 10, remainingWorkCount: 1 }),
    telemetry: { turns: 48, toolCalls: 40 },
  });
  assert.equal(out.action, 'stop');
  assert.equal(out.policyRule, BUDGET_POLICY_RULES.STOP_STALE);
  assert.equal(out.newBudget.turns.current_limit, 48);
});

test('regression C: 5 independent remaining items -> split, no extension', () => {
  const budget = createTaskBudget(TASK, RT);
  budget.turns.used = 32;
  const out = decideBudgetExtension({
    task: TASK, budget, terminationReason: 'turn_limit',
    progressReport: reportWith([{}, {}, {}, {}, {}]),
    progressMetrics: healthyMetrics({ lastProgressTurn: 30, remainingWorkCount: 5 }),
    telemetry: { turns: 32 },
  });
  assert.equal(out.action, 'split');
  assert.equal(out.eligible, false);
  assert.equal(out.policyRule, BUDGET_POLICY_RULES.SPLIT_RESIDUAL);
  assert.equal(out.remainingWorkSnapshot.count, 5);
  assert.equal(out.newBudget.turns.current_limit, 32); // unchanged
});

test('regression D: extensions exhausted -> stop at the limit', () => {
  const budget = createTaskBudget(TASK, RT);
  budget.turns.used = 40; budget.turns.current_limit = 40;
  budget.extensions.count = 2; // max_count 2
  const out = decideBudgetExtension({
    task: TASK, budget, terminationReason: 'turn_limit',
    progressReport: reportWith([{}]),
    progressMetrics: healthyMetrics({ lastProgressTurn: 39, remainingWorkCount: 1 }),
    telemetry: { turns: 40 },
  });
  assert.equal(out.action, 'stop');
  assert.equal(out.policyRule, BUDGET_POLICY_RULES.STOP_LIMITS);
  // And with headroom left, exhaustion is irrelevant -> continue.
  const headroom = decideBudgetExtension({
    task: TASK, budget: { ...budget, turns: { ...budget.turns, used: 20 } }, terminationReason: 'unknown',
    progressReport: reportWith([{}]),
    progressMetrics: healthyMetrics({ lastProgressTurn: 19, remainingWorkCount: 1 }),
    telemetry: { turns: 20 },
  });
  assert.equal(headroom.action, 'continue');
  assert.equal(headroom.policyRule, BUDGET_POLICY_RULES.CONTINUE_HEADROOM);
});

test('regression E: repeated tool failure -> stop', () => {
  const budget = createTaskBudget(TASK, RT);
  budget.turns.used = 32;
  const byFlag = decideBudgetExtension({
    task: TASK, budget, terminationReason: 'turn_limit',
    progressReport: reportWith([{}]),
    progressMetrics: healthyMetrics({ lastProgressTurn: 30, remainingWorkCount: 1 }),
    telemetry: { turns: 32, repeatedToolFailure: true },
  });
  assert.equal(byFlag.action, 'stop');
  assert.equal(byFlag.policyRule, BUDGET_POLICY_RULES.STOP_REPEATED_FAILURE);
  const bySignature = decideBudgetExtension({
    task: TASK, budget, terminationReason: 'turn_limit',
    progressReport: reportWith([{}]),
    progressMetrics: healthyMetrics({ lastProgressTurn: 30, remainingWorkCount: 1, repeatedFailureSignature: 'fail:npm test' }),
    telemetry: { turns: 32 },
    priorFailureSignature: 'fail:npm test',
  });
  assert.equal(bySignature.action, 'stop');
  assert.equal(bySignature.policyRule, BUDGET_POLICY_RULES.STOP_REPEATED_FAILURE);
});

test('regression F: turn 44/48 at current limit extends to the absolute cap', () => {
  const budget = createTaskBudget(TASK, RT);
  budget.turns.used = 44; budget.turns.current_limit = 44; budget.turns.max_limit = 48;
  budget.extensions.count = 1;
  const out = decideBudgetExtension({
    task: TASK, budget, terminationReason: 'turn_limit',
    progressReport: reportWith([{}]),
    progressMetrics: healthyMetrics({ lastProgressTurn: 43, remainingWorkCount: 1 }),
    telemetry: { turns: 44 },
  });
  assert.equal(out.action, 'extend');
  assert.equal(out.newBudget.turns.current_limit, 48); // +16 requested, capped at 48
  assert.equal(out.newBudget.extensions.count, 2);
});

test('regression G: healthy tool-limit hit extends tool calls by the bounded step', () => {
  const budget = createTaskBudget(TASK, RT);
  budget.tool_calls.used = 40;
  const out = decideBudgetExtension({
    task: TASK, budget, terminationReason: 'tool_limit',
    progressReport: reportWith([{}]),
    progressMetrics: healthyMetrics({ lastProgressToolCall: 39, remainingWorkCount: 1 }),
    telemetry: { turns: 10, toolCalls: 40 },
  });
  assert.equal(out.action, 'extend');
  assert.equal(out.newBudget.tool_calls.current_limit, 52); // +12
  assert.equal(out.newBudget.tool_calls.max_limit, 80);
  assert.equal(out.newBudget.extensions.count, 1);
});

// ---------- additional pure-policy guarantees ----------------------------------

test('no measured progress -> stop, never extend', () => {
  const budget = createTaskBudget(TASK, RT);
  budget.turns.used = 32;
  const out = decideBudgetExtension({
    task: TASK, budget, terminationReason: 'turn_limit',
    progressMetrics: { progressMade: false, remainingWorkCount: 1, lastProgressTurn: null, lastProgressToolCall: null },
    telemetry: { turns: 32, toolCalls: 0 },
  });
  assert.equal(out.action, 'stop');
  assert.equal(out.policyRule, BUDGET_POLICY_RULES.STOP_NO_PROGRESS);
});

test('already at the absolute cap with headroom left -> continue, not extend', () => {
  const budget = createTaskBudget(TASK, RT);
  budget.turns.used = 20;
  const out = decideBudgetExtension({
    task: TASK, budget, terminationReason: 'unknown',
    progressReport: reportWith([{}]),
    progressMetrics: healthyMetrics({ lastProgressTurn: 19, remainingWorkCount: 1 }),
    telemetry: { turns: 20 },
  });
  assert.equal(out.action, 'continue');
  assert.equal(out.newBudget.turns.current_limit, 32); // unchanged
});

test('a large remaining item or foreign artifact forces split over extend', () => {
  const budget = createTaskBudget(TASK, RT);
  budget.turns.used = 32;
  for (const [label, items] of [
    ['large', [{ estimated_complexity: 'large' }]],
    ['foreign artifact', [{ estimated_complexity: 'small', artifact_type: 'documentation' }]],
  ]) {
    const out = decideBudgetExtension({
      task: TASK, budget, terminationReason: 'turn_limit',
      progressReport: reportWith(items),
      progressMetrics: healthyMetrics({ lastProgressTurn: 30, remainingWorkCount: 1 }),
      telemetry: { turns: 32 },
    });
    assert.equal(out.action, 'split', label);
    assert.equal(out.policyRule, BUDGET_POLICY_RULES.SPLIT_RESIDUAL);
  }
});

test('exported enums and caps stay explicit', () => {
  assert.deepEqual([...BUDGET_ACTIONS].sort(), ['continue', 'extend', 'split', 'stop']);
  assert.equal(BUDGET_CAPS.extensionTurns, 16);
  assert.equal(BUDGET_CAPS.extensionToolCalls, 12);
  assert.equal(BUDGET_CAPS.progressWindowTurns, 4);
  assert.equal(BUDGET_CAPS.progressWindowToolCalls, 6);
  assert.equal(BUDGET_CAPS.maxRemainingForExtend, 2);
});
