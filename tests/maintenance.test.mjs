// Model-provisioning maintenance: catalog/events validation, scoring, and the
// Qoder/Qwen3.8-Flash free-campaign-end scenario. Proposals only — nothing is applied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateMaintenance, loadCatalog, loadEvents, loadAvailabilityFile,
  validateCatalog, validateEvents, scoreModel, DEFAULT_MARGIN,
} from '../lib/maintenance.mjs';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { mergeRegistries } from '../lib/registry.mjs';
import { parseModelList } from '../adapters/pi/lib/list-models.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fx = join(kit, 'tests/fixtures/maintenance');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const catalog = loadCatalog(join(fx, 'catalog.json'));
const events = loadEvents(join(fx, 'events.json')); // qoder/Qwen3.8-Flash free-campaign-ended

const baseRegistry = () => mergeRegistries(null, {
  version: 1,
  backends: {
    local: { provider: 'freetoken', model: 'Qwen3.6-35B-A3B-NVFP4', thinking: 'off' },
    cheap: { provider: 'openai-codex', model: 'gpt-5.6-luna', thinking: 'low' },
    qoder: { provider: 'qoder', model: 'Qwen3.8-Flash', thinking: 'low' },
    devin: { provider: 'devin', model: 'swe-2-high', thinking: 'high' },
    sol: { provider: 'openai-codex', model: 'gpt-5.6-sol', thinking: 'medium' },
    astra: { provider: 'openai-codex', model: 'gpt-6-astra', thinking: 'medium', vision: true },
    codex: { provider: 'openai-codex', model: 'gpt-5.5', thinking: 'high' },
  },
});
const decide = (report, backend) => report.decisions.find(d => d.backend === backend);

test('catalog and events validators reject malformed input', () => {
  assert.ok(validateCatalog({ version: 1, models: [{ provider: 'p', model: 'm', status: 'gone' }] }).some(e => e.includes('status')));
  assert.ok(validateCatalog({ version: 1, models: [{ provider: 'p', model: 'm', status: 'active', cost: { usdPerMInput: -1 } }] }).some(e => e.includes('usdPerMInput')));
  assert.ok(validateCatalog({ version: 1, models: [
    { provider: 'p', model: 'm', status: 'active' }, { provider: 'p', model: 'm', status: 'active' },
  ] }).some(e => e.includes('duplicates')));
  assert.ok(validateEvents({ version: 1, events: [{ type: 'exploded', provider: 'p', model: 'm' }] }).some(e => e.includes('type')));
  assert.ok(validateEvents({ version: 1, events: [{ type: 'price-changed', provider: 'p' }] }).some(e => e.includes('provider and model')));
});

test('scoring is tier-weighted: the high tier values quality far more than the low tier', () => {
  const free = { cost: { free: true }, contextK: 64, toolUse: 'basic', scores: { coding: 40, reasoning: 35, speed: 70 } };
  const strong = { cost: { usdPerMInput: 1.5, usdPerMOutput: 6 }, contextK: 400, toolUse: 'good', scores: { coding: 85, reasoning: 82, speed: 55 } };
  const lowDelta = scoreModel(strong, 'low').score - scoreModel(free, 'low').score;
  const highDelta = scoreModel(strong, 'high').score - scoreModel(free, 'high').score;
  assert.ok(highDelta > lowDelta, `high ${highDelta} should exceed low ${lowDelta}`);
  assert.ok(scoreModel(strong, 'high').score > scoreModel(free, 'high').score);
  assert.equal(scoreModel({ status: 'active' }, 'low').score, null); // nothing known
});

test('free-campaign end alone does not force a change: current model is re-scored and compared', () => {
  const report = evaluateMaintenance({ routing, registry: baseRegistry(), agents, catalog, events });
  const cheap = decide(report, 'qoder');
  assert.equal(cheap.current.model, 'Qwen3.8-Flash');
  assert.ok(cheap.trigger.some(t => t.includes('free-campaign-ended')), JSON.stringify(cheap.trigger));
  // Post-campaign Qwen3.8-Flash (~$0.75/M) scores close to the paid alternatives under
  // low-tier weights: advantage < margin -> keep. The event alone changed nothing.
  assert.equal(cheap.decision, 'keep', cheap.reason);
  assert.match(cheap.reason, /below margin/);
  assert.equal(report.changes.length, 0);
});

test('a forced migration (removed model) produces a full proposal with rollback', () => {
  const removed = [{ type: 'removed', provider: 'qoder', model: 'Qwen3.8-Flash', asOf: '2026-03-15' }];
  const report = evaluateMaintenance({ routing, registry: baseRegistry(), agents, catalog, events: removed });
  const change = report.changes.find(c => c.affected.backend === 'qoder');
  assert.ok(change.changeReason.includes('removed'));
  assert.deepEqual(change.affected.capabilities, ['cheap-code', 'orchestration']);
  assert.deepEqual(change.affected.agents, ['design-planner', 'orchestrator', 'scout', 'tester']);
  assert.equal(change.currentModel.provider, 'qoder');
  assert.equal(change.proposedModel.model, 'Qwen3.9-Flash'); // best eligible under low-tier weights
  assert.match(change.expectedCostImpact, /\$0 \(free\) -> proposed ~\$/);
  assert.match(change.expectedQualityImpact, /coding 62->70/);
  assert.equal(change.rollback.method, 'manual-edit');
  assert.deepEqual(change.rollback.previousBinding, { provider: 'qoder', model: 'Qwen3.8-Flash', thinking: 'low' });
  assert.ok(change.rollback.steps.some(s => s.includes('models.local.json')));
});

test('a free-campaign end proposes a switch when a clearly better candidate exists', () => {
  // Same event, but the cheap backend is bound to a weak model: the margin is exceeded.
  const reg = baseRegistry();
  const cat = structuredClone(catalog);
  cat.models.find(m => m.model === 'Qwen3.8-Flash').scores = { coding: 30, reasoning: 25, speed: 60 };
  const report = evaluateMaintenance({ routing, registry: reg, agents, catalog: cat, events });
  const cheap = decide(report, 'qoder');
  assert.equal(cheap.decision, 'propose', cheap.reason);
  assert.equal(cheap.proposed.model, 'Qwen3.9-Flash');
  assert.ok(report.changes.length >= 1);
});

test('a free-campaign end with a comparable successor keeps the current model', () => {
  const cat = structuredClone(catalog);
  cat.models.find(m => m.model === 'Qwen3.8-Flash').postCampaignCost = { usdPerMInput: 0.3, usdPerMOutput: 1.2 };
  const report = evaluateMaintenance({ routing, registry: baseRegistry(), agents, catalog: cat, events });
  // Qwen3.9-Flash (0.25/1.0, coding 70) vs post-campaign Qwen3.8 (0.3/1.2, coding 62):
  // advantage is below the margin -> keep.
  const cheap = decide(report, 'qoder');
  assert.equal(cheap.decision, 'keep', cheap.reason);
  assert.match(cheap.reason, /below margin/);
  assert.equal(report.changes.length, 0);
});

test('margin is configurable and forced migration ignores it when the model is removed', () => {
  const reg = baseRegistry();
  const removed = { version: 1, events: [{ type: 'removed', provider: 'qoder', model: 'Qwen3.8-Flash', asOf: '2026-03-01' }] };
  const report = evaluateMaintenance({ routing, registry: reg, agents, catalog, events: removed.events, margin: 90 });
  const cheap = decide(report, 'qoder');
  assert.equal(cheap.decision, 'propose'); // forced: removed model must move even with margin 90
  assert.match(cheap.reason, /migration required/);
});

test('availability listing: a bound model absent from its provider listing is forced to migrate', () => {
  const availability = { models: new Set(['openai-codex/gpt-5.6-sol', 'openai-codex/gpt-6-astra', 'openai-codex/gpt-5.5', 'openai-codex/gpt-5.6-luna']), providers: new Set(['openai-codex', 'qoder']), source: 'test' };
  const report = evaluateMaintenance({ routing, registry: baseRegistry(), agents, catalog, events: [], availability });
  const cheap = decide(report, 'qoder'); // qoder listed but Qwen3.8-Flash absent -> gone
  assert.equal(cheap.decision, 'propose');
  assert.ok(cheap.trigger.some(t => t.includes('not')));
  // provider not in the listing at all -> unknown, never "missing"
  const availability2 = { models: new Set(['openai-codex/gpt-5.6-sol']), providers: new Set(['openai-codex']), source: 'test' };
  const report2 = evaluateMaintenance({ routing, registry: baseRegistry(), agents, catalog, events: [], availability: availability2 });
  assert.equal(decide(report2, 'qoder').decision, 'keep');
  assert.equal(decide(report2, 'local').decision, 'not-primary'); // fallback-only backend: reported, not evaluated
});

test('vision-requiring capability only proposes vision-capable candidates', () => {
  const reg = baseRegistry();
  const removed = [{ type: 'removed', provider: 'openai-codex', model: 'gpt-6-astra', asOf: '2026-03-01' }];
  const report = evaluateMaintenance({ routing, registry: reg, agents, catalog, events: removed });
  const astra = decide(report, 'astra');
  assert.equal(astra.decision, 'insufficient-data'); // no other vision model in catalog
  assert.match(astra.reason, /no eligible candidate/);
});

test('unbound/placeholder backends are skipped; fallback-only backends are reported not evaluated', () => {
  const reg = mergeRegistries({ version: 1, backends: { qoder: { provider: 'TODO-provider', model: 'TODO-model' } } }, {
    version: 1, backends: { codex: { provider: 'openai-codex', model: 'gpt-5.5' } },
  });
  const report = evaluateMaintenance({ routing, registry: reg, agents, catalog, events });
  assert.equal(decide(report, 'qoder').decision, 'skip');
  // codex is primary of no capability but fallback of strong-code/browser/orchestration
  assert.equal(decide(report, 'codex').decision, 'not-primary');
});

test('model-added triggers comparison but keeps when the new model is not better', () => {
  const added = [{ type: 'model-added', provider: 'qoder', model: 'Qwen3.9-Flash', asOf: '2026-03-05' }];
  const report = evaluateMaintenance({ routing, registry: baseRegistry(), agents, catalog, events: added });
  const cheap = decide(report, 'qoder');
  // Qwen3.9-Flash is better than free Qwen3.8-Flash but not by the margin -> keep.
  assert.equal(cheap.decision, 'keep', cheap.reason);
  assert.ok(cheap.trigger.some(t => t.includes('Qwen3.9-Flash')));
});

test('no events and healthy catalog -> every bound primary keeps, zero changes', () => {
  const report = evaluateMaintenance({ routing, registry: baseRegistry(), agents, catalog, events: [] });
  assert.equal(report.changes.length, 0);
  assert.deepEqual(report.decisions.filter(d => d.decision === 'keep').map(d => d.backend).sort(), ['astra', 'devin', 'qoder', 'sol']);
  assert.equal(decide(report, 'local').decision, 'not-primary');
  assert.equal(decide(report, 'codex').decision, 'not-primary');
});

test('parseModelList extracts provider/model pairs and tolerates noise', () => {
  const { models, providers } = parseModelList('openai-codex/gpt-5.6-sol\nqoder / Qwen3.8-Flash\nnot a model line\n');
  assert.ok(models.has('openai-codex/gpt-5.6-sol'));
  assert.ok(models.has('qoder/Qwen3.8-Flash'));
  assert.ok(providers.has('qoder'));
});

test('parseModelList reads the real `pi --list-models` table (space-separated columns, header skipped)', () => {
  // Regression: the table format is `provider  model  context  max-out  thinking  images`,
  // not `provider/model`. The old regex silently matched nothing -> probe reported null.
  const table = 'provider      model              context  max-out  thinking  images\n'
    + 'qoder         Qwen3.8-Flash        1M       131.1K   yes       yes\n'
    + 'devin         swe-2-high           256K     128K     yes       yes\n'
    + 'freetoken     Qwen3.6-35B-A3B-NVFP4 262.1K 4.1K     no        yes\n'
    + 'openai-codex  gpt-5.6-luna         272K     128K     yes       yes\n';
  const { models, providers } = parseModelList(table);
  assert.ok(models.has('qoder/Qwen3.8-Flash'));
  assert.ok(models.has('devin/swe-2-high'));
  assert.ok(models.has('freetoken/Qwen3.6-35B-A3B-NVFP4'));
  assert.ok(models.has('openai-codex/gpt-5.6-luna'));
  assert.ok(!providers.has('provider')); // header row excluded
});

test('loadAvailabilityFile produces the same shape', () => {
  const tmp = join(fx, 'availability.txt');
  const a = loadAvailabilityFile(tmp);
  assert.ok(a.providers.has('qoder'));
  assert.ok(a.models.has('qoder/Qwen3.9-Flash'));
});
