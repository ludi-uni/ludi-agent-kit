// Adaptive planning translation (Phase 2): a VALIDATED planning report plus the
// persistent acceptance ledger become routed task specs. Pure: no store, runner,
// retries or model calls. Every failure is explicit — the translator never
// guesses an agent, silently drops an acceptance criterion, or decomposes a
// large work item on its own.
import { parsePlanningReport } from './planning-contract.mjs';
import { validatePlan } from './planner.mjs';
import { findCycle, ARTIFACT_TYPES, expectedOutcomeForArtifact } from './task-store.mjs';
import { DEFAULT_POLICY } from './policy.mjs';

// Structured failure codes. `result.code` is the first one raised; every error
// string is prefixed with its code so callers can grep or group them.
export const PLAN_CODES = Object.freeze({
  INVALID_REPORT: 'INVALID_REPORT',
  INVALID_CONTEXT: 'INVALID_CONTEXT',
  UNRESOLVED_LARGE_WORK_ITEM: 'UNRESOLVED_LARGE_WORK_ITEM',
  UNCOVERED_ACCEPTANCE: 'UNCOVERED_ACCEPTANCE',
  UNKNOWN_ROLE: 'UNKNOWN_ROLE',
  ROLE_ARTIFACT_MISMATCH: 'ROLE_ARTIFACT_MISMATCH',
  INVALID_REFERENCE: 'INVALID_REFERENCE',
  DEPENDENCY_CYCLE: 'DEPENDENCY_CYCLE',
  INVALID_PLAN: 'INVALID_PLAN',
});

// recommended_role -> actual agent. Explicit on purpose: a role that is not
// listed here fails (UNKNOWN_ROLE) instead of falling back to a default worker.
// auditor maps to reviewer, investigator to scout, documentation to coder, and
// planner to scout (re-planning/design work is delegated as focused analysis;
// the orchestrator itself can never be a task assignee).
export const ROLE_AGENTS = Object.freeze({
  coder: 'coder',
  tester: 'tester',
  reviewer: 'reviewer',
  auditor: 'reviewer',
  investigator: 'scout',
  documentation: 'coder',
  planner: 'scout',
});

// artifact_type -> owning agent. This is the hard invariant for who executes a
// work item; recommended_role must agree with it (see ROLE_ARTIFACT_MISMATCH).
export const ARTIFACT_AGENTS = Object.freeze({
  code_change: 'coder',
  test_result: 'tester',
  design_report: 'scout',
  audit_report: 'reviewer',
  documentation: 'coder',
  experiment_result: 'scout',
  investigation: 'scout',
});

// Legacy task kind per artifact so downstream consumers that still branch on
// `kind` keep working. artifact_type stays authoritative.
const ARTIFACT_KINDS = Object.freeze({
  code_change: 'implement',
  test_result: 'verify',
  design_report: 'investigate',
  audit_report: 'review',
  documentation: 'implement',
  experiment_result: 'investigate',
  investigation: 'investigate',
});

// Only a satisfied criterion is exempt from coverage. failed/blocked/unknown
// criteria are still outstanding acceptance and must be planned for.
const COVERED_STATUSES = new Set(['satisfied']);

const err = (code, message) => `${code}: ${message}`;

/**
 * Merge ledger truth over report criteria. Ledger status wins (the persistent
 * store is authoritative); a report-only criterion defaults to pending.
 * Returns [{id, description, source, status}] in stable order: report order
 * first, then ledger-only criteria in ledger order.
 */
function mergeCriteria(report, ledger) {
  const ledgerStatus = new Map();
  for (const row of Array.isArray(ledger) ? ledger : []) {
    if (row && typeof row.id === 'string') ledgerStatus.set(row.id, row.status ?? 'pending');
  }
  const merged = [];
  const seen = new Set();
  for (const c of report.acceptance_criteria ?? []) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    // Child-reported satisfaction is not evidence; only persisted ledger status is trusted.
    merged.push({ id: c.id, description: c.description, source: c.source, status: ledgerStatus.get(c.id) ?? 'pending' });
  }
  for (const row of Array.isArray(ledger) ? ledger : []) {
    if (!row || typeof row.id !== 'string' || seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push({ id: row.id, description: row.description ?? '', source: row.source ?? 'ledger', status: row.status ?? 'pending' });
  }
  return merged;
}

/**
 * Translate a planning report into routed task specs.
 * @param {object|string} report   A report ALREADY acceptable to parsePlanningReport.
 *                                 It is re-validated here so invariants hold even if the caller skipped it.
 * @param {object} options
 * @param {object[]} options.agents    Loaded agent definitions (workerAgents applied inside routing).
 * @param {object}   options.routing   routing.json content (capabilities map).
 * @param {object}   [options.policy]  Decision policy; defaults to DEFAULT_POLICY.
 * @param {object[]} [options.ledger]  Persistent acceptance rows ({id,status,...}); statuses override the report.
 * @param {string}   [options.planningRef]  Provenance reference stamped on every emitted task spec.
 * @param {string[]} [options.existingIds]  Task ids already in the store (collision + max_tasks accounting).
 * @returns {{ok: boolean, code: string|null, planner: 'adaptive', tasks: object[], coverage: object, errors: string[]}}
 */
export function planFromReport(report, { agents, routing, policy = DEFAULT_POLICY, ledger = [], planningRef = null, existingIds = [] } = {}) {
  const coverage = {};
  const fail = (code, errors, extra = {}) => ({ ok: false, code, planner: 'adaptive', tasks: [], coverage, errors, ...extra });

  if (!Array.isArray(agents) || !routing?.capabilities) return fail(PLAN_CODES.INVALID_CONTEXT, [err(PLAN_CODES.INVALID_CONTEXT, 'agents and routing are required')]);

  let parsed;
  try { parsed = parsePlanningReport(report); }
  catch (e) { return fail(PLAN_CODES.INVALID_REPORT, [err(PLAN_CODES.INVALID_REPORT, String(e.message ?? e))]); }
  const items = parsed.work_items;
  const criteria = mergeCriteria(parsed, ledger);
  const criterionById = new Map(criteria.map(c => [c.id, c]));

  // Coverage: for every merged criterion, the work items that claim it.
  const coveredBy = new Map(criteria.map(c => [c.id, []]));
  for (const item of items) for (const id of item.acceptance_ids) if (coveredBy.has(id)) coveredBy.get(id).push(item.id);
  for (const c of criteria) {
    const n = coveredBy.get(c.id)?.length ?? 0;
    coverage[c.id] = { status: c.status, coveredBy: coveredBy.get(c.id) ?? [], count: n, bucket: n === 0 ? 'none' : n === 1 ? 'single' : 'multiple' };
  }

  const errors = [];
  const itemIds = new Set();

  // --- structural integrity (defense in depth; the parser already checks most of this) ---
  for (const item of items) if (itemIds.has(item.id)) errors.push(err(PLAN_CODES.INVALID_REFERENCE, `duplicate work item id "${item.id}"`));
  for (const item of items) itemIds.add(item.id);
  for (const item of items) {
    for (const dep of item.depends_on) {
      if (dep === item.id) errors.push(err(PLAN_CODES.INVALID_REFERENCE, `work item "${item.id}" depends on itself`));
      else if (!itemIds.has(dep)) errors.push(err(PLAN_CODES.INVALID_REFERENCE, `work item "${item.id}" depends on unknown item "${dep}"`));
    }
    for (const id of item.acceptance_ids) if (!criterionById.has(id)) errors.push(err(PLAN_CODES.INVALID_REFERENCE, `work item "${item.id}" references unknown acceptance id "${id}"`));
  }
  const cycle = findCycle(items.map(i => ({ id: i.id, dependencies: i.depends_on })));
  if (cycle) errors.push(err(PLAN_CODES.DEPENDENCY_CYCLE, `work item dependency cycle ${cycle.join(' -> ')}`));

  // --- executability: complexity, role and artifact must all resolve explicitly ---
  const agentFor = new Map();
  for (const item of items) {
    if (item.estimated_complexity === 'large') {
      // Never silently turn a large item into one execution task. A `subitems`
      // concept is NOT part of the report schema, so there is no clean flat
      // expansion: the planner must re-emit the concern as explicit small/
      // medium work_items with their own depends_on/acceptance_ids.
      errors.push(err(PLAN_CODES.UNRESOLVED_LARGE_WORK_ITEM,
        `work item "${item.id}" ("${item.title}") is estimated_complexity=large; re-plan it as explicit flat subitems before scheduling`));
      continue;
    }
    const roleAgent = ROLE_AGENTS[item.recommended_role];
    if (roleAgent === undefined) {
      errors.push(err(PLAN_CODES.UNKNOWN_ROLE, `work item "${item.id}" has unknown recommended_role "${item.recommended_role}"`));
      continue;
    }
    const artifactAgent = ARTIFACT_AGENTS[item.artifact_type];
    if (artifactAgent === undefined) {
      errors.push(err(PLAN_CODES.INVALID_REFERENCE, `work item "${item.id}" has unmapped artifact_type "${item.artifact_type}"`));
      continue;
    }
    if (roleAgent !== artifactAgent) {
      errors.push(err(PLAN_CODES.ROLE_ARTIFACT_MISMATCH,
        `work item "${item.id}" recommends role "${item.recommended_role}" (-> ${roleAgent}) but artifact_type "${item.artifact_type}" requires ${artifactAgent}`));
      continue;
    }
    agentFor.set(item.id, artifactAgent);
  }

  // --- coverage gate: every non-satisfied criterion needs at least one work item ---
  for (const c of criteria) {
    if (!COVERED_STATUSES.has(c.status) && (coverage[c.id]?.count ?? 0) === 0) {
      errors.push(err(PLAN_CODES.UNCOVERED_ACCEPTANCE, `acceptance criterion "${c.id}" (status ${c.status}) is not covered by any work item`));
    }
  }

  if (errors.length) return fail(errors[0].split(':')[0], errors);

  // A plan with nothing outstanding is vacuously valid: no tasks, no errors.
  if (!items.length) return { ok: true, code: null, planner: 'adaptive', tasks: [], coverage, errors: [] };

  // --- emit newTask-compatible specs, then route + bound them through validatePlan ---
  const specs = items.map(item => ({
    id: item.id,
    title: item.title,
    goal: item.likely_files?.length ? `${item.description}\nLikely files: ${item.likely_files.join(', ')}` : item.description,
    agent: agentFor.get(item.id),
    kind: ARTIFACT_KINDS[item.artifact_type] ?? 'implement',
    artifact_type: item.artifact_type,
    expected_outcome: expectedOutcomeForArtifact(item.artifact_type),
    dependencies: [...item.depends_on],
    acceptance: item.acceptance_ids.map(id => {
      const c = criterionById.get(id);
      return c?.description ? `${id}: ${c.description}` : id;
    }),
    // Provenance is persisted on task payloads; outputs are reserved for actual files.
    outputs: [],
    sourceWorkItemId: item.id,
    acceptanceIds: [...item.acceptance_ids],
    estimatedComplexity: item.estimated_complexity,
    recommendedRole: item.recommended_role,
    dependsOn: [...item.depends_on],
    likelyFiles: [...item.likely_files],
    planningRef,
  }));

  const { errors: planErrors, tasks } = validatePlan(specs, { agents, routing, policy, existingIds });
  if (planErrors.length) {
    const all = planErrors.map(e => err(PLAN_CODES.INVALID_PLAN, e));
    return fail(PLAN_CODES.INVALID_PLAN, all);
  }

  // Merge the routed shape (assignedAgent/capability) with our provenance.
  const bySpec = new Map(specs.map(s => [s.id, s]));
  const routed = tasks.map(t => ({ ...bySpec.get(t.id), ...t, agent: t.assignedAgent }));
  return { ok: true, code: null, planner: 'adaptive', tasks: routed, coverage, errors: [] };
}

export { ARTIFACT_TYPES };
