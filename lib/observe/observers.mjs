// Observer registry (Phase 4b): provider/source observers behind a common
// interface so the CLI and the scheduled job iterate a requested list instead of
// stacking per-source `if` branches. Adding a provider = adding one registry entry
// here — no changes to observe-models.mjs or job.mjs.
//
// Observer interface:
//   async run(context) -> { observations: [], probeFailed: bool, metadata: {} }
//
// context carries everything an observer may need (all optional):
//   { catalog, outDir, now, observedAt, adapterDir, kit,
//     listing, qoderListing, qoderCachePath, ...overrides }
// `listing`/`qoderListing`/... are test seams: an explicit value overrides the
// real probe, `false` simulates a failed probe. Provider specifics stay inside
// the observer; the runner only sees normalized observations + a failure flag.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCES, fromPiCli, fromQoderCache } from './sources.mjs';

// ---------------------------------------------------------------------------
// Observer registry. Each entry: { id, describe, run(context) }.
// ---------------------------------------------------------------------------
export const OBSERVERS = {
  'pi-cli': {
    id: 'pi-cli',
    describe: 'pi --list-models availability (provider presence + model listing)',
    async run(context) {
      const { catalog, observedAt, listing } = context;
      // listing === false simulates a failed probe (tests); undefined = real probe.
      const lst = listing === false ? null
        : listing ?? (await import('../../adapters/pi/lib/list-models.mjs')).fetchPiAvailability?.() ?? null;
      if (!lst) {
        return { observations: [], probeFailed: true, metadata: { reason: 'pi --list-models unavailable' } };
      }
      return { observations: fromPiCli(lst, { catalog, observedAt }), probeFailed: false, metadata: { source: lst.source ?? 'pi --list-models' } };
    },
  },

  'qoder-cache': {
    id: 'qoder-cache',
    describe: 'qoder-models-cache.json priceFactor -> free/paid campaign state',
    async run(context) {
      const { catalog, outDir, observedAt, qoderListing, qoderCachePath } = context;
      const statePath = join(outDir, 'qoder-observer-state.json');
      let previous = null;
      try { previous = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')).snapshot ?? null : null; } catch { previous = null; }
      let r;
      if (qoderListing === false) r = { state: 'missing', observations: [], snapshot: {} };
      else if (qoderListing !== undefined) r = qoderListing;
      else {
        const { homedir } = await import('node:os');
        r = fromQoderCache(qoderCachePath ?? join(homedir(), '.pi', 'agent', 'qoder-models-cache.json'), { previous, catalog, observedAt });
      }
      if (r.state !== 'ok') {
        return { observations: [], probeFailed: true, metadata: { reason: `qoder cache probe: ${r.state}` } };
      }
      // Persist the new snapshot for next run's transition detection (out/ only).
      if (outDir) {
        try {
          const { writeFileSync, mkdirSync } = await import('node:fs');
          mkdirSync(outDir, { recursive: true });
          writeFileSync(statePath, JSON.stringify({ version: 1, snapshot: r.snapshot, observedAt }, null, 2) + '\n');
        } catch { /* state write must not break the observer */ }
      }
      return { observations: r.observations, probeFailed: false, metadata: { state: r.state, snapshot: r.snapshot, noTransition: r.observations.length === 0 } };
    },
  },
};

// ---------------------------------------------------------------------------
// Requested-observer resolution + execution.
// ---------------------------------------------------------------------------

/** option property -> observer id. Back-compat aliases live here, not in the runner.
 * Keys are the JS option names (checkPi / checkQoder); the CLI maps --check-pi ->
 * checkPi etc. before calling. */
export const OBSERVER_FLAG_MAP = {
  checkPi: 'pi-cli',
  checkQoder: 'qoder-cache',
};

/**
 * Resolve the requested observer id list from job/CLI options.
 *   options.check       — generic list: 'pi-cli,qoder-cache' or ['pi-cli', ...]
 *   options.checkPi / options.checkQoder — legacy boolean flags (mapped)
 *   options.observers   — explicit id list (programmatic)
 * Returns { ids: string[], unknown: string[] }. Order is stable (first-seen),
 * duplicates removed — the same observer never runs twice.
 */
export function resolveRequestedObservers(options = {}) {
  const ids = [];
  const seen = new Set();
  const push = id => { if (!seen.has(id)) { seen.add(id); ids.push(id); } };

  // legacy boolean flags -> ids (declaration order -> deterministic)
  for (const [flag, id] of Object.entries(OBSERVER_FLAG_MAP)) {
    if (options[flag] === true) push(id);
  }
  // generic --check list (string or array)
  const generic = options.check;
  const genericList = Array.isArray(generic) ? generic : (typeof generic === 'string' ? generic.split(',') : []);
  for (const id of genericList) push(String(id).trim());
  // explicit programmatic list
  for (const id of options.observers ?? []) push(String(id).trim());

  const unknown = ids.filter(id => !OBSERVERS[id]);
  return { ids: ids.filter(id => OBSERVERS[id]), unknown };
}

/**
 * Run each requested observer once, in order. One observer's failure is isolated:
 * it sets probeFailed + records per-source metadata, but never stops the others.
 * Returns { observations, probeFailed, results: [{id, probeFailed, count, metadata}] }.
 * `results` is the audit trail of which source produced what / failed.
 */
export async function runObservers(requestedIds, context = {}) {
  const observations = [];
  const results = [];
  let probeFailed = false;
  for (const id of requestedIds) {
    const observer = OBSERVERS[id];
    if (!observer) { results.push({ id, probeFailed: true, count: 0, metadata: { reason: 'unknown observer' } }); probeFailed = true; continue; }
    try {
      const r = await observer.run(context);
      const list = r.observations ?? [];
      observations.push(...list);
      if (r.probeFailed) probeFailed = true;
      results.push({ id, probeFailed: r.probeFailed === true, count: list.length, metadata: r.metadata ?? {} });
    } catch (e) {
      probeFailed = true;
      results.push({ id, probeFailed: true, count: 0, metadata: { reason: e.message } });
    }
  }
  return { observations, probeFailed, results };
}
