import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewFinding, findingSignature, decideReviewFinding, validateRepairScope, focusedRepairSpec, completionGate } from '../lib/orchestrator/review-policy.mjs';
const finding = (over = {}) => ({ id: 'F1', source_task_id: 'review1', severity: 'blocking', classification: 'project_defect', title: 'resume generation',
  description: 'paused-run resume generation increment is incorrect', evidence: [{ type: 'test_result', command: 'pytest resume', result: 'fail' }],
  affected_acceptance_ids: ['AC_RESUME'], affected_files: ['runner.py'], suggested_scope: { summary: 'Fix paused-run resume generation increment in runner.py and add regression coverage for AC_RESUME',
    affected_acceptance_ids: ['AC_RESUME'], affected_files: ['runner.py'], subsystems: ['runtime'], estimated_complexity: 'small' }, confidence: 0.9, ...over });
const action = (f, extra) => decideReviewFinding(f, extra).action;

test('strict structured finding preserves independent severity/classification and evidence', () => {
  const f = parseReviewFinding(finding(), { sourceTaskId: 'review1', acceptanceIds: ['AC_RESUME'] });
  assert.equal(f.classification, 'project_defect'); assert.equal(f.severity, 'blocking');
  assert.throws(() => parseReviewFinding({ ...f, classification: undefined }), /classification/);
  assert.throws(() => parseReviewFinding({ ...f, evidence: [] }), /evidence/);
  assert.throws(() => parseReviewFinding({ ...f, affected_acceptance_ids: ['AC_OTHER'] }, { acceptanceIds: ['AC_RESUME'] }), /unknown acceptance/);
});

test('Strategy A: blocking shell limitation never produces project repair', () => {
  const f = finding({ classification: 'environment_limitation', description: 'shell allowlist prevented DB verification' });
  assert.equal(action(f), 'blocked');
  assert.equal(action(f, { alternatePath: 'inspect DB through read-only API' }), 'investigate');
});

test('Strategy B: defect or test failure -> focused repair only matching files/acceptance', () => {
  for (const cls of ['project_defect', 'test_failure']) assert.equal(action(finding({ classification: cls })), 'repair');
  const spec = focusedRepairSpec(finding(), { id: 'review1', goal: 'Implement Strategy Evolution Lab with everything' }, 1,
    [{ id: 'AC_RESUME', description: 'resume generation' }]);
  assert.deepEqual(spec.sourceFindingIds, ['F1']);
  assert.deepEqual(spec.affectedFiles, ['runner.py']);
  assert.deepEqual(spec.acceptanceIds, ['AC_RESUME']);
  assert.doesNotMatch(spec.goal, /Strategy Evolution Lab/);
  assert.equal(spec.rootTaskId, 'review1');
});

test('Strategy C: insufficient evidence -> reverify/investigate; external blocker and ambiguity never repair', () => {
  assert.equal(action(finding({ classification: 'insufficient_evidence' })), 'reverify');
  assert.equal(action(finding({ classification: 'insufficient_evidence', affected_acceptance_ids: [] })), 'investigate');
  assert.equal(action(finding({ classification: 'external_blocker' })), 'blocked');
  assert.equal(action(finding({ classification: 'requirement_ambiguity' })), 'approval_required');
});

test('Strategy D: multi-subsystem or scope expansion replans, never emits one giant repair', () => {
  const cross = finding({ suggested_scope: { ...finding().suggested_scope, subsystems: ['runtime', 'storage', 'experiment comparison'] } });
  assert.equal(action(cross), 'replan');
  assert.equal(action(finding({ suggested_scope: { ...finding().suggested_scope, summary: 'Fix entire repository' } })), 'replan');
  assert.equal(action(finding({ suggested_scope: { ...finding().suggested_scope, affected_acceptance_ids: ['AC_RESUME', 'AC_OTHER'] } })), 'replan');
  assert.throws(() => focusedRepairSpec(cross, { id: 'review1' }, 1), /repair scope rejected/);
});

test('Strategy E: normalized duplicate findings attach to one repair', () => {
  const f = finding(); const duplicate = finding({ id: 'F2', source_task_id: 'review2', description: 'Paused-run  RESUME generation increment is incorrect!' });
  assert.equal(findingSignature(f), findingSignature(duplicate));
  const decision = decideReviewFinding(duplicate, { existing: [{ id: 'F1', signature: findingSignature(f), status: 'repairing', repairTaskId: 't3' }] });
  assert.equal(decision.action, 'ignore_duplicate'); assert.equal(decision.repairTaskId, 't3');
});

test('Strategy F: repeated repair -> replan or safe stop at limit; review round bounded', () => {
  assert.equal(action(finding(), { repairsForFinding: 1 }), 'replan');
  assert.equal(action(finding(), { repairsForFinding: 1, replanCount: 2 }), 'blocked');
  assert.equal(action(finding(), { reviewRounds: 4 }), 'blocked');
});

test('completion gate requires ledger, resolved blocking findings, no approval or reverify', () => {
  const ledger = [{ id: 'AC_RESUME', status: 'satisfied' }];
  assert.equal(completionGate({ ledger, findings: [{ ...finding(), status: 'repairing' }] }).allowed, false);
  assert.equal(completionGate({ ledger, findings: [{ ...finding(), status: 'awaiting_reverification' }] }).allowed, false);
  assert.equal(completionGate({ ledger, findings: [{ ...finding(), status: 'resolved', resolutionEvidence: { verification: [{ command: 'pytest resume', result: 'pass' }] } }] }).allowed, true);
  assert.equal(completionGate({ ledger, findings: [{ ...finding(), status: 'resolved' }] }).allowed, false);
  assert.equal(completionGate({ ledger: [{ id: 'AC_RESUME', status: 'in_progress' }] }).allowed, false);
  assert.equal(completionGate({ ledger, pendingApprovals: [{}] }).allowed, false);
});
