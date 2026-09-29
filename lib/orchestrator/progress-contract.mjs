// Phase 3 progress contract (PURE): validates a worker's structured execution
// progress report, derives deterministic metrics and continuation eligibility,
// and builds a residual continuation task spec. No store, runner, retries or
// model calls; inputs are never mutated and nothing is scheduled or persisted.
import { FINDING_CLASSES, COMPLEXITIES } from './planning-contract.mjs';
import { ARTIFACT_TYPES } from './task-store.mjs';

export const PROGRESS_STATUSES = Object.freeze(['completed', 'partial', 'blocked', 'failed', 'unknown']);
// terminationReason is deliberately a SEPARATE enum from status: a partial run
// can end by turn_limit, a completed run by 'completed', etc.
export const TERMINATION_REASONS = Object.freeze(['completed', 'turn_limit', 'tool_limit', 'process_error', 'environment_block', 'validation_failure', 'user_stop', 'unknown']);
export const BLOCKED_CLASSES = FINDING_CLASSES;
// Continuation chains are bounded: parent.c1 -> .c2 -> .c3 is the deepest a
// residual may go; a fourth continuation is never eligible.
export const MAX_CONTINUATION_DEPTH = 3;

/** Observable process outcome wins over the child's self-reported reason. */
export function classifyTermination(run, report = null) {
  const stop = String(run?.child?.stopReason ?? run?.stopReason ?? '');
  if (run?.abort || /user|cancel|interrupt/i.test(stop)) return 'user_stop';
  if (/tool.*limit|tool.*budget/i.test(stop)) return 'tool_limit';
  if (/turn.*limit|timeout|deadline/i.test(stop)) return 'turn_limit';
  if (run?.gate || ['POLICY_BLOCK', 'USER_DECISION_REQUIRED'].includes(run?.failureClass)) return 'environment_block';
  if (['TIMEOUT', 'PROGRESS_TIMEOUT', 'NO_PROGRESS_TIMEOUT'].includes(run?.failureClass) || /turn limit|timed out/i.test(run?.error ?? '')) return 'turn_limit';
  if (run?.failureClass === 'MALFORMED_RESULT') return 'validation_failure';
  if (!run?.ok) return 'process_error';
  return report?.termination_reason ?? (report?.status === 'completed' ? 'completed' : 'unknown');
}

export const PROGRESS_CODES = Object.freeze({
  INVALID_PROGRESS_REPORT: 'INVALID_PROGRESS_REPORT',
  INVALID_RESIDUAL_INPUT: 'INVALID_RESIDUAL_INPUT',
  NOT_CONTINUABLE: 'NOT_CONTINUABLE',
});

const string = x => typeof x === 'string' && x.trim().length > 0;
const strings = x => Array.isArray(x) && x.every(string);
const required = (obj, fields, prefix, errors) => {
  for (const field of fields) if (!Object.hasOwn(obj, field)) errors.push(`${prefix}.${field} is required`);
};

// Deterministic keyword probe for reports that hint at destructive or
// workspace-resetting actions. Any hit makes a residual continuation
// ineligible — a human must resolve the ambiguity, never the planner.
const DESTRUCTIVE_HINT = /\b(destructive|git\s+reset|git\s+clean|git\s+stash|force[-\s]?push|rm\s+-rf|wip(e|ed|ing))\b/i;

/** @typedef {{acceptance_id: string, evidence: unknown[]}} CompletedAcceptance */
/** @typedef {{id: string, description: string, acceptance_ids: string[], estimated_complexity: 'small'|'medium'|'large'|'unknown'}} RemainingWorkItem */
/** @typedef {{description: string, reason: string, classification: FindingClassification}} BlockedWork */
/** @typedef {{command: string, result: string}} TestRun */
/** @typedef {{type: ArtifactType, location: string, description: string}} ArtifactRef */
/**
 * @typedef {{task_id: string, status: 'completed'|'partial'|'blocked'|'failed'|'unknown',
 *   termination_reason?: TerminationReason, completed_acceptance: CompletedAcceptance[],
 *   completed_steps: string[], remaining_work: RemainingWorkItem[], blocked_work: BlockedWork[],
 *   files_touched: string[], tests_run: TestRun[], artifacts: ArtifactRef[],
 *   environment_constraints: string[], handoff_notes: string[]}} ProgressReport
 * @typedef {'completed'|'turn_limit'|'tool_limit'|'process_error'|'environment_block'|'validation_failure'|'user_stop'|'unknown'} TerminationReason
 */

/**
 * Parse a JSON object or string into a validated progress report.
 * Every field is strictly required (arrays may be empty). A report claiming
 * status 'completed' while still listing remaining_work is a contradiction and
 * rejected. Throws on invalid input; never executes or schedules anything.
 */
export function parseProgressReport(input) {
  let report;
  try { report = typeof input === 'string' ? JSON.parse(input) : input; } catch { throw new Error('progress report: invalid JSON'); }
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('progress report: expected object');
  try { report = structuredClone(report); } catch { /* non-cloneable extras are validated but never mutated */ }
  const errors = [];
  required(report, ['task_id', 'status', 'completed_acceptance', 'completed_steps', 'remaining_work', 'blocked_work', 'files_touched', 'tests_run', 'artifacts', 'environment_constraints', 'handoff_notes'], 'report', errors);
  if (!string(report.task_id)) errors.push('report.task_id must be a nonempty string');
  if (!PROGRESS_STATUSES.includes(report.status)) errors.push(`report.status must be one of ${PROGRESS_STATUSES.join('/')}`);
  // terminationReason is separate from status; accept either casing, keep the
  // snake_case key canonical (it mirrors the JSON field naming of the report).
  const termination = report.termination_reason ?? report.terminationReason;
  if (termination != null && !TERMINATION_REASONS.includes(termination)) {
    errors.push(`report.termination_reason must be one of ${TERMINATION_REASONS.join('/')}`);
  } else if (report.termination_reason == null && termination != null) {
    report.termination_reason = termination;
  }
  for (const key of ['completed_steps', 'files_touched', 'environment_constraints', 'handoff_notes']) {
    if (!strings(report[key])) errors.push(`report.${key} must be a string array`);
  }
  if (!Array.isArray(report.completed_acceptance)) errors.push('report.completed_acceptance must be an array');
  else report.completed_acceptance.forEach((c, i) => {
    if (!c || typeof c !== 'object' || !string(c.acceptance_id)) errors.push(`completed_acceptance ${i}: acceptance_id is required`);
    if (!Array.isArray(c?.evidence)) errors.push(`completed_acceptance ${i}: evidence must be an array`);
  });
  const remainingIds = new Set();
  if (!Array.isArray(report.remaining_work)) errors.push('report.remaining_work must be an array');
  else report.remaining_work.forEach((w, i) => {
    if (!w || typeof w !== 'object') { errors.push(`remaining_work ${i}: expected object`); return; }
    required(w, ['id', 'description', 'acceptance_ids', 'estimated_complexity'], `remaining_work ${i}`, errors);
    for (const field of ['id', 'description']) if (!string(w[field])) errors.push(`remaining_work ${i}: ${field} must be a nonempty string`);
    if (string(w.id)) { if (remainingIds.has(w.id)) errors.push(`remaining_work ${i}: duplicate id`); remainingIds.add(w.id); }
    if (!strings(w.acceptance_ids)) errors.push(`remaining_work ${i}: acceptance_ids must be a string array`);
    if (!COMPLEXITIES.includes(w.estimated_complexity)) errors.push(`remaining_work ${i}: invalid estimated_complexity`);
  });
  if (!Array.isArray(report.blocked_work)) errors.push('report.blocked_work must be an array');
  else report.blocked_work.forEach((b, i) => {
    if (!b || typeof b !== 'object') { errors.push(`blocked_work ${i}: expected object`); return; }
    for (const field of ['description', 'reason']) if (!string(b[field])) errors.push(`blocked_work ${i}: ${field} must be a nonempty string`);
    if (!BLOCKED_CLASSES.includes(b.classification)) errors.push(`blocked_work ${i}: invalid classification`);
  });
  if (!Array.isArray(report.tests_run)) errors.push('report.tests_run must be an array');
  else report.tests_run.forEach((t, i) => {
    if (!t || typeof t !== 'object' || !string(t.command) || !string(t.result)) errors.push(`tests_run ${i}: command and result are required`);
  });
  if (!Array.isArray(report.artifacts)) errors.push('report.artifacts must be an array');
  else report.artifacts.forEach((a, i) => {
    if (!a || typeof a !== 'object') { errors.push(`artifacts ${i}: expected object`); return; }
    if (!ARTIFACT_TYPES.includes(a.type)) errors.push(`artifacts ${i}: invalid artifact type`);
    for (const field of ['location', 'description']) if (!string(a[field])) errors.push(`artifacts ${i}: ${field} must be a nonempty string`);
  });
  // Hard contradiction: 'completed' while still carrying remaining work.
  if (report.status === 'completed' && Array.isArray(report.remaining_work) && report.remaining_work.length > 0) {
    errors.push('report: status "completed" contradicts a nonempty remaining_work list');
  }
  if (errors.length) throw new Error(`progress report: ${errors.join('; ')}`);
  return report;
}

/**
 * Pure deterministic metrics over a validated report.
 * - progressMade: any completed work, file touch or test run.
 * - lastProgressMarker: last completed step, else last test command, else last
 *   touched file, else null.
 * - completedWorkCount: completed_steps + completed_acceptance entries.
 * - remainingWorkCount: remaining_work entries.
 * - repeatedFailureSignature: stable signature of failing test commands and
 *   blocked classifications (free text excluded so the same failure across
 *   differently worded reports still collides); null when nothing failed.
 */
export function progressMetrics(report) {
  const r = parseProgressReport(report);
  const completedWorkCount = r.completed_steps.length + r.completed_acceptance.length;
  const remainingWorkCount = r.remaining_work.length;
  const progressMade = completedWorkCount > 0 || r.files_touched.length > 0 || r.tests_run.length > 0;
  const lastProgressMarker = r.completed_steps.at(-1)
    ?? (r.tests_run.length ? `test:${r.tests_run.at(-1).command}` : undefined)
    ?? (r.files_touched.length ? `file:${r.files_touched.at(-1)}` : undefined)
    ?? null;
  const failureParts = new Set();
  for (const t of r.tests_run) if (t.result !== 'pass' && t.result !== 'skipped') failureParts.add(`fail:${t.command}`);
  for (const b of r.blocked_work) failureParts.add(`blocked:${b.classification}`);
  const repeatedFailureSignature = failureParts.size ? [...failureParts].sort().join('|') : null;
  return { progressMade, lastProgressMarker, completedWorkCount, remainingWorkCount, repeatedFailureSignature };
}

/** True when the report text hints at destructive/resetting actions needing human review. */
export function destructiveAmbiguity(report) {
  const haystack = [
    ...report.handoff_notes, ...report.environment_constraints,
    ...report.blocked_work.flatMap(b => [b.description, b.reason]),
  ].join('\n');
  return DESTRUCTIVE_HINT.test(haystack);
}

/**
 * Deterministic continuation eligibility. Eligible iff ALL of:
 *   report parses, status is 'partial', remaining work exists, observable
 *   progress was made, termination was not 'user_stop', the next continuation
 *   index stays within MAX_CONTINUATION_DEPTH, and no destructive ambiguity.
 * @returns {{eligible: boolean, code: string|null, reasons: string[], metrics: object|null}}
 */
export function classifyContinuation(report, { terminationReason, nextContinuationIndex = 1 } = {}) {
  let r;
  try { r = parseProgressReport(report); }
  catch (e) {
    return { eligible: false, code: PROGRESS_CODES.INVALID_PROGRESS_REPORT, reasons: [`invalid progress report: ${String(e.message ?? e)}`], metrics: null };
  }
  const metrics = progressMetrics(r);
  const reason = terminationReason ?? r.termination_reason ?? 'unknown';
  const reasons = [];
  if (r.status !== 'partial') reasons.push(`status "${r.status}" is not "partial"`);
  if (!metrics.remainingWorkCount) reasons.push('no remaining work to continue');
  if (!metrics.progressMade) reasons.push('no observable progress this run');
  if (r.remaining_work.some(w => w.estimated_complexity === 'large')) reasons.push('large residual work needs explicit decomposition before execution');
  if (reason === 'user_stop') reasons.push('termination "user_stop" must never be continued automatically');
  if (reason === 'environment_block') reasons.push('environment block must be resolved before continuation');
  if (nextContinuationIndex > MAX_CONTINUATION_DEPTH) reasons.push(`continuation depth ${nextContinuationIndex} exceeds max ${MAX_CONTINUATION_DEPTH}`);
  if (destructiveAmbiguity(r)) reasons.push('report hints at destructive/resetting actions; requires human review');
  return { eligible: reasons.length === 0, code: reasons.length ? PROGRESS_CODES.NOT_CONTINUABLE : null, reasons, metrics };
}

const COMPLEXITY_RANK = { small: 1, medium: 2, unknown: 3, large: 4 };

/**
 * Build the residual continuation task spec for an eligible partial run.
 * The emitted spec is newTask-compatible PLUS lineage/handoff provenance:
 *   id "<parent>.cN", parentTaskId, rootTaskId, continuationIndex,
 *   sourceProgressReport, remainingWorkIds, inheritedArtifacts,
 *   inheritedEvidence, workspaceStateReference.
 * acceptanceIds is the union of the parent's STILL-UNSATISFIED acceptance ids
 * and every remaining_work acceptance id — only persisted ledger status
 * 'satisfied' is trusted, so no pending criterion is ever lost. The goal is
 * built ONLY from remaining_work descriptions (never the original long goal)
 * and dependencies start empty because the parent already ran.
 * @returns {{ok: boolean, code: string|null, task: object|null, metrics: object|null, errors: string[]}}
 */
export function buildContinuationTask({ task, report, ledger = [], workspaceRef = null, progressRef = null, terminationReason } = {}) {
  const fail = (code, errors) => ({ ok: false, code, task: null, metrics: null, errors });
  if (!task || typeof task !== 'object' || !string(task.id)) {
    return fail(PROGRESS_CODES.INVALID_RESIDUAL_INPUT, ['INVALID_RESIDUAL_INPUT: original task with a nonempty id is required']);
  }
  const parentIndex = task.continuationIndex ?? task.lineage?.continuationIndex ?? 0;
  const nextIndex = parentIndex + 1;
  const gate = classifyContinuation(report, { terminationReason, nextContinuationIndex: nextIndex });
  if (!gate.eligible) return fail(gate.code ?? PROGRESS_CODES.NOT_CONTINUABLE, gate.reasons);
  const r = parseProgressReport(report); // re-parse for a fresh, trusted shape

  // Only persisted ledger 'satisfied' is trusted — child claims in
  // completed_acceptance never mark a criterion satisfied.
  const satisfied = new Set((Array.isArray(ledger) ? ledger : []).filter(l => l?.status === 'satisfied').map(l => l.id));
  const ledgerDesc = new Map((Array.isArray(ledger) ? ledger : []).filter(l => string(l?.id)).map(l => [l.id, l.description]));
  const pending = (Array.isArray(task.acceptanceIds) ? task.acceptanceIds : []).filter(id => !satisfied.has(id));
  const remainingIds = r.remaining_work.flatMap(w => w.acceptance_ids);
  const acceptanceIds = [...new Set([...pending, ...remainingIds])].filter(id => !satisfied.has(id));

  const spec = {
    id: `${task.rootTaskId ?? task.lineage?.rootTaskId ?? task.id}.c${nextIndex}`,
    title: `${task.title ?? task.id} (continuation ${nextIndex})`,
    // Goal is rebuilt ONLY from remaining descriptions — the original long
    // task goal is never copied into a residual.
    goal: ['Continue the remaining work:', ...r.remaining_work.map(w => `- ${w.description}`)].join('\n'),
    agent: task.assignedAgent ?? task.agent,
    assignedAgent: task.assignedAgent ?? task.agent,
    capability: task.capability,
    planningRef: task.planningRef,
    sourceWorkItemId: task.sourceWorkItemId,
    recommendedRole: task.recommendedRole,
    kind: task.kind ?? 'implement',
    artifact_type: task.artifact_type ?? 'code_change',
    dependencies: [],
    acceptance: acceptanceIds.map(id => (string(ledgerDesc.get(id)) ? `${id}: ${ledgerDesc.get(id)}` : id)),
    outputs: [],
    // Lineage + provenance.
    parentTaskId: task.id,
    rootTaskId: task.rootTaskId ?? task.lineage?.rootTaskId ?? task.id,
    continuationIndex: nextIndex,
    sourceProgressReport: progressRef,
    sourceTaskId: task.id,
    // Residual work, untouched input objects preserved via structuredClone.
    remainingWorkIds: r.remaining_work.map(w => w.id),
    remainingWork: structuredClone(r.remaining_work),
    inheritedArtifacts: structuredClone(r.artifacts),
    inheritedEvidence: r.completed_acceptance.flatMap(c => c.evidence.map(evidence => ({ acceptance_id: c.acceptance_id, evidence }))),
    workspaceStateReference: workspaceRef,
    acceptanceIds,
    estimatedComplexity: r.remaining_work.reduce((worst, w) => (COMPLEXITY_RANK[w.estimated_complexity] > COMPLEXITY_RANK[worst] ? w.estimated_complexity : worst), 'small'),
    dependsOn: [],
    // Handoff context: everything the next worker needs without re-deriving it.
    handoff: {
      completedSteps: [...r.completed_steps],
      completedAcceptance: structuredClone(r.completed_acceptance),
      filesTouched: [...r.files_touched],
      testsRun: structuredClone(r.tests_run),
      artifacts: structuredClone(r.artifacts),
      environmentConstraints: [...r.environment_constraints],
      blockedWork: structuredClone(r.blocked_work),
      handoffNotes: [...r.handoff_notes],
      workspaceDirty: workspaceRef?.dirty ?? null,
    },
    progress: gate.metrics,
  };
  return { ok: true, code: null, task: spec, metrics: gate.metrics, errors: [] };
}
