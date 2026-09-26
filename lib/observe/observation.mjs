// Observation layer (Phase 4): normalized provider/model observations from external
// sources, kept separate from the core maintenance engine. Sources produce
// observations; this module validates, hashes, dedupes and resolves them — never
// writes model-catalog.json, routing.json or anything outside out/.
import { createHash } from 'node:crypto';
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SOURCE_TYPES = new Set(['manual', 'api', 'web', 'cli']);
export const TRUST_LEVELS = ['manual_verified', 'provider_api', 'provider_local_cache', 'provider_web', 'pi_cli', 'third_party', 'unknown'];
const TRUST_RANK = Object.fromEntries(TRUST_LEVELS.map((t, i) => [t, TRUST_LEVELS.length - i])); // manual_verified highest

// Fields an observation may report. null = not observed (distinct from false/0).
export const OBSERVED_FIELDS = ['availability', 'status', 'free', 'freeUntil', 'inputPricePer1M', 'outputPricePer1M', 'contextK', 'toolUse', 'vision'];
const STATUS_VALUES = new Set(['active', 'free-campaign', 'deprecated', 'removed']);
const AVAIL_VALUES = new Set(['available', 'unavailable', 'unknown']);
const TOOL_VALUES = new Set(['good', 'basic', 'poor', 'none']);

export function validateObservation(o) {
  const errors = [];
  if (!o || typeof o !== 'object' || Array.isArray(o)) return ['observation: must be an object'];
  if (typeof o.provider !== 'string' || !o.provider.trim()) errors.push('observation.provider required');
  if (typeof o.model !== 'string' || !o.model.trim()) errors.push('observation.model required');
  if (typeof o.observedAt !== 'string' || Number.isNaN(Date.parse(o.observedAt))) errors.push('observation.observedAt must be an ISO timestamp');
  const src = o.source;
  if (!src || typeof src !== 'object') errors.push('observation.source required');
  else {
    if (!SOURCE_TYPES.has(src.type)) errors.push(`observation.source.type must be one of ${[...SOURCE_TYPES].join('|')}`);
    if (src.trust !== undefined && !TRUST_LEVELS.includes(src.trust)) errors.push(`observation.source.trust must be one of ${TRUST_LEVELS.join('|')}`);
  }
  const ch = o.changes;
  if (!ch || typeof ch !== 'object' || Array.isArray(ch)) errors.push('observation.changes must be an object');
  else {
    for (const k of Object.keys(ch)) if (!OBSERVED_FIELDS.includes(k)) errors.push(`observation.changes.${k} is not a known field`);
    if (ch.status !== undefined && ch.status !== null && !STATUS_VALUES.has(ch.status)) errors.push('observation.changes.status invalid');
    if (ch.availability !== undefined && ch.availability !== null && !AVAIL_VALUES.has(ch.availability)) errors.push('observation.changes.availability invalid');
    if (ch.toolUse !== undefined && ch.toolUse !== null && !TOOL_VALUES.has(ch.toolUse)) errors.push('observation.changes.toolUse invalid');
    for (const k of ['free', 'vision']) if (ch[k] !== undefined && ch[k] !== null && typeof ch[k] !== 'boolean') errors.push(`observation.changes.${k} must be boolean or null`);
    for (const k of ['inputPricePer1M', 'outputPricePer1M', 'contextK']) if (ch[k] !== undefined && ch[k] !== null && (typeof ch[k] !== 'number' || ch[k] < 0)) errors.push(`observation.changes.${k} must be a number >= 0 or null`);
    if (ch.freeUntil !== undefined && ch.freeUntil !== null && typeof ch.freeUntil !== 'string') errors.push('observation.changes.freeUntil must be a string or null');
  }
  if (o.confidence !== undefined && (typeof o.confidence !== 'number' || o.confidence < 0 || o.confidence > 1)) errors.push('observation.confidence must be 0-1');
  if (o.evidence !== undefined && !Array.isArray(o.evidence)) errors.push('observation.evidence must be an array');
  return errors;
}

/** Deterministic identity: provider+model+the exact observed change set. Same facts -> same hash. */
export function observationHash(o) {
  const stable = {
    p: o.provider, m: o.model,
    c: OBSERVED_FIELDS.filter(f => o.changes?.[f] !== undefined && o.changes[f] !== null).sort().map(f => [f, o.changes[f]]),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

/** Fill defaults and stamp id/hash. Returns a new object. */
export function normalizeObservation(o, { now } = {}) {
  const n = structuredClone(o);
  n.observedAt = n.observedAt ?? now ?? new Date().toISOString();
  n.confidence = typeof n.confidence === 'number' ? n.confidence : 0.5;
  n.evidence = Array.isArray(n.evidence) ? n.evidence : [];
  n.source = { url: null, label: null, trust: 'unknown', ...n.source };
  n.changes = Object.fromEntries(OBSERVED_FIELDS.map(f => [f, n.changes?.[f] ?? null]));
  // Environment tag: 'production' (default) vs 'test'. Fixture/test observations are
  // marked by their source adapter (sourceFixture) or an explicit environment; the
  // production maintenance pipeline excludes them so a fixture replay can never
  // contaminate the real catalog/routing evaluation.
  n.environment = o.environment === 'test' || o.sourceFixture === true || n.source?.fixture === true ? 'test' : 'production';
  n.sourceFixture = n.environment === 'test';
  n.id = observationHash(n);
  return n;
}

// ---------------------------------------------------------------------------
// Observation store — append-only JSONL under out/ (gitignored). No credentials,
// no prompt text: only normalized observations + validation results.
// ---------------------------------------------------------------------------

export function loadObservationStore(path) {
  if (!existsSync(path)) return { path, observations: [] };
  const observations = [];
  for (const [i, line] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { observations.push(JSON.parse(line)); }
    catch { observations.push({ _corrupt: true, line: i + 1 }); }
  }
  return { path, observations };
}

/**
 * Production view: drop test/fixture observations so a fixture replay can never
 * drive a real catalog/routing proposal. An observation is test when
 * environment==='test', sourceFixture===true, or source.fixture===true. Anything
 * without a marker is treated as production (back-compat with pre-tag records).
 */
export function productionObservations(observations) {
  return (observations ?? []).filter(o =>
    o._corrupt || (o.environment !== 'test' && o.sourceFixture !== true && o.source?.fixture !== true));
}

/**
 * Ingest observations into the store. Dedupe rules:
 *  - identical hash already stored -> 'duplicate'
 *  - same key+fields with older timestamp than a stored observation -> 'stale'
 *  - otherwise appended -> 'stored'
 * Returns { stored, duplicates, stale, invalid }.
 */
export function ingestObservations(storePath, rawObservations, { now = () => new Date().toISOString() } = {}) {
  const store = loadObservationStore(storePath);
  const byHash = new Map(store.observations.filter(o => o.id).map(o => [o.id, o]));
  // Newest observedAt per (provider/model, field). Staleness is field-aware: an
  // observation reporting `free` is not stale just because a newer `availability`
  // observation exists for the same model — different fields, different facts.
  const latestByKey = new Map();
  const fieldsOf = o => OBSERVED_FIELDS.filter(f => o.changes?.[f] !== null && o.changes?.[f] !== undefined);
  for (const o of store.observations) {
    if (!o.provider || !o.model || !o.observedAt) continue;
    for (const f of fieldsOf(o)) {
      const k = `${o.provider}/${o.model}::${f}`;
      if (!latestByKey.has(k) || o.observedAt > latestByKey.get(k)) latestByKey.set(k, o.observedAt);
    }
  }
  const result = { stored: [], duplicates: [], stale: [], invalid: [] };
  mkdirSync(dirname(storePath), { recursive: true });
  for (const raw of rawObservations) {
    const errors = validateObservation(raw);
    if (errors.length) { result.invalid.push({ observation: raw, errors }); continue; }
    const o = normalizeObservation(raw, { now: now() });
    if (byHash.has(o.id)) { result.duplicates.push(o); continue; }
    // stale only if EVERY reported field is older than the newest stored value for it
    const fields = fieldsOf(o);
    const allStale = fields.length > 0 && fields.every(f => {
      const latest = latestByKey.get(`${o.provider}/${o.model}::${f}`);
      return latest && o.observedAt < latest;
    });
    if (allStale) { result.stale.push(o); continue; }
    const record = { ...o, ingestedAt: now(), validation: 'ok' };
    appendFileSync(storePath, JSON.stringify(record) + '\n');
    byHash.set(o.id, record);
    for (const f of fields) {
      const k = `${o.provider}/${o.model}::${f}`;
      if (!latestByKey.has(k) || o.observedAt > latestByKey.get(k)) latestByKey.set(k, o.observedAt);
    }
    result.stored.push(record);
  }
  return result;
}
