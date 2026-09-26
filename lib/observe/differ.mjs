// Catalog differ (Phase 4): compare stored observations against model-catalog.json
// and produce catalog-diff + catalog-proposal documents. Proposals only — the real
// catalog is never written. removed/deprecated proposals require >=2 independent
// sources or one high-trust source; a lone availability listing absence is never
// enough to propose removal.
import { TRUST_LEVELS } from './observation.mjs';

const TRUST_RANK = Object.fromEntries(TRUST_LEVELS.map((t, i) => [t, TRUST_LEVELS.length - i]));
const HIGH_TRUST = new Set(['manual_verified', 'provider_api']);
// Fields whose conflicting values across sources are "major" — never auto-resolved.
const MAJOR_FIELDS = new Set(['status', 'free', 'inputPricePer1M', 'outputPricePer1M']);

// observation field -> catalog field path. Returns {path, toCatalog(value)} pairs.
const FIELD_MAP = {
  status: { get: e => e.status, set: 'status' },
  free: { get: e => e.cost?.free === true || ((e.cost?.usdPerMInput ?? 1) === 0 && (e.cost?.usdPerMOutput ?? 1) === 0), set: 'cost.free' },
  inputPricePer1M: { get: e => e.cost?.usdPerMInput ?? null, set: 'cost.usdPerMInput' },
  outputPricePer1M: { get: e => e.cost?.usdPerMOutput ?? null, set: 'cost.usdPerMOutput' },
  contextK: { get: e => e.contextK ?? null, set: 'contextK' },
  toolUse: { get: e => e.toolUse ?? null, set: 'toolUse' },
  vision: { get: e => e.vision ?? null, set: 'vision' },
  availability: { get: () => null, set: null }, // availability maps to status inference, not a stored field
  freeUntil: { get: e => e.freeUntil ?? null, set: 'freeUntil' },
};

/** Latest observation per (model, field), resolved: newer > trust > confidence. Major ties -> conflict. */
export function resolveObservations(observations) {
  const groups = new Map(); // key -> [obs]
  for (const o of observations) {
    if (o._corrupt) continue;
    for (const [field, value] of Object.entries(o.changes ?? {})) {
      if (value === null || value === undefined) continue;
      const key = `${o.provider}/${o.model}::${field}`;
      (groups.get(key) ?? groups.set(key, []).get(key)).push({ o, field, value });
    }
  }
  const resolved = new Map(); // key -> {winner, conflict}
  for (const [key, items] of groups) {
    const sorted = items.slice().sort((a, b) =>
      b.o.observedAt.localeCompare(a.o.observedAt) ||
      (TRUST_RANK[b.o.source?.trust ?? 'unknown'] - TRUST_RANK[a.o.source?.trust ?? 'unknown']) ||
      (b.o.confidence ?? 0) - (a.o.confidence ?? 0));
    const [best, second] = sorted;
    const conflict = second && best.value !== second.value &&
      best.o.observedAt === second.o.observedAt &&
      (TRUST_RANK[best.o.source?.trust] === TRUST_RANK[second.o.source?.trust]) &&
      MAJOR_FIELDS.has(best.field);
    resolved.set(key, { winner: best, conflict: conflict ? { rival: second } : null, contenders: items.length });
  }
  return resolved;
}

/** Diff resolved observations against the catalog. Returns a catalog-diff document. */
export function diffCatalog(catalog, observations) {
  const resolved = resolveObservations(observations);
  const catalogByKey = new Map((catalog?.models ?? []).map(m => [`${m.provider}/${m.model}`, m]));
  const diffs = [];
  for (const [key, r] of resolved) {
    const { winner, conflict } = r;
    const { provider, model } = winner.o;
    const entry = catalogByKey.get(`${provider}/${model}`);
    const map = FIELD_MAP[winner.field];
    const currentValue = entry ? map.get(entry) : null;
    const base = {
      model: `${provider}/${model}`, field: winner.field,
      currentValue, observedValue: winner.value,
      source: { type: winner.o.source?.type, trust: winner.o.source?.trust, label: winner.o.source?.label },
      confidence: winner.o.confidence ?? null, observedAt: winner.o.observedAt,
      knownModel: Boolean(entry),
    };
    if (conflict) diffs.push({ ...base, status: 'conflict', conflict: { rival: { value: conflict.rival.value, source: conflict.rival.o.source, observedAt: conflict.rival.o.observedAt } } });
    else if (currentValue === winner.value) diffs.push({ ...base, status: 'unchanged' });
    else diffs.push({ ...base, status: 'proposed' });
  }
  return { version: 1, kind: 'catalog-diff', generatedAt: new Date().toISOString(), diffs };
}

/**
 * Build a catalog proposal from a diff. Rules:
 *  - 'unchanged' -> ignored listing
 *  - 'conflict' -> recorded, never applied
 *  - status removed/deprecated -> requires >=2 independent sources OR one high-trust
 *    source; availability-only evidence never proposes 'removed'.
 *  - unknown model + observed status/fields -> addition proposal
 */
export function buildCatalogProposal(catalog, diff, observations) {
  const catalogByKey = new Map((catalog?.models ?? []).map(m => [`${m.provider}/${m.model}`, m]));
  const proposal = { version: 1, kind: 'catalog-proposal', generatedAt: new Date().toISOString(), additions: [], updates: [], deprecations: [], conflicts: [], ignored: [], freshness: {} };

  const sourcesFor = (modelKey, field) => new Set(observations
    .filter(o => `${o.provider}/${o.model}` === modelKey && o.changes?.[field] !== null && o.changes?.[field] !== undefined)
    .map(o => o.source?.label ?? o.source?.type ?? 'unknown'));

  for (const d of diff.diffs) {
    if (d.status === 'unchanged') { proposal.ignored.push({ model: d.model, field: d.field, reason: 'same value observed' }); continue; }
    if (d.status === 'conflict') { proposal.conflicts.push(d); continue; }
    const entry = catalogByKey.get(d.model);
    if (d.field === 'availability') {
      // Listing absence is evidence, never a verdict.
      if (d.observedValue === 'unavailable') proposal.ignored.push({ model: d.model, field: d.field, reason: 'absent from a listing is not removal; recorded as evidence only' });
      else proposal.ignored.push({ model: d.model, field: d.field, reason: 'availability confirmed; no catalog field' });
      continue;
    }
    if (!entry) {
      if (d.field === 'status' && d.observedValue === 'active') {
        proposal.additions.push({ model: d.model, provider: d.model.split('/')[0], modelId: d.model.split('/').slice(1).join('/'), status: 'active', source: d.source, confidence: d.confidence, note: 'new model observed; fill scores/cost before adopting' });
      } else {
        proposal.ignored.push({ model: d.model, field: d.field, reason: 'model not in catalog; field-level update skipped until the model is added' });
      }
      continue;
    }
    if (d.field === 'status' && (d.observedValue === 'removed' || d.observedValue === 'deprecated')) {
      const srcs = sourcesFor(d.model, 'status');
      const highTrust = [...srcs].some(s => observations.some(o => `${o.provider}/${o.model}` === d.model && (o.source?.label ?? o.source?.type) === s && HIGH_TRUST.has(o.source?.trust)));
      if (srcs.size < 2 && !highTrust) {
        proposal.ignored.push({ model: d.model, field: d.field, observedValue: d.observedValue, reason: `${d.observedValue} requires >=2 independent sources or one high-trust source; got ${srcs.size}` });
        continue;
      }
      proposal.deprecations.push({ model: d.model, field: d.field, currentValue: d.currentValue, observedValue: d.observedValue, source: d.source, evidenceSources: [...srcs], confidence: d.confidence });
      continue;
    }
    proposal.updates.push({ model: d.model, field: FIELD_MAP[d.field]?.set ?? d.field, currentValue: d.currentValue, observedValue: d.observedValue, source: d.source, confidence: d.confidence });
  }

  const ats = observations.filter(o => o.observedAt).map(o => o.observedAt).sort();
  proposal.freshness = { observations: observations.length, oldest: ats[0] ?? null, newest: ats[ats.length - 1] ?? null, diffs: diff.diffs.length, proposed: diff.diffs.filter(d => d.status === 'proposed').length };
  return proposal;
}

/**
 * Translate a catalog proposal into maintenance events for the hypothetical preview.
 * A proposed field change is a *condition change* the engine should re-evaluate —
 * free->paid becomes 'free-campaign-ended', status changes map directly, price/context
 * changes become 'price-changed' so the backend is re-scored.
 */
export function proposalToEvents(proposal) {
  const events = [];
  const push = (type, model, note) => {
    const [provider, ...rest] = model.split('/');
    events.push({ type, provider, model: rest.join('/'), asOf: proposal.generatedAt, note });
  };
  for (const d of proposal.deprecations ?? []) push(d.observedValue === 'removed' ? 'removed' : 'deprecated', d.model, `observed ${d.observedValue}`);
  for (const u of proposal.updates ?? []) {
    if (u.field === 'cost.free' && u.observedValue === false) push('free-campaign-ended', u.model, 'free ended per observation');
    else if (u.field === 'cost.free' && u.observedValue === true) push('free-campaign-started', u.model, 'free (re)started per observation');
    else if (u.field === 'status' && (u.observedValue === 'deprecated' || u.observedValue === 'removed')) push(u.observedValue, u.model, 'observed status change');
    else if (u.field?.startsWith('cost.') || u.field === 'contextK' || u.field === 'toolUse') push('price-changed', u.model, `${u.field} ${JSON.stringify(u.currentValue)} -> ${JSON.stringify(u.observedValue)}`);
  }
  for (const a of proposal.additions ?? []) push('model-added', a.model, 'new model observed');
  return events;
}

/**
 * Apply a proposal to a catalog in memory — the "hypothetical catalog" for the
// maintenance preview. Returns a NEW catalog object; the input is not mutated.
 */
export function applyProposalToCatalog(catalog, proposal) {
  const next = structuredClone(catalog);
  const byKey = new Map(next.models.map(m => [`${m.provider}/${m.model}`, m]));
  const setPath = (obj, path, value) => {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] ??= {};
    cur[parts[parts.length - 1]] = value;
  };
  for (const u of proposal.updates ?? []) {
    const entry = byKey.get(u.model);
    if (entry) setPath(entry, u.field, u.observedValue);
  }
  for (const d of proposal.deprecations ?? []) {
    const entry = byKey.get(d.model);
    if (entry) entry.status = d.observedValue;
  }
  for (const a of proposal.additions ?? []) {
    const key = a.model;
    if (!byKey.has(key)) {
      const entry = { provider: a.provider, model: a.modelId, status: 'active', cost: null, contextK: null, vision: false, toolUse: 'basic', scores: { coding: null, reasoning: null, speed: null }, notes: 'added by catalog proposal; scores/cost unknown' };
      next.models.push(entry);
      byKey.set(key, entry);
    }
  }
  next.updatedAt = proposal.generatedAt;
  next._hypothetical = true;
  return next;
}
