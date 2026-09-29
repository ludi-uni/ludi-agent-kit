// Phase 1 data contract. Validation has no side effects and never schedules tasks.
import { ARTIFACT_TYPES } from './task-store.mjs';

export const ACCEPTANCE_STATUSES = Object.freeze(['pending', 'in_progress', 'satisfied', 'failed', 'blocked', 'unknown']);
export const FINDING_CLASSES = Object.freeze(['project_defect', 'environment_limitation', 'insufficient_evidence', 'external_blocker', 'requirement_ambiguity', 'test_failure']);
export const COMPLEXITIES = Object.freeze(['small', 'medium', 'large', 'unknown']);

/** @typedef {{originalRequest: string, goalSummary: string, constraints: string[], userDecisions: string[]}} ImmutableGoal */
/** The original request cannot be overridden by a supplied summary or constraint snapshot. */
export function canonicalGoal(request, { goalSummary, constraints = [], userDecisions = [] } = {}) {
  if (typeof request !== 'string' || !request.trim()) throw new Error('goal: original request is required');
  if (goalSummary != null && (typeof goalSummary !== 'string' || !goalSummary.trim())) throw new Error('goal: invalid summary');
  if (![constraints, userDecisions].every(a => Array.isArray(a) && a.every(x => typeof x === 'string'))) throw new Error('goal: constraints and user decisions must be string arrays');
  return { originalRequest: request, goalSummary: goalSummary ?? request.replace(/\s+/g, ' ').trim(), constraints: [...constraints], userDecisions: [...userDecisions] };
}

/** Explicit classification: environment limitations are never implicitly project defects. */
export function classifyFinding(finding) {
  if (!finding || typeof finding !== 'object' || !FINDING_CLASSES.includes(finding.classification)) throw new Error('finding: explicit classification is required');
  return finding.classification;
}

const string = x => typeof x === 'string' && x.trim().length > 0;
const strings = x => Array.isArray(x) && x.every(string);
const required = (obj, fields, prefix, errors) => {
  for (const field of fields) if (!Object.hasOwn(obj, field)) errors.push(`${prefix}.${field} is required`);
};

/** @typedef {'pending'|'in_progress'|'satisfied'|'failed'|'blocked'|'unknown'} AcceptanceStatus */
/** @typedef {'project_defect'|'environment_limitation'|'insufficient_evidence'|'external_blocker'|'requirement_ambiguity'|'test_failure'} FindingClassification */
/** @typedef {'code_change'|'test_result'|'design_report'|'audit_report'|'experiment_result'|'investigation'|'documentation'} ArtifactType */
/** @typedef {{id: string, description: string, source: string, status?: AcceptanceStatus, evidence?: object[]}} AcceptanceCriterion */
/** @typedef {{id: string, title: string, description: string, depends_on: string[], acceptance_ids: string[], estimated_complexity: 'small'|'medium'|'large'|'unknown', recommended_role: string, artifact_type: ArtifactType, likely_files: string[]}} PlanningWorkItem */
/** @typedef {{goal_summary: string, current_state: string, acceptance_criteria: AcceptanceCriterion[], work_items: PlanningWorkItem[], risks: string[], environment_constraints: string[], unknowns: string[], findings?: {classification: FindingClassification}[]}} PlanningReport */
/** Parse a JSON object or string. Returns a validated report or throws; never executes it. */
export function parsePlanningReport(input) {
  let report;
  try { report = typeof input === 'string' ? JSON.parse(input) : input; } catch { throw new Error('planning report: invalid JSON'); }
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('planning report: expected object');
  const errors = [];
  required(report, ['goal_summary', 'current_state', 'acceptance_criteria', 'work_items', 'risks', 'environment_constraints', 'unknowns'], 'report', errors);
  for (const key of ['goal_summary', 'current_state']) if (!string(report[key])) errors.push(`report.${key} must be a nonempty string`);
  for (const key of ['risks', 'environment_constraints', 'unknowns']) if (!strings(report[key])) errors.push(`report.${key} must be a string array`);
  const criteria = Array.isArray(report.acceptance_criteria) ? report.acceptance_criteria : [];
  if (!Array.isArray(report.acceptance_criteria)) errors.push('report.acceptance_criteria must be an array');
  const criterionIds = new Set();
  criteria.forEach((c, i) => {
    if (!c || typeof c !== 'object' || !string(c.id) || !string(c.description) || !string(c.source)) errors.push(`criterion ${i}: id, description and source are required`);
    else if (criterionIds.has(c.id)) errors.push(`criterion ${i}: duplicate id`);
    else criterionIds.add(c.id);
    if (c?.status != null && !ACCEPTANCE_STATUSES.includes(c.status)) errors.push(`criterion ${i}: invalid status`);
    if (c?.evidence != null && !Array.isArray(c.evidence)) errors.push(`criterion ${i}: invalid evidence`);
  });
  const items = Array.isArray(report.work_items) ? report.work_items : [];
  if (!Array.isArray(report.work_items)) errors.push('report.work_items must be an array');
  const itemIds = new Set();
  items.forEach((item, i) => {
    if (!item || typeof item !== 'object') { errors.push(`work item ${i}: expected object`); return; }
    const fields = ['id', 'title', 'description', 'depends_on', 'acceptance_ids', 'estimated_complexity', 'recommended_role', 'artifact_type', 'likely_files'];
    required(item, fields, `work item ${i}`, errors);
    for (const field of ['id', 'title', 'description', 'recommended_role']) if (!string(item[field])) errors.push(`work item ${i}: ${field} must be a nonempty string`);
    if (string(item.id)) { if (itemIds.has(item.id)) errors.push(`work item ${i}: duplicate id`); itemIds.add(item.id); }
    for (const field of ['depends_on', 'acceptance_ids', 'likely_files']) if (!strings(item[field])) errors.push(`work item ${i}: ${field} must be a string array`);
    if (!COMPLEXITIES.includes(item.estimated_complexity)) errors.push(`work item ${i}: invalid estimated_complexity`);
    if (!ARTIFACT_TYPES.includes(item.artifact_type)) errors.push(`work item ${i}: invalid artifact_type`);
  });
  items.forEach((item, i) => {
    for (const id of item?.depends_on ?? []) if (!itemIds.has(id) || id === item.id) errors.push(`work item ${i}: unknown or self dependency ${id}`);
    for (const id of item?.acceptance_ids ?? []) if (!criterionIds.has(id)) errors.push(`work item ${i}: unknown acceptance id ${id}`);
  });
  if (report.findings != null) {
    if (!Array.isArray(report.findings)) errors.push('report.findings must be an array');
    else report.findings.forEach((finding, i) => {
      try { classifyFinding(finding); } catch { errors.push(`finding ${i}: invalid classification`); }
    });
  }
  if (errors.length) throw new Error(`planning report: ${errors.join('; ')}`);
  return report;
}
