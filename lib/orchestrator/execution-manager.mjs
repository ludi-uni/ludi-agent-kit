// Execution manager (Phase 4, BOUNDED PURE): after a bounded task run ends, one
// deterministic decision — complete | extend | continue | split | reassign | retry | escalate | approval_required | stop.
// No orchestrator, runner, store, scheduling or model/provider calls. It never
// executes, persists or mutates: inputs are snapshotted, outcomes are data.
//
// Priority: hard guards, then evidenced complete; measured bounded extend before continue/split, then reassign > retry > stop.
// Hard guards (checked before every action) never yield to priority:
//   user_stop          -> stop, always.
//   destructive hints  -> stop (human review required, never auto-delegated).
//   environment limits -> stop (they can only stop, never justify continue).
//   no_progress        -> never continue/retry/split.
//   decision limits    -> a candidate action that exceeds a limit is skipped
//                         (dropped to the next action), it is never silently
//                         executed; retry is additionally suppressed when the
//                         identical failure signature already retried.
import { parseProgressReport, progressMetrics, destructiveAmbiguity, classifyTermination, classifyContinuation, PROGRESS_CODES } from './progress-contract.mjs';
import { COMPLEXITIES } from './planning-contract.mjs';
import { ARTIFACT_TYPES, findCycle } from './task-store.mjs';
import { ROLE_AGENTS, ARTIFACT_AGENTS } from './adaptive-planner.mjs';
import { classifyBackendFailure } from './health.mjs';
import { decideBudgetExtension } from './budget-policy.mjs';
import { decideRouteEscalation } from './route-escalation.mjs';

// ---------------------------------------------------------------------------
// Public enums

export const DECISION_ACTIONS = Object.freeze(['complete', 'extend', 'continue', 'split', 'reassign', 'retry', 'escalate', 'approval_required', 'stop']);

/** Phase 6: add an explicit route decision only after cheaper Phase 4/5 actions. */
export function decideExecutionEscalation(baseDecision, inputs = {}) {
  const routeDecision = decideRouteEscalation({ ...inputs, baseDecision });
  return routeDecision.action === 'none' ? baseDecision
    : { ...baseDecision, ...routeDecision, source_task_id: inputs.task?.id ?? baseDecision.source_task_id };
}

export const FAILURE_CLASSES = Object.freeze([
  'transient_error', 'environment_limitation', 'task_too_large', 'agent_capability_mismatch',
  'implementation_defect', 'test_failure', 'no_progress', 'invalid_output',
  'external_blocker', 'requirement_ambiguity', 'unknown',
]);

export const DECISION_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  ...PROGRESS_CODES,
});

// Action -> policy rule identifier, so callers can trace WHY an action fired.
export const POLICY_RULES = Object.freeze({
  COMPLETE_EVIDENCED: 'complete.evidenced-acceptance',
  STOP_USER: 'guard.user_stop',
  STOP_DESTRUCTIVE: 'guard.destructive_ambiguity',
  STOP_ENVIRONMENT: 'guard.environment_limitation',
  STOP_NO_PROGRESS: 'guard.no_progress',
  STOP_LIMITS: 'guard.decision_limits',
  STOP_NO_ACTION: 'stop.no-actionable-path',
  CONTINUE_PARTIAL: 'continue.partial-progress',
  SPLIT_REMAINING_WORK: 'split.explicit-remaining-work',
  REASSIGN_MISMATCH: 'reassign.role-mismatch',
  RETRY_TRANSIENT: 'retry.transient-signature',
  ESCALATE_BOUNDED: 'escalate.bounded-free-route',
  ESCALATE_APPROVAL: 'escalate.approval-required',
});

// Retry is ONLY for transient/process problems: socket drops, provider limits,
// crashed child processes. Never for project defects, scope or no-progress.
const RETRYABLE_CLASSES = new Set(['transient_error']);
const TRANSIENT_PATTERN = /\b(UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang ?up|remote side (closed|disconnected)|connection (reset|refused|aborted|closed)|fetch failed|terminated)\b|rate limit|too many requests|temporarily unavailable|service unavailable|overloaded|retry after|spawn .+ (exited|failed)/i;
const ENV_PATTERN = /\b(shell allowlist|tool allowlist|shell restriction|usage limit has been reached|insufficient_quota|missing (tool|binary|dependency|package|command)|not installed|command not found|permission denied|EACCES|ENOSPC|no space|sandbox|network (is )?unreachable|offline)\b/i;
const CAPABILITY_MISMATCH_PATTERN = /\b(cannot (write|edit|modify)|not permitted|permission (is )?denied|capabilit\w+ mismatch|wrong (agent|role)|out of (my |the )?role|outside (my )?(role|scope)|requires? (a |an )?(different|other) (agent|role)|should be (a |an )?(tester|investigator|auditor|reviewer)|cannot run tests?)\b/i;
const AMBIGUITY_PATTERN = /\b(ambiguous|unclear requirement|contradictory|conflicting requirement|needs? clarification|cannot determine|undecidable)\b/i;
const EXTERNAL_PATTERN = /\b(external (service|dependency|api|blocker)|upstream (service|api)|third[- ]party|blocked by (an? )?external)\b/i;

export const DEFAULT_LIMITS = Object.freeze({ maxRetries: 2, maxReassignments: 2, maxSplitTasks: 8, maxSplitDepth: 1 });
// Bounded input snapshot sizes: the decision must never pin unbounded report text.
const SNAP = { acceptance: 64, history: 16, deps: 64, signature: 400, notes: 200 };

// ---------------------------------------------------------------------------
// Failure classification

const haystack = (...parts) => parts.filter(Boolean).join('\n');

/**
 * Deterministic failure classification for a finished run. Signal order:
 *   explicit blocked_work classifications > termination/run evidence >
 *   progress metrics > free-text probes > unknown.
 * `failureSignature` is a STABLE identity for suppression: free-text wording is
 * excluded so the same failure across differently worded reports collides.
 * Returns { class, signature, evidence[] } — never throws.
 */
export function classifyExecutionFailure(inputs = {}) {
  const { task = null, run = null, terminationReason = null, progressReport = null, progressMetrics: metricsIn = null } = inputs;
  if (!run && !progressReport && !terminationReason && !metricsIn) {
    return { class: 'unknown', signature: 'unknown', evidence: ['no run/report evidence supplied'] };
  }
  const evidence = [];
  const parts = { commands: new Set(), blocked: new Set() };
  let report = null;
  if (progressReport != null) {
    try { report = parseProgressReport(progressReport); }
    catch (e) { evidence.push(`invalid_report:${String(e.message ?? e).slice(0, 120)}`); }
  }
  const metrics = metricsIn ?? (report ? progressMetrics(report) : null);
  const reason = terminationReason ?? classifyTermination(run, report);
  const runText = haystack(run?.error, run?.result?.status === 'completed' ? '' : run?.result?.summary);
  const reportText = report ? haystack(
    ...report.blocked_work.flatMap(b => [b.description, b.reason]),
    ...report.environment_constraints, ...report.handoff_notes) : '';
  const allText = haystack(runText, reportText);

  // Explicit blocked classifications first — the worker already diagnosed it.
  for (const b of report?.blocked_work ?? []) {
    parts.blocked.add(b.classification);
  }
  for (const t of report?.tests_run ?? []) {
    if (t.result !== 'pass' && t.result !== 'skipped') parts.commands.add(t.command);
  }

  const blocked = new Set(report?.blocked_work.map(b => b.classification) ?? []);
  const has = cls => {
    if (blocked.has(cls)) { evidence.push(`blocked_work:${cls}`); return true; }
    return false;
  };

  let cls = null;
  if (run?.evaluatorReasonCodes?.includes('MISSING_REQUIRED_CODE_CHANGE')) { cls = 'implementation_defect'; evidence.push('evaluator:MISSING_REQUIRED_CODE_CHANGE'); }
  else if (run?.evaluatorReasonCodes?.includes('CONTRADICTORY_EVIDENCE')) { cls = 'test_failure'; evidence.push('evaluator:CONTRADICTORY_EVIDENCE'); }
  else if (has('environment_limitation')) cls = 'environment_limitation';
  else if (has('external_blocker')) cls = 'external_blocker';
  else if (has('requirement_ambiguity')) cls = 'requirement_ambiguity';
  else if (has('test_failure') || parts.commands.size) { cls = 'test_failure'; evidence.push(...[...parts.commands].map(c => `failed_test:${c}`)); }
  else if (has('insufficient_evidence') || has('project_defect')) cls = 'implementation_defect';
  else if (reason === 'user_stop' || run?.abort) { cls = 'unknown'; evidence.push('user_stop'); }
  else if (report?.status === 'blocked' && metrics && !metrics.progressMade) { cls = 'no_progress'; evidence.push('blocked_without_progress'); }
  else if (reason === 'validation_failure' || run?.failureClass === 'MALFORMED_RESULT' || run?.failureClass === 'EMPTY_RESPONSE') {
    cls = 'invalid_output'; evidence.push(`termination:${reason}`);
  } else if (reason === 'environment_block' || run?.gate || ENV_PATTERN.test(allText)) {
    cls = 'environment_limitation'; evidence.push(`termination:${reason}`);
  } else if (reason === 'process_error' || reason === 'turn_limit' || reason === 'tool_limit'
    || TRANSIENT_PATTERN.test(allText) || classifyBackendFailure(runText)) {
    // Socket drops, provider limits, crashed/limited child processes. A turn_limit
    // WITH progress is a size problem handled by continue/split, not a defect; a
    // turn_limit with NO progress is a stall, which is never transient.
    if (reason === 'turn_limit' && metrics) {
      if (metrics.progressMade && metrics.remainingWorkCount) { cls = 'task_too_large'; evidence.push('turn_limit_with_remaining_work'); }
      else if (!metrics.progressMade) { cls = 'no_progress'; evidence.push('turn_limit_without_progress'); }
      else { cls = 'transient_error'; evidence.push(`termination:${reason}`); }
    } else {
      cls = 'transient_error'; evidence.push(`termination:${reason}`);
    }
  } else if (report?.status === 'failed' || run?.ok === false) {
    if (AMBIGUITY_PATTERN.test(allText)) { cls = 'requirement_ambiguity'; evidence.push('ambiguous wording'); }
    else if (EXTERNAL_PATTERN.test(allText)) { cls = 'external_blocker'; evidence.push('external blocker wording'); }
    else if (CAPABILITY_MISMATCH_PATTERN.test(allText)) { cls = 'agent_capability_mismatch'; evidence.push('capability mismatch wording'); }
    else { cls = 'implementation_defect'; evidence.push(`status:${report?.status ?? 'run-failed'}`); }
  } else if (report?.status === 'blocked') {
    cls = 'external_blocker'; evidence.push('blocked without explicit class');
  }
  if (!cls && metrics && !metrics.progressMade && run && !run.ok) { cls = 'no_progress'; evidence.push('failed without progress'); }
  cls ??= 'unknown';

  // Stable signature: class + structured failure ids only. Prose is stripped.
  const signature = [cls, ...parts.blocked, ...parts.commands].sort().join('|').slice(0, SNAP.signature) || cls;
  return { class: cls, signature, evidence };
}

// ---------------------------------------------------------------------------
// Split builder / validator

const validId = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s);

/**
 * Split = emit 2+ focused child tasks from the report's EXPLICIT remaining_work
 * entries. Nothing is invented: an entry needs its own acceptance ids (or an
 * explicit artifact/role override) to become an independent task; a single
 * undifferentiated remainder is continuation work, not a split.
 *
 * Returned shape per child: {id,title,goal,assignedAgent,capability? null,
 * dependencies,acceptance,acceptanceIds,artifact_type,kind,sourceTaskId}.
 * Validation rejects unknown acceptance ids, cycles, a giant re-clone of the
 * parent, and any dependency on a task outside {parent} ∪ siblings.
 */
export function buildSplitTasks({ task, report, acceptanceCoverage = {}, counters = {} } = {}) {
  const errors = [];
  const fail = errs => ({ ok: false, code: DECISION_CODES.INVALID_RESIDUAL_INPUT, tasks: [], errors: errs });
  if (!task || typeof task !== 'object' || !validId(task.id)) return fail(['INVALID_INPUT: task with a valid id is required']);
  const known = new Set(task.acceptanceIds ?? []);
  const items = (report?.remaining_work ?? []).filter(w => w && typeof w === 'object');
  const independent = items.filter(w => validId(w.id) && typeof w.description === 'string' && w.description.trim()
    && COMPLEXITIES.includes(w.estimated_complexity) && w.estimated_complexity !== 'large'
    && (w.acceptance_ids?.length || w.artifact_type || w.recommended_role));
  if (items.some(w => w.estimated_complexity === 'large')) return fail(['SPLIT_INVALID: a large remaining item needs re-planning, not execution splitting']);
  if (items.length !== independent.length) return fail(['SPLIT_INVALID: every remaining item must be valid and independently scoped']);
  if (new Set(items.map(w => w.id)).size !== items.length) return fail(['SPLIT_INVALID: duplicate remaining work id']);
  if (independent.length < 2) return fail(['SPLIT_NOT_APPLICABLE: fewer than two independent remaining_work items']);

  // Coverage may be a {id: {status}} map or a ledger-like [{id,status}] array.
  const rows = Array.isArray(acceptanceCoverage) ? acceptanceCoverage : Object.entries(acceptanceCoverage ?? {}).map(([id, c]) => ({ id, ...(typeof c === 'object' ? c : { status: c }) }));
  const unsatisfied = id => (rows.find(r => r.id === id)?.status ?? 'pending') !== 'satisfied';
  const pendingParent = [...known].filter(unsatisfied);
  const unknown = independent.flatMap(w => (w.acceptance_ids ?? []).filter(id => !known.has(id)).map(id => `SPLIT_INVALID: remaining_work "${w.id}" references unknown acceptance id "${id}"`));
  if (unknown.length) return fail(unknown);

  // Coverage: every unsatisfied parent acceptance id must be claimed by >=1 child.
  const claimed = new Set(independent.flatMap(w => w.acceptance_ids ?? []));
  const uncovered = pendingParent.filter(id => !claimed.has(id));
  if (uncovered.length) return fail([`SPLIT_UNCOVERED_ACCEPTANCE: ${uncovered.join(', ')} not claimed by any remaining_work item`]);

  const depth = counters.splitDepth ?? task.splitDepth ?? 0;
  const children = independent.map((w, i) => {
    const artifactType = w.artifact_type ?? task.artifact_type ?? 'code_change';
    const role = w.recommended_role ?? task.recommendedRole;
    let agent = w.assignedAgent ?? null;
    if (!agent && role) {
      if (ROLE_AGENTS[role] === undefined) errors.push(`SPLIT_INVALID: remaining_work "${w.id}" has unknown recommended_role "${role}"`);
      else agent = ROLE_AGENTS[role];
    }
    if (role && ROLE_AGENTS[role] && ARTIFACT_AGENTS[artifactType] && ROLE_AGENTS[role] !== ARTIFACT_AGENTS[artifactType]) {
      errors.push(`SPLIT_INVALID: role/artifact mismatch for "${w.id}"`);
    }
    if (!agent) {
      if (ARTIFACT_AGENTS[artifactType] === undefined) errors.push(`SPLIT_INVALID: remaining_work "${w.id}" has unmapped artifact_type "${artifactType}"`);
      else agent = ARTIFACT_AGENTS[artifactType];
    }
    // Unknown acceptance ids are rejected, never silently dropped from the spec.
    for (const id of w.acceptance_ids ?? []) if (!known.has(id)) errors.push(`SPLIT_INVALID: remaining_work "${w.id}" references unknown acceptance id "${id}"`);
    const ids = (w.acceptance_ids ?? []).filter(id => known.has(id));
    return {
      id: `${task.id}.s${depth + 1}-${i + 1}`,
      title: `${task.title ?? task.id} — ${w.id}`,
      // Goal is ONLY this remaining item's description; the parent's goal is
      // never re-cloned into a child.
      goal: w.description,
      assignedAgent: agent ?? null,
      artifact_type: artifactType,
      kind: w.kind ?? task.kind ?? 'implement',
      dependencies: [...(w.depends_on ?? []).map(d => `${task.id}.s${depth + 1}-${independent.findIndex(x => x.id === d) + 1}`)],
      acceptance: ids.map(id => {
        const c = Array.isArray(acceptanceCoverage) ? acceptanceCoverage.find(x => x?.id === id) : acceptanceCoverage?.[id];
        return c?.description ? `${id}: ${c.description}` : id;
      }),
      acceptanceIds: ids,
      sourceTaskId: task.id,
      rootTaskId: task.rootTaskId ?? task.id,
      splitDepth: depth + 1,
      remainingWorkId: w.id,
      estimatedComplexity: w.estimated_complexity,
      recommendedRole: role ?? null,
    };
  });

  // ---- validation ------------------------------------------------------------
  const ids = new Set(children.map(c => c.id));
  for (const c of children) {
    if (ids.size !== children.length) { errors.push('SPLIT_INVALID: duplicate child ids'); break; }
    for (const id of c.acceptanceIds) if (!known.has(id)) errors.push(`SPLIT_INVALID: child "${c.id}" references unknown acceptance id "${id}"`);
    for (const dep of c.dependencies) {
      if (dep === c.id) errors.push(`SPLIT_INVALID: child "${c.id}" depends on itself`);
      else if (!ids.has(dep) && dep !== task.id) errors.push(`SPLIT_INVALID: child "${c.id}" depends on unknown task "${dep}"`);
    }
    if (!c.assignedAgent) errors.push(`SPLIT_INVALID: child "${c.id}" has no resolvable agent (unknown role/artifact mapping)`);
    if (!ARTIFACT_TYPES.includes(c.artifact_type)) errors.push(`SPLIT_INVALID: child "${c.id}" has invalid artifact_type "${c.artifact_type}"`);
    // One giant re-clone guard: a child carrying every pending acceptance id and
    // the parent's artifact type adds no focus — reject rather than re-delegate.
    if (c.acceptanceIds.length >= pendingParent.length && pendingParent.length > 0 && c.artifact_type === (task.artifact_type ?? 'code_change') && independent.length === 1) {
      errors.push(`SPLIT_INVALID: child "${c.id}" is a re-clone of the parent scope`);
    }
  }
  const cycle = findCycle(children.map(c => ({ id: c.id, dependencies: c.dependencies })));
  if (cycle) errors.push(`SPLIT_INVALID: dependency cycle ${cycle.join(' -> ')}`);
  if (errors.length) return fail(errors);
  return { ok: true, code: null, tasks: children, errors: [] };
}

// ---------------------------------------------------------------------------
// Reassign target

const MISMATCH_HINTS = [
  { re: /\b(cannot run tests?|tests? (need|require)|verification (needed|required)|run the tests?|should be (a )?tester)\b/i, role: 'tester' },
  { re: /\b(investigat\w+|needs? (more )?(context|evidence|research)|unknown (file|code|area)|should be (an? )?investigator)\b/i, role: 'investigator' },
  { re: /\b(audit|security review|risk review|should be (an? )?auditor)\b/i, role: 'auditor' },
  { re: /\b(review (needed|required)|should be (a )?reviewer)\b/i, role: 'reviewer' },
];

/**
 * Explicit mismatch hints in the report (or a produced artifact type that the
 * CURRENT agent cannot own) pick the next ROLE — resolved to an agent through
 * the Phase 2 ROLE_AGENTS map. Never a model/provider change.
 * @returns {string|null} target role or null when nothing explicit exists.
 */
export function reassignTarget({ task, report } = {}) {
  const text = report ? haystack(
    ...report.handoff_notes, ...report.environment_constraints,
    ...report.blocked_work.flatMap(b => [b.description, b.reason])) : '';
  for (const { re, role } of MISMATCH_HINTS) if (re.test(text)) return role;
  // A produced artifact that belongs to a different agent is an explicit signal.
  for (const a of report?.artifacts ?? []) {
    const owner = ARTIFACT_AGENTS[a.type];
    if (owner && owner !== (task?.assignedAgent ?? task?.agent)) return roleForAgent(owner);
  }
  return null;
}

const AGENT_ROLES = Object.freeze({ coder: 'coder', tester: 'tester', reviewer: 'auditor', scout: 'investigator' });
const roleForAgent = agent => AGENT_ROLES[agent] ?? null;

// ---------------------------------------------------------------------------
// Decision

const snapshot = inputs => ({
  task_id: inputs.task?.id ?? null,
  taskComplexity: inputs.task?.estimatedComplexity ?? null,
  artifactType: inputs.task?.artifact_type ?? null,
  assignedAgent: inputs.task?.assignedAgent ?? null,
  continuationIndex: inputs.task?.continuationIndex ?? 0,
  retryCount: inputs.counters?.retries ?? 0,
  reassignmentCount: inputs.counters?.reassignments ?? 0,
  terminationReason: inputs.terminationReason ?? null,
  status: inputs.progressReport?.status ?? null,
  progressMetrics: inputs.progressMetrics ? { ...inputs.progressMetrics } : null,
  failureSignature: String(inputs.failureSignature ?? '').slice(0, SNAP.signature),
  runnerFailureClass: inputs.run?.failureClass ?? null,
  workspaceState: { dirty: inputs.workspaceState?.dirty ?? null, paths: (inputs.workspaceState?.paths ?? []).slice(0, SNAP.deps) },
  goalSummary: String(inputs.canonicalGoal?.goalSummary ?? '').slice(0, SNAP.notes),
  userDecisions: (inputs.explicitUserDecisions ?? []).slice(-SNAP.history).map(d => String(d).slice(0, SNAP.notes)),
  acceptance: Object.fromEntries(Object.entries(inputs.acceptanceCoverage ?? {}).slice(0, SNAP.acceptance)),
  limits: { ...(inputs.limits ?? {}) },
  history: (inputs.history ?? []).slice(-SNAP.history).map(h => ({ action: h.action, next_role: h.next_role, policyRule: h.policyRule })),
});

const decision = (action, { reason, confidence, classification, policyRule, task, nextRole = null, splitPlan = null, retryPolicy = null, notes = [], inputs }) => ({
  action, reason, confidence,
  source_task_id: task?.id ?? null,
  next_role: nextRole,
  split_plan: splitPlan,
  retry_policy: retryPolicy,
  notes: notes.filter(Boolean),
  failureClassification: classification,
  policyRule,
  inputsSnapshot: snapshot(inputs),
});

/**
 * One deterministic decision for a finished bounded run.
 * @param {object} inputs
 *   task              task row ({id, acceptanceIds, assignedAgent, attempts, reassignments?, splitDepth?})
 *   run               runner result ({ok,error,result,abort,gate,failureClass,child})
 *   terminationReason TERMINATION_REASONS value (run truth wins over report)
 *   progressReport    validated progress report object
 *   progressMetrics   progressMetrics() output (recomputed when absent)
 *   failureSignature  signature of the PREVIOUS identical failure (suppression)
 *   ledger            acceptance ledger rows ({id,status,description})
 *   acceptanceCoverage {id: {status, description}} coverage view
 *   workspaceState    {dirty, paths} — informational only
 *   canonicalGoal     Phase 1 canonical goal — informational only
 *   explicitUserDecisions string[] — honored user decisions (e.g. "stop", "do not retry")
 *   limits            {maxRetries,maxReassignments,maxSplitTasks,maxSplitDepth}
 *   counters          {retries: n, reassignments: n, splitDepth: n}
 *   history           prior decision actions for this task (oscillation guard)
 * @returns the structured decision described in the module header.
 */
export function decideExecution(inputs = {}) {
  const task = inputs.task ?? null;
  const run = inputs.run ?? null;
  const report = (() => {
    if (inputs.progressReport == null) return null;
    try { return parseProgressReport(inputs.progressReport); } catch { return null; }
  })();
  const metrics = inputs.progressMetrics ?? (report ? progressMetrics(report) : null);
  const limits = { ...DEFAULT_LIMITS, ...(inputs.limits ?? {}) };
  const counters = { retries: 0, reassignments: 0, splitDepth: 0, ...(inputs.counters ?? {}) };
  const history = [...(inputs.history ?? [])];
  const classification = classifyExecutionFailure(inputs);
  const termination = inputs.terminationReason ?? classifyTermination(run, report);
  // Ledger rows (Phase 2) and the acceptanceCoverage view feed the same map.
  const coverage = { ...(inputs.acceptanceCoverage ?? {}) };
  for (const l of inputs.ledger ?? []) if (l?.id && !coverage[l.id]) coverage[l.id] = { status: l.status, description: l.description };
  const decisions = [...(inputs.explicitUserDecisions ?? [])];
  const done = (action, o) => decision(action, { ...o, classification, task, inputs });

  // ---- hard guards (before every action) ------------------------------------
  const userStopped = termination === 'user_stop' || run?.abort === true
    || decisions.some(d => /\b(stop|abort|cancel|do not continue|do not retry|don't retry|preserve without further execution)\b|やめ|中止|再試行しない/i.test(String(d)));
  if (userStopped) {
    return done('stop', { reason: 'user_stop: an explicit user decision or abort must never be continued automatically', confidence: 1, policyRule: POLICY_RULES.STOP_USER });
  }
  if (report && destructiveAmbiguity(report)) {
    return done('stop', { reason: 'report hints at destructive/resetting actions; requires human review', confidence: 1, policyRule: POLICY_RULES.STOP_DESTRUCTIVE });
  }
  if (classification.class === 'environment_limitation' || termination === 'environment_block' || run?.gate) {
    return done('stop', { reason: 'environment limitation: resolve the environment before any automatic action', confidence: 1, policyRule: POLICY_RULES.STOP_ENVIRONMENT });
  }

  // ---- complete --------------------------------------------------------------
  if (!report && run?.ok && run?.result?.status === 'completed' && inputs.evaluatorVerdict === 'success') {
    return done('complete', { reason: 'legacy structured acceptance passed the parent evaluator', confidence: 0.8, policyRule: POLICY_RULES.COMPLETE_EVIDENCED });
  }
  if (report?.status === 'completed' && !report.remaining_work.length && run?.ok !== false) {
    const ids = [...(task?.acceptanceIds ?? [])];
    const ledgerSatisfied = new Set(Object.entries(coverage).filter(([, c]) => (c?.status ?? c) === 'satisfied').map(([id]) => id));
    const evidenced = ids.length > 0 && ids.every(id => ledgerSatisfied.has(id)
      || report.completed_acceptance.some(c => c.acceptance_id === id && c.evidence?.length));
    if (evidenced || !ids.length) {
      return done('complete', { reason: 'completed report with no remaining work and every acceptance criterion evidenced', confidence: 0.9, policyRule: POLICY_RULES.COMPLETE_EVIDENCED });
    }
    return done('stop', { reason: 'completion claimed but acceptance criteria lack evidence; stopping for review rather than auto-continuing', confidence: 0.7, policyRule: POLICY_RULES.STOP_NO_ACTION });
  }

  // ---- no_progress guard (never continue/retry/split) ------------------------
  // A transient process failure that never produced output is NOT a stall —
  // retrying it is exactly what the retry path exists for, so retriable
  // classes are exempt from this guard.
  const noProgress = classification.class === 'no_progress'
    || (report && metrics && !metrics.progressMade
      && ['blocked', 'failed'].includes(report.status)
      && !RETRYABLE_CLASSES.has(classification.class));
  if (noProgress) {
    return done('stop', { reason: 'no observable progress; continuing or retrying would repeat the same stall', confidence: 0.95, policyRule: POLICY_RULES.STOP_NO_PROGRESS });
  }

  // ---- budget-aware extension (opt-in measured telemetry, never inferred) ----
  if (report?.status === 'partial' && inputs.budget && inputs.budgetTelemetry && ['turn_limit', 'tool_limit'].includes(termination)) {
    const budgetDecision = decideBudgetExtension({ task, budget: inputs.budget, telemetry: inputs.budgetTelemetry,
      terminationReason: termination, progressReport: report, progressMetrics: inputs.budgetMetrics ?? metrics,
      priorFailureSignature: inputs.failureSignature, runBudget: inputs.runBudget });
    if (budgetDecision.action === 'extend') {
      return { ...done('extend', { reason: budgetDecision.reason, confidence: 0.85, policyRule: budgetDecision.policyRule }),
        previousBudget: budgetDecision.previousBudget, newBudget: budgetDecision.newBudget,
        progressSnapshot: budgetDecision.progressSnapshot, remainingWorkSnapshot: budgetDecision.remainingWorkSnapshot };
    }
  }

  // ---- continue --------------------------------------------------------------
  const largeResidual = (report?.remaining_work ?? []).filter(w => w.estimated_complexity === 'large');
  if (report?.status === 'partial' && metrics?.progressMade && metrics.remainingWorkCount && !largeResidual.length
    && classifyContinuation(report, { terminationReason: termination, nextContinuationIndex: (task?.continuationIndex ?? 0) + 1 }).eligible) {
    return done('continue', {
      reason: `partial run made progress with ${metrics.remainingWorkCount} remaining item(s); a bounded continuation is the smallest sufficient action`,
      confidence: 0.9, policyRule: POLICY_RULES.CONTINUE_PARTIAL,
      notes: [`lastProgressMarker=${metrics.lastProgressMarker}`],
    });
  }

  // ---- split -----------------------------------------------------------------
  // 2+ explicit remaining_work items that continuation is not handling (status
  // not 'partial', or a large residual) become focused tasks. A 'large' item
  // fails buildSplitTasks validation and falls through — never silently split.
  if (report && metrics?.remainingWorkCount >= 2) {
    if (counters.splitDepth < limits.maxSplitDepth) {
      const split = buildSplitTasks({ task, report, acceptanceCoverage: coverage, counters });
      if (split.ok && split.tasks.length >= 2 && split.tasks.length <= limits.maxSplitTasks) {
        return done('split', {
          reason: `${split.tasks.length} independent remaining_work items; split into focused tasks instead of one overloaded continuation`,
          confidence: 0.75, policyRule: POLICY_RULES.SPLIT_REMAINING_WORK, splitPlan: split.tasks,
        });
      }
      if (split.ok) return done('stop', { reason: `split produced ${split.tasks.length} task(s), exceeding maxSplitTasks=${limits.maxSplitTasks}`, confidence: 0.8, policyRule: POLICY_RULES.STOP_LIMITS });
    } else {
      return done('stop', { reason: `split depth ${counters.splitDepth} reached maxSplitDepth=${limits.maxSplitDepth}`, confidence: 0.8, policyRule: POLICY_RULES.STOP_LIMITS });
    }
  }

  // ---- reassign ---------------------------------------------------------------
  const targetRole = reassignTarget({ task, report });
  const currentRole = task ? (task.recommendedRole ?? roleForAgent(task.assignedAgent ?? task.agent)) : null;
  if (targetRole && targetRole !== currentRole) {
    const reassignCount = Math.max(counters.reassignments, history.filter(h => (typeof h === 'object' ? h.action === 'reassign' : h === 'reassign')).length);
    if (reassignCount >= limits.maxReassignments) {
      return done('stop', { reason: `reassignment count ${reassignCount} reached maxReassignments=${limits.maxReassignments}`, confidence: 0.8, policyRule: POLICY_RULES.STOP_LIMITS });
    }
    const lastReassign = [...history].reverse().find(h => (typeof h === 'object' ? h.action === 'reassign' : h === 'reassign'));
    const lastTarget = typeof lastReassign === 'object' ? lastReassign.next_role : null;
    // Oscillation guard: never re-reassign to a role already tried.
    if (lastTarget && lastTarget === targetRole) {
      return done('stop', { reason: `reassign oscillation: role "${targetRole}" was already tried`, confidence: 0.85, policyRule: POLICY_RULES.STOP_LIMITS });
    }
    return done('reassign', {
      reason: `explicit mismatch hints map this work to role "${targetRole}" (Phase 2 ROLE_AGENTS); the model/provider never changes`,
      confidence: 0.7, policyRule: POLICY_RULES.REASSIGN_MISMATCH, nextRole: targetRole,
    });
  }

  // ---- retry ------------------------------------------------------------------
  const retriable = RETRYABLE_CLASSES.has(classification.class);
  const identicalSignature = inputs.failureSignature && inputs.failureSignature === classification.signature;
  if (retriable) {
    if (identicalSignature) {
      return done('stop', {
        reason: `identical failure signature "${classification.signature}" already retried; suppressing a repeated transient retry`,
        confidence: 0.85, policyRule: POLICY_RULES.STOP_LIMITS,
        notes: ['repeated identical signature suppression'],
      });
    }
    if (counters.retries >= limits.maxRetries) {
      return done('stop', { reason: `retry count ${counters.retries} reached maxRetries=${limits.maxRetries}`, confidence: 0.85, policyRule: POLICY_RULES.STOP_LIMITS });
    }
    return done('retry', {
      reason: `${classification.class} is transient/process-level; a bounded retry is safe`,
      confidence: 0.7, policyRule: POLICY_RULES.RETRY_TRANSIENT,
      retryPolicy: { maxRetries: limits.maxRetries, attempt: counters.retries + 1, suppressIfSignature: classification.signature, escalateModel: false },
      notes: ['no model/provider escalation'],
    });
  }
  if (identicalSignature) {
    return done('stop', { reason: `identical failure signature "${classification.signature}" repeated`, confidence: 0.85, policyRule: POLICY_RULES.STOP_LIMITS });
  }

  return done('stop', {
    reason: `no actionable path: class=${classification.class}, status=${report?.status ?? 'none'}, termination=${termination}`,
    confidence: 0.6, policyRule: POLICY_RULES.STOP_NO_ACTION,
    notes: classification.evidence.slice(0, 4),
  });
}
