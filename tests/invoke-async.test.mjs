// Async one-shot invoker lifecycle: real local child processes (no model calls)
// prove parallel overlap, independent prompt files, event-loop progress during a
// model wait, bounded kill/abort semantics and cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter, getEventListeners } from 'node:events';
import { createPiInvoker } from '../adapters/pi/lib/invoke.mjs';
import { createAgentRunner } from '../lib/orchestrator/runner.mjs';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(kit, 'tests', 'fixtures', 'oneshot-child.mjs');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const REG = { version: 1, backends: {
  a: { provider: 'pa', model: 'ma' },
  b: { provider: 'pb', model: 'mb' },
  c: { provider: 'pc', model: 'mc' },
} };
const testRouting = { ...routing, capabilities: { ...(routing.capabilities ?? {}), 'test-cap': { primary: 'a', fallback: ['b', 'c'] } } };
const task = (extra = {}) => ({ id: 't', title: 't', goal: 'g', capability: 'test-cap', assignedAgent: 'scout',
  acceptance: ['done'], executionMode: 'oneshot', ...extra });
const jsonReply = obj => `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
const okReply = jsonReply({ status: 'completed', summary: 'done', acceptance: [{ id: 'A1', met: true, evidence: 'ran' }] });

const invokerFor = opts => createPiInvoker({ piEntry: FIXTURE, env: process.env, ...opts });

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4321;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

test('two real children overlap: barrier releases only after both have started', async (t) => {
  const shared = mkdtempSync(join(tmpdir(), 'ludi-barrier-'));
  const ac = new AbortController(), pending = [];
  t.after(async () => { ac.abort(); await Promise.allSettled(pending); rmSync(shared, { recursive: true, force: true }); });
  const invoke = invokerFor({ timeoutMs: 15000 });
  const req = name => ({ modelId: 'p/m', systemPrompt: 's', prompt: `barrier ${shared} ${name}`, signal: ac.signal });
  const a = invoke(req('a'));
  const b = invoke(req('b'));
  pending.push(a, b);
  // Wait for BOTH children to be alive (each writes <name>.start at launch).
  // Then a single .go file unblocks them — a second child could not have
  // created its start marker unless the event loop ran both spawns.
  for (let i = 0; i < 400 && !(existsSync(join(shared, 'a.start')) && existsSync(join(shared, 'b.start'))); i++) {
    await new Promise(r => setTimeout(r, 25));
  }
  assert.ok(existsSync(join(shared, 'a.start')), 'child a started');
  assert.ok(existsSync(join(shared, 'b.start')), 'child b started while a was still blocked');
  writeFileSync(join(shared, 'a.go'), '1');
  writeFileSync(join(shared, 'b.go'), '1');
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  // Each child echoes its own prompt back after the barrier opens — proof the
  // prompt file was still present while both children were alive (i.e. it was
  // removed only after close, not before).
  assert.match(ra.text, /^barrier .* a$/);
  assert.match(rb.text, /^barrier .* b$/);
});

test('prompt files are per-invocation and removed only after close', async () => {
  const seen = [];
  const invoke = createPiInvoker({ piEntry: 'pi-entry', spawnImpl(_cmd, args) {
    const child = fakeChild();
    seen.push(args.at(-1).slice(1));
    queueMicrotask(() => { child.stdout.emit('data', 'x'); child.emit('close', 0, null); });
    return child;
  } });
  const [r1, r2] = await Promise.all([
    invoke({ modelId: 'p/m', systemPrompt: 's', prompt: 'first' }),
    invoke({ modelId: 'p/m', systemPrompt: 's', prompt: 'second' }),
  ]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], 'each invocation gets its own prompt file');
  for (const p of seen) assert.equal(existsSync(p), false, `removed after close: ${p}`);
});

test('host event loop keeps running while a model call is in flight', async () => {
  let ticks = 0;
  const spinner = setInterval(() => { ticks++; }, 5);
  const invoke = invokerFor({ timeoutMs: 80 });
  const pending = invoke({ modelId: 'p/m', systemPrompt: 's', prompt: 'hang' });
  await new Promise(r => setTimeout(r, 120));
  clearInterval(spinner);
  const res = await pending;
  assert.ok(ticks > 5, `event loop advanced during the model wait (${ticks} ticks)`);
  assert.equal(res.ok, false);
  assert.match(res.error, /timed out/);
  assert.ok(res.durationMs >= 80);
});

test('UTF-8 stdout split across chunk boundaries decodes correctly', async () => {
  const invoke = invokerFor();
  const res = await invoke({ modelId: 'p/m', systemPrompt: 's', prompt: 'utf8' });
  assert.equal(res.ok, true);
  assert.equal(res.text, '日本語テキスト🌸'.repeat(10));
});

test('non-zero exit is a failure; signal exit and empty output classify distinctly', async () => {
  const invoke = invokerFor();
  const crash = await invoke({ modelId: 'p/m', systemPrompt: 's', prompt: 'crash' });
  assert.equal(crash.ok, false);
  assert.match(crash.error, /pi exited 2/);
  const silent = await invoke({ modelId: 'p/m', systemPrompt: 's', prompt: 'silent' });
  assert.equal(silent.ok, false);
  assert.match(silent.error, /empty model response/);
  const killed = fakeChild();
  const inv = createPiInvoker({ piEntry: 'pi-entry', env: process.env, spawnImpl: () => killed });
  const p = inv({ modelId: 'p/m', prompt: 'x' });
  queueMicrotask(() => killed.emit('close', null, 'SIGTERM'));
  const sig = await p;
  assert.equal(sig.ok, false);
  assert.match(sig.error, /signal SIGTERM/);
});

test('timeout escalates only its owned child and keeps prompt/result until real close', { timeout: 2000 }, async t => {
  const child = fakeChild(), signals = [];
  let path, forced, settled = false;
  const forceSent = new Promise(resolve => { forced = resolve; });
  child.kill = signal => { signals.push(signal); if (signal === 'SIGKILL') forced(); return false; };
  t.after(() => child.emit('close', null, 'SIGKILL'));
  const invoke = createPiInvoker({ piEntry: 'pi-entry', spawnImpl(_cmd, args) { path = args.at(-1).slice(1); return child; }, timeoutMs: 20, killGraceMs: 20 });
  const pending = invoke({ modelId: 'p/m', prompt: 'x' }).then(result => { settled = true; return result; });
  await forceSent;
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(settled, false, 'kill requests are not termination proof');
  assert.equal(existsSync(path), true, 'an unconfirmed child may still need its prompt');
  child.emit('close', null, 'SIGKILL');
  const res = await pending;
  assert.equal(res.ok, false);
  assert.match(res.error, /timed out/);
  assert.equal(existsSync(path), false);
});

test('abort racing dispatch still kills the spawned child (no silent retry)', async () => {
  const child = fakeChild();
  const ac = new AbortController();
  const invoke = createPiInvoker({ piEntry: 'pi-entry', spawnImpl: () => {
    ac.abort(); // after pre-check, before registration: exercise the recheck itself
    return child;
  }, killGraceMs: 25 });
  const pending = invoke({ modelId: 'p/m', prompt: 'x', signal: ac.signal });
  setImmediate(() => child.emit('close', null, 'SIGTERM'));
  const res = await pending;
  assert.equal(res.ok, false);
  assert.equal(child.killed, true);
  assert.equal(res.abort, true);
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
});

test('caller abort before spawn and mid-flight never look like model failures', async () => {
  const ac = new AbortController();
  ac.abort();
  const invoke = createPiInvoker({ piEntry: 'pi-entry', env: process.env, spawnImpl: () => { throw new Error('must not spawn'); } });
  const early = await invoke({ modelId: 'p/m', prompt: 'x', signal: ac.signal });
  assert.equal(early.ok, false);
  assert.equal(early.abort, true);

  const child = fakeChild();
  const inv2 = createPiInvoker({ piEntry: 'pi-entry', env: process.env, spawnImpl: () => child });
  const ac2 = new AbortController();
  const pending = inv2({ modelId: 'p/m', prompt: 'x', signal: ac2.signal });
  ac2.abort();
  assert.equal(child.killed, true);
  queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  const mid = await pending;
  assert.equal(mid.ok, false);
  assert.equal(mid.abort, true);
});

test('invalid explicit timer bounds refuse before any spawn', () => {
  for (const key of ['timeoutMs', 'killGraceMs']) for (const value of [0, -1, 0.5, NaN, Infinity, 2147483648, '50']) {
    assert.throws(() => createPiInvoker({ piEntry: 'fixture', [key]: value }), RangeError);
  }
});

test('byte overflow and stream errors stop the child, wait for close, and clean listeners', async () => {
  for (const stream of ['stdout', 'stderr']) for (const kind of ['overflow', 'error']) {
    const child = fakeChild(), ac = new AbortController();
    const invoke = createPiInvoker({ piEntry: 'fixture', spawnImpl: () => child });
    let settled = false;
    const pending = invoke({ modelId: 'p/m', prompt: 'x', signal: ac.signal }).then(result => { settled = true; return result; });
    if (kind === 'overflow') child[stream].emit('data', Buffer.alloc(16 * 1024 * 1024 + 1, 'x'));
    else child[stream].emit('error', new Error('stream broke'));
    await Promise.resolve();
    assert.equal(child.killed, true);
    assert.equal(settled, false);
    child.emit('close', 0, null);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.error, kind === 'overflow' ? /exceeded 16777216 bytes/ : /stream broke/);
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
    for (const emitter of [child, child.stdout, child.stderr]) assert.equal(emitter.eventNames().length, 0);
  }
});

test('forced UTF-8 chunk split decodes without replacement characters', async () => {
  const child = fakeChild();
  const invoke = createPiInvoker({ piEntry: 'fixture', spawnImpl: () => child });
  const pending = invoke({ modelId: 'p/m', prompt: 'x' });
  const text = '日🌸本', bytes = Buffer.from(text);
  for (const byte of bytes) child.stdout.emit('data', Buffer.from([byte]));
  child.emit('close', 0, null);
  assert.equal((await pending).text, text);
});

test('oneshot runner: cancellation wins over late success and planned task handling', async () => {
  for (const planned of [{}, { planningRef: 'plan' }, { parentTaskId: 'parent' }]) {
    const ac = new AbortController();
    let calls = 0;
    const runner = createAgentRunner({ agents, routing: testRouting, registry: REG, invoke: async req => {
      assert.equal(req.signal, ac.signal);
      calls++; ac.abort();
      return { ok: true, text: okReply };
    } });
    const result = await runner.run(task(planned), { dependencyResults: [], signal: ac.signal });
    assert.equal(result.ok, false);
    assert.equal(result.abort, true);
    assert.equal(calls, 1);
    const again = await runner.run(task(planned), { dependencyResults: [], signal: ac.signal });
    assert.equal(again.abort, true);
    assert.equal(calls, 1, 'already-aborted requests never invoke');
  }
});

test('oneshot runner: abort stops the task instead of advancing to another candidate', async () => {
  const calls = [];
  const ac = new AbortController();
  const runner = createAgentRunner({
    agents, routing: testRouting,
    registry: REG, signal: ac.signal,
    async invoke(req) {
      calls.push(req.modelId);
      ac.abort();
      return { ok: false, error: 'cancelled by caller signal', abort: true, failureClass: 'UNKNOWN', durationMs: 1 };
    },
  });
  const res = await runner.run(task(), { dependencyResults: [] });
  assert.equal(res.ok, false);
  assert.equal(res.abort, true);
  assert.deepEqual(calls, ['pa/ma'], 'cancel must not start the next candidate');
});

test('oneshot runner: a model failure still advances to the next candidate', async () => {
  const calls = [];
  const runner = createAgentRunner({
    agents, routing: testRouting, registry: REG,
    async invoke(req) {
      calls.push(req.modelId);
      return calls.length === 1
        ? { ok: false, error: 'backend exploded', failureClass: 'MODEL_FAILURE', durationMs: 1 }
        : { ok: true, text: okReply, durationMs: 1 };
    },
  });
  const res = await runner.run(task(), { dependencyResults: [] });
  assert.equal(res.ok, true);
  assert.deepEqual(calls, ['pa/ma', 'pb/mb'], 'model failure advances; cancel does not');
});
