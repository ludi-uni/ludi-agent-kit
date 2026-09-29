// Controlled long-form Strategy Evolution Lab workload. The production orchestrate
// path owns all decisions; only worker outputs and a disposable workspace are stubbed.
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../../lib/routing.mjs';
import { loadAgents } from '../../lib/agents.mjs';
import { DEFAULT_POLICY, mergePolicy } from '../../lib/orchestrator/policy.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const routing = structuredClone(loadRouting(join(kit, 'routing/routing.json')));
for (const [id, cls, cost] of [['a', 'standard', 'free'], ['b', 'strong', 'free'], ['c', 'expert', 'paid']])
  routing.backends[id] = { tier: cost === 'paid' ? 'high' : 'free', capability_class: cls, cost_class: cost,
    availability_class: 'available', roles: ['coder', 'tester', 'scout', 'reviewer', 'design-planner'], vision: false };
for (const capability of ['cheap-code', 'strong-code', 'deep-review'])
  routing.capabilities[capability] = { primary: 'a', fallback: ['b', 'c'] };
export const registry = { version: 1, backends: Object.fromEntries(['a', 'b', 'c'].map(id => [id, { provider: 'fixture', model: id }])) };
export const { agents } = loadAgents(join(kit, 'agents'), routing);
export const policy = mergePolicy(DEFAULT_POLICY, { limits: { max_tasks: 36, max_rounds: 60, max_retries: 1, max_review_rounds_per_run: 12 },
  decision_policy: { max_parallel_tasks: 1 }, agent_runtime: { max_turns: 32, absolute_max_turns: 64,
    turn_budgets: { coder: { simple: 32, normal: 32, heavy: 32, 'repo-history-heavy': 32 } } } });
export const request = 'Strategy Evolution Lab: investigate current state; verify baseline; implement storage and paused-run recovery; comparison framework, multi-seed experiments, bias/leakage audit, documentation and final verification. No paid models. Preserve existing dirty worktree changes.';
export const criteria = [
  ['AC_STATE', 'Current state investigated'], ['AC_BASE', 'Baseline verified'], ['AC_RESUME', 'Paused-run recovery verified'],
  ['AC_COMPARE', 'Comparison framework works'], ['AC_SEEDS', 'Multi-seed experiment runs'], ['AC_S1', 'CLI isolated'],
  ['AC_S2', 'Storage adapter isolated'], ['AC_S3', 'Audit export isolated'], ['AC_ROLE', 'Investigation completed'],
  ['AC_ESC', 'Capability issue resolved'], ['AC_AUDIT', 'Scientific audit evidence obtained'], ['AC_DOC', 'Documentation written'],
  ['AC_PLAN', 'Integration assumptions verified'],
].map(([id, description]) => ({ id, description, source: 'user_request' }));
const work = (id, role, artifact, ids, deps = [], description = id) => ({ id, title: id, description, depends_on: deps,
  acceptance_ids: ids, estimated_complexity: 'medium', recommended_role: role, artifact_type: artifact, likely_files: [] });
export function initialPlan() { return { goal_summary: request, current_state: 'baseline', acceptance_criteria: criteria.map(c => ({ ...c, status: 'pending' })),
  work_items: [
    work('t1', 'investigator', 'investigation', ['AC_STATE']), work('t2', 'tester', 'test_result', ['AC_BASE'], ['t1']),
    work('t3', 'coder', 'code_change', ['AC_RESUME'], ['t2'], 'Implement storage and paused-run recovery'),
    work('t4', 'coder', 'code_change', ['AC_COMPARE'], ['t3'], 'Build comparison framework'),
    work('t5', 'investigator', 'experiment_result', ['AC_SEEDS'], ['t4'], 'Run multi-seed experiments'),
    work('t6', 'coder', 'code_change', ['AC_S1', 'AC_S2', 'AC_S3'], ['t5'], 'Separate CLI storage and audit exports'),
    work('t7', 'coder', 'code_change', ['AC_ROLE'], ['t6'], 'Investigate unexplained experiment bias'),
    work('t8', 'coder', 'code_change', ['AC_ESC'], ['t7'], 'Implement bounded comparison validation'),
    work('t9', 'auditor', 'audit_report', ['AC_AUDIT'], ['t8'], 'Audit bias and leakage'),
    work('t10', 'documentation', 'documentation', ['AC_DOC'], ['t9'], 'Document reproducible experiments'),
    work('t11', 'auditor', 'audit_report', ['AC_RESUME', 'AC_AUDIT', 'AC_SEEDS'], ['t10'], 'Review integration defects and evidence'),
    work('t12', 'tester', 'test_result', ['AC_PLAN'], ['t11'], 'Verify integration assumptions'),
    work('t13', 'tester', 'test_result', ['AC_DOC'], ['t12'], 'Verify documentation handoff after integration'),
  ], risks: [], environment_constraints: [], unknowns: [] }; }
const replan = () => ({ goal_summary: request, current_state: 'verified work preserved', acceptance_criteria: criteria.map(c => ({ ...c, status: 'pending' })),
  work_items: [work('residual', 'coder', 'code_change', ['AC_PLAN'], [], 'Repair runtime/storage/comparison integration assumption only')], risks: [], environment_constraints: [], unknowns: [] });
const finding = (task, id, cls, title, ids, files, scope, extra = {}) => ({ id, source_task_id: task.id, severity: 'blocking', classification: cls, title,
  description: title, evidence: [{ type: 'test_result', command: `probe ${id}`, result: 'fail' }],
  affected_acceptance_ids: ids, affected_files: files, suggested_scope: { summary: scope, affected_acceptance_ids: ids,
    affected_files: files, subsystems: ['runtime'], estimated_complexity: 'small', ...extra }, confidence: 0.9 });
const report = (task, status, remaining = [], steps = [], termination = 'unknown') => ({ task_id: task.id, status,
  termination_reason: termination, completed_acceptance: [], completed_steps: steps, remaining_work: remaining,
  blocked_work: [], files_touched: steps.length ? ['storage.py'] : [], tests_run: [], artifacts: [], environment_constraints: [], handoff_notes: [] });
const completeProgress = (task, step) => ({ ...report(task, 'completed', [], [step], 'completed'),
  completed_acceptance: task.acceptanceIds.map(id => ({ acceptance_id: id,
    evidence: [{ type: 'test_result', command: `verify ${task.id}`, result: 'pass' }] })),
  tests_run: [{ command: `verify ${task.id}`, result: 'pass' }] });
const ok = (task, extra = {}) => {
  const code = task.artifact_type === 'code_change';
  const path = task.affectedFiles?.[0] ?? `${task.id}.artifact.py`;
  return { ok: true, structured: true, modelId: task.executionRoute?.modelId ?? 'fixture/a',
    backend: task.executionRoute?.backend ?? 'a',
    worktree: { before: { source: 'git' }, agentChanges: code ? [{ path }] : [] },
    result: { status: 'completed', summary: `completed ${task.id}`,
      artifacts: ['documentation', 'audit_report', 'design_report'].includes(task.artifact_type) ? [`${task.id}.report`] : [],
      acceptance: task.acceptance.map((_, i) => ({ id: `A${i + 1}`, met: true, evidence: `verify ${task.id}` })),
      evidence: task.acceptance.map((_, i) => ({ type: 'command_result', source: 'verification', result: 'pass', related_acceptance: `A${i + 1}`, command: `verify ${task.id}` })),
      verification: [{ command: `verify ${task.id}`, result: 'pass' }], remainingIssues: [], reviewFindings: [], ...extra } };
};
export function createFixtureRunner(repo) {
  return { async run(task) {
    if (task.kind === 'design-plan') return { ok: true, structured: true, result: { status: 'completed', planningReport: task.replanContext ? replan() : initialPlan() } };
    if (['audit_report', 'documentation'].includes(task.artifact_type)) writeFileSync(join(repo, `${task.id}.report`), `controlled ${task.id} report\n`);
    if (task.id === 't3' && task.attempts === 1) {
      writeFileSync(join(repo, 'storage.py'), 'storage + resume core\n');
      return { ok: false, structured: true, failureClass: 'PROGRESS_TIMEOUT', child: { stopReason: 'absolute-turn-limit', turns: 20, toolCalls: 5 },
        result: { status: 'partial', summary: 'storage/resume core done; CLI and test pending', progressReport: report(task, 'partial', [
          { id: 'cli', description: 'Wire resume CLI', acceptance_ids: ['AC_RESUME'], estimated_complexity: 'small' },
          { id: 'test', description: 'Verify paused-run recovery', acceptance_ids: ['AC_RESUME'], estimated_complexity: 'small' }], ['storage core', 'resume loader'], 'turn_limit') } };
    }
    if (task.id === 't3.c1') return ok(task, { progressReport: completeProgress(task, 'CLI and tests verified') });
    if (task.id === 't4' && task.attempts === 1) return { ok: false, structured: true, failureClass: 'PROGRESS_TIMEOUT',
      child: { stopReason: 'absolute-turn-limit', turns: 32, toolCalls: 7, lastProgressTurn: 30, lastProgressToolCall: 7 },
      result: { status: 'partial', summary: 'comparison core done', progressReport: report(task, 'partial', [
        { id: 'integration', description: 'Run final comparison integration test', acceptance_ids: ['AC_COMPARE'], estimated_complexity: 'small' }], ['comparison core implemented'], 'turn_limit') } };
    if (task.id === 't4.c1') return ok(task, { progressReport: completeProgress(task, 'integration check passed') });
    if (task.id === 't5' && task.attempts === 1) return { ok: false, error: 'UND_ERR_SOCKET: remote side closed', failureClass: 'TOOL_FAILURE' };
    if (task.id === 't6' && task.attempts === 1) return { ok: false, structured: true, failureClass: 'PROGRESS_TIMEOUT', child: { stopReason: 'absolute-turn-limit', turns: 24, toolCalls: 6 },
      result: { status: 'failed', summary: 'three independent residuals', progressReport: report(task, 'failed', [
        { id: 'cli', description: 'Complete isolated CLI', acceptance_ids: ['AC_S1'], estimated_complexity: 'small' },
        { id: 'storage', description: 'Complete isolated storage adapter', acceptance_ids: ['AC_S2'], estimated_complexity: 'small' },
        { id: 'audit', description: 'Complete isolated audit export', acceptance_ids: ['AC_S3'], estimated_complexity: 'small' }], ['base runner implemented'], 'turn_limit') } };
    if (task.id === 't7' && task.assignedAgent === 'coder') return { ok: true, structured: true, error: 'investigation role needed',
      result: { status: 'failed', summary: 'should be an investigator', progressReport: { ...report(task, 'failed', [], ['scope diagnosed']), handoff_notes: ['should be an investigator'] } } };
    if (task.id === 't8' && task.executionRoute?.backend === 'a') return { ok: true, structured: true, modelId: 'fixture/a', backend: 'a',
      result: { status: 'failed', summary: 'same implementation reasoning failure', progressReport: report(task, 'failed') } };
    if (task.id === 't11') { const reviewFindings = [
      finding(task, 'ENV', 'environment_limitation', 'shell allowlist prevented DB audit verification', ['AC_AUDIT'], ['audit.py'], 'Verify audit through read-only alternate API', { alternate_path: 'Use read-only AST audit API' }),
      finding(task, 'DEFECT', 'project_defect', 'resume generation increment defect', ['AC_RESUME'], ['runner.py'], 'Fix resume generation increment in runner.py and test AC_RESUME'),
      finding(task, 'EVIDENCE', 'insufficient_evidence', 'multi-seed evidence not recorded', ['AC_SEEDS'], ['seeds.py'], 'Run evidence-only multi-seed verification'),
      finding(task, 'PLAN', 'project_defect', 'runtime storage comparison planning assumption contradicted', ['AC_PLAN'],
        ['runtime.py', 'storage.py', 'comparison.py'], 'Replan runtime/storage/comparison integration',
        { subsystems: ['runtime', 'storage', 'comparison'], estimated_complexity: 'large', planning_assumption_invalid: true }),
    ]; return ok(task, { reviewFindings: [...reviewFindings, { ...reviewFindings[1] }] }); }
    if (task.repairScope) {
      writeFileSync(join(repo, 'runner.py'), 'resume generation increment fixed\n');
      return ok(task);
    }
    if (task.kind === 'investigate' && task.sourceFindingIds?.some(id => id.endsWith('/ENV'))) return ok(task, { verification: [{ command: `verify ${task.id}`, result: 'pass' }, { command: 'read-only AST audit API', result: 'pass' }] });
    return ok(task);
  } };
}
