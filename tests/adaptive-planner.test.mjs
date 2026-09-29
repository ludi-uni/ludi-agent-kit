// Adaptive planner (Phase 2): pure translation of a validated planning report +
// persistent ledger into routed task specs. No store/runner/model calls here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { DEFAULT_POLICY, mergePolicy } from '../lib/orchestrator/policy.mjs';
import { planFromReport, PLAN_CODES, ROLE_AGENTS, ARTIFACT_AGENTS } from '../lib/orchestrator/adaptive-planner.mjs';
import { newTask, ARTIFACT_TYPES } from '../lib/orchestrator/task-store.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const ctx = extra => ({ agents, routing, policy: DEFAULT_POLICY, ...extra });
const codes = r => r.errors.map(e => e.split(':')[0]);
const item = (id, extra = {}) => ({
  id, title: `Item ${id}`, description: `Do ${id}`,
  depends_on: [], acceptance_ids: [], estimated_complexity: 'small',
  recommended_role: 'coder', artifact_type: 'code_change', likely_files: [], ...extra,
});
const ac = (id, status = 'pending') => ({ id, description: `Criterion ${id}`, source: 'user_request', status, evidence: [] });

// Strategy-evolution request decomposed into distinct current-state, runtime/storage,
// paused recovery, comparison, multi-seed experiments, leakage audit, docs and verification.
const strategyReport = () => ({
  goal_summary: 'Evolve the strategy engine', current_state: 'baseline exists',
  acceptance_criteria: [ac('AC-IMPL'), ac('AC-EXP'), ac('AC-AUDIT'), ac('AC-DOCS'), ac('AC-INV'), ac('AC-TEST')],
  work_items: [
    item('W-INV1', { recommended_role: 'investigator', artifact_type: 'investigation', acceptance_ids: ['AC-INV'], title: 'Inspect current engine' }),
    item('W-INV2', { recommended_role: 'investigator', artifact_type: 'design_report', acceptance_ids: ['AC-INV'], title: 'Survey evolution options' }),
    item('W-IMPL', { acceptance_ids: ['AC-IMPL'], depends_on: ['W-INV1', 'W-INV2'], title: 'Modify runtime and storage' }),
    item('W-REC', { acceptance_ids: ['AC-IMPL'], depends_on: ['W-IMPL'], title: 'Recover paused runs' }),
    item('W-COMP', { acceptance_ids: ['AC-IMPL'], depends_on: ['W-IMPL'], title: 'Implement comparison framework' }),
    item('W-EXP1', { recommended_role: 'investigator', artifact_type: 'experiment_result', acceptance_ids: ['AC-EXP'], depends_on: ['W-IMPL'], title: 'Experiment: multi-seed mutation rates' }),
    item('W-EXP2', { recommended_role: 'investigator', artifact_type: 'experiment_result', acceptance_ids: ['AC-EXP'], depends_on: ['W-IMPL'], title: 'Experiment: multi-seed selection pressure' }),
    item('W-TEST', { recommended_role: 'tester', artifact_type: 'test_result', acceptance_ids: ['AC-TEST'], depends_on: ['W-IMPL'], title: 'Run strategy tests' }),
    item('W-DOCS', { recommended_role: 'documentation', artifact_type: 'documentation', acceptance_ids: ['AC-DOCS'], depends_on: ['W-IMPL'], title: 'Document the engine' }),
    item('W-AUDIT', { recommended_role: 'auditor', artifact_type: 'audit_report', acceptance_ids: ['AC-AUDIT'], depends_on: ['W-IMPL', 'W-TEST'], title: 'Audit scientific bias and leakage' }),
  ],
  risks: [], environment_constraints: [], unknowns: [],
});

test('strategy-evolution fixture: ten concerns route to separate implementation/experiment/audit/docs agents', () => {
  const r = planFromReport(strategyReport(), ctx({ planningRef: 'plan-42' }));
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.tasks.length, 10);
  const byId = Object.fromEntries(r.tasks.map(t => [t.id, t]));
  // Explicit role -> actual existing agent mapping.
  assert.equal(byId['W-IMPL'].assignedAgent, 'coder');
  assert.equal(byId['W-EXP1'].assignedAgent, 'scout');
  assert.equal(byId['W-EXP2'].assignedAgent, 'scout');
  assert.equal(byId['W-AUDIT'].assignedAgent, 'reviewer');
  assert.equal(byId['W-DOCS'].assignedAgent, 'coder');
  assert.equal(byId['W-INV1'].assignedAgent, 'scout');
  assert.equal(byId['W-TEST'].assignedAgent, 'tester');
  // Routed capabilities come from the real agent definitions, not the report.
  assert.equal(byId['W-IMPL'].capability, 'strong-code');
  assert.equal(byId['W-AUDIT'].capability, 'deep-review');
  // Dependencies preserved.
  assert.deepEqual(byId['W-IMPL'].dependencies, ['W-INV1', 'W-INV2']);
  assert.deepEqual(byId['W-AUDIT'].dependencies, ['W-IMPL', 'W-TEST']);
  // Provenance: newTask-compatible fields plus explicit planning metadata.
  for (const t of r.tasks) {
    assert.equal(t.sourceWorkItemId, t.id);
    assert.equal(t.planningRef, 'plan-42');
    assert.ok(Array.isArray(t.acceptanceIds));
    assert.deepEqual(t.outputs, [], 'provenance is metadata, never a required output file');
    assert.ok(ARTIFACT_TYPES.includes(t.artifact_type));
    // Proves the spec is newTask-compatible right now.
    const row = newTask(t);
    assert.equal(row.artifact_type, t.artifact_type);
    assert.equal(row.assignedAgent, t.assignedAgent);
    assert.equal(row.planningRef, 'plan-42');
    assert.equal(row.sourceWorkItemId, t.id);
    assert.deepEqual(row.acceptanceIds, t.acceptanceIds);
  }
  // Coverage: 0/1/multiple buckets are reported per criterion.
  assert.equal(r.coverage['AC-EXP'].count, 2);
  assert.equal(r.coverage['AC-EXP'].bucket, 'multiple');
  assert.equal(r.coverage['AC-IMPL'].count, 3);
  assert.equal(r.coverage['AC-IMPL'].bucket, 'multiple');
  assert.equal(r.coverage['AC-AUDIT'].count, 1);
  assert.equal(r.coverage['AC-AUDIT'].bucket, 'single');
});

test('uncovered pending criterion is rejected; satisfied criterion is exempt', () => {
  const r = planFromReport(strategyReport(), ctx());
  const uncovered = strategyReport();
  uncovered.work_items = uncovered.work_items.filter(w => w.id !== 'W-DOCS');
  const bad = planFromReport(uncovered, ctx());
  assert.equal(bad.ok, false);
  assert.equal(bad.code, PLAN_CODES.UNCOVERED_ACCEPTANCE);
  assert.ok(bad.errors.some(e => /AC-DOCS/.test(e)));
  // Coverage bookkeeping still reports zero before the failure.
  assert.equal(bad.coverage['AC-DOCS'].count, 0);
  assert.equal(bad.coverage['AC-DOCS'].bucket, 'none');
  // Same shape passes when the ledger says AC-DOCS is already satisfied.
  const good = planFromReport(uncovered, ctx({ ledger: [{ id: 'AC-DOCS', description: 'Criterion AC-DOCS', source: 'user_request', status: 'satisfied', evidence: [] }] }));
  assert.equal(good.ok, true);
  assert.equal(good.coverage['AC-DOCS'].status, 'satisfied');
  // A ledger 'failed' status does NOT exempt the criterion.
  const failed = planFromReport(uncovered, ctx({ ledger: [{ id: 'AC-DOCS', status: 'failed' }] }));
  assert.equal(failed.ok, false);
  assert.ok(codes(failed).includes(PLAN_CODES.UNCOVERED_ACCEPTANCE));
});

test('large work item is never turned into an execution task; explicit UNRESOLVED_LARGE_WORK_ITEM', () => {
  const r = strategyReport();
  r.work_items.find(w => w.id === 'W-IMPL').estimated_complexity = 'large';
  const bad = planFromReport(r, ctx());
  assert.equal(bad.ok, false);
  assert.equal(bad.code, PLAN_CODES.UNRESOLVED_LARGE_WORK_ITEM);
  assert.ok(bad.errors.some(e => /W-IMPL/.test(e) && /large/.test(e)));
  // No spec was emitted for it.
  assert.equal(bad.tasks.length, 0);
});

test('unknown recommended_role fails explicitly; mismatched role/artifact fails', () => {
  const r = strategyReport();
  r.work_items.find(w => w.id === 'W-IMPL').recommended_role = 'supercoder';
  const bad = planFromReport(r, ctx());
  assert.equal(bad.ok, false);
  assert.ok(codes(bad).includes(PLAN_CODES.UNKNOWN_ROLE));
  // auditor cannot own a code_change artifact: invariant, not a soft mapping.
  const r2 = strategyReport();
  r2.work_items.find(w => w.id === 'W-IMPL').recommended_role = 'auditor';
  const bad2 = planFromReport(r2, ctx());
  assert.equal(bad2.ok, false);
  assert.ok(codes(bad2).includes(PLAN_CODES.ROLE_ARTIFACT_MISMATCH));
});

test('dependency violations, cycles and duplicates are rejected', () => {
  // Unknown dependency.
  const r1 = strategyReport();
  r1.work_items.find(w => w.id === 'W-IMPL').depends_on = ['W-GHOST'];
  assert.ok(codes(planFromReport(r1, ctx())).some(c => [PLAN_CODES.INVALID_REFERENCE, PLAN_CODES.INVALID_REPORT].includes(c)));
  // Self dependency (parsePlanningReport catches this too; we still surface INVALID_REPORT/REFERENCE).
  const r2 = strategyReport();
  r2.work_items.find(w => w.id === 'W-IMPL').depends_on = ['W-IMPL'];
  const self = planFromReport(r2, ctx());
  assert.equal(self.ok, false);
  // Cycle: W-IMPL -> W-AUDIT -> W-IMPL (parser allows it; translator must not).
  const r3 = strategyReport();
  r3.work_items.find(w => w.id === 'W-IMPL').depends_on = ['W-AUDIT'];
  const cyc = planFromReport(r3, ctx());
  assert.equal(cyc.ok, false);
  assert.ok(codes(cyc).includes(PLAN_CODES.DEPENDENCY_CYCLE));
  assert.match(cyc.errors.find(e => /cycle/.test(e)), /W-IMPL -> W-AUDIT|W-AUDIT -> W-IMPL/);
  // Duplicate work item ids.
  const r4 = strategyReport();
  r4.work_items.push({ ...r4.work_items[0] });
  const dup = planFromReport(r4, ctx());
  assert.equal(dup.ok, false); // rejected by the contract parser (INVALID_REPORT)
});

test('unknown acceptance id in a work item is rejected', () => {
  const r = strategyReport();
  r.work_items.find(w => w.id === 'W-IMPL').acceptance_ids = ['AC-NOPE'];
  const bad = planFromReport(r, ctx());
  assert.equal(bad.ok, false);
});

test('role and artifact mappings stay explicit and land on existing agents', () => {
  assert.deepEqual(Object.keys(ROLE_AGENTS).sort(), ['auditor', 'coder', 'documentation', 'investigator', 'planner', 'reviewer', 'tester']);
  assert.deepEqual(Object.keys(ARTIFACT_AGENTS).sort(), [...ARTIFACT_TYPES].sort());
  const existing = new Set(['coder', 'tester', 'reviewer', 'scout', 'visual', 'browser']);
  for (const [role, agent] of Object.entries(ROLE_AGENTS)) {
    assert.ok(existing.has(agent), `${role} -> ${agent} must be an existing agent`);
    assert.ok(agent !== 'orchestrator', 'a role must never map to the orchestrator itself');
  }
});

test('invalid report and missing context fail with codes, never throw', () => {
  const bad = planFromReport({ goal_summary: '' }, ctx());
  assert.equal(bad.ok, false);
  assert.equal(bad.code, PLAN_CODES.INVALID_REPORT);
  const noCtx = planFromReport(strategyReport(), {});
  assert.equal(noCtx.ok, false);
  assert.equal(noCtx.code, PLAN_CODES.INVALID_CONTEXT);
});

test('plan limits are enforced through validatePlan', () => {
  const tight = mergePolicy(DEFAULT_POLICY, { limits: { max_tasks: 3 } });
  const r = planFromReport(strategyReport(), ctx({ policy: tight }));
  assert.equal(r.ok, false);
  assert.equal(r.code, PLAN_CODES.INVALID_PLAN);
  assert.ok(r.errors.some(e => /max_tasks/.test(e)));
});

test('empty report with only satisfied criteria yields a vacuously valid empty plan', () => {
  const r = planFromReport({
    goal_summary: 'done', current_state: 'complete',
    acceptance_criteria: [ac('AC1', 'satisfied')],
    work_items: [], risks: [], environment_constraints: [], unknowns: [],
  }, ctx({ ledger: [ac('AC1', 'satisfied')] }));
  assert.equal(r.ok, true);
  assert.equal(r.tasks.length, 0);
  assert.equal(r.coverage['AC1'].bucket, 'none');
});
