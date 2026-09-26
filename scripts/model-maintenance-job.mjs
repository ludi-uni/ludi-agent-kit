#!/usr/bin/env node
// Phase 5 — scheduler-safe maintenance job entrypoint.
//   observe -> dedupe -> catalog diff -> meaningful-change gate -> proposal ->
//   maintenance preview -> optional live tiers -> notification decision -> sinks.
// Quiet by default; writes only under adapters/<x>/out/. Never touches
// model-catalog.json, routing.json, models*.json, settings.json, ~/.pi, credentials.
//
// Usage:
//   node scripts/model-maintenance-job.mjs                          # diff store vs catalog, quiet exit if nothing meaningful
//   node scripts/model-maintenance-job.mjs --source fixture --input announcements.json
//   node scripts/model-maintenance-job.mjs --check-pi               # + pi --list-models availability
//   node scripts/model-maintenance-job.mjs --check-qoder            # + qoder-models-cache.json priceFactor (free campaigns)
//   node scripts/model-maintenance-job.mjs --check pi-cli,qoder-cache # generic observer list
//   node scripts/model-maintenance-job.mjs --live                   # + real tier invocations (spends quota)
//   node scripts/model-maintenance-job.mjs --shadow                 # observe only; no external notify unless --shadow-notify
//   node scripts/model-maintenance-job.mjs --notify-command "node send.js"   # explicit external sink
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadRegistry } from '../lib/registry.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { loadCatalog } from '../lib/maintenance.mjs';
import { loadExecPolicy } from '../lib/maintenance-exec.mjs';
import { runMaintenanceJob } from '../lib/job.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const has = name => args.includes(`--${name}`);
const adapter = opt('adapter', 'pi');
const adapterDir = join(kit, 'adapters', adapter);
const outDir = join(adapterDir, 'out');

const routing = loadRouting(join(kit, 'routing/routing.json'));
const { registry } = loadRegistry(join(adapterDir, 'models.json'), join(adapterDir, 'models.local.json'), routing);
const { agents, errors } = loadAgents(join(kit, 'agents'), routing);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
const catalog = loadCatalog(join(adapterDir, 'model-catalog.json'));
const policy = loadExecPolicy(opt('policy', join(adapterDir, 'maintenance-policy.json')));

let invoke = null;
if (has('live')) {
  const { createPiInvoker } = await import(`../adapters/${adapter}/lib/invoke.mjs`);
  invoke = createPiInvoker();
}

const run = await runMaintenanceJob({
  outDir, adapterDir, kit, catalog, routing, registry, agents, policy,
  source: opt('source', null), input: opt('input', null),
  checkPi: has('check-pi'), checkQoder: has('check-qoder'), check: opt('check', null), qoderCachePath: opt('qoder-cache', null), live: has('live'), invoke,
  notifyCommand: opt('notify-command', null),
  shadow: has('shadow'), shadowNotify: has('shadow-notify'),
});

if (run.status === 'skipped-locked') { console.log('maintenance job: skipped (another run holds the lock)'); process.exit(0); }
if (run.status === 'error') { console.error(`maintenance job: error ${run.error}`); process.exit(1); }
console.log(`maintenance job ${run.runId}: ${run.quiet ? `quiet (${run.verdict.quietReason})` : `${run.verdict.severity} — ${run.notification?.summary ?? ''}`}`);
if (run.notification) console.log(`  notification: sent=${run.notification.sent} (${run.notification.dedupeReason})${run.budgetLimited ? ' [budgetLimited]' : ''}`);
process.exit(run.quiet ? 0 : 2); // 2 = meaningful change pending human review (scheduler-friendly)
