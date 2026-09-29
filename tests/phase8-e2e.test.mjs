import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/orchestrator/store.mjs';
import { orchestrate } from '../lib/orchestrator/orchestrator.mjs';
import { decideReviewFinding } from '../lib/orchestrator/review-policy.mjs';
import { agents, routing, registry, policy, request, criteria, initialPlan, createFixtureRunner } from './fixtures/phase8-runtime.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = () => {
  const repo = mkdtempSync(join(tmpdir(), 'ludi-p8-repo-'));
  const db = join(mkdtempSync(join(tmpdir(), 'ludi-p8-db-')), 'state.db');
  writeFileSync(join(repo, 'preexisting.txt'), 'original\n');
  for (const args of [['init', '-q'], ['add', 'preexisting.txt'], ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'fixture']]) {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  appendFileSync(join(repo, 'preexisting.txt'), 'user change that must survive\n');
  return { repo, db };
};

const count = (decisions, action) => decisions.filter(d => d.action === action).length;

test('one controlled long-form lifecycle: design -> interruption/restart -> decisions -> review/repair/replan -> completion', async () => {
  const { repo, db } = fixture(); const before = readFileSync(join(repo, 'preexisting.txt'), 'utf8');
  const session = openStore(db); let runId;
  try {
    let stopped = false;
    await assert.rejects(() => orchestrate({ request, planner: 'adaptive', acceptanceCriteria: criteria, agents, routing, registry, policy,
      repoRoot: repo, session, runner: createFixtureRunner(repo), projectStore: { async onPlan() {}, async onTaskUpdate(task) {
        if (!stopped && task.id === 't3' && task.status === 'partial') { stopped = true; throw Error('controlled process checkpoint after continuation commit'); }
      }, async onFinal() {} } }), e => { runId = e.runId; assert.match(e.message, /controlled process checkpoint/); return true; });
    assert.equal(stopped, true);
    const interim = session.getRun(runId);
    assert.equal(interim.canonicalGoal.originalRequest, request);
    assert.deepEqual(session.getAcceptanceLedger(runId).map(c => c.id), criteria.map(c => c.id));
    assert.equal(session.getAcceptanceLedger(runId).filter(c => c.status === 'satisfied').length, 2);
    assert.equal(session.loadTasks(runId).find(t => t.id === 't3').continuedBy, 't3.c1');
    assert.ok(session.loadTasks(runId).some(t => t.id === 't3.c1' && t.status === 'pending'));
    const decisionId = session.insertDecision({ runId, taskId: 't3.c1', key: 'phase8-safety',
      question: 'Keep existing dirty changes and prohibit paid providers?', reason: 'explicit user boundary during checkpoint' });
    session.answerDecision({ runId, decisionId, answer: 'Preserve existing dirty worktree changes; no paid models' });
  } finally { session.close(); }

  // A separate Node process reopens SQLite, claims the run and executes the
  // actual orchestrate() resume path. The production code owns every decision.
  const child = spawnSync(process.execPath, [join(kit, 'tests/fixtures/phase8-resume-child.mjs'), db, runId, repo],
    { cwd: kit, encoding: 'utf8', timeout: 120_000 });
  assert.equal(child.status, 0, `resume child failed:\n${child.stdout}\n${child.stderr}`);
  const childResult = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(childResult.status, 'completed', JSON.stringify(childResult));

  const reopened = openStore(db);
  try {
    const row = reopened.getRun(runId), tasks = reopened.loadTasks(runId);
    const decisions = reopened.listExecutionDecisions(runId), ledger = reopened.getAcceptanceLedger(runId), events = reopened.loadTrace(runId);
    const findings = row.counters.reviewFindings, diffs = row.counters.planDiffs;
    assert.equal(row.canonicalGoal.originalRequest, request);
    assert.deepEqual(ledger.map(c => c.id), criteria.map(c => c.id));
    assert.ok(ledger.every(c => c.status === 'satisfied'), JSON.stringify(ledger.map(c => [c.id, c.status])));
    assert.ok(tasks.length > 13);
    const initial = tasks.filter(t => /^t(?:[1-9]|1[0-3])$/.test(t.id));
    assert.equal(initial.length, 13);
    assert.ok(new Set(initial.map(t => t.artifact_type)).size >= 5, 'not one giant implementation task');
    assert.equal(tasks.find(t => t.id === 't3').continuedBy, 't3.c1');
    assert.equal(tasks.find(t => t.id === 't3.c1').rootTaskId, 't3');
    assert.deepEqual(tasks.find(t => t.id === 't3.c1').remainingWorkIds, ['cli', 'test']);
    assert.deepEqual(tasks.find(t => t.id === 't3.c1').workspaceStateReference.paths, ['storage.py']);
    assert.equal(tasks.find(t => t.id === 't3').attempts, 1, 'do not restart completed partial scope');
    assert.equal(tasks.find(t => t.id === 't4.c1').budget.turns.current_limit, 48);
    assert.equal(tasks.find(t => t.id === 't5').retryCount, 1);
    assert.equal(tasks.find(t => t.id === 't7').assignedAgent, 'scout');
    assert.deepEqual(tasks.find(t => t.id === 't8').routeHistory.map(r => r.modelId), ['fixture/a', 'fixture/b']);
    assert.match(row.canonicalGoal.originalRequest, /No paid models.*Preserve existing dirty worktree changes/);
    assert.equal(reopened.listDecisions(runId, 'answered').filter(d => d.key === 'phase8-safety').length, 1);
    assert.match(reopened.listDecisions(runId, 'answered').find(d => d.key === 'phase8-safety').answer, /no paid models/);
    assert.equal(tasks.filter(t => t.executionRoute?.backend === 'c').length, 0);
    assert.ok(tasks.find(t => t.id === 't6').splitInto.length === 3);
    assert.ok(tasks.filter(t => t.repairScope).length === 1);
    assert.deepEqual(tasks.find(t => t.repairScope).affectedFiles, ['runner.py']);
    assert.deepEqual(tasks.find(t => t.repairScope).affectedAcceptanceIds, ['AC_RESUME']);
    assert.equal(tasks.filter(t => t.repairScope && /Strategy Evolution Lab/.test(t.goal)).length, 0);
    assert.equal(findings.find(f => f.classification === 'environment_limitation').status, 'resolved');
    assert.equal(findings.filter(f => f.classification === 'environment_limitation' && f.repairTaskId).length, 0);
    assert.ok(findings.filter(f => f.classification === 'insufficient_evidence').every(f => !f.repairTaskId));
    assert.equal(findings.length, 4, 'replayed identical review finding must not create another finding or repair');
    assert.ok(findings.every(f => f.status === 'resolved'));
    assert.equal(diffs.length, 1);
    assert.ok(diffs[0].keptTasks.includes('t1'));
    assert.ok(diffs[0].supersededTasks.includes('t12'));
    assert.equal(tasks.find(t => t.id === 't12').status, 'superseded');
    assert.ok(diffs[0].newTasks.includes('rp1-residual'));
    assert.ok(diffs[0].dependencyChanges.some(d => d.taskId === 't13' && d.before.includes('t12') && d.after.some(x => x.startsWith('rp1-'))));
    assert.ok(diffs[0].reopenedAcceptanceCriteria.includes('AC_PLAN'));
    assert.ok(tasks.find(t => t.id === 't1').status === 'completed');
    assert.equal(readFileSync(join(repo, 'preexisting.txt'), 'utf8'), before);
    assert.ok(readFileSync(join(repo, 'storage.py'), 'utf8').includes('resume core'));
    assert.ok(readFileSync(join(repo, 'runner.py'), 'utf8').includes('fixed'));
    assert.deepEqual([count(decisions, 'continue'), count(decisions, 'extend'), count(decisions, 'split'),
      count(decisions, 'retry'), count(decisions, 'reassign'), count(decisions, 'escalate')], [1, 1, 1, 2, 1, 1]);
    assert.equal(row.counters.runBudget.task_extensions, 1);
    assert.equal(row.counters.runBudget.escalations, 1);
    assert.ok(row.counters.findingDecisions.some(d => d.action === 'repair'));
    assert.ok(row.counters.findingDecisions.some(d => d.action === 'replan'));
    assert.ok(row.counters.findingDecisions.some(d => d.action === 'reverify'));
    for (const type of ['plan', 'result', 'execution-decision', 'review-finding', 'replan-diff', 'final-report'])
      assert.ok(events.some(e => e.type === type), `missing audit trace ${type}`);
    assert.equal(events.filter(e => /reset|clean|revert/.test(JSON.stringify(e))).length, 0);
    const snapshot = { tasks: tasks.length, decisions: decisions.length, findings: findings.length,
      continuation: count(decisions, 'continue'), extension: count(decisions, 'extend'), escalation: count(decisions, 'escalate') };
    for (const key of ['t3:1', 't4:1', 't5:1', 't8:2']) {
      const existing = reopened.getExecutionDecision(runId, key);
      assert.ok(existing, `missing replay target ${key}`);
      assert.equal(reopened.recordExecutionDecision(runId, key, { source_task_id: 'forged', action: 'extend', reason: 'duplicate', policyRule: 'test', inputsSnapshot: {} }).decisionId, existing.decisionId);
    }
    const originalFinding = findings.find(f => f.classification === 'project_defect' && f.repairTaskId);
    assert.equal(decideReviewFinding(originalFinding, { existing: findings }).action, 'ignore_duplicate');
    const resumed = await orchestrate({ request: '', resumeRunId: runId, agents, routing, registry, policy, repoRoot: repo, session: reopened,
      runner: { async run() { throw Error('completed run must not execute any worker on replay'); } } });
    assert.equal(resumed.status, 'completed');
    assert.deepEqual({ tasks: reopened.loadTasks(runId).length, decisions: reopened.listExecutionDecisions(runId).length,
      findings: reopened.getRun(runId).counters.reviewFindings.length,
      continuation: count(reopened.listExecutionDecisions(runId), 'continue'), extension: count(reopened.listExecutionDecisions(runId), 'extend'),
      escalation: count(reopened.listExecutionDecisions(runId), 'escalate') }, snapshot);
  } finally { reopened.close(); }
});

const controlled = (session, repo, override) => {
  const base = createFixtureRunner(repo);
  return { request, planner: 'adaptive', acceptanceCriteria: criteria, agents, routing, registry, policy, session,
    repoRoot: repo, runner: { run: task => override(task, base) } };
};

test('negative completion: all work terminal but acceptance remains pending', async () => {
  const { repo, db } = fixture(), session = openStore(db);
  try {
    const out = await orchestrate(controlled(session, repo, (task, base) => task.id === 't11'
      ? Promise.resolve({ ok: true, structured: true, result: { status: 'completed', summary: 'review passed',
        acceptance: task.acceptance.map((_, i) => ({ id: `A${i + 1}`, met: true, evidence: 'reviewed' })),
        verification: [], reviewFindings: [], remainingIssues: [] } }) : base.run(task)));
    assert.equal(out.status, 'incomplete');
    assert.ok(out.tasks.every(t => !['pending', 'running'].includes(t.status)));
    assert.equal(session.getAcceptanceLedger(out.runId).find(c => c.id === 'AC_AUDIT').status, 'pending');
  } finally { session.close(); }
});

test('negative completion: a blocking project defect remains awaiting reverify despite terminal tasks', async () => {
  const { repo, db } = fixture(), session = openStore(db);
  try {
    const out = await orchestrate(controlled(session, repo, async (task, base) => {
      if (task.kind === 'reverify') { const original = await base.run(task);
        return { ...original, result: { ...original.result, verification: [] } }; }
      if (task.id !== 't11') return base.run(task);
      const result = await base.run(task);
      return { ...result, result: { ...result.result, reviewFindings: result.result.reviewFindings.filter(f => f.classification === 'project_defect' && f.id === 'DEFECT') } };
    }));
    assert.equal(out.status, 'incomplete');
    assert.ok(out.tasks.every(t => !['pending', 'running'].includes(t.status)));
    assert.notEqual(out.reviewFindings[0].status, 'resolved');
    assert.equal(session.getAcceptanceLedger(out.runId).find(c => c.id === 'AC_RESUME').status, 'in_progress');
  } finally { session.close(); }
});

test('stalled budget does not extend; repeated identical transient error stops blind retry', async () => {
  for (const failure of ['stalled', 'socket']) {
    const { repo, db } = fixture(), session = openStore(db);
    const tinyPlan = { ...initialPlan(), work_items: initialPlan().work_items.slice(0, 1),
      acceptance_criteria: [initialPlan().acceptance_criteria[0]] };
    try {
      const out = await orchestrate({ ...controlled(session, repo, task => {
        if (task.kind === 'design-plan') return { ok: true, structured: true, result: { status: 'completed', planningReport: tinyPlan } };
        if (failure === 'socket') return { ok: false, error: 'UND_ERR_SOCKET: remote side closed', failureClass: 'TOOL_FAILURE' };
        return { ok: false, structured: true, child: { stopReason: 'absolute-turn-limit', turns: 32, toolCalls: 8 },
          result: { status: 'failed', summary: 'no new evidence', progressReport: { task_id: task.id, status: 'failed', termination_reason: 'turn_limit',
            completed_acceptance: [], completed_steps: [], remaining_work: [], blocked_work: [], files_touched: [], tests_run: [],
            artifacts: [], environment_constraints: [], handoff_notes: [] } } };
      }), acceptanceCriteria: criteria.slice(0, 1) });
      const actions = session.listExecutionDecisions(out.runId).map(d => d.action);
      assert.ok(!actions.includes('extend'), `${failure}: no extension`);
      assert.deepEqual(actions, failure === 'socket' ? ['retry', 'stop'] : ['stop']);
      assert.equal(out.tasks.find(t => t.id === 't1').attempts, failure === 'socket' ? 2 : 1);
      assert.equal(out.status, 'incomplete');
    } finally { session.close(); }
  }
});
