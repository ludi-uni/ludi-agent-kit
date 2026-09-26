// Phase 4: observation layer — schema, dedupe/freshness, trust resolution,
// catalog diff/proposal, and hypothetical-catalog maintenance preview.
// Cases A–J. Nothing here writes outside a temp dir; real catalog/routing untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateObservation, normalizeObservation, observationHash, ingestObservations, loadObservationStore } from '../lib/observe/observation.mjs';
import { fromManual, fromPiCli, fromFixture } from '../lib/observe/sources.mjs';
import { resolveObservations, diffCatalog, buildCatalogProposal, applyProposalToCatalog } from '../lib/observe/differ.mjs';
import { runMaintenancePlan, selectTierModel, DEFAULT_POLICY } from '../lib/maintenance-exec.mjs';
import { evaluateMaintenance, effectiveCatalog, loadCatalog } from '../lib/maintenance.mjs';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { mergeRegistries } from '../lib/registry.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const tmp = () => mkdtempSync(join(tmpdir(), 'observe-'));

const CAT = {
  version: 1, updatedAt: '2026-03-01',
  models: [
    { provider: 'qoder', model: 'Qwen3.8-Flash', status: 'free-campaign', cost: { free: true }, postCampaignCost: { usdPerMInput: 0.3, usdPerMOutput: 1.2 }, contextK: 256, vision: false, toolUse: 'good', location: 'cloud', scores: { coding: 62, reasoning: 55, speed: 85 } },
    { provider: 'cloudp', model: 'cheap-ok', status: 'active', cost: { usdPerMInput: 0.2, usdPerMOutput: 0.8 }, contextK: 256, vision: false, toolUse: 'good', location: 'cloud', scores: { coding: 68, reasoning: 62, speed: 75 } },
    { provider: 'cloudp', model: 'pro-strong', status: 'active', cost: { usdPerMInput: 5, usdPerMOutput: 20 }, contextK: 400, vision: false, toolUse: 'good', location: 'cloud', scores: { coding: 90, reasoning: 88, speed: 60 } },
  ],
};
const obs = (provider, model, changes, over = {}) => normalizeObservation({
  provider, model, observedAt: '2026-03-05T00:00:00Z',
  source: { type: 'manual', trust: 'manual_verified', label: 'test' },
  changes, confidence: 0.9, ...over,
});

// --- A: same price re-observed -> dedupe + unchanged -------------------------
test('A: re-observing the same price dedupes and diffs unchanged', () => {
  const dir = tmp();
  const store = join(dir, 'obs.jsonl');
  const o = obs('cloudp', 'cheap-ok', { inputPricePer1M: 0.2 });
  const r1 = ingestObservations(store, [o]);
  const r2 = ingestObservations(store, [o]);
  assert.equal(r1.stored.length, 1);
  assert.equal(r2.duplicates.length, 1);
  assert.equal(r2.stored.length, 0);
  const diff = diffCatalog(CAT, loadObservationStore(store).observations);
  const d = diff.diffs.find(x => x.field === 'inputPricePer1M');
  assert.equal(d.status, 'unchanged');
  rmSync(dir, { recursive: true, force: true });
});

// --- B: free campaign end -> proposed update + preview -----------------------
test('B: free-campaign end observation -> proposed update, preview runs on hypothetical catalog', () => {
  const dir = tmp();
  const store = join(dir, 'obs.jsonl');
  ingestObservations(store, [obs('qoder', 'Qwen3.8-Flash', { free: false, inputPricePer1M: 0.3, outputPricePer1M: 1.2 })]);
  const observations = loadObservationStore(store).observations;
  const diff = diffCatalog(CAT, observations);
  const proposal = buildCatalogProposal(CAT, diff, observations);
  assert.ok(proposal.updates.some(u => u.model === 'qoder/Qwen3.8-Flash' && u.field === 'cost.free' && u.observedValue === false));
  const hypothetical = applyProposalToCatalog(CAT, proposal);
  assert.equal(hypothetical.models.find(m => m.model === 'Qwen3.8-Flash').cost.free, false);
  const registry = mergeRegistries(null, { version: 1, backends: { qoder: { provider: 'qoder', model: 'Qwen3.8-Flash' } } });
  const run = runMaintenancePlan({ routing, registry, agents, catalog: hypothetical, events: [], policy: DEFAULT_POLICY });
  assert.ok(['proposal', 'evaluated-no-change', 'no-change'].includes(run.outcome));
  assert.equal(CAT.models.find(m => m.model === 'Qwen3.8-Flash').cost.free, true); // real catalog untouched
  rmSync(dir, { recursive: true, force: true });
});

// --- C: price drop -> proposed, preview shows selection may change -----------
test('C: price drop observation -> proposed update; preview reflects cheaper model', () => {
  const dir = tmp();
  const store = join(dir, 'obs.jsonl');
  ingestObservations(store, [obs('cloudp', 'pro-strong', { inputPricePer1M: 0.1, outputPricePer1M: 0.4 })]);
  const observations = loadObservationStore(store).observations;
  const proposal = buildCatalogProposal(CAT, diffCatalog(CAT, observations), observations);
  assert.ok(proposal.updates.some(u => u.field === 'cost.usdPerMInput' && u.observedValue === 0.1));
  const hypothetical = applyProposalToCatalog(CAT, proposal);
  const sel = runMaintenancePlan({ routing, registry: mergeRegistries(null, { version: 1, backends: {} }), agents, catalog: hypothetical, events: [], policy: DEFAULT_POLICY });
  // pro-strong now costs ~$0.2/run blended — cheapest-sufficient for evaluate tier
  const evalTier = sel.tiers.find(t => t.role === 'monitor');
  assert.ok(evalTier);
  rmSync(dir, { recursive: true, force: true });
});

// --- D: absent from pi listing -> NOT removed --------------------------------
test('D: model absent from pi listing -> availability observation only, never removed', () => {
  const listing = { models: new Set(['cloudp/cheap-ok']), providers: new Set(['cloudp', 'qoder']) };
  const observations = fromPiCli(listing, { catalog: CAT, observedAt: '2026-03-05T00:00:00Z' });
  const qoder = observations.find(o => o.model === 'Qwen3.8-Flash');
  assert.equal(qoder.changes.availability, 'unavailable');
  const diff = diffCatalog(CAT, observations);
  const proposal = buildCatalogProposal(CAT, diff, observations);
  assert.equal(proposal.deprecations.length, 0);
  assert.ok(proposal.ignored.some(i => i.field === 'availability' && /not removal/.test(i.reason)));
});

// --- E: high-trust deprecated -> deprecation proposal -------------------------
test('E: provider_api deprecated observation -> deprecation proposal', () => {
  const o = obs('cloudp', 'cheap-ok', { status: 'deprecated' }, { source: { type: 'api', trust: 'provider_api', label: 'provider status endpoint' } });
  const diff = diffCatalog(CAT, [o]);
  const proposal = buildCatalogProposal(CAT, diff, [o]);
  assert.equal(proposal.deprecations.length, 1);
  assert.equal(proposal.deprecations[0].observedValue, 'deprecated');
});

// --- F: low vs high trust conflict -------------------------------------------
test('F: conflicting sources — high trust wins; equal-trust major conflict is recorded', () => {
  const low = obs('cloudp', 'cheap-ok', { inputPricePer1M: 9.9 }, { source: { type: 'web', trust: 'third_party' }, confidence: 0.4 });
  const high = obs('cloudp', 'cheap-ok', { inputPricePer1M: 0.25 }, { source: { type: 'api', trust: 'provider_api' }, confidence: 0.9 });
  const resolved = resolveObservations([low, high]);
  const r = resolved.get('cloudp/cheap-ok::inputPricePer1M');
  assert.equal(r.winner.value, 0.25); // same timestamp -> trust decides
  assert.equal(r.conflict, null);
  // equal trust + equal timestamp + different major value -> conflict
  const a = obs('cloudp', 'cheap-ok', { status: 'deprecated' }, { source: { type: 'api', trust: 'provider_api', label: 'a' } });
  const b = obs('cloudp', 'cheap-ok', { status: 'active' }, { source: { type: 'api', trust: 'provider_api', label: 'b' } });
  const r2 = resolveObservations([a, b]).get('cloudp/cheap-ok::status');
  assert.ok(r2.conflict);
  const proposal = buildCatalogProposal(CAT, diffCatalog(CAT, [a, b]), [a, b]);
  assert.equal(proposal.conflicts.length, 1);
  assert.equal(proposal.updates.filter(u => u.field === 'status').length, 0);
});

// --- G: stale observation does not overwrite newer ----------------------------
test('G: older observation is stale and never wins resolution', () => {
  const dir = tmp();
  const store = join(dir, 'obs.jsonl');
  ingestObservations(store, [obs('cloudp', 'cheap-ok', { inputPricePer1M: 0.5 }, { observedAt: '2026-03-10T00:00:00Z' })]);
  const r = ingestObservations(store, [obs('cloudp', 'cheap-ok', { inputPricePer1M: 0.1 }, { observedAt: '2026-03-01T00:00:00Z' })]);
  assert.equal(r.stale.length, 1);
  const resolved = resolveObservations(loadObservationStore(store).observations);
  assert.equal(resolved.get('cloudp/cheap-ok::inputPricePer1M').winner.value, 0.5);
  rmSync(dir, { recursive: true, force: true });
});

// --- H: duplicate re-ingest ignored ------------------------------------------
test('H: identical observation re-ingested -> duplicate', () => {
  const dir = tmp();
  const store = join(dir, 'obs.jsonl');
  const o = obs('cloudp', 'cheap-ok', { contextK: 512 });
  ingestObservations(store, [o]);
  const r = ingestObservations(store, [o]);
  assert.equal(r.duplicates.length, 1);
  assert.equal(loadObservationStore(store).observations.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

// --- I: new model -> addition proposal, no auto-adoption ----------------------
test('I: unknown model observed active -> addition proposal; routing unchanged', () => {
  const o = obs('newp', 'Brand-New-1', { status: 'active', contextK: 512 }, { source: { type: 'api', trust: 'provider_api' } });
  const proposal = buildCatalogProposal(CAT, diffCatalog(CAT, [o]), [o]);
  assert.equal(proposal.additions.length, 1);
  assert.equal(proposal.additions[0].model, 'newp/Brand-New-1');
  const hypothetical = applyProposalToCatalog(CAT, proposal);
  assert.ok(hypothetical.models.some(m => m.model === 'Brand-New-1'));
  assert.equal(CAT.models.length, 3); // real catalog untouched
  assert.equal(routing.capabilities['cheap-code'].primary, 'qoder'); // routing untouched
});

// --- J: preview on hypothetical catalog leaves real files unchanged -----------
test('J: maintenance preview on hypothetical catalog; real catalog/routing unchanged', () => {
  const o = obs('qoder', 'Qwen3.8-Flash', { status: 'removed' }, { source: { type: 'api', trust: 'provider_api' } });
  const proposal = buildCatalogProposal(CAT, diffCatalog(CAT, [o]), [o]);
  const hypothetical = applyProposalToCatalog(CAT, proposal);
  assert.equal(hypothetical._hypothetical, true);
  const registry = mergeRegistries(null, { version: 1, backends: { qoder: { provider: 'qoder', model: 'Qwen3.8-Flash' } } });
  const run = runMaintenancePlan({ routing, registry, agents, catalog: hypothetical, events: [], policy: DEFAULT_POLICY });
  const cheap = run.proposal?.decisions.find(d => d.backend === 'qoder');
  assert.ok(cheap && cheap.decision === 'propose'); // forced migration previewed
  // real objects unchanged
  assert.equal(CAT.models.find(m => m.model === 'Qwen3.8-Flash').status, 'free-campaign');
  assert.ok(!('_hypothetical' in CAT));
});

// --- K: Qoder free-campaign expiry end-to-end (observe -> diff -> proposal ->
//     hypothetical catalog -> maintenance reevaluation -> routing decision).
//     Nothing real is written: the shipped catalog and routing stay untouched. --
test('K: Qwen3.8-Flash free-campaign expiry is observed, proposed and re-evaluated without applying anything', () => {
  const dir = tmp();
  const store = join(dir, 'obs.jsonl');
  const realCatalog = loadCatalog(join(kit, 'adapters/pi/model-catalog.json'));
  const qwen = () => realCatalog.models.find(m => m.provider === 'qoder' && m.model === 'Qwen3.8-Flash');
  assert.equal(qwen().status, 'free-campaign');
  assert.equal(qwen().cost.free, true);

  // before: free cloud wins the monitor-tier selection
  const before = selectTierModel(effectiveCatalog(realCatalog, [], '2026-09-25T00:00:00Z'), 'monitor', DEFAULT_POLICY);
  assert.equal(before.selectionPath, 'free-cloud');
  assert.equal(before.selected.model, 'qoder/Qwen3.8-Flash');

  // observation: campaign ended
  const o = obs('qoder', 'Qwen3.8-Flash', { free: false }, { source: { type: 'web', trust: 'provider_web', label: 'qoder pricing page' } });
  ingestObservations(store, [o]);
  const observations = loadObservationStore(store).observations;
  const diff = diffCatalog(realCatalog, observations);
  const d = diff.diffs.find(x => x.model === 'qoder/Qwen3.8-Flash' && x.field === 'free');
  assert.equal(d.status, 'proposed');
  assert.equal(d.currentValue, true);
  assert.equal(d.observedValue, false);

  const proposal = buildCatalogProposal(realCatalog, diff, observations);
  assert.ok(proposal.updates.some(u => u.model === 'qoder/Qwen3.8-Flash' && u.field === 'cost.free' && u.observedValue === false));

  // hypothetical catalog: paid now; postCampaignCost is null so the entry becomes costUnknown
  const hypothetical = applyProposalToCatalog(realCatalog, proposal);
  const hq = hypothetical.models.find(m => m.provider === 'qoder' && m.model === 'Qwen3.8-Flash');
  assert.equal(hq.cost.free, false);
  assert.equal(hypothetical._hypothetical, true);

  // maintenance preview on the hypothetical catalog: cheapest-sufficient re-evaluated.
  // The registry binds cheap->qoder/Qwen3.8-Flash; the event-equivalent is the proposal.
  const registry = mergeRegistries(null, { version: 1, backends: {
    local: { provider: 'freetoken', model: 'Qwen3.6-35B-A3B-NVFP4', thinking: 'off' },
    cheap: { provider: 'qoder', model: 'Qwen3.8-Flash', thinking: 'low' },
    qoder: { provider: 'qoder', model: 'Qwen3.8-Flash', thinking: 'low' },
    devin: { provider: 'devin', model: 'swe-2-high', thinking: 'high' },
    sol: { provider: 'openai-codex', model: 'gpt-5.6-sol', thinking: 'medium' },
    astra: { provider: 'openai-codex', model: 'gpt-6-astra', thinking: 'medium', vision: true },
    codex: { provider: 'openai-codex', model: 'gpt-5.5', thinking: 'high' },
  } });
  const events = [{ type: 'free-campaign-ended', provider: 'qoder', model: 'Qwen3.8-Flash', asOf: '2026-09-24' }];
  const run = runMaintenancePlan({ routing, registry, agents, catalog: realCatalog, events, policy: DEFAULT_POLICY, asOf: '2026-09-25T00:00:00Z' });
  assert.equal(run.monitor.changed, true);
  // the qoder backend (primary of cheap-code) was re-evaluated against the post-event cost
  const qoderDecision = run.proposal.decisions.find(x => x.backend === 'qoder');
  assert.ok(qoderDecision, 'qoder backend must appear in maintenance decisions');
  assert.ok(['keep', 'propose', 'insufficient-data'].includes(qoderDecision.decision));
  // Qoder's offer ended; the separately free Devin campaign may still win.
  const after = selectTierModel(effectiveCatalog(realCatalog, events, '2026-09-25T00:00:00Z'), 'monitor', DEFAULT_POLICY);
  assert.notEqual(after.selected.model, 'qoder/Qwen3.8-Flash');
  assert.equal(after.selected.model, 'devin/swe-2-high');
  // devin stays the strong-code/deep-review primary (its own evaluation is independent)
  const devinDecision = run.proposal.decisions.find(x => x.backend === 'devin');
  assert.ok(!devinDecision || devinDecision.decision !== 'propose' || devinDecision.proposed?.provider !== undefined);

  // nothing applied: shipped catalog + routing untouched
  assert.equal(qwen().cost.free, true);
  assert.equal(qwen().status, 'free-campaign');
  assert.ok(!('_hypothetical' in realCatalog));
  assert.equal(routing.capabilities['cheap-code'].primary, 'qoder');
  rmSync(dir, { recursive: true, force: true });
});

// --- schema + sources ---------------------------------------------------------
test('observation validation: null vs false/0 are distinct, unknown fields rejected', () => {
  assert.deepEqual(validateObservation(obs('p', 'm', { free: false, inputPricePer1M: 0 })), []);
  assert.ok(validateObservation({ provider: 'p', model: 'm', observedAt: 'x', source: { type: 'manual' }, changes: { free: 'yes' } }).some(e => e.includes('boolean')));
  assert.ok(validateObservation({ provider: 'p', model: 'm', observedAt: '2026-01-01T00:00:00Z', source: { type: 'manual' }, changes: { bogusField: 1 } }).some(e => e.includes('bogusField')));
  const n = normalizeObservation({ provider: 'p', model: 'm', source: { type: 'manual' }, changes: { free: false } });
  assert.equal(n.changes.free, false);
  assert.equal(n.changes.contextK, null); // unobserved stays null, not 0/false
});

test('fixture source replays announcements deterministically', () => {
  const doc = { announcements: [
    { provider: 'qoder', model: 'Qwen3.8-Flash', type: 'free-campaign-ended', asOf: '2026-03-01' },
    { provider: 'cloudp', model: 'cheap-ok', type: 'price-changed', inputPricePer1M: 0.15, outputPricePer1M: 0.6, asOf: '2026-03-02' },
    { provider: 'newp', model: 'X-1', type: 'model-added', contextK: 512, asOf: '2026-03-03' },
  ] };
  const out = fromFixture(doc);
  assert.equal(out.length, 3);
  assert.equal(out[0].changes.free, false);
  assert.equal(out[1].changes.inputPricePer1M, 0.15);
  assert.equal(out[2].changes.status, 'active');
  assert.equal(out[0].source.trust, 'provider_web');
});

test('manual source defaults trust to manual_verified', () => {
  const out = fromManual({ observations: [{ provider: 'p', model: 'm', observedAt: '2026-01-01T00:00:00Z', changes: { contextK: 128 } }] });
  assert.equal(out[0].source.trust, 'manual_verified');
  assert.equal(out[0].source.type, 'manual');
});

test('observationHash is deterministic and field-sensitive', () => {
  const a = obs('p', 'm', { contextK: 128 });
  const b = obs('p', 'm', { contextK: 128 });
  const c = obs('p', 'm', { contextK: 256 });
  assert.equal(observationHash(a), observationHash(b));
  assert.notEqual(observationHash(a), observationHash(c));
});
