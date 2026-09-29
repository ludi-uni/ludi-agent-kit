import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../lib/orchestrator/store.mjs';
import { newTask } from '../lib/orchestrator/task-store.mjs';
import { canonicalGoal, parsePlanningReport, classifyFinding } from '../lib/orchestrator/planning-contract.mjs';
import { evaluateResult } from '../lib/orchestrator/evaluator.mjs';

const path = () => join(mkdtempSync(join(tmpdir(), 'ludi-phase1-')), 'state.db');
const valid = () => ({
  goal_summary: 'Keep the user objective', current_state: 'Needs design',
  acceptance_criteria: [{ id: 'AC1', description: 'Works', source: 'user_request', status: 'pending', evidence: [] }],
  work_items: [{ id: 'W1', title: 'Design', description: 'Inspect the state', depends_on: [], acceptance_ids: ['AC1'], estimated_complexity: 'small', recommended_role: 'scout', artifact_type: 'design_report', likely_files: [] }],
  risks: [], environment_constraints: ['shell unavailable'], unknowns: [],
  findings: [{ classification: 'environment_limitation', summary: 'shell unavailable' }],
});

test('immutable goal remains unchanged when tasks are replaced and mutable ledger status changes', () => {
  const store = openStore(path());
  try {
    const id = store.createRun({ request: '  Fix this\n safely ', policy: {}, goal: { constraints: ['no destructive changes'], userDecisions: ['use SQLite'] } });
    const goal = structuredClone(store.getRun(id).canonicalGoal);
    assert.deepEqual(goal, canonicalGoal('  Fix this\n safely ', { constraints: ['no destructive changes'], userDecisions: ['use SQLite'] }));
    store.saveTask(id, newTask({ id: 't1', title: 'Design', goal: 'Inspect', kind: 'investigate' }));
    store.saveTask(id, newTask({ id: 't2', title: 'Replacement', goal: 'Inspect again', kind: 'investigate' }));
    store.addAcceptanceCriterion(id, { id: 'AC1', description: 'User requirement', source: 'user_request' });
    store.setAcceptanceStatus(id, 'AC1', 'in_progress');
    store.saveTask(id, { ...store.loadTasks(id)[1], status: 'completed' });
    assert.equal(store.getAcceptanceLedger(id)[0].status, 'in_progress', 'task completion is not acceptance satisfaction');
    assert.deepEqual(store.getRun(id).canonicalGoal, goal);
  } finally { store.close(); }
});

test('criterion identity is independent of task ids and accumulates evidence across tasks', () => {
  const store = openStore(path());
  try {
    const id = store.createRun({ request: 'Work', policy: {} });
    store.addAcceptanceCriterion(id, { id: 'AC1', description: 'verified', source: 'request' });
    store.addAcceptanceEvidence(id, 'AC1', { taskId: 'old-task', detail: 'design review' });
    store.addAcceptanceEvidence(id, 'AC1', { taskId: 'replacement-task', detail: 'test run' });
    store.setAcceptanceStatus(id, 'AC1', 'satisfied');
    const criterion = store.getAcceptanceLedger(id)[0];
    assert.equal(criterion.id, 'AC1');
    assert.equal(criterion.status, 'satisfied');
    assert.deepEqual(criterion.evidence.map(e => [e.taskId, e.detail]), [
      ['old-task', 'design review'], ['replacement-task', 'test run'],
    ]);
    assert.throws(() => store.addAcceptanceCriterion(id, { id: 'AC1', description: 'changed', source: 'request' }), /UNIQUE/);
  } finally { store.close(); }
});

test('valid planning report parses; missing fields, broken references and invalid enums reject', () => {
  assert.deepEqual(parsePlanningReport(JSON.stringify(valid())), valid());
  const missing = valid(); delete missing.goal_summary;
  assert.throws(() => parsePlanningReport(missing), /goal_summary is required/);
  const broken = valid(); broken.work_items[0].acceptance_ids = ['missing'];
  assert.throws(() => parsePlanningReport(broken), /unknown acceptance id/);
  const malformed = valid(); malformed.work_items[0].artifact_type = 'unsupported';
  assert.throws(() => parsePlanningReport(malformed), /invalid artifact_type/);
});

test('environment limitation is not a project defect; classification is explicit', () => {
  assert.equal(classifyFinding(valid().findings[0]), 'environment_limitation');
  assert.notEqual(classifyFinding(valid().findings[0]), 'project_defect');
  assert.equal(classifyFinding({ classification: 'project_defect', summary: 'bug' }), 'project_defect');
  assert.throws(() => classifyFinding({ summary: 'shell blocked' }), /explicit classification/);
});

test('artifact type persists and non-code reports do not require a diff', () => {
  const store = openStore(path());
  try {
    const id = store.createRun({ request: 'Design', policy: {} });
    const t = newTask({ id: 't', title: 'Report', goal: 'Design', kind: 'implement', artifactType: 'design_report', acceptance: ['report delivered'] });
    store.saveTask(id, t);
    assert.equal(store.loadTasks(id)[0].artifact_type, 'design_report');
    const run = { ok: true, structured: true, worktree: { before: { source: 'git' }, agentChanges: [] }, result: { status: 'completed', summary: 'report', acceptance: [{ id: 'A1', met: true, evidence: 'report' }] } };
    assert.equal(evaluateResult(t, run).verdict, 'success');
    assert.match(evaluateResult({ ...t, artifact_type: 'code_change' }, run).reasons.join(' '), /no file changes/);
  } finally { store.close(); }
});

test('legacy database migrates forward idempotently and legacy task remains loadable', () => {
  const file = path();
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, request TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0, rework_cycles INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0, planner TEXT, policy_snapshot TEXT NOT NULL, counters TEXT NOT NULL, repo_root TEXT, scope_key TEXT NOT NULL);`);
  db.prepare('INSERT INTO runs (id,request,status,created_at,updated_at,planner,policy_snapshot,counters,scope_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('old', 'legacy request', 'completed', 'yesterday', 'yesterday', 'rules', '{}', '{}', 'default');
  db.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = openStore(file);
    try {
      assert.equal(store.getRun('old').canonicalGoal.originalRequest, 'legacy request');
      if (!attempt) store.saveTask('old', { id: 't', title: 'old', goal: 'work', kind: 'implement', status: 'completed' });
      assert.equal(store.loadTasks('old')[0].artifact_type, 'code_change');
      assert.deepEqual(store.getAcceptanceLedger('old'), []);
    } finally { store.close(); }
  }
});
