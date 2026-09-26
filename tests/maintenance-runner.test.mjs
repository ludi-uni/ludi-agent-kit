// Phase 3: maintenance runner — real (stubbed) tier invocation, schema validation,
// one retry, ordered fallback, deterministic authority, and per-run cost profiles.
// Cases A–J from the Phase 3 spec. No real model is invoked; `invoke` is scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  invokeTier, runMaintenanceLive, validateStructuredOutput, extractJson,
  buildTierPrompt, TIER_SCHEMAS, MONITOR_SCHEMA,
} from '../lib/maintenance-runner.mjs';
import { selectTierModel, estimatedCostPerRun, DEFAULT_POLICY } from '../lib/maintenance-exec.mjs';
import { effectiveCatalog } from '../lib/maintenance.mjs';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { mergeRegistries } from '../lib/registry.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);

const m = (provider, model, over = {}) => ({
  provider, model, status: 'active', cost: { usdPerMInput: 0.5, usdPerMOutput: 2 },
  contextK: 256, vision: false, toolUse: 'good', location: 'cloud',
  scores: { coding: 60, reasoning: 55, speed: 70 }, ...over,
});
const cat = models => ({ version: 1, updatedAt: '2026-03-01', models });
const registryWith = backends => mergeRegistries(null, { version: 1, backends });

const FREE_GOOD = m('freep', 'free-good', { cost: { free: true }, scores: { coding: 75, reasoning: 68, speed: 80 } });
const CHEAP2 = m('cloudp', 'cheap-2', { cost: { usdPerMInput: 0.1, usdPerMOutput: 0.4 }, scores: { coding: 66, reasoning: 60, speed: 78 } });
const PREMIUM = m('cloudp', 'premium-huge', { premium: true, cost: { usdPerMInput: 10, usdPerMOutput: 40 }, scores: { coding: 95, reasoning: 95, speed: 40 } });
const LOCAL = m('localp', 'local-mid', { location: 'local', cost: { free: true }, local: { powerWatts: 400, taskMinutes: 10 }, scores: { coding: 45, reasoning: 40, speed: 50 }, toolUse: 'basic' });

const json = o => JSON.stringify(o);
const ok = text => ({ ok: true, text, durationMs: 5 });
const fail = error => ({ ok: false, error, durationMs: 3 });
const scriptInvoker = (script, calls = []) => async req => {
  calls.push(req.modelId);
  const v = typeof script === 'function' ? script(req) : script[req.modelId.split(':')[0]] ?? script['*'];
  return typeof v === 'function' ? v(req) : v;
};

const MON_OK = () => json({ decision: 'changed', confidence: 0.9, reasoningSummary: 'event diffs found', affectedModels: ['qoder/Qwen3.8-Flash'], severity: 'medium', evaluateNeeded: true, recommendedActions: [] });
const EVAL_OK = (c = 0.85) => json({ decision: 'keep', confidence: c, reasoningSummary: 'within margin', affectedCapabilities: ['cheap-code'], recommendedActions: [], recommendedModels: [] });
const REC_OK = () => json({ decision: 'propose', confidence: 0.8, reasoningSummary: 'structural', affectedCapabilities: ['cheap-code', 'strong-code'], recommendedActions: [], recommendedModels: [], routingNotes: [] });

// Post-campaign Qwen3.8-Flash stays mid-quality: the switch is simple, no escalation.
const dyingCatalog = () => cat([
  m('qoder', 'Qwen3.8-Flash', { status: 'free-campaign', cost: { free: true }, postCampaignCost: { usdPerMInput: 0.3, usdPerMOutput: 1.2 }, scores: { coding: 62, reasoning: 55, speed: 85 } }),
  CHEAP2, FREE_GOOD,
]);

// --- A: no change -> monitor only ------------------------------------------
test('A: no-change -> only monitor is invoked, run stops', async () => {
  const calls = [];
  const run = await runMaintenanceLive({
    routing, registry: registryWith({ cheap: { provider: 'cloudp', model: 'cheap-2' } }),
    agents, catalog: cat([CHEAP2, FREE_GOOD]), events: [],
    invoke: scriptInvoker({ '*': () => ok(json({ decision: 'no-change', confidence: 0.95, reasoningSummary: 'quiet', severity: 'none', evaluateNeeded: false })) }, calls),
  });
  assert.equal(run.outcome, 'no-change');
  assert.equal(calls.length, 1);
  assert.equal(run.invocations.length, 1);
  assert.equal(run.invocations[0].tier, 'monitor');
});

// --- B: simple change -> monitor + evaluate, no reconfigure -----------------
test('B: simple change -> monitor and evaluate invoked, no reconfigure', async () => {
  const calls = [];
  const run = await runMaintenanceLive({
    routing, registry: registryWith({ cheap: { provider: 'qoder', model: 'Qwen3.8-Flash' } }),
    agents, catalog: dyingCatalog(),
    events: [{ type: 'free-campaign-ended', provider: 'qoder', model: 'Qwen3.8-Flash' }],
    invoke: scriptInvoker({ '*': req => ok(req.prompt.includes('STAGE: monitor') ? MON_OK() : EVAL_OK()) }, calls),
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(run.invocations.map(i => i.tier), ['monitor', 'evaluate']);
  assert.equal(run.escalation, null);
});

// --- C: complex change -> all three tiers -----------------------------------
test('C: multi-capability structural change -> reconfigure is invoked', async () => {
  const calls = [];
  const catalog = cat([
    m('qoder', 'Qwen3.8-Flash', { scores: { coding: 30, reasoning: 25, speed: 85 } }),
    CHEAP2, FREE_GOOD, m('cloudp', 'vis', { vision: true, cost: { usdPerMInput: 3, usdPerMOutput: 12 }, scores: { coding: 85, reasoning: 88, speed: 55 } }),
  ]);
  const registry = registryWith({
    cheap: { provider: 'qoder', model: 'Qwen3.8-Flash' },
    sol: { provider: 'qoder', model: 'Qwen3.8-Flash' },
    astra: { provider: 'qoder', model: 'Qwen3.8-Flash' },
  });
  const run = await runMaintenanceLive({
    routing, registry, agents, catalog,
    events: [{ type: 'removed', provider: 'qoder', model: 'Qwen3.8-Flash' }],
    invoke: scriptInvoker({ '*': req => ok(req.prompt.includes('STAGE: monitor') ? MON_OK() : req.prompt.includes('STAGE: evaluate') ? EVAL_OK() : REC_OK()) }, calls),
  });
  assert.deepEqual(run.invocations.map(i => i.tier), ['monitor', 'evaluate', 'reconfigure']);
  assert.ok(run.escalation.escalationReason.length > 0);
  assert.equal(run.escalation.targetTier, 'reconfigure');
});

// --- D: monitor model fails -> next cheap candidate --------------------------
test('D: monitor invocation failure falls back to the next ordered candidate', async () => {
  const calls = [];
  const run = await runMaintenanceLive({
    routing, registry: registryWith({ cheap: { provider: 'cloudp', model: 'cheap-2' } }),
    agents, catalog: cat([FREE_GOOD, CHEAP2]), events: [],
    invoke: scriptInvoker(req => req.modelId.startsWith('freep/') ? fail('rate limit exceeded') : ok(json({ decision: 'no-change', confidence: 0.9, reasoningSummary: 'ok', severity: 'none', evaluateNeeded: false })), calls),
  });
  assert.deepEqual(calls.map(c => c.split('/')[0]), ['freep', 'cloudp']);
  const inv = run.invocations[0];
  assert.equal(inv.fallbackOccurred, true);
  assert.equal(inv.selectedModel, 'cloudp/cheap-2');
  assert.equal(inv.invocations[0].failureClass, 'invoke');
});

// --- E: malformed JSON -> one retry -> success -------------------------------
test('E: malformed structured output retries once then succeeds', async () => {
  let n = 0;
  const inv = await invokeTier('monitor', selectTierModel(effectiveCatalog(cat([FREE_GOOD])), 'monitor', DEFAULT_POLICY), {
    invoke: async () => (++n === 1 ? ok('not json at all') : ok(MON_OK())),
    catalogKeys: new Set(['freep/free-good']),
  });
  assert.equal(n, 2);
  assert.equal(inv.output.decision, 'changed');
  assert.equal(inv.attempts.length, 2);
  assert.equal(inv.attempts[0].schemaValid, false);
  assert.equal(inv.attempts[1].schemaValid, true);
});

// --- F: still invalid after retry -> deterministic continues -----------------
test('F: invalid output after retry -> tier degrades to deterministic result', async () => {
  const calls = [];
  const run = await runMaintenanceLive({
    routing, registry: registryWith({ cheap: { provider: 'cloudp', model: 'cheap-2' } }),
    agents, catalog: cat([FREE_GOOD]), events: [],
    invoke: scriptInvoker({ '*': () => ok('garbage {no json') }, calls),
  });
  const inv = run.invocations[0];
  assert.equal(inv.degradedToDeterministic, true);
  assert.equal(calls.length, 2); // initial + one retry, then stop
  assert.equal(run.outcome, 'no-change'); // deterministic monitor still decides
});

// --- G/H: per-run cost comparison --------------------------------------------
test('G: short profile -> cloud cheaper than local electricity -> cloud selected', () => {
  const models = [LOCAL, CHEAP2];
  const r = selectTierModel(models, 'monitor', DEFAULT_POLICY); // 8K in / 800 out
  assert.equal(r.selected.location, 'cloud');
  const localCost = estimatedCostPerRun(LOCAL, DEFAULT_POLICY, models, 'monitor');
  const cloudCost = estimatedCostPerRun(CHEAP2, DEFAULT_POLICY, models, 'monitor');
  assert.ok(cloudCost.api < localCost.electricity, `api ${cloudCost.api} vs elec ${localCost.electricity}`);
});

test('H: long coding profile -> token cost grows, local becomes cheaper', () => {
  const expensiveCloud = m('cloudp', 'pricey', { cost: { usdPerMInput: 8, usdPerMOutput: 30 }, scores: { coding: 66, reasoning: 60, speed: 70 } });
  const local = m('localp', 'local-ok', { location: 'local', cost: { free: true }, local: { powerWatts: 300, taskMinutes: 2 }, scores: { coding: 45, reasoning: 40, speed: 60 }, toolUse: 'basic' });
  const policy = structuredClone(DEFAULT_POLICY);
  policy.taskProfiles.monitor = { estimatedInputTokens: 500000, estimatedOutputTokens: 50000, estimatedTaskMinutes: 20 };
  const models = [expensiveCloud, local];
  const r = selectTierModel(models, 'monitor', policy);
  const cloudApi = estimatedCostPerRun(expensiveCloud, policy, models, 'monitor').api; // ~$5.5
  const localElec = estimatedCostPerRun(local, policy, models, 'monitor').electricity; // 0.3kWh*0.3=$0.03
  assert.ok(cloudApi > localElec);
  assert.equal(r.selected.location, 'local');
  assert.equal(r.selectionPath, 'cheapest-sufficient-local'); // local wins on cost, not as a fallback
});

// --- I: premium not used for monitor -----------------------------------------
test('I: premium models are excluded from monitor/evaluate selection', () => {
  const r = selectTierModel([PREMIUM, CHEAP2], 'monitor', DEFAULT_POLICY);
  assert.equal(r.selected.model, 'cloudp/cheap-2');
  assert.ok(!r.candidates.some(c => c.model === 'cloudp/premium-huge'));
  const rec = selectTierModel([PREMIUM, CHEAP2], 'reconfigure', DEFAULT_POLICY); // reconfigure may see it
  assert.ok(rec.candidates.some(c => c.model === 'cloudp/premium-huge'));
});

// --- J: LLM recommends a non-catalog model -> rejected ------------------------
test('J: recommendedModels outside the catalog are rejected and recorded', async () => {
  const out = json({ decision: 'keep', confidence: 0.8, reasoningSummary: 'x', affectedCapabilities: [], recommendedActions: [], recommendedModels: ['evil/ghost-model', 'freep/free-good'] });
  const inv = await invokeTier('evaluate', selectTierModel(effectiveCatalog(cat([FREE_GOOD, CHEAP2])), 'evaluate', DEFAULT_POLICY), {
    invoke: async () => ok(out),
    catalogKeys: new Set(['freep/free-good', 'cloudp/cheap-2']),
  });
  assert.deepEqual(inv.output.recommendedModels, ['freep/free-good']);
  assert.deepEqual(inv.output.rejectedRecommendations, ['evil/ghost-model']);
});

// --- schema / parsing --------------------------------------------------------
test('schema validation: required keys, enums, ranges', () => {
  assert.deepEqual(validateStructuredOutput(MONITOR_SCHEMA, { decision: 'changed', confidence: 0.5, reasoningSummary: 'x' }), []);
  assert.ok(validateStructuredOutput(MONITOR_SCHEMA, { decision: 'maybe', confidence: 0.5, reasoningSummary: 'x' }).some(e => e.includes('decision')));
  assert.ok(validateStructuredOutput(MONITOR_SCHEMA, { decision: 'changed', confidence: 2, reasoningSummary: 'x' }).some(e => e.includes('confidence')));
  assert.ok(validateStructuredOutput(MONITOR_SCHEMA, { confidence: 0.5 }).some(e => e.includes('decision')));
  assert.ok(validateStructuredOutput(MONITOR_SCHEMA, 'text').some(e => e.includes('object')));
});

test('extractJson tolerates fences and surrounding prose', () => {
  assert.equal(extractJson('```json\n{"a":1}\n```').a, 1);
  assert.equal(extractJson('here is the result: {"a":{"b":2}} done').a.b, 2);
  assert.equal(extractJson('no json'), null);
});

test('tier prompts embed deterministic facts and forbid invented models', () => {
  const p = buildTierPrompt('evaluate', { evaluation: { changes: 1 }, catalogKeys: ['a/b'] });
  assert.ok(p.includes('STAGE: evaluate'));
  assert.ok(p.includes('a/b'));
  assert.ok(p.includes('Never invent provider/model ids'));
  const mp = buildTierPrompt('monitor', { monitor: { changed: true, reasons: ['e'], affectedModels: ['p/m'], severity: 'low' } });
  assert.ok(mp.includes('Do NOT propose routing changes'));
});

test('quota failure is classified distinctly', async () => {
  const inv = await invokeTier('monitor', selectTierModel(effectiveCatalog(cat([FREE_GOOD, CHEAP2])), 'monitor', DEFAULT_POLICY), {
    invoke: async req => req.modelId.startsWith('freep/') ? fail('Error: usage limit has been reached') : ok(MON_OK()),
    catalogKeys: new Set(),
  });
  assert.equal(inv.attempts[0].failureClass, 'quota');
  assert.equal(inv.selected.model, 'cloudp/cheap-2');
});
