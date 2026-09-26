#!/usr/bin/env node
// Phase 4 — observation pipeline: external sources -> normalized observations ->
// JSONL store -> catalog diff -> catalog proposal -> optional maintenance preview.
// Dry-run only: writes exclusively to adapters/<x>/out/. Never touches
// model-catalog.json, routing.json, models*.json, settings.json, ~/.pi, credentials.
//
// Usage:
//   node scripts/observe-models.mjs --source manual --input observations.json
//   node scripts/observe-models.mjs --source fixture --input announcements.json
//   node scripts/observe-models.mjs --check-pi                 # pi --list-models availability
//   node scripts/observe-models.mjs --check-qoder              # qoder-models-cache.json priceFactor (free campaigns)
//   node scripts/observe-models.mjs --check pi-cli,qoder-cache  # generic observer list (same ids)
//   node scripts/observe-models.mjs                            # diff store vs catalog (no new input)
//   node scripts/observe-models.mjs --preview-maintenance      # + hypothetical catalog -> maintenance dry-run
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadRegistry } from '../lib/registry.mjs';
import { piUserModelsPath } from '../adapters/pi/lib/model-registry.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { loadCatalog } from '../lib/maintenance.mjs';
import { ingestObservations, loadObservationStore, productionObservations } from '../lib/observe/observation.mjs';
import { SOURCES } from '../lib/observe/sources.mjs';
import { OBSERVERS, resolveRequestedObservers, runObservers } from '../lib/observe/observers.mjs';
import { diffCatalog, buildCatalogProposal, applyProposalToCatalog } from '../lib/observe/differ.mjs';
import { runMaintenancePlan, loadExecPolicy } from '../lib/maintenance-exec.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const has = name => args.includes(`--${name}`);
const adapter = opt('adapter', 'pi');
const adapterDir = join(kit, 'adapters', adapter);
const outDir = join(adapterDir, 'out');
mkdirSync(outDir, { recursive: true });

const catalog = loadCatalog(join(adapterDir, 'model-catalog.json'));
const storePath = join(outDir, 'model-observations.jsonl');

// 1. collect observations — an explicit --input file, plus any requested live
// observers. Selection/execution is registry-driven (lib/observe/observers.mjs):
// --check-pi/--check-qoder/--check <list> resolve to observer ids and run once
// each, in order; one observer's failure never blocks the others.
let fresh = [];
if (opt('input', null)) {
  const source = opt('source', 'manual');
  const fn = SOURCES[source];
  if (!fn) { console.error(`unknown --source "${source}"; expected ${Object.keys(SOURCES).join('|')}`); process.exit(1); }
  fresh = fn(resolve(opt('input')));
}
const requested = resolveRequestedObservers({ checkPi: has('check-pi'), checkQoder: has('check-qoder'), check: opt('check', null) });
if (requested.unknown.length) { console.error(`unknown observer id(s): ${requested.unknown.join(', ')}; known: ${Object.keys(OBSERVERS).join(', ')}`); process.exit(1); }
if (requested.ids.length) {
  const r = await runObservers(requested.ids, { catalog, outDir, observedAt: new Date().toISOString(), qoderCachePath: opt('qoder-cache', null) });
  fresh.push(...r.observations);
  for (const res of r.results) {
    if (res.probeFailed) console.error(`${res.id}: ${res.metadata?.reason ?? 'probe failed'}; no observations ingested (unknown, not absent)`);
    else if (res.metadata?.noTransition) console.log(`${res.id}: no transition; no observations ingested`);
  }
}

// 2. ingest into the JSONL store (dedupe/stale handled inside)
const ingest = fresh.length ? ingestObservations(storePath, fresh) : { stored: [], duplicates: [], stale: [], invalid: [] };
const store = loadObservationStore(storePath);

// 3. diff production observations against the catalog (test/fixture records are
// stored for audit but excluded from real proposals)
const prodObs = productionObservations(store.observations);
const diff = diffCatalog(catalog, prodObs);
const diffFile = join(outDir, 'catalog-diff.json');
writeFileSync(diffFile, JSON.stringify(diff, null, 2) + '\n');

// 4. proposal
const proposal = buildCatalogProposal(catalog, diff, prodObs);
const proposalFile = join(outDir, 'model-catalog.proposal.json');
writeFileSync(proposalFile, JSON.stringify(proposal, null, 2) + '\n');

// 5. optional: hypothetical catalog -> maintenance dry-run preview
let previewFile = null;
if (has('preview-maintenance')) {
  const hypothetical = applyProposalToCatalog(catalog, proposal);
  const routing = loadRouting(join(kit, 'routing/routing.json'));
  const { registry } = loadRegistry(join(adapterDir, 'models.json'), join(adapterDir, 'models.local.json'), routing, adapter === 'pi' ? piUserModelsPath() : null);
  const { agents, errors } = loadAgents(join(kit, 'agents'), routing);
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  const policy = loadExecPolicy(join(adapterDir, 'maintenance-policy.json'));
  const preview = runMaintenancePlan({ routing, registry, agents, catalog: hypothetical, events: [], policy });
  preview.hypothetical = true;
  preview.note = 'catalog proposal applied in memory only; model-catalog.json and routing.json unchanged';
  previewFile = join(outDir, 'maintenance-preview.json');
  writeFileSync(previewFile, JSON.stringify(preview, null, 2) + '\n');
}

console.log(`observe: ${fresh.length} fresh, stored ${ingest.stored.length}, dup ${ingest.duplicates.length}, stale ${ingest.stale.length}, invalid ${ingest.invalid.length}`);
console.log(`  diff: ${diff.diffs.length} rows (${diff.diffs.filter(d => d.status === 'proposed').length} proposed, ${diff.diffs.filter(d => d.status === 'conflict').length} conflict) -> ${diffFile}`);
console.log(`  proposal: +${proposal.additions.length} add, ${proposal.updates.length} update, ${proposal.deprecations.length} deprecate, ${proposal.conflicts.length} conflict -> ${proposalFile}`);
if (previewFile) console.log(`  preview: ${previewFile} (hypothetical catalog; nothing applied)`);
