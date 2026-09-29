// Phase 3 progress contract: pure parsing, metrics, eligibility and the
// residual-continuation spec. No store, runner or model calls here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProgressReport, progressMetrics, classifyContinuation, buildContinuationTask,
  destructiveAmbiguity, PROGRESS_STATUSES, TERMINATION_REASONS, MAX_CONTINUATION_DEPTH, PROGRESS_CODES,
} from '../lib/orchestrator/progress-contract.mjs';
import { newTask } from '../lib/orchestrator/task-store.mjs';

const report = (extra = {}) => ({
  task_id: 'W-IMPL',
  status: 'partial',
  termination_reason: 'turn_limit',
  completed_acceptance: [{ acceptance_id: 'AC-IMPL', evidence: ['runtime mutates seeds deterministically'] }],
  completed_steps: ['modified runtime', 'added resume path'],
  remaining_work: [
    { id: 'RW1', description: 'Finish comparison framework', acceptance_ids: ['AC-IMPL'], estimated_complexity: 'medium' },
    { id: 'RW2', description: 'Run multi-seed experiments', acceptance_ids: ['AC-EXP'], estimated_complexity: 'small' },
  ],
  blocked_work: [],
  files_touched: ['src/strategy_evolution_lab/runtime/runner.py', 'src/strategy_evolution_lab/storage/sqlite.py'],
  tests_run: [{ command: 'pytest tests/test_pipeline.py', result: 'pass' }],
  artifacts: [{ type: 'code_change', location: 'src/strategy_evolution_lab/compare.py', description: 'partial compare scaffold' }],
  environment_constraints: ['shell sandbox only'],
  handoff_notes: ['compare CLI flag is stubbed'],
  ...extra,
});

const parentTask = () => ({
  id: 'W-IMPL',
  title: 'Modify runtime and storage',
  goal: 'original long goal that must never be copied into a residual',
  assignedAgent: 'coder',
  kind: 'implement',
  artifact_type: 'code_change',
  acceptanceIds: ['AC-IMPL', 'AC-EXP', 'AC-AUDIT'],
  // Six-file strategy scenario: the planned surface a continuation must preserve.
  likelyFiles: [
    'src/strategy_evolution_lab/compare.py',
    'src/strategy_evolution_lab/runtime/runner.py',
    'src/strategy_evolution_lab/storage/sqlite.py',
    'tests/test_pipeline.py',
    'config.example.toml',
    'docs/strategy.md',
  ],
});

test('valid progress report parses; missing/invalid fields and contradictions reject', () => {
  const r = report();
  assert.deepEqual(parseProgressReport(JSON.stringify(r)), r);
  for (const field of ['task_id', 'status', 'completed_acceptance', 'completed_steps', 'remaining_work', 'blocked_work', 'files_touched', 'tests_run', 'artifacts', 'environment_constraints', 'handoff_notes']) {
    const bad = report(); delete bad[field];
    assert.throws(() => parseProgressReport(bad), new RegExp(`${field.replace('_', '[_]')} is required`), `missing ${field} must reject`);
  }
  assert.throws(() => parseProgressReport(report({ status: 'done' })), /status must be one of/);
  assert.throws(() => parseProgressReport(report({ termination_reason: 'crashed' })), /termination_reason must be one of/);
  // completed + remaining => invalid.
  assert.throws(() => parseProgressReport(report({ status: 'completed' })), /contradicts/);
  assert.equal(parseProgressReport(report({ status: 'completed', remaining_work: [] })).status, 'completed');
  // Sub-field strictness.
  assert.throws(() => parseProgressReport(report({ remaining_work: [{ id: 'x', description: 'd', acceptance_ids: [], estimated_complexity: 'huge' }] })), /invalid estimated_complexity/);
  assert.throws(() => parseProgressReport(report({ blocked_work: [{ description: 'd', reason: 'r', classification: 'unlucky' }] })), /invalid classification/);
  assert.throws(() => parseProgressReport(report({ artifacts: [{ type: 'jpeg', location: 'l', description: 'd' }] })), /invalid artifact type/);
  assert.throws(() => parseProgressReport('{"task_id":'), /invalid JSON/);
  assert.throws(() => parseProgressReport([1, 2]), /expected object/);
});

test('enums are explicit and frozen', () => {
  assert.deepEqual(PROGRESS_STATUSES, ['completed', 'partial', 'blocked', 'failed', 'unknown']);
  assert.deepEqual(TERMINATION_REASONS, ['completed', 'turn_limit', 'tool_limit', 'process_error', 'environment_block', 'validation_failure', 'user_stop', 'unknown']);
  assert.equal(MAX_CONTINUATION_DEPTH, 3);
});

test('metrics are pure and deterministic; repeated-failure signature ignores wording', () => {
  const m = progressMetrics(report());
  assert.equal(m.progressMade, true);
  assert.equal(m.lastProgressMarker, 'added resume path');
  assert.equal(m.completedWorkCount, 3); // 2 steps + 1 acceptance entry
  assert.equal(m.remainingWorkCount, 2);
  assert.equal(m.repeatedFailureSignature, null);
  const failing = report({
    completed_steps: [], completed_acceptance: [],
    tests_run: [{ command: 'pytest tests/test_pipeline.py', result: 'fail' }],
    blocked_work: [{ description: 'cannot reach db', reason: 'sandbox', classification: 'environment_limitation' }],
  });
  const m2 = progressMetrics(failing);
  assert.equal(m2.lastProgressMarker, 'test:pytest tests/test_pipeline.py');
  assert.equal(m2.repeatedFailureSignature, 'blocked:environment_limitation|fail:pytest tests/test_pipeline.py');
  // Same failure, differently worded reason -> identical signature.
  const m3 = progressMetrics(report({
    completed_steps: [], completed_acceptance: [],
    tests_run: [{ command: 'pytest tests/test_pipeline.py', result: 'fail' }],
    blocked_work: [{ description: 'totally different words', reason: 'other prose', classification: 'environment_limitation' }],
  }));
  assert.equal(m3.repeatedFailureSignature, m2.repeatedFailureSignature);
  const empty = progressMetrics(report({
    status: 'blocked', completed_steps: [], completed_acceptance: [],
    remaining_work: [{ id: 'RW1', description: 'd', acceptance_ids: [], estimated_complexity: 'small' }],
    files_touched: [], tests_run: [], artifacts: [],
  }));
  assert.equal(empty.progressMade, false);
  assert.equal(empty.lastProgressMarker, null);
});

test('eligibility: partial + remaining + progress only; exclusions are explicit', () => {
  const ok = classifyContinuation(report());
  assert.equal(ok.eligible, true);
  assert.equal(ok.code, null);
  assert.equal(ok.metrics.remainingWorkCount, 2);
  // completed + remaining: parser rejects it as contradictory — surfaced as invalid, never eligible.
  assert.equal(classifyContinuation(report({ status: 'completed', remaining_work: [] })).eligible, false);
  for (const [why, r] of [
    ['blocked', report({ status: 'blocked' })],
    ['failed', report({ status: 'failed' })],
    ['unknown', report({ status: 'unknown' })],
    ['no remaining', report({ status: 'partial', remaining_work: [] })],
    ['no progress', report({ completed_steps: [], completed_acceptance: [], files_touched: [], tests_run: [] })],
    ['user_stop', report({ termination_reason: 'user_stop' })],
    ['user_stop override', report({ termination_reason: 'turn_limit' })],
    ['depth exceeded', report()],
    ['destructive hint', report({ handoff_notes: ['tried git reset --hard to recover'] })],
    ['large residual', report({ remaining_work: [{ id: 'RW1', description: 'large unfinished module', acceptance_ids: ['AC-IMPL'], estimated_complexity: 'large' }] })],
  ]) {
    const extra = why === 'user_stop override' ? { terminationReason: 'user_stop' } : why === 'depth exceeded' ? { nextContinuationIndex: 4 } : {};
    const res = classifyContinuation(r, extra);
    assert.equal(res.eligible, false, why);
    assert.ok(res.reasons.length, why);
  }
  // Invalid reports are excluded as invalid, not merely ineligible.
  const invalid = classifyContinuation({ status: 'partial' });
  assert.equal(invalid.code, PROGRESS_CODES.INVALID_PROGRESS_REPORT);
  // Depth boundary: index 3 is the last allowed continuation.
  assert.equal(classifyContinuation(report(), { nextContinuationIndex: 3 }).eligible, true);
  assert.equal(classifyContinuation(report(), { nextContinuationIndex: 4 }).eligible, false);
});

test('residual spec: lineage, unsatisfied-union acceptance ids, rebuilt goal, newTask-compatible', () => {
  const ledger = [
    { id: 'AC-IMPL', status: 'satisfied', description: 'Runtime evolves seeds' },
    { id: 'AC-EXP', status: 'failed', description: 'Multi-seed experiments run' },
    { id: 'AC-AUDIT', status: 'pending', description: 'Leakage audited' },
  ];
  const r = buildContinuationTask({ task: parentTask(), report: report(), ledger, workspaceRef: { path: '/ws', dirty: true }, progressRef: 'progress-7' });
  assert.equal(r.ok, true);
  const t = r.task;
  assert.equal(t.id, 'W-IMPL.c1');
  assert.equal(t.parentTaskId, 'W-IMPL');
  assert.equal(t.rootTaskId, 'W-IMPL');
  assert.equal(t.continuationIndex, 1);
  assert.equal(t.sourceProgressReport, 'progress-7');
  assert.deepEqual(t.remainingWorkIds, ['RW1', 'RW2']);
  // Ledger-satisfied AC-IMPL is dropped even though the child claimed it;
  // failed AC-EXP + pending AC-AUDIT survive — no pending id is lost.
  assert.deepEqual(t.acceptanceIds, ['AC-EXP', 'AC-AUDIT']);
  // Goal is ONLY remaining descriptions — never the original long goal.
  assert.ok(t.goal.includes('Finish comparison framework'));
  assert.ok(t.goal.includes('Run multi-seed experiments'));
  assert.ok(!t.goal.includes('original long goal'));
  assert.deepEqual(t.dependencies, []);
  assert.deepEqual(t.dependsOn, []);
  assert.equal(t.workspaceStateReference.dirty, true);
  assert.equal(t.inheritedArtifacts[0].location, 'src/strategy_evolution_lab/compare.py');
  assert.equal(t.inheritedEvidence.length, 1);
  assert.equal(t.estimatedComplexity, 'medium'); // worst remaining
  // Handoff context carries files/tests/env/blocked/notes and workspace dirtiness.
  assert.deepEqual(t.handoff.filesTouched, ['src/strategy_evolution_lab/runtime/runner.py', 'src/strategy_evolution_lab/storage/sqlite.py']);
  assert.equal(t.handoff.testsRun[0].command, 'pytest tests/test_pipeline.py');
  assert.equal(t.handoff.environmentConstraints[0], 'shell sandbox only');
  assert.equal(t.handoff.workspaceDirty, true);
  // Proves the spec is newTask-compatible right now.
  const row = newTask({ ...t, dependencies: [] });
  assert.equal(row.id, 'W-IMPL.c1');
  assert.equal(row.artifact_type, 'code_change');
  assert.deepEqual(row.acceptanceIds, t.acceptanceIds);
});

test('residual spec preserves the six-file strategy surface and never mutates inputs', () => {
  const task = parentTask();
  const input = report();
  const before = structuredClone(input);
  const r = buildContinuationTask({ task, report: input, ledger: [{ id: 'AC-IMPL', status: 'satisfied' }], workspaceRef: { path: '/ws', dirty: false } });
  assert.equal(r.ok, true);
  // All six strategy files remain reachable: 2 touched + 4 via likelyFiles/goal context.
  const covered = new Set([...r.task.handoff.filesTouched, ...(task.likelyFiles ?? [])]);
  assert.equal(covered.size, 6);
  for (const f of task.likelyFiles) assert.ok(covered.has(f), `${f} preserved`);
  // Pure: input objects untouched.
  assert.deepEqual(input, before);
  assert.equal(task.likelyFiles.length, 6);
  // Depth: parent.c2 -> c3 allowed, c4 never.
  const c3 = buildContinuationTask({ task: { ...task, id: 'W-IMPL.c2', continuationIndex: 2, rootTaskId: 'W-IMPL' }, report: report() });
  assert.equal(c3.ok, true);
  assert.equal(c3.task.id, 'W-IMPL.c3');
  assert.equal(c3.task.rootTaskId, 'W-IMPL');
  const c4 = buildContinuationTask({ task: { ...task, id: 'W-IMPL.c3', continuationIndex: 3, rootTaskId: 'W-IMPL' }, report: report() });
  assert.equal(c4.ok, false);
  assert.match(c4.errors.join(' '), /exceeds max 3/);
});

test('incomplete or ineligible inputs fail explicitly and never emit a spec', () => {
  assert.equal(buildContinuationTask({ task: null, report: report() }).code, PROGRESS_CODES.INVALID_RESIDUAL_INPUT);
  const stopped = buildContinuationTask({ task: parentTask(), report: report({ termination_reason: 'user_stop' }) });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.code, PROGRESS_CODES.NOT_CONTINUABLE);
  assert.equal(stopped.task, null);
  const done = buildContinuationTask({ task: parentTask(), report: report({ status: 'completed', remaining_work: [] }) });
  assert.equal(done.ok, false);
  assert.equal(done.task, null);
});
