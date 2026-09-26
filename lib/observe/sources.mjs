// Observation source adapters (Phase 4). Each adapter turns a raw source into
// normalized observations. Sources never write; they only emit observation objects.
// Interface: (input) -> observation[]. A future HTTP/Web adapter plugs in here —
// the pipeline only consumes normalized output.
import { readFileSync } from 'node:fs';
import { parseModelList } from '../../adapters/pi/lib/list-models.mjs';

/**
 * manual source — canonical fallback. Input is a JSON file (or parsed object) of
 * { version:1, observations:[...] } or a bare array. Trust defaults to
 * 'manual_verified' when not stated — a human wrote it on purpose.
 */
export function fromManual(input) {
  const doc = typeof input === 'string' ? JSON.parse(readFileSync(input, 'utf8')) : input;
  const list = Array.isArray(doc) ? doc : doc?.observations ?? [];
  return list.map(o => ({
    ...o,
    source: { type: 'manual', trust: 'manual_verified', url: null, label: 'manual input', ...o.source, type: 'manual' },
  }));
}

/**
 * pi CLI source — `pi --list-models` text (or a parsed {models,providers} set).
 * Emits availability observations ONLY for models already in the catalog — a model
 * absent from the listing is NOT reported 'unavailable' here (that inference is the
// differ's job, and it never asserts 'removed' from a listing alone).
 */
export function fromPiCli(listing, { catalog, observedAt } = {}) {
  const parsed = typeof listing === 'string' ? parseModelList(listing) : listing;
  const out = [];
  for (const m of catalog?.models ?? []) {
    const key = `${m.provider}/${m.model}`;
    if (!parsed.providers?.has(m.provider)) continue; // provider unseen -> no observation (unknown, not gone)
    out.push({
      provider: m.provider, model: m.model,
      observedAt,
      source: { type: 'cli', trust: 'pi_cli', label: 'pi --list-models' },
      changes: { availability: parsed.models.has(key) ? 'available' : 'unavailable' },
      confidence: 0.9,
      evidence: ['pi --list-models'],
    });
  }
  return out;
}

/**
 * static/web fixture source — replays provider announcements from a JSON document
 * without real scraping. Accepts the observation shape directly, or a compact
 * announcement form:
 *   { "announcements": [{ "provider":"qoder", "model":"Qwen3.8-Flash",
 *       "type":"price-changed|free-campaign-started|free-campaign-ended|deprecated|context-changed|model-added",
 *       "asOf":"...", "inputPricePer1M":0.3, "outputPricePer1M":1.2, "contextK":256,
 *       "url":"...", "label":"..." }] }
 * A real HTTP source would implement the same emitter against fetched pages.
 */
export function fromFixture(input, { defaultTrust = 'provider_web' } = {}) {
  const doc = typeof input === 'string' ? JSON.parse(readFileSync(input, 'utf8')) : input;
  const list = doc?.observations ?? [];
  const announcements = doc?.announcements ?? [];
  // Fixture observations are TEST data — mark them so production maintenance excludes them.
  const tag = { environment: 'test', sourceFixture: true };
  const out = list.map(o => ({ ...o, ...tag, source: { type: 'web', trust: defaultTrust, fixture: true, ...o.source } }));
  for (const a of announcements) {
    const changes = {};
    switch (a.type) {
      case 'price-changed':
        if (a.inputPricePer1M !== undefined) changes.inputPricePer1M = a.inputPricePer1M;
        if (a.outputPricePer1M !== undefined) changes.outputPricePer1M = a.outputPricePer1M;
        break;
      case 'free-campaign-started': changes.free = true; if (a.freeUntil) changes.freeUntil = a.freeUntil; break;
      case 'free-campaign-ended': changes.free = false; changes.freeUntil = null; break;
      case 'deprecated': changes.status = 'deprecated'; break;
      case 'removed': changes.status = 'removed'; break;
      case 'context-changed': if (a.contextK !== undefined) changes.contextK = a.contextK; break;
      case 'model-added': changes.status = 'active'; if (a.contextK !== undefined) changes.contextK = a.contextK; if (a.vision !== undefined) changes.vision = a.vision; break;
      default: break;
    }
    out.push({
      provider: a.provider, model: a.model, observedAt: a.asOf, ...tag,
      source: { type: 'web', trust: a.trust ?? defaultTrust, url: a.url ?? null, label: a.label ?? a.type, fixture: true },
      changes, confidence: a.confidence ?? 0.8,
      evidence: [a.url ?? a.label ?? a.type].filter(Boolean),
    });
  }
  return out;
}

/**
 * Qoder provider-metadata source — reads the pi-maintained local cache
 * `~/.pi/agent/qoder-models-cache.json` (schema v2: `{version, updatedAt, models:[{id, priceFactor, ...}]}`).
 * Authority is the OBSERVED schema, not an assumption: `priceFactor` is the provider's
 * subscription cost multiplier; 0 means "currently free". A missing file, unparseable
 * JSON, absent entry, or absent/invalid priceFactor yields NO observation (unknown),
 * never a guessed "not free".
 *
 * Transition detection vs the previous snapshot (a state file the caller owns):
 *   0 -> non-zero : free-campaign ended   -> observation {free:false}
 *   non-zero -> 0 : free-campaign started -> observation {free:true}
 *   same          : no observation
 * First observation (no previous snapshot) emits the current free state so the
 * catalog can be reconciled; a null/unknown previous emits nothing (cannot diff).
 *
 * @param {string|object} input cache file path or parsed cache doc
 * @param {object} opts.models   [{provider, model}] to observe (default: all catalog qoder entries via opts.catalog)
 * @param {object} opts.previous { "<id>": <priceFactor|null> } prior snapshot, or null
 * @param {string} opts.observedAt ISO timestamp (defaults to cache updatedAt or now)
 * @returns {{observations: object[], snapshot: object, state: string}}
 *   observations:normalized obs; snapshot: new {id:priceFactor} to persist; state:
 *   'ok'|'missing'|'malformed'|'no-schema'|'entry-missing'|'priceFactor-missing'
 */
export function fromQoderCache(input, { models = null, previous = undefined, observedAt = null, catalog = null } = {}) {
  const out = { observations: [], snapshot: {}, state: 'ok' };
  let doc;
  if (typeof input === 'string') {
    let raw;
    try { raw = readFileSync(input, 'utf8'); } catch { out.state = 'missing'; return out; }
    try { doc = JSON.parse(raw); } catch { out.state = 'malformed'; return out; }
  } else doc = input;
  const entries = Array.isArray(doc?.models) ? doc.models : null;
  if (!entries) { out.state = 'no-schema'; return out; }
  const byId = new Map(entries.filter(e => e && typeof e.id === 'string').map(e => [e.id, e]));
  // observedAt is the read time (now), not the cache's updatedAt — the observation
  // records "we saw this state now"; using updatedAt would stale it against fresher
  // same-model observations from other sources in a combined run.
  const at = observedAt ?? new Date().toISOString();
  const want = models ?? (catalog?.models ?? []).filter(m => m.provider === 'qoder').map(m => ({ provider: m.provider, model: m.model }));
  for (const w of want) {
    const e = byId.get(w.model);
    if (!e) { out.state = out.state === 'ok' ? 'entry-missing' : out.state; continue; }
    const pf = e.priceFactor;
    const valid = typeof pf === 'number' && Number.isFinite(pf) && pf >= 0;
    out.snapshot[w.model] = valid ? pf : null;
    if (!valid) { out.state = out.state === 'ok' ? 'priceFactor-missing' : out.state; continue; } // unknown, not "not free"
    const prev = previous?.[w.model];
    const free = pf === 0;
    const prevFree = prev === 0;
    const prevKnown = typeof prev === 'number' && Number.isFinite(prev);
    // Emit on transition, or on first sighting (prev unknown/absent) so the store
    // holds a baseline. Same value -> nothing.
    const transitioned = prevKnown && prevFree !== free;
    const firstSighting = previous === undefined || previous === null || prev === undefined;
    if (!transitioned && !firstSighting) continue;
    out.observations.push({
      provider: w.provider, model: w.model, observedAt: at,
      source: { type: 'cli', trust: 'provider_local_cache', label: 'qoder-models-cache.json' },
      changes: { free }, confidence: 0.85,
      evidence: [`qoder-models-cache.json priceFactor=${pf}${prevKnown ? ` (was ${prev})` : ''}`],
    });
  }
  return out;
}

/** Registry of source adapters by --source name. */
export const SOURCES = { manual: fromManual, 'pi-cli': fromPiCli, fixture: fromFixture, 'qoder-cache': fromQoderCache };
