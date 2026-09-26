// Qoder provider-metadata observer (qoder-models-cache.json priceFactor).
// Cases A–J. The cache is read-only; tests use temp fixture files. Nothing real is
// written — catalog/routing/settings untouched, only out/ artifacts + temp state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromQoderCache, fromFixture } from '../lib/observe/sources.mjs';
import { validateObservation, normalizeObservation, ingestObservations, loadObservationStore, productionObservations } from '../lib/observe/observation.mjs';
import { diffCatalog, buildCatalogProposal, applyProposalToCatalog, proposalToEvents } from '../lib/observe/differ.mjs';
import { runMaintenanceJob } from '../lib/job.mjs';
import { runMaintenancePlan, selectTierModel, DEFAULT_POLICY } from '../lib/maintenance-exec.mjs';
import { evaluateMaintenance, effectiveCatalog } from '../lib/maintenance.mjs';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { mergeRegistries } from '../lib/registry.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const tmp = () => mkdtempSync(join(tmpdir(), 'qoder-'));

const cacheDoc = (priceFactor, extra = {}) => ({
  version: 2, updatedAt: 1790224130520,
  models: [
    { id: 'Qwen3.8-Flash', name: 'Qwen3.8-Flash (0x)', priceFactor, api: 'qoder-api', provider: 'qoder', baseUrl: 'https://api3.qoder.sh/', contextWindow: 1000000, ...extra },
    { id: 'Qwen3.8-Max', priceFactor: 0.5, api: 'qoder-api', provider: 'qoder' },
  ],
});
const MODELS = [{ provider: 'qoder', model: 'Qwen3.8-Flash' }];
const CAT = {
  version: 1, updatedAt: '2026-03-01',
  models: [
    { provider: 'qoder', model: 'Qwen3.8-Flash', status: 'free-campaign', cost: { free: true }, postCampaignCost: null, contextK: 1024, vision: false, toolUse: 'good', location: 'cloud', scores: { coding: 62, reasoning: 55, speed: 85 } },
    { provider: 'cloudp', model: 'cheap-ok', status: 'active', cost: { usdPerMInput: 0.2, usdPerMOutput: 0.8 }, contextK: 256, vision: false, toolUse: 'good', location: 'cloud', scores: { coding: 68, reasoning: 62, speed: 75 } },
    { provider: 'cloudp', model: 'pro-strong', status: 'active', cost: { usdPerMInput: 5, usdPerMOutput: 20 }, contextK: 400, vision: false, toolUse: 'good', location: 'cloud', scores: { coding: 90, reasoning: 88, speed: 60 } },
    { provider: 'freetoken', model: 'Local-1', status: 'active', cost: { free: true }, location: 'local', local: { powerWatts: 450, taskMinutes: 4 }, contextK: 64, vision: false, toolUse: 'basic', scores: { coding: 40, reasoning: 35, speed: 70 } },
  ],
};
const REG = mergeRegistries(null, { version: 1, backends: {
  qoder: { provider: 'qoder', model: 'Qwen3.8-Flash' },
  cheap: { provider: 'cloudp', model: 'cheap-ok' },
  sol: { provider: 'cloudp', model: 'pro-strong' },
  local: { provider: 'freetoken', model: 'Local-1' },
} });

const writeCache = (dir, doc) => { const p = join(dir, 'qoder-models-cache.json'); writeFileSync(p, JSON.stringify(doc)); return p; };

// --- A: priceFactor 0 -> free=true -------------------------------------------
test('A: priceFactor 0 -> free=true observation', () => {
  const r = fromQoderCache(cacheDoc(0), { models: MODELS });
  assert.equal(r.state, 'ok');
  assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0].changes.free, true);
  assert.equal(r.snapshot['Qwen3.8-Flash'], 0);
});

// --- B: priceFactor > 0 -> free=false ----------------------------------------
test('B: priceFactor 1 -> free=false observation', () => {
  const r = fromQoderCache(cacheDoc(1), { models: MODELS });
  assert.equal(r.observations[0].changes.free, false);
  assert.equal(r.snapshot['Qwen3.8-Flash'], 1);
});

// --- C: 0 -> 1 = free-campaign-ended ------------------------------------------
test('C: transition 0 -> 1 emits free=false (campaign ended)', () => {
  const r = fromQoderCache(cacheDoc(1), { models: MODELS, previous: { 'Qwen3.8-Flash': 0 } });
  assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0].changes.free, false);
  assert.match(r.observations[0].evidence[0], /was 0/);
});

// --- D: 1 -> 0 = free-campaign-started ----------------------------------------
test('D: transition 1 -> 0 emits free=true (campaign started)', () => {
  const r = fromQoderCache(cacheDoc(0), { models: MODELS, previous: { 'Qwen3.8-Flash': 1 } });
  assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0].changes.free, true);
});

// --- E: 0 -> 0 = no event ------------------------------------------------------
test('E: same priceFactor -> no observation', () => {
  const r = fromQoderCache(cacheDoc(0), { models: MODELS, previous: { 'Qwen3.8-Flash': 0 } });
  assert.equal(r.observations.length, 0);
  const r2 = fromQoderCache(cacheDoc(1), { models: MODELS, previous: { 'Qwen3.8-Flash': 1 } });
  assert.equal(r2.observations.length, 0);
});

// --- F: cache missing -> unknown, catalog unchanged ----------------------------
test('F: missing cache file -> state=missing, no observation, catalog unchanged', () => {
  const dir = tmp();
  const r = fromQoderCache(join(dir, 'nope.json'), { models: MODELS });
  assert.equal(r.state, 'missing');
  assert.equal(r.observations.length, 0);
  assert.equal(CAT.models[0].cost.free, true); // untouched
  rmSync(dir, { recursive: true, force: true });
});

// --- G: malformed JSON / schema -> unknown, job continues ----------------------
test('G: malformed JSON and unknown schema -> unknown, no crash', async () => {
  const dir = tmp();
  const bad = join(dir, 'bad.json'); writeFileSync(bad, '{ not json');
  assert.equal(fromQoderCache(bad, { models: MODELS }).state, 'malformed');
  assert.equal(fromQoderCache({ version: 2, models: 'nope' }, { models: MODELS }).state, 'no-schema');
  assert.equal(fromQoderCache(cacheDoc(0), { models: [{ provider: 'qoder', model: 'Ghost-9' }] }).state, 'entry-missing');
  assert.equal(fromQoderCache(cacheDoc(undefined, { priceFactor: undefined }), { models: MODELS }).state, 'priceFactor-missing');
  // job continues on probe failure
  const run = await runMaintenanceJob({ outDir: dir, adapterDir: join(kit, 'adapters/pi'), kit, catalog: CAT, routing, registry: REG, agents, policy: DEFAULT_POLICY, checkQoder: true, qoderListing: false });
  assert.equal(run.status, 'ok');
  assert.equal(run.ingest.probeFailed, true);
  assert.equal(run.quiet, true);
  rmSync(dir, { recursive: true, force: true });
});

// --- H: campaign end -> maintenance preview re-evaluates -----------------------
test('H: 0->non-zero -> diff proposes cost.free=false; preview re-evaluates cheapest-sufficient', () => {
  const dir = tmp();
  const store = join(dir, 'obs.jsonl');
  const r = fromQoderCache(cacheDoc(1), { models: MODELS, previous: { 'Qwen3.8-Flash': 0 } });
  ingestObservations(store, r.observations);
  const observations = loadObservationStore(store).observations;
  const proposal = buildCatalogProposal(CAT, diffCatalog(CAT, observations), observations);
  assert.ok(proposal.updates.some(u => u.field === 'cost.free' && u.observedValue === false));
  // proposal -> event -> maintenance preview on hypothetical catalog
  const events = proposalToEvents(proposal);
  assert.ok(events.some(e => e.type === 'free-campaign-ended' && e.model === 'Qwen3.8-Flash'));
  const hypothetical = applyProposalToCatalog(CAT, proposal);
  const run = runMaintenancePlan({ routing, registry: REG, agents, catalog: hypothetical, events, policy: DEFAULT_POLICY });
  assert.equal(run.monitor.changed, true);
  const qd = run.proposal.decisions.find(d => d.backend === 'qoder');
  assert.ok(qd, 'qoder backend re-evaluated');
  // postCampaignCost is null -> costUnknown; never treated as $0
  const hq = effectiveCatalog(hypothetical, events).find(m => m.model === 'Qwen3.8-Flash');
  assert.equal(hq.costUnknown, true);
  assert.notEqual(hq.cost?.free, true);
  // monitor tier can no longer pick it as a free cloud model
  const after = selectTierModel(effectiveCatalog(hypothetical, events), 'monitor', DEFAULT_POLICY);
  assert.notEqual(after.selectionPath, 'free-cloud');
  rmSync(dir, { recursive: true, force: true });
});

// --- I: campaign start -> Qwen becomes free-eligible again ---------------------
test('I: non-zero -> 0 -> free=true; Qwen re-enters free-eligible pool in preview', () => {
  const dir = tmp();
  const store = join(dir, 'obs.jsonl');
  // catalog currently shows paid (campaign previously ended)
  const paidCat = structuredClone(CAT);
  paidCat.models[0].status = 'active';
  paidCat.models[0].cost = { free: false, usdPerMInput: null, usdPerMOutput: null };
  paidCat.models[0].costUnknown = true;
  const r = fromQoderCache(cacheDoc(0), { models: MODELS, previous: { 'Qwen3.8-Flash': 1 } });
  ingestObservations(store, r.observations);
  const observations = loadObservationStore(store).observations;
  const proposal = buildCatalogProposal(paidCat, diffCatalog(paidCat, observations), observations);
  assert.ok(proposal.updates.some(u => u.field === 'cost.free' && u.observedValue === true));
  const events = proposalToEvents(proposal);
  assert.ok(events.some(e => e.type === 'free-campaign-started' && e.model === 'Qwen3.8-Flash'));
  const hypothetical = applyProposalToCatalog(paidCat, proposal);
  const hq = effectiveCatalog(hypothetical, events).find(m => m.model === 'Qwen3.8-Flash');
  assert.equal(hq.status, 'free-campaign');
  assert.equal(hq.cost.free, true);
  const sel = selectTierModel(effectiveCatalog(hypothetical, events), 'monitor', DEFAULT_POLICY);
  assert.equal(sel.selectionPath, 'free-cloud');
  assert.equal(sel.selected.model, 'qoder/Qwen3.8-Flash');
  rmSync(dir, { recursive: true, force: true });
});

// --- J: costUnknown is never treated as $0 -------------------------------------
test('J: post-campaign costUnknown -> not free, not $0, flagged in proposal', () => {
  const events = [{ type: 'free-campaign-ended', provider: 'qoder', model: 'Qwen3.8-Flash', asOf: '2026-03-01' }];
  const eff = effectiveCatalog(CAT, events).find(m => m.model === 'Qwen3.8-Flash');
  assert.equal(eff.costUnknown, true);
  assert.equal(eff.cost, null);
  // costPoints(scoreModel) treats null cost as unknown, not 0
  const report = evaluateMaintenance({ routing, registry: REG, agents, catalog: CAT, events });
  const qd = report.decisions.find(d => d.backend === 'qoder');
  assert.ok(qd.currentScore.unknown.includes('cost'));
  // decision reason / proposal carries the uncertainty (never a silent $0 switch)
  if (qd.decision === 'propose') {
    const change = report.changes.find(c => c.affected.backend === 'qoder');
    assert.match(change.expectedCostImpact, /unknown/);
  }
});

// --- combined probes: --check-pi + --check-qoder run together ----------------
test('combined: checkPi + checkQoder both contribute; a stale qoder cache does not block pi availability', async () => {
  const dir = tmp();
  const listing = { models: new Set(['qoder/Qwen3.8-Flash', 'cloudp/cheap-ok', 'cloudp/pro-strong', 'freetoken/Local-1']), providers: new Set(['qoder', 'cloudp', 'freetoken']), source: 'test' };
  // observedAt must be ~now: a stale timestamp is correctly deduped as stale.
  const qoderOk = fromQoderCache(cacheDoc(0), { models: MODELS, observedAt: new Date().toISOString() }); // free:true, first sighting
  const run = await runMaintenanceJob({ outDir: dir, adapterDir: join(kit, 'adapters/pi'), kit, catalog: CAT, routing, registry: REG, agents, policy: DEFAULT_POLICY,
    checkPi: true, listing, checkQoder: true, qoderListing: qoderOk });
  assert.equal(run.status, 'ok');
  assert.equal(run.ingest.probeFailed, false);
  // both sources contributed: availability (pi) + free (qoder cache)
  const store = loadObservationStore(join(dir, 'model-observations.jsonl')).observations;
  assert.ok(store.some(o => o.changes?.availability === 'available'), 'pi availability observation stored');
  assert.ok(store.some(o => o.changes?.free === true && o.source?.trust === 'provider_local_cache'), 'qoder free observation stored');
  rmSync(dir, { recursive: true, force: true });
});

test('combined: qoder probe failure is quiet and does not suppress pi observations', async () => {
  const dir = tmp();
  const listing = { models: new Set(['qoder/Qwen3.8-Flash']), providers: new Set(['qoder']), source: 'test' };
  const run = await runMaintenanceJob({ outDir: dir, adapterDir: join(kit, 'adapters/pi'), kit, catalog: CAT, routing, registry: REG, agents, policy: DEFAULT_POLICY,
    checkPi: true, listing, checkQoder: true, qoderListing: false }); // qoder probe failed
  assert.equal(run.status, 'ok');
  assert.equal(run.ingest.probeFailed, true);
  const store = loadObservationStore(join(dir, 'model-observations.jsonl')).observations;
  assert.ok(store.some(o => o.changes?.availability === 'available'), 'pi observation still stored despite qoder failure');
  rmSync(dir, { recursive: true, force: true });
});

// --- observation schema + trust ------------------------------------------------
test('qoder observation validates and carries provider_local_cache trust', () => {
  const r = fromQoderCache(cacheDoc(0), { models: MODELS });
  const o = normalizeObservation(r.observations[0]);
  assert.deepEqual(validateObservation(o), []);
  assert.equal(o.source.trust, 'provider_local_cache');
  assert.equal(o.source.type, 'cli');
});

// --- fixture/production boundary ------------------------------------------------
test('fixture observations are tagged test and excluded from production proposals', async () => {
  const dir = tmp();
  // a fixture observation claiming qoder free:false (the contamination we just cleaned)
  const fixtureObs = fromFixture({ announcements: [{ provider: 'qoder', model: 'Qwen3.8-Flash', type: 'free-campaign-ended', asOf: '2026-03-01', label: 'Qoder pricing page', url: 'https://example.invalid/x' }] });
  assert.equal(fixtureObs[0].environment, 'test');
  assert.equal(fixtureObs[0].sourceFixture, true);
  // real production observation: qoder free:true from the cache
  const prodObs = fromQoderCache(cacheDoc(0), { models: MODELS, observedAt: new Date().toISOString() }).observations;
  const store = join(dir, 'obs.jsonl');
  ingestObservations(store, [...fixtureObs, ...prodObs]);
  const all = loadObservationStore(store).observations;
  const prod = productionObservations(all);
  assert.equal(all.length, 2);
  assert.equal(prod.length, 1);
  assert.equal(prod[0].changes.free, true); // fixture free:false excluded
  // production proposal sees only the real free:true
  const proposal = buildCatalogProposal(CAT, diffCatalog(CAT, prod), prod);
  assert.equal(proposal.updates.filter(u => u.field === 'cost.free' && u.observedValue === false).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('job excludes fixture observations from the production diff even when stored', async () => {
  const dir = tmp();
  // seed the store with a fixture observation directly (simulating prior contamination)
  const fixtureObs = fromFixture({ announcements: [{ provider: 'qoder', model: 'Qwen3.8-Flash', type: 'free-campaign-ended', asOf: '2026-03-01', label: 'fixture' }] });
  ingestObservations(join(dir, 'model-observations.jsonl'), fixtureObs);
  const run = await runMaintenanceJob({ ...{ outDir: dir, adapterDir: join(kit, 'adapters/pi'), kit, catalog: CAT, routing, registry: REG, agents, policy: DEFAULT_POLICY }, checkQoder: true, qoderListing: fromQoderCache(cacheDoc(0), { models: MODELS, observedAt: new Date().toISOString() }) });
  assert.equal(run.status, 'ok');
  assert.equal(run.excludedTestObservations, 1); // fixture record excluded from the diff
  rmSync(dir, { recursive: true, force: true });
});

// --- real cache smoke (read-only) ----------------------------------------------
test('smoke: real ~/.pi/agent/qoder-models-cache.json parses and reports Qwen3.8-Flash state', () => {
  const real = join(process.env.USERPROFILE ?? process.env.HOME, '.pi', 'agent', 'qoder-models-cache.json');
  if (!existsSync(real)) { console.log('  (skipped: real cache not present)'); return; }
  const r = fromQoderCache(real, { models: MODELS });
  assert.equal(r.state, 'ok');
  assert.equal(typeof r.snapshot['Qwen3.8-Flash'], 'number');
  // first sighting emits the current free state (0 -> free:true on this machine)
  assert.equal(r.observations[0].changes.free, r.snapshot['Qwen3.8-Flash'] === 0);
});
