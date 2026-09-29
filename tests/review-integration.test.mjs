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

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const registry = { version: 1, backends: { local: { provider: 'test', model: 'local' }, cheap: { provider: 'test', model: 'cheap' }, sol: { provider: 'test', model: 'sol' }, astra: { provider: 'test', model: 'astra' }, codex: { provider: 'test', model: 'codex' } } };
const file = () => join(mkdtempSync(join(tmpdir(), 'ludi-review-')), 'state.db');
const criteria = [{ id: 'AC_RESUME', description: 'resume generation', source: 'user_request' }];
const item = (id, role, type, deps = [], ids = ['AC_RESUME']) => ({ id, title: id, description: `Implement ${id}`, depends_on: deps,
  acceptance_ids: ids, estimated_complexity: 'small', recommended_role: role, artifact_type: type, likely_files: [] });
const plan = (work = [item('impl', 'coder', 'code_change'), item('review', 'auditor', 'audit_report', ['impl'])], cs = criteria) => ({
  goal_summary: 'Strategy Evolution Lab', current_state: 'baseline', acceptance_criteria: cs.map(c => ({ ...c, status: 'pending' })),
  work_items: work, risks: [], environment_constraints: [], unknowns: [] });
const finding = (source, over = {}) => ({ id: 'F1', source_task_id: source, severity: 'blocking', classification: 'project_defect',
  title: 'resume generation increment', description: 'paused-run resume generation increment is incorrect',
  evidence: [{ type: 'test_result', command: 'pytest resume', result: 'fail' }], affected_acceptance_ids: ['AC_RESUME'], affected_files: ['runner.py'],
  suggested_scope: { summary: 'Fix paused-run resume generation increment in runner.py and add regression coverage for AC_RESUME',
    affected_acceptance_ids: ['AC_RESUME'], affected_files: ['runner.py'], subsystems: ['runtime'], estimated_complexity: 'small' }, confidence: 0.9, ...over });
const success = (task, extra = {}) => ({ ok: true, structured: true,
  worktree: { before: { source: 'git' }, agentChanges: task.artifact_type === 'code_change' ? [{ path: task.affectedFiles?.[0] ?? `${task.id}.py` }] : [] },
  result: { status: 'completed', summary: `verified ${task.id}`, artifacts: task.artifact_type === 'audit_report' ? [`audit-${task.id}.json`] : [],
  acceptance: (task.acceptance ?? []).map((_, i) => ({ id: `A${i + 1}`, met: true, evidence: 'pytest resume' })),
  evidence: (task.acceptance ?? []).map((_, i) => ({ type: 'command_result', source: 'verification', result: 'pass', related_acceptance: `A${i + 1}`, command: 'pytest resume' })),
  verification: [{ command: 'pytest resume', result: 'pass' }], remainingIssues: [], ...extra } });
const options = (session, runner, p = plan(), cs = criteria) => ({ request: 'Strategy Evolution Lab', planner: 'adaptive', acceptanceCriteria: cs,
  agents, routing, registry, policy: DEFAULT_POLICY, session, runner: { async run(task, ctx) {
    if (task.kind === 'design-plan') return { ok: true, structured: true, result: { status: 'completed', planningReport: p } };
    return runner(task, ctx);
  } } });

test('Scenario 1: implementation -> reviewer defect -> focused repair -> evidence-based reverify -> resolved', async () => {
  const db = file(), session = openStore(db); let runId; const visited = [];
  try {
    const out = await orchestrate(options(session, task => {
      visited.push([task.id, task.kind, task.goal]);
      if (task.id === 'review') return success(task, { reviewFindings: [finding('review')] });
      if (task.kind === 'reverify') return success(task, { verification: [{ command: 'pytest resume', result: 'pass' }] });
      return success(task);
    }));
    runId = out.runId;
    assert.equal(out.status, 'completed');
    assert.deepEqual(visited.map(x => x[1]), ['implement', 'review', 'implement', 'reverify']);
    const repair = out.tasks.find(t => t.repairScope);
    assert.ok(repair);
    assert.deepEqual(repair.sourceFindingIds, ['review/F1']);
    assert.deepEqual(repair.affectedAcceptanceIds, ['AC_RESUME']);
    assert.deepEqual(repair.affectedFiles, ['runner.py']);
    assert.doesNotMatch(repair.goal, /Strategy Evolution Lab/);
    assert.equal(repair.sourceReviewTaskId, 'review');
    assert.equal(out.reviewFindings[0].status, 'resolved');
    assert.equal(out.reviewFindings[0].resolutionEvidence.verification[0].result, 'pass');
    assert.equal(session.getAcceptanceLedger(runId)[0].status, 'satisfied');
    assert.ok(session.getAcceptanceLedger(runId)[0].evidence.some(e => /reopened by finding/.test(e.detail)));
    assert.deepEqual(out.findingDecisions.map(x => x.action), ['repair']);
  } finally { session.close(); }
  const reopened = openStore(db);
  try {
    const before = reopened.loadTasks(runId).length;
    const again = await orchestrate({ ...options(reopened, () => { throw Error('no replay'); }), resumeRunId: runId });
    assert.equal(again.status, 'completed');
    assert.equal(reopened.loadTasks(runId).length, before);
    assert.equal(again.reviewFindings[0].status, 'resolved');
  } finally { reopened.close(); }
});

test('repair completion without reverify evidence cannot resolve the finding or re-satisfy acceptance', async () => {
  const session = openStore(file());
  try {
    const out = await orchestrate(options(session, task => task.id === 'review'
      ? success(task, { reviewFindings: [finding('review')] })
      : task.kind === 'reverify' ? success(task, { verification: [], evidence: [] }) : success(task)));
    assert.equal(out.status, 'incomplete');
    assert.notEqual(out.reviewFindings[0].status, 'resolved');
    assert.equal(session.getAcceptanceLedger(out.runId)[0].status, 'in_progress');
  } finally { session.close(); }
});

test('two independent reviewers reporting the same defect create one repair linked to both findings', async () => {
  const session = openStore(file());
  const p = plan([item('impl', 'coder', 'code_change'), item('review', 'auditor', 'audit_report', ['impl']),
    item('review2', 'auditor', 'audit_report', ['impl'])]);
  try {
    const out = await orchestrate(options(session, task => {
      if (task.id === 'review2') return success(task, { reviewFindings: [finding('review2', { id: 'F2',
        description: 'Paused-run RESUME generation increment is incorrect!' })] });
      if (task.id === 'review') return success(task, { reviewFindings: [finding('review')] });
      if (task.kind === 'reverify') return success(task, { verification: [{ command: 'pytest resume', result: 'pass' }] });
      return success(task);
    }, p));
    assert.equal(out.status, 'completed');
    assert.deepEqual(out.findingDecisions.map(d => d.action), ['repair', 'ignore_duplicate']);
    assert.equal(out.tasks.filter(t => t.repairScope).length, 1);
    assert.equal(out.tasks.find(t => t.repairScope).sourceFindingIds.length, 2);
    assert.deepEqual(out.reviewFindings.map(f => f.status), ['resolved', 'resolved']);
  } finally { session.close(); }
});

test('insufficient evidence routes to reverify and cannot create code repair', async () => {
  const session = openStore(file());
  try {
    const out = await orchestrate(options(session, task => task.id === 'review'
      ? success(task, { reviewFindings: [finding('review', { classification: 'insufficient_evidence', description: 'test result missing' })] })
      : task.kind === 'reverify' ? success(task, { verification: [{ command: 'pytest resume', result: 'pass' }] }) : success(task)));
    assert.equal(out.status, 'completed');
    assert.equal(out.findingDecisions[0].action, 'reverify');
    assert.equal(out.tasks.filter(t => t.repairScope).length, 0);
    assert.equal(out.reviewFindings[0].status, 'resolved');
  } finally { session.close(); }
});

test('Scenario 2: blocking shell environment finding never creates project repair', async () => {
  const session = openStore(file());
  try {
    const out = await orchestrate(options(session, task => task.id === 'review'
      ? success(task, { reviewFindings: [finding('review', { classification: 'environment_limitation', description: 'shell allowlist prevented DB verification' })] })
      : success(task)));
    assert.equal(out.status, 'incomplete');
    assert.equal(out.reviewFindings[0].classification, 'environment_limitation');
    assert.equal(out.reviewFindings[0].status, 'blocked');
    assert.equal(out.findingDecisions[0].action, 'blocked');
    assert.equal(out.tasks.filter(t => t.repairScope).length, 0);
    assert.equal(out.tasks.length, 2);
  } finally { session.close(); }
});

test('failed focused repair triggers bounded design replanning instead of blind repair recreation', async () => {
  const session = openStore(file()); let designs = 0, repairCalls = 0;
  const runner = { async run(task) {
    if (task.kind === 'design-plan') return { ok: true, structured: true, result: { status: 'completed', planningReport: designs++ === 0
      ? plan() : plan([item('residual', 'coder', 'code_change')]) } };
    if (task.id === 'review') return success(task, { reviewFindings: [finding('review')] });
    if (task.repairScope) { repairCalls++; return { ok: true, structured: true, result: { status: 'failed', summary: 'repair failed', acceptance: [] } }; }
    if (task.kind === 'reverify') return success(task, { verification: [{ command: 'pytest resume', result: 'pass' }] });
    return success(task);
  } };
  try {
    const out = await orchestrate({ ...options(session, () => {}), runner,
      policy: { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, max_retries: 0 } } });
    assert.equal(designs, 2);
    assert.equal(repairCalls, 1);
    assert.equal(out.planDiffs.length, 1);
    assert.ok(out.tasks.some(t => t.repairScope && t.status === 'superseded' && t.result?.status === 'failed'));
    assert.ok(out.tasks.some(t => t.kind === 'reverify' && t.status === 'superseded'));
    assert.equal(out.reviewFindings[0].status, 'resolved');
    assert.equal(out.status, 'completed', 'failed repair remains audit-visible but is superseded by verified residual work');
  } finally { session.close(); }
});

test('Scenario 3: cross-subsystem finding replans with same design child, keeps completed work and saves graph diff', async () => {
  const session = openStore(file()); const cs = [
    { id: 'AC_DONE', description: 'verified base', source: 'user_request' }, ...criteria];
  const initial = plan([item('done', 'coder', 'code_change', [], ['AC_DONE']), item('impl', 'coder', 'code_change', ['done']),
    item('review', 'auditor', 'audit_report', ['impl'])], cs);
  let designs = 0, sawContext = false;
  const runner = { async run(task) {
    if (task.kind === 'design-plan') {
      designs++;
      if (designs === 2) {
        sawContext = !!task.replanContext?.existingTaskGraph.find(t => t.id === 'done' && t.status === 'completed')
          && task.replanContext.acceptanceLedger.find(c => c.id === 'AC_DONE')?.status === 'satisfied';
        return { ok: true, structured: true, result: { status: 'completed', planningReport: plan([
          item('residual', 'coder', 'code_change', [], ['AC_RESUME'])], cs) } };
      }
      return { ok: true, structured: true, result: { status: 'completed', planningReport: initial } };
    }
    if (task.id === 'review') return success(task, { reviewFindings: [finding('review', { suggested_scope: {
      ...finding('review').suggested_scope, subsystems: ['runtime', 'storage', 'experiment comparison'] } })] });
    if (task.kind === 'reverify') return success(task, { verification: [{ command: 'pytest resume', result: 'pass' }] });
    return success(task);
  } };
  try {
    const out = await orchestrate({ ...options(session, () => {}, initial, cs), runner });
    assert.equal(out.status, 'completed');
    assert.equal(designs, 2);
    assert.equal(sawContext, true);
    assert.equal(out.tasks.find(t => t.id === 'done').status, 'completed');
    assert.ok(out.tasks.find(t => t.id === 'rp1-residual'));
    assert.equal(out.planDiffs.length, 1);
    assert.ok(out.planDiffs[0].keptTasks.includes('done'));
    assert.ok(out.planDiffs[0].newTasks.includes('rp1-residual'));
    assert.ok(out.planDiffs[0].reopenedAcceptanceCriteria.includes('AC_RESUME'));
    assert.equal(out.reviewFindings[0].status, 'resolved');
  } finally { session.close(); }
});
