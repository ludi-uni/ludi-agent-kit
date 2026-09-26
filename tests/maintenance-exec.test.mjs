// Phase 2: maintenance execution tiers + cheapest-sufficient selection.
// Cases A-G from the Phase 2 spec. Selection is a dry-run decision layer: no model
// is invoked and no config is written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  selectTierModel, buildMonitorOutput, escalationDecision, runMaintenancePlan,
  localElectricityCost, estimatedCostPerRun, validateExecPolicy, loadExecPolicy, DEFAULT_POLICY,
} from '../lib/maintenance-exec.mjs';
import { effectiveCatalog, evaluateMaintenance, loadCatalog, validateCatalog } from '../lib/maintenance.mjs';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { mergeRegistries } from '../lib/registry.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);

// --- fixture helpers -------------------------------------------------------
const m = (provider, model, over = {}) => ({
  provider, model, status: 'active', cost: { usdPerMInput: 0.5, usdPerMOutput: 2 },
  contextK: 256, vision: false, toolUse: 'good', location: 'cloud',
  scores: { coding: 60, reasoning: 55, speed: 70 }, ...over,
});
const cat = models => ({ version: 1, updatedAt: '2026-03-01', models });
const registryWith = backends => mergeRegistries(null, { version: 1, backends });
const sel = (models, tier, opts) => selectTierModel(models, tier, DEFAULT_POLICY, opts);

test('SWE-2 campaign cutoff changes free-capacity advice without live rebinding', () => {
  const catalog = loadCatalog(join(kit, 'adapters/pi/model-catalog.json'));
  const policy = loadExecPolicy(join(kit, 'adapters/pi/maintenance-policy.json'));
  const reg = registryWith({ devin: { provider: 'devin', model: 'swe-2-high' } });
  const before = runMaintenancePlan({ routing, registry: reg, agents, catalog, policy, asOf: '2026-10-10T14:59:59Z' });
  const beforeCode = before.freeCapacityPlan.find(p => p.capability === 'strong-code');
  assert.equal(beforeCode.recommendedFree, 'devin/swe-2-high');
  assert.equal(before.freeCapacityPlan.find(p => p.capability === 'deep-review').recommendedFree, 'devin/swe-2-high');
  assert.equal(before.freeCapacityPlan.find(p => p.capability === 'cheap-code').recommendedFree, 'qoder/Qwen3.8-Flash');
  assert.equal(before.freeCapacityPlan.find(p => p.capability === 'vision-reasoning').recommendedFree, null);
  assert.equal(beforeCode.freeCandidates[0].freeUntil, '2026-10-10T15:00:00Z');
  assert.equal(before.outcome, 'no-change');

  const after = runMaintenancePlan({ routing, registry: reg, agents, catalog, policy, asOf: '2026-10-10T15:00:00Z' });
  assert.equal(after.freeCapacityPlan.find(p => p.capability === 'strong-code').recommendedFree, null);
  assert.equal(after.monitor.changed, true);
  assert.match(after.monitor.reasons.join(' '), /free campaign cutoff reached/);
  assert.equal(after.proposal.decisions.find(d => d.backend === 'devin').decision === 'keep' || after.proposal.decisions.find(d => d.backend === 'devin').decision === 'propose', true);
  assert.equal(effectiveCatalog(catalog, [], '2026-10-10T15:00:00Z').find(m => m.provider === 'devin').cost.free, false);
  assert.deepEqual(validateCatalog({ version: 1, models: [{ ...catalog.models.find(m => m.provider === 'devin'), freeUntil: 'tomorrow' }] }).some(e => e.includes('freeUntil')), true);
});

const FREE_STRONG = m('freep', 'free-strong', { cost: { free: true }, scores: { coding: 78, reasoning: 70, speed: 80 } });
const FREE_WEAK = m('freep', 'free-weak', { cost: { free: true }, scores: { coding: 30, reasoning: 25, speed: 60 } });
const CHEAP_OK = m('cloudp', 'cheap-ok', { cost: { usdPerMInput: 0.2, usdPerMOutput: 0.8 }, scores: { coding: 68, reasoning: 62, speed: 75 } });
const EXPENSIVE_STRONG = m('cloudp', 'pro-strong', { cost: { usdPerMInput: 5, usdPerMOutput: 20 }, scores: { coding: 90, reasoning: 88, speed: 60 } });
const LOCAL = m('localp', 'local-mid', { location: 'local', cost: { free: true }, local: { powerWatts: 400, taskMinutes: 10 }, scores: { coding: 45, reasoning: 40, speed: 50 }, toolUse: 'basic' });

// --- A: strong free model -> monitor and evaluate both pick it --------------
test('Case A: a strong free model is selected for monitor and evaluate', () => {
  const models = [FREE_STRONG, CHEAP_OK, EXPENSIVE_STRONG];
  for (const tier of ['monitor', 'evaluate']) {
    const r = sel(models, tier);
    assert.equal(r.selected.model, 'freep/free-strong', `${tier}: ${r.selectionReason}`);
    assert.equal(r.selectionPath, 'free-cloud');
    assert.equal(r.selected.effectiveCostUsd < 0.02, true); // only the speed penalty
  }
});

// --- B: free ends, cheap sufficient cloud -> cheapest-sufficient, no premium
test('Case B: free campaign end -> cheapest-sufficient cloud, no reconfigure escalation', () => {
  const catalog = cat([
    m('qoder', 'Qwen3.8-Flash', { status: 'free-campaign', cost: { free: true }, postCampaignCost: { usdPerMInput: 0.3, usdPerMOutput: 1.2 }, scores: { coding: 62, reasoning: 55, speed: 85 } }),
    CHEAP_OK, EXPENSIVE_STRONG,
  ]);
  const events = [{ type: 'free-campaign-ended', provider: 'qoder', model: 'Qwen3.8-Flash', asOf: '2026-03-01' }];
  const effective = effectiveCatalog(catalog, events);
  const r = sel(effective, 'evaluate');
  assert.equal(r.selected.model, 'cloudp/cheap-ok', r.selectionReason);
  assert.equal(r.selectionPath, 'cheapest-sufficient-cloud');
  // and the pipeline: monitor detects, evaluate decides, no premium escalation
  const registry = registryWith({ cheap: { provider: 'qoder', model: 'Qwen3.8-Flash' } });
  const run = runMaintenancePlan({ routing, registry, agents, catalog, events });
  assert.equal(run.monitor.changed, true);
  assert.equal(run.escalation, null);
  assert.equal(run.outcome, 'evaluated-no-change'); // advantage below margin -> keep
});

// --- C: cheap models below requiredQuality -> escalate to a stronger model -
test('Case C: models below requiredQuality are rejected; a stronger candidate is selected', () => {
  const weak = m('cloudp', 'too-weak', { cost: { usdPerMInput: 0.05, usdPerMOutput: 0.2 }, scores: { coding: 30, reasoning: 25, speed: 80 } });
  const r = sel([weak, EXPENSIVE_STRONG], 'evaluate'); // requiredQuality 65
  assert.equal(r.selected.model, 'cloudp/pro-strong');
  const rejected = r.candidates.find(c => c.model === 'cloudp/too-weak');
  assert.equal(rejected.eligible, false);
  assert.ok(rejected.rejectedReasons.some(x => x.includes('requiredQuality')));
});

// --- D: no eligible cloud -> local fallback --------------------------------
test('Case D: cloud unusable -> local fallback with electricity cost', () => {
  const gone = m('cloudp', 'gone', { status: 'removed' });
  const r = sel([gone, LOCAL], 'monitor'); // requiredQuality 40; local quality ~44
  assert.equal(r.selectionPath, 'local-fallback');
  assert.equal(r.selected.model, 'localp/local-mid');
  assert.equal(r.fallbackOccurred, true);
  assert.equal(r.selected.location, 'local');
  assert.ok(r.selected.costDetail.electricityUsd > 0);
});

// --- E: cloud API cheaper than local electricity -> cloud chosen ------------
test('Case E: cheaper cloud API beats local electricity estimate', () => {
  const powerHungry = structuredClone(LOCAL);
  powerHungry.local = { powerWatts: 900, taskMinutes: 30 }; // 0.45kWh * $0.30 = $0.135/run
  const cheapCloud = m('cloudp', 'tiny', { cost: { usdPerMInput: 0.05, usdPerMOutput: 0.1 }, scores: { coding: 55, reasoning: 50, speed: 90 } });
  const r = sel([powerHungry, cheapCloud], 'monitor');
  assert.equal(r.selected.location, 'cloud');
  assert.equal(r.selected.model, 'cloudp/tiny');
  // sanity: the local run really would cost more
  assert.ok(localElectricityCost(powerHungry.local, 0.30) > estimatedCostPerRun(cheapCloud, DEFAULT_POLICY, [powerHungry, cheapCloud], 'monitor').total);
});

// --- F: multi-capability change -> reconfigure escalation -------------------
test('Case F: changes spanning multiple capabilities escalate to reconfigure', () => {
  const catalog = cat([
    m('qoder', 'Qwen3.8-Flash', { status: 'free-campaign', cost: { free: true }, postCampaignCost: { usdPerMInput: 0.3, usdPerMOutput: 1.2 }, scores: { coding: 30, reasoning: 25, speed: 85 } }),
    CHEAP_OK, EXPENSIVE_STRONG,
    m('cloudp', 'vis-strong', { vision: true, cost: { usdPerMInput: 3, usdPerMOutput: 12 }, scores: { coding: 85, reasoning: 88, speed: 55 } }),
  ]);
  const registry = registryWith({
    cheap: { provider: 'qoder', model: 'Qwen3.8-Flash' },
    sol: { provider: 'qoder', model: 'Qwen3.8-Flash' },   // two primaries on the same dying model
    astra: { provider: 'qoder', model: 'Qwen3.8-Flash' }, // vision caps too
  });
  const events = [{ type: 'removed', provider: 'qoder', model: 'Qwen3.8-Flash', asOf: '2026-03-01' }];
  const run = runMaintenancePlan({ routing, registry, agents, catalog, events });
  assert.ok(run.escalation, 'expected escalation');
  assert.equal(run.escalation.targetTier, 'reconfigure');
  assert.equal(run.escalation.sourceTier, 'evaluate');
  assert.ok(run.escalation.affectedCapabilities.length >= 2);
  assert.ok(run.tiers.some(t => t.role === 'reconfigure'));
  assert.ok(run.escalation.estimatedDecisionCostUsd >= 0);
  // proposal changes carry the escalation record
  assert.ok(run.proposal.changes.every(c => c.escalation?.targetTier === 'reconfigure'));
});

// --- G: availability probe failure -> unknown, never "gone" -----------------
test('Case G: failed availability probe is unknown, not unavailable', () => {
  const monitor = buildMonitorOutput({ events: [], catalog: cat([CHEAP_OK]), availability: null, availabilitySource: 'pi --list-models (failed)' });
  assert.equal(monitor.infoStatus.probeFailed, true);
  assert.equal(monitor.changed, false); // nothing declared missing
  const r = sel([CHEAP_OK], 'monitor', { availability: null });
  assert.equal(r.selected.model, 'cloudp/cheap-ok'); // still eligible
  assert.equal(r.candidates[0].availability, 'unknown');
});

// --- supporting behaviour ---------------------------------------------------
test('free below requiredQuality is not used (free never overrides the quality bar)', () => {
  const r = sel([FREE_WEAK, CHEAP_OK], 'evaluate');
  assert.equal(r.selected.model, 'cloudp/cheap-ok');
  assert.equal(r.selectionPath, 'cheapest-sufficient-cloud');
  const rejected = r.candidates.find(c => c.model === 'freep/free-weak');
  assert.equal(rejected.eligible, false);
});

test('localElectricityCost: watts x minutes x price', () => {
  assert.ok(Math.abs(localElectricityCost({ powerWatts: 450, taskMinutes: 4 }, 0.30) - 0.009) < 1e-9);
  assert.equal(localElectricityCost({ powerWatts: 450 }, 0.30), null);
  assert.equal(localElectricityCost(null, 0.30), null);
});

test('monitor output shape: changed/reasons/affectedModels/severity/escalationRequired', () => {
  const out = buildMonitorOutput({ events: [{ type: 'price-changed', provider: 'p', model: 'x' }], catalog: cat([m('p', 'x')]) });
  assert.equal(out.changed, true);
  assert.deepEqual(out.affectedModels, ['p/x']);
  assert.equal(out.severity, 'low');
  assert.equal(out.escalationRequired, false);
  const quiet = buildMonitorOutput({ events: [], catalog: cat([m('p', 'x')]) });
  assert.equal(quiet.changed, false);
  assert.equal(quiet.severity, 'none');
});

test('runMaintenancePlan short-circuits on no change (only monitor tier runs)', () => {
  const registry = registryWith({ cheap: { provider: 'cloudp', model: 'cheap-ok' } });
  const run = runMaintenancePlan({ routing, registry, agents, catalog: cat([CHEAP_OK]), events: [] });
  assert.equal(run.outcome, 'no-change');
  assert.deepEqual(run.tiers.map(t => t.role), ['monitor']);
  assert.equal(run.proposal, null);
});

test('escalationDecision returns null for small single-capability changes', () => {
  const result = { changes: [{ affected: { capabilities: ['cheap-code'], agents: ['scout'] }, scores: { current: 50, proposed: 62, delta: 12 }, confidence: 'high' }], decisions: [], infoStatus: { eventsApplied: [] } };
  assert.equal(escalationDecision(result, { severity: 'low' }, DEFAULT_POLICY), null);
});

test('exec policy validates and merges over defaults', () => {
  assert.ok(validateExecPolicy({ version: 1, requiredQuality: { monitor: 200 } }).some(e => e.includes('requiredQuality')));
  const p = loadExecPolicy(null);
  assert.equal(p.requiredQuality.reconfigure, 80);
  assert.equal(p.electricityPricePerKwh, 0.30);
});

test('run report records tier selections, candidates, costs and flags', () => {
  const registry = registryWith({ cheap: { provider: 'qoder', model: 'Qwen3.8-Flash' } });
  const catalog = cat([
    m('qoder', 'Qwen3.8-Flash', { status: 'free-campaign', cost: { free: true }, postCampaignCost: { usdPerMInput: 0.3, usdPerMOutput: 1.2 }, scores: { coding: 30, reasoning: 25, speed: 85 } }),
    CHEAP_OK,
  ]);
  const events = [{ type: 'free-campaign-ended', provider: 'qoder', model: 'Qwen3.8-Flash' }];
  const run = runMaintenancePlan({ routing, registry, agents, catalog, events });
  for (const t of run.tiers) {
    assert.ok(t.selected?.model, `${t.role} selected`);
    assert.ok(t.selectionReason);
    assert.ok(Array.isArray(t.candidates) && t.candidates.length);
    assert.ok(typeof t.selected.effectiveCostUsd === 'number');
    assert.ok(typeof t.fallbackOccurred === 'boolean');
  }
  assert.ok(run.estimatedDecisionCostUsd > 0);
});
