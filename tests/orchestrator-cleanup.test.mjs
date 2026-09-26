// Safe orchestrator run-history cleanup: preview/prune/delete/clear.
// Safety contract:
//  - default cleanup only deletes terminal runs (completed/failed/cancelled)
//    without pending decisions; active/resumable runs require explicit force
//    (--clear --force --include-active or --delete ID --force).
//  - every delete runs inside one BEGIN IMMEDIATE transaction; an injected failure
//    mid-batch rolls the whole batch back.
//  - decision_memory, protocol_stats and GLOBAL backend health (run_id = '') are
//    never touched; run-local health rows go with their run.
//  - all tests use temp dirs; the real .orchestration/state.db is never written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../lib/orchestrator/store.mjs';
import { newTask } from '../lib/orchestrator/task-store.mjs';
import { DEFAULT_POLICY } from '../lib/orchestrator/policy.mjs';
import { parseOlderThan, formatCleanup, resumeOrchestration } from '../lib/orchestrator/api.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(kit, 'scripts/orchestrate.mjs');
const dbPath = () => join(mkdtempSync(join(tmpdir(), 'ludi-clean-')), 'state.db');
const runCli = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

const seedTask = (session, runId, status = 'completed') => {
  const store = session.openTaskStore(runId);
  store.add(newTask({ id: 't1', title: 't', goal: 'g', capability: 'cheap-code', assignedAgent: 'scout', acceptance: ['done'] }));
  store.update('t1', { status });
};

const seedTraceAndHealth = (session, runId) => {
  session.appendTrace(runId, { at: '2026-01-01T00:00:00.000Z', round: 1, type: 'result' });
  session.recordHealth({ provider: 'ps', model: 'ms', state: 'rate_limited', runId, ttlMs: 60_000 });
};

const counts = session => {
  const p = session.previewRuns({ includeActive: true });
  return {
    runs: p.runs.length,
    tasks: p.runs.reduce((n, r) => n + r.counts.tasks, 0),
    decisions: p.runs.reduce((n, r) => n + r.counts.decisions, 0),
    trace: p.runs.reduce((n, r) => n + r.counts.trace, 0),
    health: p.runs.reduce((n, r) => n + r.counts.health, 0),
  };
};

test('A: previewRuns classifies terminal vs active and pending decisions; nothing is written', () => {
  const session = openStore(dbPath());
  const done = session.createRun({ request: 'done', policy: DEFAULT_POLICY });
  session.updateRun(done, { status: 'completed' });
  const running = session.createRun({ request: 'live', policy: DEFAULT_POLICY });
  const waiting = session.createRun({ request: 'wait', policy: DEFAULT_POLICY });
  session.updateRun(waiting, { status: 'waiting_for_user' });
  session.insertDecision({ runId: waiting, taskId: 't1', question: 'pick one', options: [{ id: 'a' }] });
  // Terminal status but a pending decision -> still resumable, not deletable.
  const zombie = session.createRun({ request: 'zombie', policy: DEFAULT_POLICY });
  session.updateRun(zombie, { status: 'failed' });
  session.insertDecision({ runId: zombie, taskId: 't1', question: 'pick one', options: [{ id: 'a' }] });

  const before = session.listRuns().length;
  const preview = session.previewRuns();
  assert.equal(session.listRuns().length, before, 'preview wrote nothing');
  assert.deepEqual(preview.deletable, [done]);
  assert.match(preview.runs.find(r => r.id === zombie).reason, /pending decision/);
  assert.match(preview.runs.find(r => r.id === running).reason, /active\/resumable/);
  assert.match(preview.runs.find(r => r.id === waiting).reason, /active\/resumable/);
  const all = session.previewRuns({ includeActive: true });
  assert.deepEqual(new Set(all.deletable), new Set([done, running, waiting, zombie]));
  session.close();
});

test('B: pruneRuns deletes terminal runs and cascades tasks/decisions/trace/run-local health', () => {
  const session = openStore(dbPath());
  const runId = session.createRun({ request: 'old', policy: DEFAULT_POLICY });
  seedTask(session, runId);
  session.updateRun(runId, { status: 'completed' });
  session.insertDecision({ runId, taskId: 't1', question: 'q', options: [] });
  session.answerDecision({ runId, decisionId: session.listDecisions(runId)[0].id, answer: 'yes' });
  seedTraceAndHealth(session, runId);
  const result = session.pruneRuns();
  assert.equal(result.executed, true);
  assert.deepEqual(result.deletable, [runId]);
  assert.equal(result.totals.tasks, 1);
  assert.equal(result.totals.decisions, 1);
  assert.equal(result.totals.trace, 1);
  assert.equal(result.totals.health, 1);
  assert.equal(session.getRun(runId), null);
  assert.equal(session.loadTasks(runId).length, 0);
  assert.equal(session.listDecisions(runId).length, 0);
  assert.equal(session.loadTrace(runId).length, 0);
  assert.equal(session.activeHealth({ provider: 'ps', model: 'ms', runId }), null);
  session.close();
});

test('C: olderThan cutoff keeps recent terminal runs', () => {
  const session = openStore(dbPath());
  const old = session.createRun({ request: 'old', policy: DEFAULT_POLICY });
  session.updateRun(old, { status: 'completed' });
  const fresh = session.createRun({ request: 'fresh', policy: DEFAULT_POLICY });
  session.updateRun(fresh, { status: 'completed' });
  const cutoff = new Date(Date.now() - 1000).toISOString(); // everything older than 1s ago
  const none = session.previewRuns({ olderThan: cutoff });
  assert.equal(none.deletable.length, 0, 'both runs were just updated');
  const future = new Date(Date.now() + 60_000).toISOString();
  const all = session.pruneRuns({ olderThan: future });
  assert.equal(all.totals.runs, 2);
  assert.equal(session.listRuns().length, 0);
  session.close();
});

test('D: decision_memory, protocol_stats and global health survive any cleanup', () => {
  const session = openStore(dbPath());
  const runId = session.createRun({ request: 'r', policy: DEFAULT_POLICY });
  session.updateRun(runId, { status: 'completed' });
  session.saveMemory({ scope: 'repository', scopeKey: 'default', key: 'lib', decision: { optionId: 'a' }, rationale: 'r' });
  session.recordProtocol({ provider: 'ps', model: 'ms', kind: 'malformed' });
  session.recordHealth({ provider: 'pc', model: 'mc', state: 'usage_exhausted', runId, ttlMs: 60_000 }); // stored with run_id=''
  const cleared = session.clearRuns({ force: true, includeActive: true });
  assert.equal(cleared.totals.runs, 1);
  assert.equal(session.listRuns().length, 0);
  assert.equal(session.listMemory().length, 1);
  assert.equal(session.protocolStats().length, 1);
  assert.equal(session.protocolStats()[0].malformed, 1);
  const global = session.activeHealth({ provider: 'pc', model: 'mc' });
  assert.ok(global, 'global usage_exhausted health is preserved');
  assert.equal(global.runId, undefined);
  session.close();
});

test('E: injected failure inside pruneRuns rolls the whole batch back', () => {
  const path = dbPath();
  const session = openStore(path);
  const a = session.createRun({ request: 'a', policy: DEFAULT_POLICY });
  session.updateRun(a, { status: 'completed' });
  const b = session.createRun({ request: 'b', policy: DEFAULT_POLICY });
  session.updateRun(b, { status: 'failed' });
  session.insertDecision({ runId: b, taskId: 't1', question: 'q', options: [] });
  const dec = session.listDecisions(b)[0];
  session.answerDecision({ runId: b, decisionId: dec.id, answer: 'ok' });
  // Corrupt the answered decision so the mid-transaction DELETE fails with a
  // constraint error — proves rollback, not partial cleanup.
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TRIGGER fail_on_decision_delete BEFORE DELETE ON decisions
    WHEN OLD.run_id = '${b}' BEGIN SELECT RAISE(ABORT, 'injected constraint'); END;`);
  raw.close();
  assert.throws(() => session.pruneRuns(), /injected|abort/i);
  assert.ok(session.getRun(a), 'first run still present after rollback');
  assert.ok(session.getRun(b), 'second run still present after rollback');
  assert.equal(session.listDecisions(b).length, 1);
  session.close();
  const cleanup = new DatabaseSync(path);
  cleanup.exec('DROP TRIGGER fail_on_decision_delete');
  cleanup.close();
});

test('F: deleteRun refuses active and pending-decision runs; --force deletes terminal', () => {
  const session = openStore(dbPath());
  const running = session.createRun({ request: 'live', policy: DEFAULT_POLICY });
  assert.throws(() => session.deleteRun(running), /active\/resumable; use --force/);
  const waiting = session.createRun({ request: 'w', policy: DEFAULT_POLICY });
  session.updateRun(waiting, { status: 'waiting_for_user' });
  session.insertDecision({ runId: waiting, taskId: 't1', question: 'q', options: [] });
  assert.throws(() => session.deleteRun(waiting), /active\/resumable; use --force/);
  assert.equal(session.deleteRun(waiting, { force: true }).id, waiting);
  const done = session.createRun({ request: 'd', policy: DEFAULT_POLICY });
  session.updateRun(done, { status: 'cancelled' });
  const out = session.deleteRun(done);
  assert.equal(out.id, done);
  assert.equal(session.getRun(done), null);
  assert.throws(() => session.deleteRun('run-nope'), /run not found/);
  session.close();
});

test('G: clearRuns previews by default; --force deletes terminal only; --include-active adds active runs', () => {
  const session = openStore(dbPath());
  const done = session.createRun({ request: 'done', policy: DEFAULT_POLICY });
  session.updateRun(done, { status: 'completed' });
  const live = session.createRun({ request: 'live', policy: DEFAULT_POLICY });
  const waiting = session.createRun({ request: 'wait', policy: DEFAULT_POLICY });
  session.updateRun(waiting, { status: 'waiting_for_user' });
  session.insertDecision({ runId: waiting, taskId: 't1', question: 'q', options: [] });

  const preview = session.clearRuns();
  assert.equal(preview.executed, false);
  assert.deepEqual(preview.deletable, [done]);
  assert.equal(session.listRuns().length, 3, 'preview wrote nothing');
  const totals = counts(session);
  assert.equal(totals.runs, 3);

  const forced = session.clearRuns({ force: true });
  assert.equal(forced.executed, true);
  assert.deepEqual(forced.deletable, [done]);
  assert.ok(session.getRun(live), 'active run survived --force without --include-active');
  assert.ok(session.getRun(waiting), 'pending-decision run survived');

  const all = session.clearRuns({ force: true, includeActive: true });
  assert.deepEqual(new Set(all.deletable), new Set([live, waiting]), 'explicit include-active removes both active and waiting');
  assert.equal(session.listRuns().length, 0);
  session.close();
});

test('H: CLI --prune honours --older-than and prints Japanese output', () => {
  const path = dbPath();
  const session = openStore(path);
  const r = session.createRun({ request: 'old run', policy: DEFAULT_POLICY });
  session.updateRun(r, { status: 'completed' });
  session.close();

  const bad = runCli(['--prune', '--older-than', 'soon', '--store', path]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /invalid --older-than/);
  const misplaced = runCli(['--older-than', '7d', '--list', '--store', path]);
  assert.equal(misplaced.status, 2);
  assert.match(misplaced.stderr, /--older-than requires --prune/);

  const keep = runCli(['--prune', '--older-than', '7d', '--store', path]);
  assert.equal(keep.status, 0, keep.stderr);
  assert.match(keep.stdout, /削除しました: 0 ラン/);
  const gone = runCli(['--prune', '--store', path]);
  assert.equal(gone.status, 0, gone.stderr);
  assert.match(gone.stdout, /削除しました: 0 ラン/);
  const db = new DatabaseSync(path);
  db.prepare('UPDATE runs SET updated_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', r);
  db.close();
  const preview = runCli(['--prune', '--dry-run', '--store', path]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /削除対象（プレビュー）: 1 ラン/);
  const aged = runCli(['--prune', '--store', path]);
  assert.equal(aged.status, 0, aged.stderr);
  assert.match(aged.stdout, /削除しました: 1 ラン/);
  const check = openStore(path);
  assert.equal(check.listRuns().length, 0);
  check.close();
});

test('I: CLI --delete removes terminal runs and requires --force for active runs', () => {
  const path = dbPath();
  const session = openStore(path);
  const done = session.createRun({ request: 'finished', policy: DEFAULT_POLICY });
  session.updateRun(done, { status: 'completed' });
  const live = session.createRun({ request: 'live', policy: DEFAULT_POLICY });
  session.close();

  const blocked = runCli(['--delete', live, '--store', path]);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /active\/resumable; use --force/);
  const del = runCli(['--delete', done, '--store', path]);
  assert.equal(del.status, 0, del.stderr);
  assert.match(del.stdout, new RegExp(`削除しました: ${done}`));
  const missing = runCli(['--delete', done, '--store', path]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /run not found/);
  const forced = runCli(['--delete', live, '--force', '--store', path]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, new RegExp(`削除しました: ${live}`));
});

test('J: CLI --clear previews, --force clears terminal, --include-active is explicit', () => {
  const path = dbPath();
  const session = openStore(path);
  const done = session.createRun({ request: 'done', policy: DEFAULT_POLICY });
  session.updateRun(done, { status: 'completed' });
  const live = session.createRun({ request: 'live', policy: DEFAULT_POLICY });
  session.close();

  const preview = runCli(['--clear', '--store', path]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /削除対象（プレビュー）: 1 ラン/);
  assert.match(preview.stdout, /--force/);
  const forced = runCli(['--clear', '--force', '--store', path]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /削除しました: 1 ラン/);
  const check1 = openStore(path);
  assert.equal(check1.listRuns().length, 1, 'active run survived');
  check1.close();
  const active = runCli(['--clear', '--force', '--include-active', '--store', path]);
  assert.equal(active.status, 0, active.stderr);
  assert.match(active.stdout, /削除しました: 1 ラン/);
  const check2 = openStore(path);
  assert.equal(check2.listRuns().length, 0);
  check2.close();
  const bad = runCli(['--include-active', '--prune', '--store', path]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--include-active requires --clear/);
  const bad2 = runCli(['--force', '--list', '--store', path]);
  assert.equal(bad2.status, 2);
  assert.match(bad2.stderr, /--force requires --delete or --clear/);
  const bad3 = runCli(['--prune', '--clear', '--store', path]);
  assert.equal(bad3.status, 2);
  assert.match(bad3.stderr, /exclusive/);
});

test('K: parseOlderThan validates durations', () => {
  assert.equal(parseOlderThan('7d'), 7 * 86_400_000);
  assert.equal(parseOlderThan('12h'), 12 * 3_600_000);
  assert.equal(parseOlderThan('30m'), 30 * 60_000);
  assert.equal(parseOlderThan('2w'), 2 * 604_800_000);
  for (const bad of ['', 'abc', '7', 'd7', '-3d', '1.5d', '7y']) {
    assert.throws(() => parseOlderThan(bad), /invalid --older-than/, bad);
  }
});

test('L: formatCleanup renders concise Japanese for preview and executed results', () => {
  const session = openStore(dbPath());
  const r = session.createRun({ request: 'some request', policy: DEFAULT_POLICY });
  session.updateRun(r, { status: 'completed' });
  const preview = session.clearRuns();
  const text = formatCleanup(preview);
  assert.match(text, /削除対象（プレビュー）: 1 ラン/);
  assert.match(text, /--force/);
  const done = formatCleanup(session.clearRuns({ force: true }));
  assert.match(done, /削除しました: 1 ラン/);
  assert.equal(formatCleanup(session.clearRuns()), '削除対象のランはありません');
  session.close();
});

test('M: cleanup never touches the real .orchestration/state.db in tests', () => {
  // Every test above uses mkdtempSync paths; this asserts the convention and that
  // the CLI never writes to the default store when --store is given a temp path.
  const realDefault = join(kit, '.orchestration', 'state.db');
  const path = dbPath();
  assert.notEqual(resolve(path), resolve(realDefault));
  const out = runCli(['--clear', '--store', path]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /削除対象のランはありません/);
});

test('N: a terminal run with an in-flight task is protected until the task settles', () => {
  const session = openStore(dbPath());
  const runId = session.createRun({ request: 'crashed', policy: DEFAULT_POLICY });
  seedTask(session, runId, 'running');
  session.updateRun(runId, { status: 'failed' });
  const preview = session.previewRuns();
  assert.deepEqual(preview.deletable, []);
  assert.match(preview.runs.find(r => r.id === runId).reason, /running task/);
  assert.throws(() => session.deleteRun(runId), /active\/resumable; use --force/);
  session.openTaskStore(runId).update('t1', { status: 'failed' });
  const out = session.deleteRun(runId);
  assert.equal(out.deleted.tasks, 1);
  assert.equal(session.loadTasks(runId).length, 0);
  session.close();
});

test('O: list/show/resume of a deleted run do not revive it', async () => {
  const session = openStore(dbPath());
  const id = session.createRun({ request: 'finished', policy: DEFAULT_POLICY });
  session.updateRun(id, { status: 'completed' });
  session.deleteRun(id);
  assert.equal(session.getRun(id), null);
  assert.ok(!session.listRuns().some(r => r.id === id));
  await assert.rejects(() => resumeOrchestration({ session, agents: [], routing: {}, registry: {}, policy: DEFAULT_POLICY },
    { runId: id, runner: { run() { throw new Error('must not invoke'); } } }), /run not found/);
  session.close();
});
