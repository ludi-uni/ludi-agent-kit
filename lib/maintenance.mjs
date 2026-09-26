// Model-provisioning maintenance: re-evaluate capability -> backend -> model bindings when
// provider conditions change (free campaign end, quota/rate-limit change, deprecation,
// price change, new model added). Neutral: no provider or model names here — concrete data
// comes from an adapter catalog (adapters/<x>/model-catalog.json) plus an events file.
// Pure evaluation: reads config objects and returns a proposal. It never writes
// models.json / models.local.json / settings.json or anything under ~/.pi.
import { readFileSync } from 'node:fs';
import { isPlaceholder } from './registry.mjs';

export const EVENT_TYPES = new Set([
  'free-campaign-started', 'free-campaign-ended', 'free-quota-changed', 'rate-limits-changed',
  'price-changed', 'deprecated', 'removed', 'model-added',
]);
export const MODEL_STATUS = new Set(['active', 'free-campaign', 'deprecated', 'removed']);
export const TOOL_USE = new Set(['good', 'basic', 'poor', 'none']);
export const LOCATION = new Set(['cloud', 'local']);
export const AVAILABILITY = new Set(['available', 'unavailable', 'unknown']);
const TOOL_POINTS = { good: 100, basic: 60, poor: 30, none: 0 };
const USABLE = new Set(['active', 'free-campaign']);

// Heuristic point scales: $0/M blended -> 100, >= $15/M -> 0 (linear); 400K context -> 100.
const COST_FULL_PRICE = 15;
const CONTEXT_FULL_K = 400;

// Dimension weights per backend tier: cheap tiers care about cost, high tiers about quality.
export const TIER_WEIGHTS = {
  free: { cost: 5, coding: 2, reasoning: 1, speed: 2, context: 1, tool: 2 },
  low:  { cost: 4, coding: 3, reasoning: 2, speed: 2, context: 1, tool: 2 },
  mid:  { cost: 2, coding: 4, reasoning: 3, speed: 1, context: 2, tool: 3 },
  high: { cost: 1, coding: 4, reasoning: 4, speed: 1, context: 2, tool: 3 },
};

// Minimum score advantage a candidate must have before a change is "rational".
// A free offer ending is by itself NOT a reason to switch: the current model is
// re-scored with its post-event cost and only loses if a candidate beats it by margin.
export const DEFAULT_MARGIN = 8;

export function validateCatalog(cat) {
  const errors = [];
  if (!cat || typeof cat !== 'object' || Array.isArray(cat)) return ['catalog: root must be an object'];
  if (cat.version !== 1) errors.push('catalog: version must be 1');
  if (!Array.isArray(cat.models)) { errors.push('catalog: models must be an array'); return errors; }
  const seen = new Set();
  cat.models.forEach((m, i) => {
    const at = `catalog: models[${i}]`;
    if (!m || typeof m !== 'object' || Array.isArray(m)) { errors.push(`${at} must be an object`); return; }
    for (const k of ['provider', 'model']) {
      if (typeof m[k] !== 'string' || !m[k].trim()) errors.push(`${at}.${k} must be a non-empty string`);
    }
    const key = `${m.provider}/${m.model}`;
    if (seen.has(key)) errors.push(`${at} duplicates ${key}`);
    seen.add(key);
    if (!MODEL_STATUS.has(m.status)) errors.push(`${at}.status must be one of ${[...MODEL_STATUS].join('|')}`);
    for (const field of ['cost', 'postCampaignCost']) {
      const c = m[field];
      if (c === undefined || c === null) continue;
      if (typeof c !== 'object' || Array.isArray(c)) { errors.push(`${at}.${field} must be an object`); continue; }
      for (const kk of ['usdPerMInput', 'usdPerMOutput']) {
        if (c[kk] !== undefined && c[kk] !== null && (typeof c[kk] !== 'number' || c[kk] < 0)) errors.push(`${at}.${field}.${kk} must be a number >= 0 or null`);
      }
      if (c.free !== undefined && typeof c.free !== 'boolean') errors.push(`${at}.${field}.free must be boolean`);
    }
    if (m.freeUntil != null && (typeof m.freeUntil !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m.freeUntil) || !Number.isFinite(Date.parse(m.freeUntil)))) errors.push(`${at}.freeUntil must be a UTC ISO timestamp`);
    if (m.contextK !== undefined && m.contextK !== null && (typeof m.contextK !== 'number' || m.contextK <= 0)) errors.push(`${at}.contextK must be a number > 0 or null`);
    if (m.vision !== undefined && typeof m.vision !== 'boolean') errors.push(`${at}.vision must be boolean`);
    if (m.location !== undefined && !LOCATION.has(m.location)) errors.push(`${at}.location must be one of ${[...LOCATION].join('|')}`);
    if (m.availability !== undefined && !AVAILABILITY.has(m.availability)) errors.push(`${at}.availability must be one of ${[...AVAILABILITY].join('|')}`);
    if (m.local !== undefined) {
      if (typeof m.local !== 'object' || m.local === null || Array.isArray(m.local)) { errors.push(`${at}.local must be an object`); return; }
      if (m.local.powerWatts !== undefined && (typeof m.local.powerWatts !== 'number' || m.local.powerWatts < 0)) errors.push(`${at}.local.powerWatts must be a number >= 0`);
      if (m.local.taskMinutes !== undefined && (typeof m.local.taskMinutes !== 'number' || m.local.taskMinutes <= 0)) errors.push(`${at}.local.taskMinutes must be a number > 0`);
    }
    if (m.toolUse !== undefined && !TOOL_USE.has(m.toolUse)) errors.push(`${at}.toolUse must be one of ${[...TOOL_USE].join('|')}`);
    if (m.thinking !== undefined && typeof m.thinking !== 'string') errors.push(`${at}.thinking must be a string`);
    if (m.scores !== undefined) {
      if (typeof m.scores !== 'object' || m.scores === null) { errors.push(`${at}.scores must be an object`); return; }
      for (const [sk, sv] of Object.entries(m.scores)) {
        if (!['coding', 'reasoning', 'speed'].includes(sk)) errors.push(`${at}.scores.${sk} is not a known dimension`);
        else if (sv !== null && (typeof sv !== 'number' || sv < 0 || sv > 100)) errors.push(`${at}.scores.${sk} must be 0-100 or null`);
      }
    }
  });
  return errors;
}

export function validateEvents(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['events: root must be an object'];
  if (doc.version !== 1) errors.push('events: version must be 1');
  if (!Array.isArray(doc.events)) { errors.push('events: events must be an array'); return errors; }
  doc.events.forEach((e, i) => {
    const at = `events[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) { errors.push(`${at} must be an object`); return; }
    if (!EVENT_TYPES.has(e.type)) errors.push(`${at}.type must be one of ${[...EVENT_TYPES].join('|')}`);
    if (typeof e.provider !== 'string' || !e.provider.trim() || typeof e.model !== 'string' || !e.model.trim()) {
      errors.push(`${at} requires non-empty provider and model`);
    }
    if (e.cost !== undefined && (typeof e.cost !== 'object' || e.cost === null || Array.isArray(e.cost))) errors.push(`${at}.cost must be an object`);
  });
  return errors;
}

export function loadCatalog(path) {
  const cat = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateCatalog(cat);
  if (errors.length) throw new Error(errors.join('\n'));
  return cat;
}

export function loadEvents(path) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateEvents(doc);
  if (errors.length) throw new Error(errors.join('\n'));
  return doc.events;
}

/** Availability list file: one "provider/model" per line. Providers seen -> models known. */
export function loadAvailabilityFile(path) {
  const models = new Set(), providers = new Set();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Za-z0-9_-]+)\/(\S+)$/);
    if (m) { providers.add(m[1]); models.add(`${m[1]}/${m[2]}`); }
  }
  return { models, providers, source: `file:${path}` };
}

/** Index events by "provider/model": effective status/cost overrides + human-readable notes. */
function applyEvents(events) {
  const overrides = new Map();
  for (const e of events ?? []) {
    const key = `${e.provider}/${e.model}`;
    const prev = overrides.get(key) ?? { notes: [] };
    prev.eventType = e.type;
    if (e.asOf) prev.asOf = e.asOf;
    prev.notes.push(e.note ? `${e.type} (${e.asOf ?? 'n/a'}): ${e.note}` : e.type);
    switch (e.type) {
      case 'free-campaign-started': prev.started = true; break;
      case 'free-campaign-ended': prev.ended = true; break;
      case 'price-changed': if (e.cost) prev.cost = e.cost; break;
      case 'free-quota-changed': case 'rate-limits-changed': prev.limits = e.note ?? e.type; break;
      case 'deprecated': prev.status = 'deprecated'; break;
      case 'removed': prev.status = 'removed'; break;
      case 'model-added': prev.added = true; break;
    }
    overrides.set(key, prev);
  }
  return overrides;
}

/** Catalog entries with all event overrides applied — the view selection and evaluation share. */
export function effectiveCatalog(catalog, events = [], asOf = new Date().toISOString()) {
  const overrides = applyEvents(events);
  return (catalog?.models ?? []).map(m => effectiveEntry(m, overrides.get(`${m.provider}/${m.model}`), asOf));
}

/** Catalog entry with event overrides applied. Free-campaign end re-prices to postCampaignCost. */
function effectiveEntry(entry, ov, asOf = new Date().toISOString()) {
  if (!entry) return null;
  const m = structuredClone(entry);
  // A published cutoff is a safety boundary: never plan a $0 run past it merely
  // because no explicit end event has arrived. An observed start event cannot
  // extend a stale deadline; update freeUntil from new evidence first.
  if (m.status === 'free-campaign' && m.freeUntil && Date.parse(asOf) >= Date.parse(m.freeUntil)) {
    m.status = 'active';
    m.cost = m.postCampaignCost ?? null;
    if (m.cost) m.cost.free = false; else m.costUnknown = true;
    m.campaignExpired = true;
  }
  if (!ov) return m;
  if (ov.status) m.status = ov.status;
  if (ov.started) {
    // Campaign (re)started: usable again at $0. postCampaignCost is kept for the
    // next end; it is never applied while the campaign is live.
    m.status = 'free-campaign';
    m.cost = { free: true };
    delete m.costUnknown;
  } else if (ov.ended) {
    m.status = 'active';
    m.cost = ov.cost ?? m.postCampaignCost ?? null;
    if (m.cost) m.cost.free = false; else m.costUnknown = true;
  } else if (ov.cost) m.cost = ov.cost;
  if (ov.limits) m.limitsNote = ov.limits;
  if (m.campaignExpired && !ov.ended) {
    m.status = 'active';
    m.cost = m.postCampaignCost ?? null;
    if (m.cost) m.cost.free = false; else m.costUnknown = true;
  }
  return m;
}

function costPoints(cost) {
  if (!cost) return null;
  if (cost.free === true) return 100;
  const i = cost.usdPerMInput, o = cost.usdPerMOutput;
  if (i == null && o == null) return null;
  return Math.max(0, 100 - (((i ?? 0) + (o ?? 0)) / 2) * (100 / COST_FULL_PRICE));
}
const contextPoints = k => (typeof k === 'number' ? Math.min(100, (k / CONTEXT_FULL_K) * 100) : null);

/** Weighted 0-100 score for a catalog entry under a backend tier. Unknown dims are skipped. */
export function scoreModel(entry, tier = 'mid') {
  const w = TIER_WEIGHTS[tier] ?? TIER_WEIGHTS.mid;
  const points = {
    cost: costPoints(entry?.cost),
    coding: entry?.scores?.coding ?? null,
    reasoning: entry?.scores?.reasoning ?? null,
    speed: entry?.scores?.speed ?? null,
    context: contextPoints(entry?.contextK),
    tool: entry?.toolUse ? TOOL_POINTS[entry.toolUse] : null,
  };
  let sum = 0, wsum = 0;
  const unknown = [];
  for (const [d, pts] of Object.entries(points)) {
    if (pts === null || pts === undefined) { unknown.push(d); continue; }
    sum += w[d] * pts; wsum += w[d];
  }
  if (!wsum) return { score: null, confidence: 'low', unknown: Object.keys(points), points };
  const confidence = (unknown.includes('cost') || unknown.includes('coding') || unknown.length >= 3) ? 'low' : 'high';
  return { score: sum / wsum, confidence, unknown, points };
}

/** Quality-only delta (all dims except cost) between two scored point maps. Null if incomparable. */
function qualityDelta(curPoints, newPoints, tier) {
  const w = TIER_WEIGHTS[tier] ?? TIER_WEIGHTS.mid;
  let s = 0, ws = 0;
  for (const d of ['coding', 'reasoning', 'speed', 'context', 'tool']) {
    if (curPoints[d] == null || newPoints[d] == null) continue;
    s += w[d] * (newPoints[d] - curPoints[d]); ws += w[d];
  }
  return ws ? s / ws : null;
}

const round1 = v => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const fmtDim = v => (v === null || v === undefined ? '?' : String(Math.round(v)));

function fmtCost(cost) {
  if (!cost) return 'unknown';
  if (cost.free === true) return '$0 (free)';
  const i = cost.usdPerMInput, o = cost.usdPerMOutput;
  if (i == null && o == null) return 'unknown';
  return `~$${(((i ?? 0) + (o ?? 0)) / 2).toFixed(2)}/M blended`;
}

function costImpact(cur, best) {
  return `current ${fmtCost(cur?.cost)} -> proposed ${fmtCost(best?.cost)}`;
}

function qualityImpact(cur, best) {
  const parts = ['coding', 'reasoning', 'speed'].map(d => {
    const a = cur?.scores?.[d], b = best?.scores?.[d];
    const delta = a != null && b != null ? ` (${b - a >= 0 ? '+' : ''}${Math.round(b - a)})` : '';
    return `${d} ${fmtDim(a)}->${fmtDim(b)}${delta}`;
  });
  parts.push(`context ${cur?.contextK ?? '?'}K->${best?.contextK ?? '?'}K`);
  parts.push(`toolUse ${cur?.toolUse ?? '?'}->${best?.toolUse ?? '?'}`);
  return parts.join(', ');
}

/**
 * Re-evaluate every bound primary backend against the catalog + events.
 *   routing   loaded routing.json
 *   registry  merged models.json + models.local.json ({ backends: {name: {provider, model, ...}} })
 *   agents    loaded agent definitions (for affected-agent reporting)
 *   catalog   loaded model catalog ({ models: [...] })
 *   events    provisioning events (see EVENT_TYPES)
 *   availability  optional { models:Set<"p/m">, providers:Set<p>, source } — a provider absent
 *                 from `providers` means "unknown", never "missing".
 *   margin    minimum score advantage for a non-forced proposal (DEFAULT_MARGIN)
 * Returns { infoStatus, changes, decisions }. `changes` is the proposal; `decisions` is the audit trail.
 */
export function evaluateMaintenance({ routing, registry, agents = [], catalog, events = [], availability = null, margin = DEFAULT_MARGIN, asOf = new Date().toISOString() }) {
  const overrides = applyEvents(events);
  const effectiveModels = effectiveCatalog(catalog, events, asOf);
  const byKey = new Map((catalog?.models ?? []).map(m => [`${m.provider}/${m.model}`, m]));
  const addedKeys = new Set((events ?? []).filter(e => e.type === 'model-added').map(e => `${e.provider}/${e.model}`));
  const warnings = [];
  for (const k of addedKeys) if (!byKey.has(k)) warnings.push(`model-added event for ${k} but no catalog entry; it cannot be scored`);

  const capsByBackend = {}, agentsByCap = {};
  for (const [name, c] of Object.entries(routing.capabilities ?? {})) (capsByBackend[c.primary] ??= []).push(name);
  for (const a of agents) (agentsByCap[a.meta?.capability] ??= []).push(a.meta?.name);

  const modelAvailable = m => {
    if (!availability) return true;
    if (!availability.providers?.has(m.provider)) return true; // provider unseen -> unknown, keep
    return availability.models.has(`${m.provider}/${m.model}`);
  };
  const currentMissing = b => Boolean(availability && availability.providers?.has(b.provider) && !availability.models.has(`${b.provider}/${b.model}`));

  const decisions = [], changes = [];
  for (const [backend, capNames] of Object.entries(capsByBackend)) {
    const tier = routing.backends[backend]?.tier ?? 'mid';
    const sortedCaps = [...capNames].sort();
    const affectedAgents = [...new Set(sortedCaps.flatMap(c => agentsByCap[c] ?? []))].sort();
    const base = { backend, tier, capabilities: sortedCaps, agents: affectedAgents };
    const binding = registry?.backends?.[backend];
    if (!binding || isPlaceholder(binding)) {
      decisions.push({ ...base, decision: 'skip', reason: 'no bound model (unbound or placeholder)' });
      continue;
    }
    const key = `${binding.provider}/${binding.model}`;
    const entry = byKey.get(key);
    const ov = overrides.get(key);
    const eff = effectiveEntry(entry, ov, asOf);
    const missing = currentMissing(binding);
    const status = eff?.status ?? 'unknown';
    const current = { provider: binding.provider, model: binding.model, ...(binding.thinking ? { thinking: binding.thinking } : {}) };

    const triggered = Boolean(ov) || eff?.campaignExpired || addedKeys.size > 0 || status === 'deprecated' || status === 'removed' || missing;
    if (!triggered) {
      decisions.push({ ...base, decision: 'keep', current, reason: 'no triggering event; catalog status healthy' });
      continue;
    }

    const reasons = [];
    if (ov) reasons.push(...ov.notes);
    if (eff?.campaignExpired) reasons.push(`free campaign expired at ${eff.freeUntil}`);
    if (status === 'deprecated' && ov?.eventType !== 'deprecated') reasons.push('catalog status: deprecated');
    if (status === 'removed' && ov?.eventType !== 'removed') reasons.push('catalog status: removed');
    if (missing) reasons.push(`provider "${binding.provider}" is present in the availability listing but ${key} is not`);
    if (addedKeys.size) reasons.push(`new model(s) announced: ${[...addedKeys].join(', ')}`);

    const requiresVision = sortedCaps.some(c => routing.capabilities[c]?.requires?.vision === true);
    const pool = effectiveModels.filter(m =>
      `${m.provider}/${m.model}` !== key &&
      USABLE.has(m.status) &&
      (!requiresVision || m.vision === true) &&
      m.toolUse !== 'none' &&
      modelAvailable(m));
    const curScore = scoreModel(eff, tier);
    const scored = pool
      .map(m => ({ entry: m, ...scoreModel(m, tier) }))
      .filter(s => s.score !== null)
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    const detail = {
      ...base, current, currentStatus: status, trigger: reasons,
      currentScore: { score: round1(curScore.score), confidence: curScore.confidence, unknown: curScore.unknown },
      topCandidates: scored.slice(0, 3).map(s => ({ model: `${s.entry.provider}/${s.entry.model}`, score: round1(s.score), confidence: s.confidence })),
    };

    if (!best) {
      decisions.push({ ...detail, decision: 'insufficient-data', reason: 'no eligible candidate in the catalog (all filtered by usability, vision/tool requirements or availability)' });
      continue;
    }

    const forced = status === 'removed' || status === 'deprecated' || missing;
    const delta = curScore.score === null ? null : best.score - curScore.score;
    const curCostUnknown = eff?.costUnknown === true || curScore.unknown.includes('cost');
    const bestIsFree = best.entry.cost?.free === true || ((best.entry.cost?.usdPerMInput ?? 0) === 0 && (best.entry.cost?.usdPerMOutput ?? 0) === 0);
    const qDelta = curScore.points && best.points ? qualityDelta(curScore.points, best.points, tier) : null;

    let decision, reason;
    if (forced) {
      decision = 'propose';
      reason = `current model is ${status !== 'unknown' ? status : 'unavailable'}; migration required — proposing best eligible candidate regardless of margin`;
    } else if (curScore.score === null) {
      decision = 'insufficient-data';
      reason = 'current model has no usable catalog data; refusing to compare on speculation';
    } else if (delta !== null && delta >= margin && best.confidence !== 'low') {
      decision = 'propose';
      reason = `best candidate scores +${delta.toFixed(1)} over current (margin ${margin}) under tier "${tier}" weights`;
    } else if (curCostUnknown && bestIsFree && (qDelta === null || qDelta >= -margin)) {
      decision = 'propose';
      reason = 'post-event cost of the current model is unknown and a free candidate with comparable quality exists';
    } else {
      decision = 'keep';
      reason = delta !== null && delta < margin
        ? `best candidate advantage ${delta.toFixed(1)} is below margin ${margin}; keeping current model`
        : 'best candidate has low-confidence catalog data; keeping current model';
    }

    const proposedModel = {
      provider: best.entry.provider, model: best.entry.model,
      ...(best.entry.thinking ?? binding.thinking ? { thinking: best.entry.thinking ?? binding.thinking } : {}),
      ...(best.entry.vision ? { vision: true } : {}),
    };
    decisions.push({ ...detail, decision, reason, proposed: decision === 'propose' ? proposedModel : undefined });

    if (decision === 'propose') {
      changes.push({
        changeReason: reasons.join('; '),
        affected: { backend, capabilities: sortedCaps, agents: affectedAgents },
        currentModel: current,
        proposedModel,
        expectedCostImpact: costImpact(eff, best.entry),
        expectedQualityImpact: qualityImpact(eff, best.entry),
        scores: { current: round1(curScore.score), proposed: round1(best.score), delta: round1(delta), margin },
        confidence: curScore.confidence === 'high' && best.confidence === 'high' ? 'high' : 'low',
        rollback: {
          method: 'manual-edit',
          previousBinding: binding,
          steps: [
            `edit the adapter models.local.json: set backends.${backend} to the embedded previousBinding`,
            're-run scripts/resolve-capabilities.mjs to regenerate settings.proposal.json',
            'if agent overrides were merged into live settings.json, re-merge the regenerated proposal',
          ],
        },
      });
    }
  }

  // Bound backends that are only fallbacks: report, do not evaluate.
  for (const [backend, binding] of Object.entries(registry?.backends ?? {})) {
    if (capsByBackend[backend] || !(backend in (routing.backends ?? {}))) continue;
    if (isPlaceholder(binding)) continue;
    decisions.push({ backend, tier: routing.backends[backend]?.tier ?? null, capabilities: [], agents: [], decision: 'not-primary', current: { provider: binding.provider, model: binding.model }, reason: 'bound only as a fallback; primary re-evaluation covers routing changes' });
  }

  return {
    version: 1,
    kind: 'model-maintenance',
    infoStatus: {
      catalogUpdatedAt: catalog?.updatedAt ?? null,
      eventsApplied: (events ?? []).map(e => `${e.type}:${e.provider}/${e.model}`),
      availability: availability?.source ?? 'not-checked (catalog status only)',
      warnings,
    },
    changes,
    decisions,
  };
}
