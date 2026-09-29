// Phase 7: strict review finding contract and bounded, side-effect-free action policy.
import { FINDING_CLASSES } from './planning-contract.mjs';

export const FINDING_STATUSES = Object.freeze(['open', 'repairing', 'awaiting_reverification', 'resolved', 'blocked', 'rejected', 'superseded']);
export const FINDING_ACTIONS = Object.freeze(['accept', 'repair', 'investigate', 'reverify', 'replan', 'blocked', 'approval_required', 'ignore_duplicate']);
export const REVIEW_LIMITS = Object.freeze({ maxRepairsPerFinding: 1, maxRepairRoundsPerRootTask: 2, maxReplansPerRun: 2, maxReviewRoundsPerRun: 4 });
const severities = new Set(['info', 'low', 'medium', 'high', 'critical', 'blocking']);
const clean = text => String(text).trim().replace(/\s+/g, ' ');
const list = a => Array.isArray(a) && a.every(x => typeof x === 'string' && !!x.trim());

/** Legacy remainingIssues are observations, never implicit code-change orders. */
export function normalizeLegacyReviewIssue(issue, task) {
  const description = clean(issue?.description ?? issue?.summary ?? '');
  if (!description || !(issue?.blocking || ['high', 'critical', 'blocking'].includes(issue?.severity))) return null;
  const environment = /POLICY_BLOCK|policy.block|shell|allowlist|sandbox|tool unavailable|provider.*(execution|disconnect)|実行.*(拒否|制限)|ツール.*使用不可/i.test(description);
  const classification = environment ? 'environment_limitation' : issue.classification === 'test_failure' ? 'test_failure' : 'project_defect';
  const affected_acceptance_ids = issue.affected_acceptance_ids ?? task.acceptanceIds ?? [];
  const affected_files = environment ? [] : issue.affected_files ?? [];
  const scope = { summary: environment ? `Verify execution availability before changing project code: ${description}` : description,
    affected_acceptance_ids, affected_files, subsystems: [], estimated_complexity: 'small',
    ...(issue.alternate_path ? { alternate_path: issue.alternate_path } : {}) };
  return { id: `legacy-${String(issue.id ?? description).replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60)}`,
    source_task_id: task.id, severity: issue.severity ?? 'blocking', classification,
    title: description.slice(0, 100), description,
    evidence: issue.evidence?.length ? issue.evidence : [{ type: 'review_observation', source: 'legacy_remainingIssues', result: 'reported', detail: description }],
    affected_acceptance_ids, affected_files, suggested_scope: scope, suggested_action: environment ? 'investigate' : 'review', confidence: 0.5 };
}

export function parseReviewFinding(raw, { sourceTaskId, acceptanceIds = [] } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('finding: structured object required');
  for (const k of ['id', 'source_task_id', 'severity', 'classification', 'title', 'description', 'evidence', 'affected_acceptance_ids', 'affected_files', 'suggested_scope', 'confidence'])
    if (!Object.hasOwn(raw, k)) throw new Error(`finding: ${k} required`);
  for (const k of ['id', 'source_task_id', 'title', 'description']) if (typeof raw[k] !== 'string' || !raw[k].trim()) throw new Error(`finding: ${k} must be nonempty`);
  if (sourceTaskId && raw.source_task_id !== sourceTaskId) throw new Error('finding: source_task_id mismatch');
  if (!severities.has(raw.severity) || !FINDING_CLASSES.includes(raw.classification)) throw new Error('finding: invalid severity or classification');
  if (!Array.isArray(raw.evidence) || !raw.evidence.length || raw.evidence.some(x => !x || typeof x !== 'object' || Array.isArray(x) || !Object.keys(x).length)) throw new Error('finding: concrete evidence objects required');
  if (!list(raw.affected_acceptance_ids) || !list(raw.affected_files)) throw new Error('finding: affected ids/files must be string arrays');
  if (acceptanceIds.length && raw.affected_acceptance_ids.some(id => !acceptanceIds.includes(id))) throw new Error('finding: unknown acceptance id');
  if (typeof raw.confidence !== 'number' || raw.confidence < 0 || raw.confidence > 1) throw new Error('finding: confidence must be in [0,1]');
  const scope = raw.suggested_scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || typeof scope.summary !== 'string' || !scope.summary.trim()
    || !list(scope.affected_acceptance_ids ?? []) || !list(scope.affected_files ?? [])
    || !list(scope.subsystems ?? [])) throw new Error('finding: suggested_scope must contain summary and optional string arrays');
  return structuredClone({ ...raw, affected_acceptance_ids: [...new Set(raw.affected_acceptance_ids)], affected_files: [...new Set(raw.affected_files)] });
}

export function findingSignature(f) {
  const desc = clean(f.description).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return JSON.stringify([f.classification, [...f.affected_acceptance_ids].sort(), [...f.affected_files].sort(), desc]);
}

export function validateRepairScope(f) {
  const scope = f.suggested_scope;
  const files = scope.affected_files ?? f.affected_files;
  const criteria = scope.affected_acceptance_ids ?? f.affected_acceptance_ids;
  const errors = [];
  if (!f.affected_files.length || !f.affected_acceptance_ids.length) errors.push('repair requires explicit affected files and acceptance criteria');
  if (files.some(file => !f.affected_files.includes(file)) || criteria.some(id => !f.affected_acceptance_ids.includes(id))) errors.push('repair expands beyond finding files/acceptance');
  if (/\b(entire|whole|all)\s+(repo|repository|project|application)\b|リポジトリ全体|プロジェクト全体/i.test(scope.summary)) errors.push('repair scope expands to entire project');
  if (scope.estimated_complexity === 'large' || scope.planning_assumption_invalid || scope.graph_invalid || (scope.subsystems ?? []).length > 1 || f.affected_acceptance_ids.length > 2) errors.push('scope requires replanning');
  return { ok: errors.length === 0, errors };
}

export function decideReviewFinding(f, { existing = [], alternatePath = null, repairsForFinding = 0, repairRoundsForRoot = 0, reviewRounds = 0,
  replanCount = 0, limits = REVIEW_LIMITS, failedRepairHistory = [] } = {}) {
  const counts = { ...REVIEW_LIMITS, ...limits };
  const signature = findingSignature(f);
  const prior = existing.find(x => x.signature === signature && x.status !== 'rejected' && x.status !== 'superseded');
  const result = (action, reason) => ({ action, reason, sourceFindingId: f.id, signature, policyRule: `review.${action}` });
  if (prior) return { ...result('ignore_duplicate', 'same finding signature already recorded'), existingFindingId: prior.id, repairTaskId: prior.repairTaskId };
  if (reviewRounds >= counts.maxReviewRoundsPerRun) return result('blocked', 'REVIEW_ROUND_LIMIT_EXCEEDED');
  if (f.classification === 'environment_limitation') return result(alternatePath ? 'investigate' : 'blocked', 'environment restriction is not a project defect');
  if (f.classification === 'insufficient_evidence') return result(f.affected_acceptance_ids.length ? 'reverify' : 'investigate', 'gather evidence without changing implementation');
  if (f.classification === 'external_blocker') return result('blocked', 'external blocker requires an external change');
  if (f.classification === 'requirement_ambiguity') return result('approval_required', 'human specification decision required');
  const scope = validateRepairScope(f);
  const repeated = repairsForFinding >= counts.maxRepairsPerFinding || repairRoundsForRoot >= counts.maxRepairRoundsPerRootTask || failedRepairHistory.length >= counts.maxRepairsPerFinding;
  if (!scope.ok || repeated) return replanCount >= counts.maxReplansPerRun
    ? result('blocked', 'REPLAN_LIMIT_EXCEEDED') : result('replan', `${repeated ? 'focused repair failed repeatedly' : scope.errors.join('; ')}; design replanning required`);
  return result('repair', 'bounded project defect or test failure with explicit local scope');
}

export function focusedRepairSpec(f, reviewTask, index, acceptanceLedger = []) {
  const scope = validateRepairScope(f);
  if (!scope.ok) throw new Error(`repair scope rejected: ${scope.errors.join('; ')}`);
  const ids = f.affected_acceptance_ids;
  return { title: `Repair ${f.id}: ${clean(f.title).slice(0, 100)}`,
    goal: clean(f.suggested_scope.summary).slice(0, 320), kind: 'implement', artifact_type: 'code_change',
    expected_outcome: f.suggested_scope.allow_refutation === true ? 'evidence_or_change' : 'code_change_required',
    assignedAgent: 'coder', acceptanceIds: ids, acceptance: ids.map(id => `${id}: ${acceptanceLedger.find(c => c.id === id)?.description ?? id}`),
    likelyFiles: [...f.affected_files], sourceFindingIds: [f.id], sourceReviewTaskId: reviewTask.id,
    affectedAcceptanceIds: ids, affectedFiles: [...f.affected_files], repairScope: structuredClone(f.suggested_scope),
    rootTaskId: reviewTask.rootTaskId ?? reviewTask.id, repairIndex: index, recommendedRole: 'coder',
    artifactType: 'code_change' };
}

export function completionGate({ tasks = [], ledger = [], findings = [], pendingApprovals = [] } = {}) {
  const issues = [];
  for (const c of ledger) if (c.status !== 'satisfied') issues.push(`acceptance ${c.id} is ${c.status}`);
  for (const f of findings) if ((['open', 'repairing', 'awaiting_reverification'].includes(f.status)
    && (['project_defect', 'test_failure'].includes(f.classification) && ['blocking', 'high', 'critical'].includes(f.severity)
      || f.status === 'awaiting_reverification')) || f.status === 'resolved' && !f.resolutionEvidence?.verification?.some(v => v.result === 'pass'))
    issues.push(`finding ${f.id} requires resolution/reverification evidence`);
  if (pendingApprovals.length || tasks.some(t => t.status === 'waiting_for_user')) issues.push('approval required');
  if (tasks.some(t => t.kind === 'reverify' && t.status !== 'completed' && t.status !== 'superseded')) issues.push('reverification pending');
  return { allowed: !issues.length, issues };
}
