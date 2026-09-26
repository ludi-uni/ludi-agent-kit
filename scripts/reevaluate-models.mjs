#!/usr/bin/env node
// Periodic maintenance: re-evaluate capability -> backend -> model bindings when provider
// conditions change (free campaign end, quota/rate-limit change, deprecation, price change,
// new model added). Phase 2 adds execution tiers: monitor -> evaluate -> reconfigure,
// each selecting a model under the cheapest-sufficient policy (free first, then cheapest
// eligible cloud, then local fallback). This run is a dry-run decision layer: it selects
// which model each tier WOULD use and records the rationale — no model is invoked.
//
// Reads routing.json, agents/, adapters/<x>/models.json + models.local.json,
// model-catalog.json, maintenance-policy.json and an events file. Writes ONLY to
// adapters/<x>/out/: model-maintenance.proposal.json (Phase 1 proposal) and
// model-maintenance.run.json (per-tier selection + escalation audit). Never touches
// ~/.pi, settings.json, models.json, models.local.json or routing.json.
//
// Usage:
//   node scripts/reevaluate-models.mjs [--adapter pi] [--events <events.json>]
//       [--availability-file <list.txt>] [--check-availability] [--margin <n>]
//       [--policy <maintenance-policy.json>] [--live] [--stdout]
//
// --live: actually invoke the selected tier models through the pi CLI (spends quota).
//   Without it the run is a pure dry-run decision layer. Even --live writes only
//   out/ reports — never ~/.pi, settings.json, models*.json or routing.json.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadRegistry } from '../lib/registry.mjs';
import { piUserModelsPath } from '../adapters/pi/lib/model-registry.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { loadCatalog, loadEvents, loadAvailabilityFile } from '../lib/maintenance.mjs';
import { runMaintenancePlan, loadExecPolicy } from '../lib/maintenance-exec.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const has = name => args.includes(`--${name}`);
const adapter = opt('adapter', 'pi');
const adapterDir = join(kit, 'adapters', adapter);

const routing = loadRouting(join(kit, 'routing/routing.json'));
const { registry, sources } = loadRegistry(join(adapterDir, 'models.json'), join(adapterDir, 'models.local.json'), routing, adapter === 'pi' ? piUserModelsPath() : null);
const { agents, errors } = loadAgents(join(kit, 'agents'), routing);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
const catalog = loadCatalog(join(adapterDir, 'model-catalog.json'));
const events = opt('events', null) ? loadEvents(resolve(opt('events'))) : [];
const policy = loadExecPolicy(opt('policy', join(adapterDir, 'maintenance-policy.json')));

let availability = null, availabilitySource = 'not-checked';
if (has('check-availability')) {
  availabilitySource = 'pi --list-models (failed)';
  try {
    const { fetchPiAvailability } = await import(`../adapters/${adapter}/lib/list-models.mjs`);
    availability = fetchPiAvailability();
    if (availability) availabilitySource = availability.source;
  } catch { availability = null; }
} else if (opt('availability-file', null)) {
  availability = loadAvailabilityFile(resolve(opt('availability-file')));
  availabilitySource = availability.source;
}

const margin = Number(opt('margin', NaN)) || undefined;
let run;
if (has('live')) {
  const { createPiInvoker } = await import(`../adapters/${adapter}/lib/invoke.mjs`);
  const { runMaintenanceLive } = await import('../lib/maintenance-runner.mjs');
  const invoke = createPiInvoker();
  run = await runMaintenanceLive({ routing, registry, agents, catalog, events, availability, policy, margin, invoke });
} else {
  run = runMaintenancePlan({ routing, registry, agents, catalog, events, availability, policy, margin });
}
run.adapter = adapter;
run.inputs = { registrySources: sources, catalog: join(adapterDir, 'model-catalog.json'), policy: opt('policy', join(adapterDir, 'maintenance-policy.json')), events: opt('events', null), availabilitySource };
run.apply = {
  auto: false,
  how: 'edit adapters/<x>/models.local.json per change.proposedModel, then re-run scripts/resolve-capabilities.mjs and merge out/settings.proposal.json into live settings.json',
  never: ['~/.pi/agent/settings.json', 'adapters/*/models.json', 'adapters/*/models.local.json', 'routing/routing.json', 'provider credentials'],
};

const outDir = join(adapterDir, 'out');
mkdirSync(outDir, { recursive: true });
const runFile = join(outDir, 'model-maintenance.run.json');
writeFileSync(runFile, JSON.stringify(run, null, 2) + '\n');
let proposalFile = null;
if (run.proposal) {
  proposalFile = join(outDir, 'model-maintenance.proposal.json');
  writeFileSync(proposalFile, JSON.stringify(run.proposal, null, 2) + '\n');
}

const tierSummary = run.tiers.map(t => `${t.role}:${t.selected?.model ?? 'none'}($${t.selected?.effectiveCostUsd ?? '?'})`).join(' -> ');
console.log(`model-maintenance: ${run.outcome}; tiers ${tierSummary}; est decision cost $${run.estimatedDecisionCostUsd}`);
console.log(`  run report -> ${runFile}${proposalFile ? `; proposal -> ${proposalFile}` : ''}`);
if (run.escalation) console.log(`  escalation: ${run.escalation.sourceTier} -> ${run.escalation.targetTier}: ${run.escalation.escalationReason}`);
if (run.invocations?.length) {
  for (const inv of run.invocations) console.log(`  invoked ${inv.tier}: ${inv.selectedModel ?? 'none'}${inv.fallbackOccurred ? ' (fallback)' : ''}${inv.degradedToDeterministic ? ' [deterministic-only]' : ''}`);
}
if (has('stdout')) console.log(JSON.stringify(run, null, 2));
