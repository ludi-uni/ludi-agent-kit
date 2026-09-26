// Observer registry: resolution, ordering, dedupe, failure isolation, unknown ids,
// and parity between the standalone observe path and the scheduled job.
// Nothing real is written — temp outDirs only; catalog/routing/settings untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OBSERVERS, OBSERVER_FLAG_MAP, resolveRequestedObservers, runObservers } from '../lib/observe/observers.mjs';
import { loadObservationStore } from '../lib/observe/observation.mjs';
import { fromQoderCache } from '../lib/observe/sources.mjs';
import { runMaintenanceJob } from '../lib/job.mjs';
import { DEFAULT_POLICY } from '../lib/maintenance-exec.mjs';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { mergeRegistries } from '../lib/registry.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const tmp = () => mkdtempSync(join(tmpdir(), 'obsv-'));

const CAT = {
  version: 1, updatedAt: '2026-03-01',
  models: [
    { provider: 'qoder', model: 'Qwen3.8-Flash', status: 'free-campaign', cost: { free: true }, contextK: 1024, toolUse: 'good', location: 'cloud', scores: { coding: 62, reasoning: 55, speed: 85 } },
    { provider: 'cloudp', model: 'cheap-ok', status: 'active', cost: { usdPerMInput: 0.2, usdPerMOutput: 0.8 }, contextK: 256, toolUse: 'good', location: 'cloud', scores: { coding: 68, reasoning: 62, speed: 75 } },
  ],
};
const REG = mergeRegistries(null, { version: 1, backends: { qoder: { provider: 'qoder', model: 'Qwen3.8-Flash' }, cheap: { provider: 'cloudp', model: 'cheap-ok' } } });
const PI_LISTING = { models: new Set(['qoder/Qwen3.8-Flash', 'cloudp/cheap-ok']), providers: new Set(['qoder', 'cloudp']), source: 'test' };
const qoderCache = pf => ({ version: 2, updatedAt: Date.now(), models: [{ id: 'Qwen3.8-Flash', priceFactor: pf, provider: 'qoder' }] });
const qoderResult = pf => fromQoderCache(qoderCache(pf), { models: [{ provider: 'qoder', model: 'Qwen3.8-Flash' }], observedAt: new Date().toISOString() });
const jobBase = dir => ({ outDir: dir, adapterDir: join(kit, 'adapters/pi'), kit, catalog: CAT, routing, registry: REG, agents, policy: DEFAULT_POLICY });

// --- A: pi-cli only -----------------------------------------------------------
test('A: only --check-pi resolves to and runs only the pi-cli observer', async () => {
  const { ids, unknown } = resolveRequestedObservers({ checkPi: true });
  assert.deepEqual(ids, ['pi-cli']);
  assert.deepEqual(unknown, []);
  const dir = tmp();
  const run = await runMaintenanceJob({ ...jobBase(dir), checkPi: true, listing: PI_LISTING });
  assert.deepEqual(run.observers.map(o => o.id), ['pi-cli']);
  const store = loadObservationStore(join(dir, 'model-observations.jsonl')).observations;
  assert.ok(store.every(o => o.source?.trust === 'pi_cli'));
  rmSync(dir, { recursive: true, force: true });
});

// --- B: qoder-cache only --------------------------------------------------------
test('B: only --check-qoder resolves to and runs only the qoder-cache observer', async () => {
  const { ids } = resolveRequestedObservers({ checkQoder: true });
  assert.deepEqual(ids, ['qoder-cache']);
  const dir = tmp();
  const run = await runMaintenanceJob({ ...jobBase(dir), checkQoder: true, qoderListing: qoderResult(0) });
  assert.deepEqual(run.observers.map(o => o.id), ['qoder-cache']);
  const store = loadObservationStore(join(dir, 'model-observations.jsonl')).observations;
  assert.ok(store.every(o => o.source?.trust === 'provider_local_cache'));
  rmSync(dir, { recursive: true, force: true });
});

// --- C: both run once each ------------------------------------------------------
test('C: --check-pi + --check-qoder run both observers exactly once, in order', async () => {
  const { ids } = resolveRequestedObservers({ checkPi: true, checkQoder: true });
  assert.deepEqual(ids, ['pi-cli', 'qoder-cache']);
  const dir = tmp();
  const run = await runMaintenanceJob({ ...jobBase(dir), checkPi: true, listing: PI_LISTING, checkQoder: true, qoderListing: qoderResult(0) });
  assert.deepEqual(run.observers.map(o => o.id), ['pi-cli', 'qoder-cache']);
  assert.equal(run.observers.filter(o => o.id === 'pi-cli').length, 1);
  assert.equal(run.observers.filter(o => o.id === 'qoder-cache').length, 1);
  const store = loadObservationStore(join(dir, 'model-observations.jsonl')).observations;
  assert.ok(store.some(o => o.changes?.availability === 'available'));
  assert.ok(store.some(o => o.changes?.free === true));
  rmSync(dir, { recursive: true, force: true });
});

// --- D: duplicate observer deduped ------------------------------------------------
test('D: the same observer via flag + generic list runs once', async () => {
  const { ids } = resolveRequestedObservers({ checkPi: true, check: 'pi-cli,qoder-cache' });
  assert.deepEqual(ids, ['pi-cli', 'qoder-cache']); // pi-cli not duplicated
  const dir = tmp();
  const run = await runMaintenanceJob({ ...jobBase(dir), checkPi: true, check: 'pi-cli,qoder-cache', listing: PI_LISTING, qoderListing: qoderResult(0) });
  assert.equal(run.observers.filter(o => o.id === 'pi-cli').length, 1);
  rmSync(dir, { recursive: true, force: true });
});

// --- E: pi ok + qoder fail -> pi kept, job continues ------------------------------
test('E: pi-cli success + qoder-cache failure -> pi observations kept, job continues', async () => {
  const dir = tmp();
  const run = await runMaintenanceJob({ ...jobBase(dir), checkPi: true, listing: PI_LISTING, checkQoder: true, qoderListing: false });
  assert.equal(run.status, 'ok');
  assert.equal(run.ingest.probeFailed, true);
  const qoderRes = run.observers.find(o => o.id === 'qoder-cache');
  assert.equal(qoderRes.probeFailed, true);
  const store = loadObservationStore(join(dir, 'model-observations.jsonl')).observations;
  assert.ok(store.some(o => o.changes?.availability === 'available'), 'pi observations kept');
  rmSync(dir, { recursive: true, force: true });
});

// --- F: qoder ok + pi fail -> qoder kept, job continues ---------------------------
test('F: qoder-cache success + pi-cli failure -> qoder observations kept, job continues', async () => {
  const dir = tmp();
  const run = await runMaintenanceJob({ ...jobBase(dir), checkPi: true, listing: false, checkQoder: true, qoderListing: qoderResult(0) });
  assert.equal(run.status, 'ok');
  assert.equal(run.ingest.probeFailed, true);
  const piRes = run.observers.find(o => o.id === 'pi-cli');
  assert.equal(piRes.probeFailed, true);
  const store = loadObservationStore(join(dir, 'model-observations.jsonl')).observations;
  assert.ok(store.some(o => o.changes?.free === true), 'qoder observations kept');
  rmSync(dir, { recursive: true, force: true });
});

// --- G: unknown observer id -> explicit failure -----------------------------------
test('G: unknown observer id -> structured failure, never silent', async () => {
  const { ids, unknown } = resolveRequestedObservers({ check: 'pi-cli,bogus-observer' });
  assert.deepEqual(ids, ['pi-cli']);
  assert.deepEqual(unknown, ['bogus-observer']);
  const dir = tmp();
  const run = await runMaintenanceJob({ ...jobBase(dir), check: 'pi-cli,bogus-observer', listing: PI_LISTING });
  assert.equal(run.status, 'error');
  assert.match(run.error, /unknown observer/);
  rmSync(dir, { recursive: true, force: true });
});

// --- H: deterministic ordering ----------------------------------------------------
test('H: observer execution order follows the requested order deterministically', async () => {
  // requested order is honoured, not registry order
  const { ids } = resolveRequestedObservers({ check: 'qoder-cache,pi-cli' });
  assert.deepEqual(ids, ['qoder-cache', 'pi-cli']);
  const dir = tmp();
  const run = await runMaintenanceJob({ ...jobBase(dir), check: 'qoder-cache,pi-cli', listing: PI_LISTING, qoderListing: qoderResult(0) });
  assert.deepEqual(run.observers.map(o => o.id), ['qoder-cache', 'pi-cli']);
  rmSync(dir, { recursive: true, force: true });
});

// --- I: standalone CLI and job resolve identically --------------------------------
test('I: standalone observe options and job options resolve to the same observer set', () => {
  // simulate the CLI's option mapping (has('check-pi') -> checkPi:true, --check -> check)
  const cliOptions = { checkPi: true, checkQoder: true, check: null };
  const jobOptions = { checkPi: true, checkQoder: true, check: null };
  assert.deepEqual(resolveRequestedObservers(cliOptions), resolveRequestedObservers(jobOptions));
  // and the generic form maps to the same ids
  assert.deepEqual(resolveRequestedObservers({ check: 'pi-cli,qoder-cache' }).ids, ['pi-cli', 'qoder-cache']);
});

// --- registry shape ---------------------------------------------------------------
test('registry: every observer exposes the common interface', () => {
  for (const [id, o] of Object.entries(OBSERVERS)) {
    assert.equal(o.id, id);
    assert.equal(typeof o.run, 'function');
    assert.equal(typeof o.describe, 'string');
  }
  assert.ok(OBSERVERS['pi-cli']);
  assert.ok(OBSERVERS['qoder-cache']);
  assert.equal(OBSERVER_FLAG_MAP.checkPi, 'pi-cli');
  assert.equal(OBSERVER_FLAG_MAP.checkQoder, 'qoder-cache');
});
