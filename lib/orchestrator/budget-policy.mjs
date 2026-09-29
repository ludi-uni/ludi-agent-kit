// Adaptive task budget policy (Phase 5, BOUNDED PURE): given a typed per-task
// budget and the evidence of one finished bounded run, emit ONE deterministic
// decision — extend | split | stop | continue — plus the next budget object.
// No orchestrator, runner, store, scheduling or model/provider calls. Inputs
// are never mutated; newBudget is always a fresh object (or null for legacy
// tasks). This module never changes a task's goal or acceptance criteria and
// never escalates a model/provider — it only sizes the execution envelope.
//
// Guard order (never yield to the extend path):
//   user_stop          -> stop, always.
//   destructive hints  -> stop (human review, mirrors execution-manager).
//   environment block  -> stop (cannot be fixed by more budget).
//   run budget out     -> stop (the PARENT's budget, not the task's).
//   completed          -> stop (nothing left to buy with budget).
//   repeated failure   -> stop (same signature / repeated tool failure).
//   no/stale progress  -> stop (a marker older than the window is not progress).
//   oversized residual -> split (>2 items, a 'large' item, or foreign artifact).
//   limit exhaustion   -> stop (extension count or absolute cap reached).
//   headroom           -> continue (used < current_limit, no extension needed).
//   otherwise          -> extend (bounded, capped, one resource at a time).
import { classifyTaskComplexity, initialTurnBudget, progressScore } from './turn-budget.mjs';
import { parseProgressReport, progressMetrics, destructiveAmbiguity } from './progress-contract.mjs';

// ---------------------------------------------------------------------------
// Public enums + caps

export const BUDGET_ACTIONS = Object.freeze(['extend', 'split', 'stop', 'continue']);

// Explicit safe caps. Extensions are a fixed small step, the recency window is
// small and measured, and only a small same-artifact residual may be extended.
export const BUDGET_CAPS = Object.freeze({
  extensionTurns: 16,          // +16 turns per granted extension
  extensionToolCalls: 12,      // +12 tool calls per granted extension
  progressWindowTurns: 4,      // last progress must be within 4 turns of used
  progressWindowToolCalls: 6,  // ...or within 6 tool calls of used
  maxRemainingForExtend: 2,    // 1-2 small/medium same-artifact items max
  defaultMaxExtensions: 2,     // extensions.count < 2 unless runtime overrides
});

// Action -> policy rule identifier, so callers can trace WHY an action fired.
export const BUDGET_POLICY_RULES = Object.freeze({
  EXTEND_HEALTHY_PROGRESS: 'budget.extend.healthy-progress',
  CONTINUE_HEADROOM: 'budget.continue.headroom',
  CONTINUE_LEGACY: 'budget.continue.legacy-no-budget',
  SPLIT_RESIDUAL: 'budget.split.residual-too-large',
  STOP_USER: 'budget.stop.user_stop',
  STOP_DESTRUCTIVE: 'budget.stop.destructive_ambiguity',
  STOP_ENVIRONMENT: 'budget.stop.environment_block',
  STOP_RUN_BUDGET: 'budget.stop.run-budget-exhausted',
  STOP_COMPLETED: 'budget.stop.completed',
  STOP_REPEATED_FAILURE: 'budget.stop.repeated-failure-signature',
  STOP_NO_PROGRESS: 'budget.stop.no-measured-progress',
  STOP_STALE: 'budget.stop.stale-progress',
  STOP_LIMITS: 'budget.stop.limits-exhausted',
});

const int = (v, d) => (Number.isInteger(v) && v >= 0 ? v : d);
const numOrNull = v => (Number.isFinite(v) ? v : null);
const clone = v => { try { return structuredClone(v); } catch { return v; } };

// ---------------------------------------------------------------------------
// Budget construction

const normalizeBudget = b => ({
  version: 1,
  complexity: b.complexity ?? null,
  role: b.role ?? null,
  turns: {
    initial: int(b.turns?.initial, 0),
    used: int(b.turns?.used, 0),
    current_limit: int(b.turns?.current_limit, int(b.turns?.initial, 0)),
    max_limit: Math.max(int(b.turns?.max_limit, int(b.turns?.initial, 0)), int(b.turns?.current_limit, int(b.turns?.initial, 0))),
  },
  tool_calls: {
    initial: int(b.tool_calls?.initial, 0),
    used: int(b.tool_calls?.used, 0),
    current_limit: int(b.tool_calls?.current_limit, int(b.tool_calls?.initial, 0)),
    max_limit: Math.max(int(b.tool_calls?.max_limit, int(b.tool_calls?.initial, 0)), int(b.tool_calls?.current_limit, int(b.tool_calls?.initial, 0))),
  },
  extensions: {
    count: int(b.extensions?.count, 0),
    max_count: int(b.extensions?.max_count, BUDGET_CAPS.defaultMaxExtensions),
  },
  continuation_depth: int(b.continuation_depth, 0),
  retry_count: int(b.retry_count, 0),
  reassignment_count: int(b.reassignment_count, 0),
});

/**
 * Create the typed budget for a task. The initial turn limit reuses the
 * existing role+complexity `initialTurnBudget` (same resolution the runner's
 * `limitsFor` applies); tool calls come from `agent_runtime.max_tool_calls`;
 * hard ceilings come from `absolute_max_turns` / `absolute_max_tool_calls`
 * (defaulting to the initial limit — no implicit growth). Returns the BUDGET
 * object only; attaching it to the task is the caller's job, and the input
 * task is never mutated.
 */
export function createTaskBudget(task, agentRuntime = {}) {
  const rt = agentRuntime ?? {};
  const complexity = classifyTaskComplexity(task);
  const role = task?.assignedAgent ?? task?.agent ?? 'default';
  const turnInitial = initialTurnBudget(rt, role, complexity);
  const toolInitial = int(rt.max_tool_calls, 40);
  return normalizeBudget({
    complexity,
    role,
    turns: {
      initial: turnInitial, used: 0, current_limit: turnInitial,
      max_limit: Math.max(turnInitial, int(rt.absolute_max_turns, turnInitial)),
    },
    tool_calls: {
      initial: toolInitial, used: 0, current_limit: toolInitial,
      max_limit: Math.max(toolInitial, int(rt.absolute_max_tool_calls, toolInitial)),
    },
    extensions: { count: 0, max_count: int(rt.max_extensions, BUDGET_CAPS.defaultMaxExtensions) },
    continuation_depth: int(task?.continuationIndex, 0),
    retry_count: int(task?.retryCount ?? task?.retries, 0),
    reassignment_count: int(task?.reassignmentCount ?? task?.reassignments, 0),
  });
}

const isBudget = b => Boolean(b && typeof b === 'object' && b.turns && b.tool_calls && b.extensions
  && Number.isFinite(b.turns.current_limit) && Number.isFinite(b.tool_calls.current_limit));

/**
 * Synthesize a budget for a legacy in-flight task that predates typed budgets.
 * Seeds used counts from the telemetry the runner already records
 * (turns/toolCalls/extensionsGranted/retries/reassignments) so guard decisions
 * compare like with like. If the task already carries a budget it is returned
 * unchanged — legacy tasks without one get a fresh budget; nothing is mutated.
 */
export function budgetForLegacy(task, agentRuntime = {}) {
  if (isBudget(task?.budget)) return task.budget;
  const t = task ?? {};
  const b = createTaskBudget(t, agentRuntime);
  return normalizeBudget({
    ...b,
    turns: { ...b.turns, used: int(t.turnsUsed ?? t.telemetry?.turns ?? t.child?.turns, 0) },
    tool_calls: { ...b.tool_calls, used: int(t.toolCallsUsed ?? t.telemetry?.toolCalls ?? t.child?.toolCalls, 0) },
    extensions: { ...b.extensions, count: int(t.extensionsGranted ?? t.child?.extensionsGranted, 0) },
    continuation_depth: int(t.continuationIndex ?? t.lineage?.continuationIndex, 0),
    retry_count: int(t.retryCount ?? t.retries, 0),
    reassignment_count: int(t.reassignmentCount ?? t.reassignments, 0),
  });
}

// ---------------------------------------------------------------------------
// Decision

/**
 * One deterministic budget decision for a finished bounded run.
 * @param {object} inputs
 *   task                  task row (read-only; goal/acceptance never touched)
 *   budget                typed budget from createTaskBudget/budgetForLegacy
 *                         (falls back to task.budget; absent => legacy continue)
 *   terminationReason     TERMINATION_REASONS value for the finished run
 *   progressMetrics       progressMetrics() output, optionally extended with
 *                         lastProgressTurn / lastProgressToolCall markers
 *   progressReport        validated (or raw) progress report object
 *   telemetry             runner telemetry ({turns, toolCalls, lastProgressTurn,
 *                         lastProgressToolCall, repeatedToolFailure, ...})
 *   priorFailureSignature signature of the PREVIOUS identical failure
 *   runBudget             parent-level remaining budget ({exhausted,
 *                         remainingMs, remainingInvocations}); can only stop
 * @returns {{eligible: boolean, action: 'extend'|'split'|'stop'|'continue',
 *   reason: string, policyRule: string, previousBudget: object|null,
 *   newBudget: object|null, progressSnapshot: object, remainingWorkSnapshot: object}}
 * `eligible` means "the run may proceed further" (extend|continue true,
 * stop|split false). newBudget is a fresh object only on 'extend'; on other
 * actions it is an unchanged clone of previousBudget (null for legacy).
 */
export function decideBudgetExtension(inputs = {}) {
  const task = inputs.task ?? null;
  const budget = inputs.budget ?? task?.budget ?? null;
  const termination = inputs.terminationReason ?? null;
  const telemetry = inputs.telemetry ?? null;

  let report = null, reportError = null;
  if (inputs.progressReport != null) {
    try { report = parseProgressReport(inputs.progressReport); }
    catch (e) { reportError = String(e.message ?? e).slice(0, 200); }
  }
  let metrics = inputs.progressMetrics ?? null;
  if (!metrics && report) {
    try { metrics = progressMetrics(report); } catch { metrics = null; }
  }

  // ---- shared snapshots ------------------------------------------------------
  const usedTurns = Math.max(int(budget?.turns?.used, 0), int(telemetry?.turns, 0));
  const usedToolCalls = Math.max(int(budget?.tool_calls?.used, 0), int(telemetry?.toolCalls, 0));
  const lastProgressTurn = numOrNull(metrics?.lastProgressTurn ?? telemetry?.lastProgressTurn);
  const lastProgressToolCall = numOrNull(metrics?.lastProgressToolCall ?? telemetry?.lastProgressToolCall);
  const signature = metrics?.repeatedFailureSignature ?? telemetry?.repeatedFailureSignature ?? telemetry?.failureSignature ?? null;
  const progressMade = Boolean(metrics?.progressMade)
    || (!metrics && telemetry ? progressScore(telemetry).meaningful : false);
  const measured = progressMade || lastProgressTurn != null || lastProgressToolCall != null;

  const items = Array.isArray(report?.remaining_work) ? report.remaining_work : [];
  const remainingCount = int(metrics?.remainingWorkCount, items.length);
  const hasLarge = items.some(w => w?.estimated_complexity === 'large');
  const foreignArtifact = task?.artifact_type
    ? items.some(w => w?.artifact_type && w.artifact_type !== task.artifact_type) : false;

  const progressSnapshot = {
    progressMade, measured,
    lastProgressMarker: metrics?.lastProgressMarker ?? null,
    lastProgressTurn, lastProgressToolCall,
    usedTurns, usedToolCalls,
    repeatedFailureSignature: signature,
    reportError,
  };
  const remainingWorkSnapshot = {
    count: remainingCount,
    ids: items.map(w => w?.id).filter(Boolean),
    complexities: [...new Set(items.map(w => w?.estimated_complexity).filter(Boolean))],
    hasLarge, sameArtifact: !foreignArtifact,
  };
  const done = (eligible, action, reason, policyRule, newBudget) => ({
    eligible, action, reason, policyRule,
    previousBudget: budget ?? null, newBudget,
    progressSnapshot, remainingWorkSnapshot,
  });
  const unchanged = () => (isBudget(budget) ? clone(budget) : null);

  // ---- legacy tasks: no typed budget -> unchanged -----------------------------
  if (!isBudget(budget)) {
    return done(true, 'continue', 'no typed budget attached; legacy task left unchanged for the existing runner policy', BUDGET_POLICY_RULES.CONTINUE_LEGACY, null);
  }

  // ---- hard guards -----------------------------------------------------------
  if (termination === 'user_stop') {
    return done(false, 'stop', 'user_stop: an explicit stop must never be extended automatically', BUDGET_POLICY_RULES.STOP_USER, unchanged());
  }
  if (report && destructiveAmbiguity(report)) {
    return done(false, 'stop', 'report hints at destructive/resetting actions; requires human review before any extension', BUDGET_POLICY_RULES.STOP_DESTRUCTIVE, unchanged());
  }
  if (termination === 'environment_block') {
    return done(false, 'stop', 'environment block must be resolved before more budget can help', BUDGET_POLICY_RULES.STOP_ENVIRONMENT, unchanged());
  }
  const rb = inputs.runBudget;
  if (rb && (rb.exhausted === true || rb.remainingMs <= 0 || rb.remainingInvocations <= 0)) {
    return done(false, 'stop', 'RUN_BUDGET_EXCEEDED: parent run extension cap reached; no task-level extension can be granted', BUDGET_POLICY_RULES.STOP_RUN_BUDGET, unchanged());
  }
  if (termination === 'completed' || report?.status === 'completed') {
    return done(false, 'stop', 'run completed; there is no remaining work a budget extension would buy', BUDGET_POLICY_RULES.STOP_COMPLETED, unchanged());
  }

  // ---- repeated failure --------------------------------------------------------
  const repeatedToolFailure = telemetry?.repeatedToolFailure === true || int(telemetry?.consecutiveToolFailures, 0) >= 2;
  if (inputs.priorFailureSignature && signature && signature === inputs.priorFailureSignature) {
    return done(false, 'stop', `identical failure signature "${signature}" already seen; extension would repeat the same stall`, BUDGET_POLICY_RULES.STOP_REPEATED_FAILURE, unchanged());
  }
  if (repeatedToolFailure) {
    return done(false, 'stop', 'repeated tool failure observed; more budget would repeat the same failure', BUDGET_POLICY_RULES.STOP_REPEATED_FAILURE, unchanged());
  }

  // ---- measured, recent progress -------------------------------------------------
  if (!measured || !progressMade || (lastProgressTurn == null && lastProgressToolCall == null)) {
    return done(false, 'stop', 'no recent measured progress marker; extending budget would fund a stall', BUDGET_POLICY_RULES.STOP_NO_PROGRESS, unchanged());
  }
  const staleTurns = lastProgressTurn != null && usedTurns - lastProgressTurn > BUDGET_CAPS.progressWindowTurns;
  const staleTools = lastProgressToolCall != null && usedToolCalls - lastProgressToolCall > BUDGET_CAPS.progressWindowToolCalls;
  if (staleTurns || staleTools) {
    return done(false, 'stop', `last measured progress is outside the recency window (${BUDGET_CAPS.progressWindowTurns} turns / ${BUDGET_CAPS.progressWindowToolCalls} tool calls); progress is ancient, not healthy`, BUDGET_POLICY_RULES.STOP_STALE, unchanged());
  }

  // ---- residual too big for a bounded extension -> split ---------------------------
  if (inputs.failureClassification === 'task_too_large' || remainingCount > BUDGET_CAPS.maxRemainingForExtend || hasLarge || foreignArtifact) {
    const why = inputs.failureClassification === 'task_too_large' ? 'task is classified as task_too_large'
      : hasLarge ? 'a remaining item is "large"'
      : foreignArtifact ? 'remaining work spans a different artifact type'
      : `${remainingCount} remaining items exceed the bounded-extension maximum of ${BUDGET_CAPS.maxRemainingForExtend}`;
    return done(false, 'split', `${why}; the residual is multi-responsibility work that needs focused tasks, not a bigger envelope`, BUDGET_POLICY_RULES.SPLIT_RESIDUAL, unchanged());
  }

  // ---- headroom: no limit was hit ---------------------------------------------------
  const turnHit = termination === 'turn_limit';
  const toolHit = termination === 'tool_limit';
  if (!remainingCount) return done(false, 'stop', 'no remaining work to justify extension', BUDGET_POLICY_RULES.STOP_COMPLETED, unchanged());
  if (!turnHit && !toolHit) {
    return done(true, 'continue', `progress is healthy and no limit was reached (turns ${usedTurns}/${budget.turns.current_limit}, tools ${usedToolCalls}/${budget.tool_calls.current_limit}); keep running within the current budget`, BUDGET_POLICY_RULES.CONTINUE_HEADROOM, unchanged());
  }

  // ---- bounded extension -------------------------------------------------------------
  const res = termination === 'tool_limit' ? 'tool_calls' : turnHit ? 'turns' : 'tool_calls';
  const other = budget[res === 'turns' ? 'tool_calls' : 'turns'];
  const otherUsed = res === 'turns' ? usedToolCalls : usedTurns;
  if (otherUsed >= other.current_limit) {
    return done(false, 'stop', 'the other budget dimension is already exhausted; a one-axis extension cannot safely resume work', BUDGET_POLICY_RULES.STOP_LIMITS, unchanged());
  }
  const r = budget[res];
  if (budget.extensions.count >= budget.extensions.max_count) {
    return done(false, 'stop', `extension count ${budget.extensions.count} reached max_count=${budget.extensions.max_count}; bounded budget is exhausted`, BUDGET_POLICY_RULES.STOP_LIMITS, unchanged());
  }
  if (r.current_limit >= r.max_limit) {
    return done(false, 'stop', `${res} already at absolute cap ${r.current_limit}/${r.max_limit}; no growth is permitted`, BUDGET_POLICY_RULES.STOP_LIMITS, unchanged());
  }
  const step = res === 'turns' ? BUDGET_CAPS.extensionTurns : BUDGET_CAPS.extensionToolCalls;
  const newLimit = Math.min(r.current_limit + step, r.max_limit);
  const next = clone(budget);
  next.turns = { ...next.turns, used: usedTurns };
  next.tool_calls = { ...next.tool_calls, used: usedToolCalls };
  next[res] = { ...next[res], current_limit: newLimit };
  next.extensions = { ...next.extensions, count: next.extensions.count + 1 };
  return done(true, 'extend', `healthy recent progress at the ${res} limit with a bounded same-artifact residual; grant +${step} ${res} capped at the absolute maximum (${r.current_limit} -> ${newLimit})`, BUDGET_POLICY_RULES.EXTEND_HEALTHY_PROGRESS, next);
}
