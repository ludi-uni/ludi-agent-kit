// Phase 5: maintenance job — quiet-by-default, severity, notification dedupe,
// lock/concurrency, failure semantics, run budget, command sink. Cases A–M.
// Everything runs against a temp outDir; real config files are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runMaintenanceJob, acquireLock, releaseLock, shouldNotify, notificationHash,
  classifyRun, buildNotification, sinks, atomicWriteJson, loadRunState,
} from '../lib/job.mjs';
import { DEFAULT_POLICY } from '../lib/maintenance-exec.mjs';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { mergeRegistries } from '../lib/registry.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const tmp = () => mkdtempSync(join(tmpdir(), 'job-'));

const CAT = {
  version: 1, updatedAt: '2026-03-01',
  models: [
    { provider: 'qoder', model: 'Qwen3.8-Flash', status: 'free-campaign', cost: { free: true }, postCampaignCost: { usdPerMInput: 0.3, usdPerMOutput: 1.2 }, contextK: 256, vision: false, toolUse: 'good', location: 'cloud', scores: { coding: 62, reasoning: 55, speed: 85 } },
    { provider: 'cloudp', model: 'cheap-ok', status: 'active', cost: { usdPerMInput: 0.2, usdPerMOutput: 0.8 }, contextK: 256, vision: false, toolUse: 'good', location: 'cloud', scores: { coding: 68, reasoning: 62, speed: 75 } },
    { provider: 'cloudp', model: 'pro-strong', status: 'active', cost: { usdPerMInput: 5, usdPerMOutput: 20 }, contextK: 400, vision: false, toolUse: 'good', location: 'cloud', scores: { coding: 90, reasoning: 88, speed: 60 } },
  ],
};
const CAT_PLUS_VISION = structuredClone(CAT);
CAT_PLUS_VISION.models.push({ provider: 'cloudp', model: 'vis-ok', status: 'active', cost: { usdPerMInput: 2, usdPerMOutput: 8 }, contextK: 400, vision: true, toolUse: 'good', location: 'cloud', scores: { coding: 80, reasoning: 82, speed: 55 } });
const REG = mergeRegistries(null, { version: 1, backends: { qoder: { provider: 'qoder', model: 'Qwen3.8-Flash' }, sol: { provider: 'cloudp', model: 'pro-strong' }, astra: { provider: 'cloudp', model: 'vis-ok' } } });
const base = dir => ({ outDir: dir, adapterDir: join(kit, 'adapters/pi'), kit, catalog: CAT_PLUS_VISION, routing, registry: REG, agents, policy: DEFAULT_POLICY });
const manualObs = (dir, observations) => { const p = join(dir, 'obs.json'); writeFileSync(p, JSON.stringify({ version: 1, observations })); return p; };
const OBS = (provider, model, changes, over = {}) => ({ provider, model, observedAt: '2026-03-05T00:00:00Z', source: { type: 'manual', trust: 'manual_verified' }, changes, confidence: 0.9, ...over });

// --- A: no change -> quiet ---------------------------------------------------
test('A: no observations -> quiet exit, no notification', async () => {
  const dir = tmp();
  const run = await runMaintenanceJob(base(dir));
  assert.equal(run.status, 'ok');
  assert.equal(run.quiet, true);
  assert.equal(run.notification, undefined);
  assert.ok(existsSync(join(dir, 'model-maintenance.lastrun.json'))); // run log kept
  rmSync(dir, { recursive: true, force: true });
});

// --- B: duplicates only -> quiet ---------------------------------------------
test('B: duplicate observations only -> quiet', async () => {
  const dir = tmp();
  const input = manualObs(dir, [OBS('cloudp', 'cheap-ok', { inputPricePer1M: 0.2 })]);
  await runMaintenanceJob({ ...base(dir), source: 'manual', input });
  // second run, same observation -> duplicate
  const run = await runMaintenanceJob({ ...base(dir), source: 'manual', input });
  assert.equal(run.ingest.duplicates, 1);
  assert.equal(run.quiet, true);
  rmSync(dir, { recursive: true, force: true });
});

// --- C: new model, no routing impact -> info ----------------------------------
test('C: new model observed -> info notification', async () => {
  const dir = tmp();
  const input = manualObs(dir, [OBS('newp', 'Nova-1', { status: 'active', contextK: 512 })]);
  const run = await runMaintenanceJob({ ...base(dir), source: 'manual', input });
  assert.equal(run.quiet, false);
  assert.equal(run.notification.severity, 'info');
  assert.equal(run.notification.sent, true);
  assert.equal(run.notification.requiresApproval, true);
  assert.ok(existsSync(join(dir, 'model-maintenance.notification.json')));
  rmSync(dir, { recursive: true, force: true });
});

// --- D: free end affecting both cheap-code and orchestration -> urgent --------
test('D: free campaign end affecting multiple capabilities -> urgent notification', async () => {
  const dir = tmp();
  // qoder backend (cheap-code primary) bound to a weak model whose campaign ends -> preview proposes a switch
  const cat = structuredClone(CAT_PLUS_VISION);
  cat.models[0].scores = { coding: 30, reasoning: 25, speed: 85 };
  const input = manualObs(dir, [
    OBS('qoder', 'Qwen3.8-Flash', { free: false, inputPricePer1M: 0.3, outputPricePer1M: 1.2 }),
    OBS('qoder', 'Qwen3.8-Flash', { status: 'active' }),
  ]);
  const run = await runMaintenanceJob({ ...base(dir), catalog: cat, source: 'manual', input });
  assert.equal(run.notification?.severity, 'urgent');
  assert.ok(run.notification.routingImpact.length >= 1);
  assert.ok(run.notification.routingImpact.some(c => c.includes('orchestrator')));
  rmSync(dir, { recursive: true, force: true });
});

// --- E: current model confirmed unavailable -> urgent --------------------------
test('E: current model removed via high-trust source -> urgent notification', async () => {
  const dir = tmp();
  const input = manualObs(dir, [OBS('qoder', 'Qwen3.8-Flash', { status: 'removed' }, { source: { type: 'api', trust: 'provider_api' } })]);
  const run = await runMaintenanceJob({ ...base(dir), source: 'manual', input });
  assert.equal(run.notification?.severity, 'urgent');
  rmSync(dir, { recursive: true, force: true });
});

// --- F: observer failure -> unknown, never urgent ------------------------------
test('F: probe failure alone -> quiet, not urgent', async () => {
  const dir = tmp();
  const run = await runMaintenanceJob({ ...base(dir), checkPi: true, listing: false }); // explicit probe failure
  assert.equal(run.ingest.probeFailed, true);
  assert.equal(run.quiet, true);
  assert.equal(run.notification, undefined);
  rmSync(dir, { recursive: true, force: true });
});

// --- G: identical notification re-run -> dedupe --------------------------------
test('G: same notification content on re-run -> not resent', async () => {
  const dir = tmp();
  const input = manualObs(dir, [OBS('newp', 'Nova-1', { status: 'active' })]);
  const r1 = await runMaintenanceJob({ ...base(dir), source: 'manual', input });
  assert.equal(r1.notification.sent, true);
  // re-ingest is a duplicate, but the stored observation still produces the same diff
  const r2 = await runMaintenanceJob(base(dir));
  assert.equal(r2.notification?.sent, false);
  assert.match(r2.notification.dedupeReason, /already sent/);
  rmSync(dir, { recursive: true, force: true });
});

// --- H: same event, severity rises -> re-notify --------------------------------
test('H: severity escalation re-notifies despite same payload', async () => {
  const dir = tmp();
  const n1 = buildNotification({ severity: 'info', reasons: ['new model'], proposal: { additions: [{ model: 'newp/Nova-1' }] }, preview: null, runId: 'r1', proposalPath: 'p', previewPath: 'v' });
  const state = { lastNotificationHash: notificationHash(n1), lastSeverity: 'info' };
  const n2 = { ...n1, severity: 'action' }; // same content, higher severity
  const d = shouldNotify(state, n2);
  assert.equal(d.notify, true);
  assert.match(d.reason, /severity rose/);
});

// --- I: budget exceeded -> no premium, deterministic, budgetLimited ------------
test('I: over-budget run skips invocations, continues deterministically', async () => {
  const dir = tmp();
  const policy = structuredClone(DEFAULT_POLICY);
  policy.budget = { maxEstimatedCostPerRunUsd: 0.0001, maxPremiumInvocationsPerRun: 0, maxTotalInvocationsPerRun: 0 };
  const cat = structuredClone(CAT_PLUS_VISION);
  cat.models[0].scores = { coding: 30, reasoning: 25, speed: 85 };
  const input = manualObs(dir, [OBS('qoder', 'Qwen3.8-Flash', { free: false, inputPricePer1M: 0.3, outputPricePer1M: 1.2 })]);
  let invoked = 0;
  const run = await runMaintenanceJob({
    ...base(dir), catalog: cat, source: 'manual', input, live: true, policy,
    invoke: async () => { invoked++; return { ok: true, text: '{"decision":"keep","confidence":0.9,"reasoningSummary":"x"}', durationMs: 1 }; },
  });
  assert.equal(invoked, 0);
  assert.equal(run.budgetLimited, true);
  assert.ok(run.notification.budgetLimited === true || run.quiet === true);
  rmSync(dir, { recursive: true, force: true });
});

// --- J: concurrent runs -> one executes, artifacts intact -----------------------
test('J: second concurrent run is skipped by the lock', async () => {
  const dir = tmp();
  const lock = acquireLock(join(dir, 'model-maintenance.lock'));
  assert.equal(lock.acquired, true);
  const run = await runMaintenanceJob(base(dir));
  assert.equal(run.status, 'skipped-locked');
  releaseLock(lock);
  const run2 = await runMaintenanceJob(base(dir));
  assert.equal(run2.status, 'ok');
  rmSync(dir, { recursive: true, force: true });
});

// --- K: stale lock -> recovery -------------------------------------------------
test('K: stale lock is recovered', async () => {
  const dir = tmp();
  const lockPath = join(dir, 'model-maintenance.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: '2020-01-01T00:00:00Z' }));
  // age the file beyond the TTL
  const old = new Date(Date.now() - 60 * 60 * 1000);
  const { utimesSync } = await import('node:fs');
  utimesSync(lockPath, old, old);
  const run = await runMaintenanceJob(base(dir));
  assert.equal(run.status, 'ok');
  rmSync(dir, { recursive: true, force: true });
});

// --- L: no notify-command -> no external execution ------------------------------
test('L: without --notify-command no external command runs', async () => {
  const dir = tmp();
  const input = manualObs(dir, [OBS('newp', 'Nova-1', { status: 'active' })]);
  const run = await runMaintenanceJob({ ...base(dir), source: 'manual', input });
  assert.equal(run.notification.sent, true);
  assert.ok(!run.notification.sinks.some(s => s.sink === 'command'));
  rmSync(dir, { recursive: true, force: true });
});

// --- M: notify-command receives JSON on stdin, failure audited ------------------
test('M: notify-command gets notification JSON on stdin; failure is audited', async () => {
  const dir = tmp();
  const capture = join(dir, 'captured.json');
  const cmd = `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>require('fs').writeFileSync('${capture.replace(/\\/g, '\\\\')}',s))"`;
  const input = manualObs(dir, [OBS('newp', 'Nova-1', { status: 'active' })]);
  const run = await runMaintenanceJob({ ...base(dir), source: 'manual', input, notifyCommand: cmd });
  const cmdSink = run.notification.sinks.find(s => s.sink === 'command');
  assert.equal(cmdSink.ok, true);
  const sent = JSON.parse(readFileSync(capture, 'utf8'));
  assert.equal(sent.severity, 'info');
  assert.equal(sent.requiresApproval, true);
  // failing command -> audited, job still ok
  const dir2 = tmp();
  const input2 = manualObs(dir2, [OBS('newp', 'Nova-2', { status: 'active' })]);
  const run2 = await runMaintenanceJob({ ...base(dir2), source: 'manual', input: input2, notifyCommand: 'node -e "process.exit(3)"' });
  const bad = run2.notification.sinks.find(s => s.sink === 'command');
  assert.equal(bad.ok, false);
  assert.equal(bad.exitCode, 3);
  assert.equal(run2.status, 'ok');
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
});

// --- supporting ----------------------------------------------------------------
test('classifyRun quiet reasons and severity ordering', () => {
  const empty = () => ({ stored: [], duplicates: [], stale: [], invalid: [] });
  assert.equal(classifyRun({ ingest: empty(), diff: { diffs: [] }, proposal: {}, preview: null }).meaningful, false);
  const dup = empty(); dup.duplicates = [{}];
  assert.equal(classifyRun({ ingest: dup, diff: { diffs: [] }, proposal: {}, preview: null }).quietReason, 'duplicates only');
});

test('state persists lastSuccessfulRunAt and proposal hash', async () => {
  const dir = tmp();
  await runMaintenanceJob(base(dir));
  const state = loadRunState(join(dir, 'model-maintenance.state.json'));
  assert.ok(state.lastSuccessfulRunAt);
  assert.ok(state.lastProposalHash);
  rmSync(dir, { recursive: true, force: true });
});
