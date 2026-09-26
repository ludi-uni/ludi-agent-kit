// SQLite concurrency and exception-safe run termination: busy_timeout, two writers on
// one state.db, injected exceptions, and no `running` zombie in list / latest-run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { DEFAULT_POLICY } from '../lib/orchestrator/policy.mjs';
import { openStore, BUSY_TIMEOUT_MS } from '../lib/orchestrator/store.mjs';
import { orchestrate } from '../lib/orchestrator/orchestrator.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const REG = { version: 1, backends: {
  local: { provider: 'pl', model: 'ml', thinking: 'off' },
  cheap: { provider: 'pc', model: 'mc', thinking: 'low' },
  sol: { provider: 'ps', model: 'ms', thinking: 'high' },
  codex: { provider: 'px', model: 'mx', thinking: 'high' },
} };
const spec = (id, agent, dependencies = []) => ({ id, title: `task ${id}`, goal: `goal ${id}`, agent, dependencies, acceptance: ['done'] });
const completed = task => ({ ok: true, structured: true, result: { status: 'completed', summary: `did ${task.id}`, artifacts: [], verification: [], acceptance: [{ id: 'A1', met: true, evidence: 'observed' }], remainingIssues: [], decisions: [], newTasks: [] } });
const dbPath = () => join(mkdtempSync(join(tmpdir(), 'ludi-sql-')), 'state.db');
const child = join(kit, 'tests/fixtures/orch-concurrent-child.mjs');
const cli = join(kit, 'scripts/orchestrate.mjs');

const spawnChild = args => new Promise(res => {
  const p = spawn(process.execPath, [child, ...args], { encoding: 'utf8' });
  let out = '', err = '';
  p.stdout.on('data', d => { out += d; });
  p.stderr.on('data', d => { err += d; });
  p.on('close', code => res({ code, out, err, json: (() => { try { return JSON.parse(out.trim().split(/\r?\n/).at(-1)); } catch { return null; } })() }));
});

test('busy_timeout is set to a bounded value and WAL is kept', () => {
  const session = openStore(dbPath());
  const p = session.pragmas();
  assert.equal(p.journalMode, 'wal');
  assert.equal(p.busyTimeoutMs, BUSY_TIMEOUT_MS);
  assert.ok(BUSY_TIMEOUT_MS >= 1000 && BUSY_TIMEOUT_MS <= 30000, 'bounded');
  session.close();
});

test('concurrent writer: another process holding the write lock makes us wait (busy_timeout), not throw', async () => {
  const path = dbPath();
  const session = openStore(path);
  const holdMs = 600;
  // Separate process: BEGIN IMMEDIATE, hold for holdMs, COMMIT.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(path)});
    db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT INTO runs (id, request, status, created_at, updated_at, policy_snapshot, counters, scope_key) VALUES ('hold','h','completed','2000','2000','{}','{}','k')").run();
    console.log('locked');
    await new Promise(r => setTimeout(r, ${holdMs}));
    db.exec('COMMIT'); db.close();
  `], { encoding: 'utf8' });
  await new Promise(res => holder.stdout.on('data', d => { if (String(d).includes('locked')) res(); }));
  const started = Date.now();
  const runId = session.createRun({ request: 'waiter', policy: DEFAULT_POLICY }); // would throw SQLITE_BUSY without busy_timeout
  const waited = Date.now() - started;
  assert.ok(waited >= 200, `expected to wait for the lock, waited ${waited}ms`);
  assert.ok(waited < BUSY_TIMEOUT_MS, `waited ${waited}ms`);
  assert.equal(session.getRun(runId).status, 'running');
  await new Promise(res => holder.on('close', res));
  assert.equal(session.listRuns().length, 2);
  session.close();
});

test('without busy_timeout the same overlap throws SQLITE_BUSY (documents why the pragma matters)', async () => {
  const path = dbPath();
  openStore(path).close();
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path); // default busy_timeout = 0
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(path)});
    db.exec('BEGIN IMMEDIATE'); console.log('locked');
    await new Promise(r => setTimeout(r, 400)); db.exec('COMMIT'); db.close();
  `], { encoding: 'utf8' });
  await new Promise(res => holder.stdout.on('data', d => { if (String(d).includes('locked')) res(); }));
  assert.throws(() => raw.exec('BEGIN IMMEDIATE'), /SQLITE_BUSY|database is locked/i);
  raw.close();
  await new Promise(res => holder.on('close', res));
});

test('concurrent E2E: two orchestrate processes on one state.db both terminate, no running zombie', async () => {
  const path = dbPath();
  openStore(path).close(); // create schema once so both children start on an existing file
  const [x, y] = await Promise.all([spawnChild([path, 'alpha', '4', '40']), spawnChild([path, 'beta', '4', '40'])]);
  assert.equal(x.code, 0, x.err + x.out);
  assert.equal(y.code, 0, y.err + y.out);
  assert.equal(x.json.runStatus, 'completed');
  assert.equal(y.json.runStatus, 'completed');
  assert.notEqual(x.json.runId, y.json.runId);
  const session = openStore(path);
  const runs = session.listRuns();
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map(r => r.status), ['completed', 'completed']);
  assert.ok(runs.every(r => r.completed === 4 && r.total === 4));
  assert.equal(session.listRuns({ status: 'running' }).length, 0, 'no zombie');
  for (const r of runs) assert.ok(session.loadTasks(r.id).every(t => t.status === 'completed'));
  session.close();
});

test('concurrent E2E with an injected exception: the failing run ends `failed`, the other completes, latest-run is never a zombie', async () => {
  const path = dbPath();
  openStore(path).close();
  const [x, y] = await Promise.all([spawnChild([path, 'alpha', '3', '40', 't2']), spawnChild([path, 'beta', '3', '40'])]);
  assert.equal(x.code, 3, x.err + x.out);
  assert.match(x.json.error, /injected failure at t2/);
  assert.equal(x.json.persisted, true, 'run state was persisted on error');
  assert.equal(y.code, 0, y.err + y.out);
  const session = openStore(path);
  const failed = session.getRun(x.json.runId);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.counters.unresolved.some(u => /run aborted/.test(u)));
  assert.ok(session.loadTrace(failed.id).some(e => e.type === 'error' && /injected/.test(e.message)));
  assert.ok(session.loadTasks(failed.id).every(t => t.status !== 'running'));
  assert.equal(session.getRun(y.json.runId).status, 'completed');
  assert.equal(session.listRuns({ status: 'running' }).length, 0);
  // list / latest-run: the top row is a terminal state, and --list from the CLI agrees.
  const list = spawnSync(process.execPath, [cli, '--list', '--store', path], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  assert.doesNotMatch(list.stdout, /\srunning\s/);
  session.close();
});

test('in-process injected store exception mid-round: in-flight task and run are terminated, updated_at moves, transaction is released', async () => {
  const path = dbPath();
  const real = openStore(path);
  let armed = false;
  // Wrap the session: appendTrace throws once on the first `result` event, i.e. while
  // the task is still `running` in the store.
  const session = { ...real, appendTrace(runId, e) { if (e.type === 'result' && !armed) { armed = true; throw new Error('disk full (injected)'); } return real.appendTrace(runId, e); } };
  let caught = null;
  try {
    await orchestrate({ request: 'boom', plan: [spec('a', 'scout'), spec('b', 'coder', ['a'])], agents, routing, registry: REG, policy: DEFAULT_POLICY, session, runner: { async run(t) { return completed(t); } } });
  } catch (e) { caught = e; }
  assert.ok(caught, 'orchestrate rethrows');
  assert.match(caught.message, /disk full/);
  assert.equal(caught.persisted, true);
  const run = real.getRun(caught.runId);
  assert.equal(run.status, 'failed');
  assert.ok(run.updatedAt >= run.createdAt);
  const tasks = real.loadTasks(run.id);
  assert.equal(tasks.find(t => t.id === 'a').status, 'failed');
  assert.match(tasks.find(t => t.id === 'a').blockedReason, /run aborted by error/);
  assert.equal(tasks.find(t => t.id === 'b').status, 'pending');
  assert.ok(real.loadTrace(run.id).some(e => e.type === 'error'));
  // The connection is usable (no dangling BEGIN): a fresh run on the same session completes.
  const ok = await orchestrate({ request: 'after', plan: [spec('a', 'scout')], agents, routing, registry: REG, policy: DEFAULT_POLICY, session: real, runner: { async run(t) { return completed(t); } } });
  assert.equal(ok.runStatus, 'completed');
  assert.equal(real.listRuns({ status: 'running' }).length, 0);
  assert.equal(real.listRuns()[0].id, ok.runId, 'latest run is the completed one');
  real.close();
});

test('store unwritable during termination: the error names the persistence limitation instead of hiding it', async () => {
  const real = openStore(dbPath());
  let phase = 0;
  const session = { ...real,
    appendTrace(runId, e) { if (e.type === 'result') { phase = 1; throw new Error('primary failure'); } if (phase === 1) throw new Error('store closed'); return real.appendTrace(runId, e); },
    updateRun(id, patch) { if (phase === 1) throw new Error('store closed'); return real.updateRun(id, patch); },
    saveTask(runId, t) { if (phase === 1) throw new Error('store closed'); return real.saveTask(runId, t); },
  };
  let caught = null;
  try { await orchestrate({ request: 'boom', plan: [spec('a', 'scout')], agents, routing, registry: REG, policy: DEFAULT_POLICY, session, runner: { async run(t) { return completed(t); } } }); }
  catch (e) { caught = e; }
  assert.match(caught.message, /primary failure/);
  assert.match(caught.message, /run state could not be persisted: store closed/);
  assert.equal(caught.persisted, false);
  real.close();
});
