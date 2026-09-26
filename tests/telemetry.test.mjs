// Phase 6: shadow mode, telemetry aggregation, calibration warnings, counterfactuals,
// policy calibration proposal, retention. Cases A–L. Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emptyTelemetry, recordRun, persistRun, loadTelemetry, calibrationWarnings,
  counterfactuals, calibrationProposal, compactTelemetry, telemetryPaths,
} from '../lib/telemetry.mjs';
import { runMaintenanceJob } from '../lib/job.mjs';
import { DEFAULT_POLICY } from '../lib/maintenance-exec.mjs';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { mergeRegistries } from '../lib/registry.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const tmp = () => mkdtempSync(join(tmpdir(), 'tel-'));

const CAT = { version: 1, models: [
  { provider: 'cloudp', model: 'cheap-ok', status: 'active', cost: { usdPerMInput: 0.2, usdPerMOutput: 0.8 }, contextK: 256, toolUse: 'good', location: 'cloud', scores: { coding: 68, reasoning: 62, speed: 75 } },
  { provider: 'cloudp', model: 'vis-ok', status: 'active', cost: { usdPerMInput: 2, usdPerMOutput: 8 }, contextK: 400, vision: true, toolUse: 'good', location: 'cloud', scores: { coding: 80, reasoning: 82, speed: 55 } },
] };
const REG = mergeRegistries(null, { version: 1, backends: { cheap: { provider: 'cloudp', model: 'cheap-ok' }, astra: { provider: 'cloudp', model: 'vis-ok' } } });
const base = dir => ({ outDir: dir, adapterDir: '.', kit: '.', catalog: CAT, routing, registry: REG, agents, policy: DEFAULT_POLICY });
const manualObs = (dir, observations) => { const p = join(dir, 'o.json'); writeFileSync(p, JSON.stringify({ version: 1, observations })); return p; };
const OBS = (p, m, changes, over = {}) => ({ provider: p, model: m, observedAt: '2026-03-05T00:00:00Z', source: { type: 'manual', trust: 'manual_verified' }, changes, confidence: 0.9, ...over });

// --- A: shadow mode -> no external notification ------------------------------
test('A: shadow mode suppresses the external notify-command', async () => {
  const dir = tmp();
  const input = manualObs(dir, [OBS('newp', 'Nova-1', { status: 'active' })]);
  let cmdRan = false;
  const run = await runMaintenanceJob({ ...base(dir), source: 'manual', input, shadow: true, notifyCommand: `node -e "require('fs').writeFileSync('${join(dir, 'cmd-ran').replace(/\\/g, '\\\\')}','1')"` });
  assert.equal(run.shadow, true);
  assert.equal(run.notification.sent, true); // decision still made + file sink
  assert.ok(run.notification.shadowSuppressed);
  assert.equal(existsSync(join(dir, 'cmd-ran')), false);
  assert.ok(existsSync(join(dir, 'model-maintenance.notification.json'))); // file sink still wrote
  rmSync(dir, { recursive: true, force: true });
});

test('A2: --shadow --shadow-notify DOES run the command', async () => {
  const dir = tmp();
  const input = manualObs(dir, [OBS('newp', 'Nova-1', { status: 'active' })]);
  const marker = join(dir, 'cmd-ran').replace(/\\/g, '\\\\');
  const run = await runMaintenanceJob({ ...base(dir), source: 'manual', input, shadow: true, shadowNotify: true, notifyCommand: `node -e "require('fs').writeFileSync('${marker}','1')"` });
  assert.equal(existsSync(join(dir, 'cmd-ran')), true);
  rmSync(dir, { recursive: true, force: true });
});

// --- B: telemetry aggregation -------------------------------------------------
test('B: telemetry aggregates runs, costs, severities, decisions', async () => {
  const dir = tmp();
  const input = manualObs(dir, [OBS('newp', 'Nova-1', { status: 'active' })]);
  await runMaintenanceJob({ ...base(dir), source: 'manual', input });
  await runMaintenanceJob(base(dir)); // second run -> deduped notification
  const t = loadTelemetry(dir);
  assert.equal(t.runs, 2);
  assert.equal(t.meaningfulRuns >= 1, true);
  assert.ok(t.notifications >= 1);
  assert.ok(t.dedupedNotifications >= 1);
  assert.ok(t.cost.totalUsd > 0);
  assert.ok(t.decisions.length >= 1);
  assert.ok(t.decisions[0].model);
  rmSync(dir, { recursive: true, force: true });
});

// --- C: mostly quiet -> no noise warning --------------------------------------
test('C: quiet-dominated history produces no too-noisy warning', () => {
  const t = emptyTelemetry();
  for (let i = 0; i < 20; i++) recordRun(t, { runId: `r${i}`, quiet: true, completedAt: '2026-03-01' });
  recordRun(t, { runId: 'm1', quiet: false, completedAt: '2026-03-02', notification: { severity: 'info', sent: true } });
  const w = calibrationWarnings(t, DEFAULT_POLICY);
  assert.equal(w.filter(x => x.kind === 'too-noisy').length, 0);
});

// --- D: notification-heavy -> noise warning ------------------------------------
test('D: notification-per-meaningful > 0.8 -> too-noisy warning', () => {
  const t = emptyTelemetry();
  for (let i = 0; i < 5; i++) recordRun(t, { runId: `m${i}`, quiet: false, completedAt: '2026-03-01', notification: { severity: 'info', sent: true } });
  const w = calibrationWarnings(t, DEFAULT_POLICY);
  assert.ok(w.some(x => x.kind === 'too-noisy'));
});

// --- E: premium escalation heavy -> warning ------------------------------------
test('E: frequent reconfigure escalations -> too-many-premium-escalations', () => {
  const t = emptyTelemetry();
  for (let i = 0; i < 6; i++) recordRun(t, { runId: `r${i}`, quiet: false, completedAt: '2026-03-01', escalation: { escalationReason: 'structural', targetTier: 'reconfigure' } });
  const w = calibrationWarnings(t, DEFAULT_POLICY);
  assert.ok(w.some(x => x.kind === 'too-many-premium-escalations'));
});

// --- F: fallback heavy -> warning ----------------------------------------------
test('F: frequent fallbacks -> too-many-fallbacks warning', () => {
  const t = emptyTelemetry();
  for (let i = 0; i < 6; i++) recordRun(t, { runId: `r${i}`, quiet: false, completedAt: '2026-03-01', tiers: [{ role: 'monitor', fallbackOccurred: true, selected: { model: 'p/m', location: 'cloud', quality: 70, effectiveCostUsd: 0.001 }, requiredQuality: 40, candidates: [] }] });
  const w = calibrationWarnings(t, DEFAULT_POLICY);
  assert.ok(w.some(x => x.kind === 'too-many-fallbacks'));
});

// --- G: small quality margins -> warning ---------------------------------------
test('G: chronically small quality margins -> quality-margin-too-small', () => {
  const t = emptyTelemetry();
  for (let i = 0; i < 6; i++) recordRun(t, { runId: `r${i}`, quiet: false, completedAt: '2026-03-01', tiers: [{ role: 'evaluate', selected: { model: 'p/m', location: 'cloud', quality: 66, effectiveCostUsd: 0.001 }, requiredQuality: 65, candidates: [] }] });
  const w = calibrationWarnings(t, DEFAULT_POLICY);
  assert.ok(w.some(x => x.kind === 'quality-margin-too-small'));
});

// --- H: below minimum data -> insufficient-observation-data --------------------
test('H: too few runs -> calibration proposal withheld', () => {
  const t = emptyTelemetry();
  for (let i = 0; i < 3; i++) recordRun(t, { runId: `r${i}`, quiet: true, completedAt: '2026-03-01' });
  const p = calibrationProposal(t, DEFAULT_POLICY);
  assert.equal(p.status, 'insufficient-observation-data');
  assert.equal(p.proposals.length, 0);
});

// --- I: enough data -> calibration proposals ------------------------------------
test('I: sufficient history -> policy calibration proposal emitted', () => {
  const t = emptyTelemetry();
  for (let i = 0; i < 25; i++) recordRun(t, { runId: `r${i}`, quiet: i < 20, completedAt: '2026-03-01', notification: i < 20 ? null : { severity: 'info', sent: true } });
  const p = calibrationProposal(t, DEFAULT_POLICY);
  assert.equal(p.status, 'ok');
  assert.ok(p.proposals.length >= 1);
  assert.ok(p.proposals.every(x => 'currentValue' in x && 'proposedValue' in x && 'evidence' in x && 'expectedEffect' in x && 'confidence' in x));
});

// --- J: counterfactual comparison ----------------------------------------------
test('J: counterfactuals compare selected vs alternatives on cost/quality', () => {
  const t = emptyTelemetry();
  recordRun(t, { runId: 'r1', quiet: false, completedAt: '2026-03-01', tiers: [{ role: 'monitor', selected: { model: 'p/mid', location: 'cloud', quality: 70, effectiveCostUsd: 0.002 }, requiredQuality: 40, ordered: [{ model: 'p/mid' }, { model: 'p/cheap', effectiveCostUsd: 0.001, quality: 65 }, { model: 'p/pro', effectiveCostUsd: 0.01, quality: 90 }], candidates: [] }] });
  const cf = counterfactuals(t);
  assert.equal(cf.length, 1);
  const alts = cf[0].counterfactual;
  assert.equal(alts.find(a => a.model === 'p/cheap').verdict, 'cheaper-lower-quality');
  assert.equal(alts.find(a => a.model === 'p/pro').verdict, 'better-more-expensive');
});

// --- K: retention compaction preserves totals -----------------------------------
test('K: compaction folds old runs but keeps summary + recent data', async () => {
  const dir = tmp();
  const { runs } = telemetryPaths(dir);
  const old = { runId: 'old', quiet: true, completedAt: new Date(Date.now() - 40 * 86400e3).toISOString() };
  const recent = { runId: 'new', quiet: true, completedAt: new Date().toISOString() };
  writeFileSync(runs, JSON.stringify(old) + '\n' + JSON.stringify(recent) + '\n');
  const r = compactTelemetry(dir, { days: 30 });
  assert.equal(r.compacted, 1);
  const lines = readFileSync(runs, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.ok(lines.some(l => l.includes('_compactedSummary')));
  assert.ok(lines.some(l => l.includes('"new"')));
  assert.ok(!lines.some(l => l.includes('"old"') && !l.includes('_compactedSummary')));
  rmSync(dir, { recursive: true, force: true });
});

// --- L: calibration proposal does not touch real policy -------------------------
test('L: writing a calibration proposal leaves the real policy file unchanged', async () => {
  const dir = tmp();
  const policyPath = join(dir, 'maintenance-policy.json');
  writeFileSync(policyPath, JSON.stringify({ version: 1, requiredQuality: { evaluate: 65 } }));
  const before = readFileSync(policyPath, 'utf8');
  const t = emptyTelemetry();
  for (let i = 0; i < 25; i++) recordRun(t, { runId: `r${i}`, quiet: i < 20, completedAt: '2026-03-01', notification: i < 20 ? null : { severity: 'info', sent: true } });
  const p = calibrationProposal(t, DEFAULT_POLICY);
  writeFileSync(join(dir, 'maintenance-policy.calibration.proposal.json'), JSON.stringify(p));
  assert.equal(readFileSync(policyPath, 'utf8'), before);
  assert.equal(p.status, 'ok');
  rmSync(dir, { recursive: true, force: true });
});
