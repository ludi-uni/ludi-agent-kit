// Phase 2 — maintenance execution tiers and cheapest-sufficient model selection.
// Neutral: no provider or model names. Concrete facts come from the adapter catalog.
//
// Execution tiers: monitor (cheapest watcher) -> evaluate (judgement) -> reconfigure
// (premium escalation). Model choice per tier: free first, then cheapest-sufficient,
// then local fallback. Selection is deterministic and explainable — no optimizer.
//
// This module is pure: it computes which model a tier *would* run on and whether
// escalation is warranted. It never invokes a model and never writes config.
import { readFileSync } from 'node:fs';
import { evaluateMaintenance, effectiveCatalog, scoreModel } from './maintenance.mjs';

export const EXEC_TIERS = ['monitor', 'evaluate', 'reconfigure'];
const USABLE_STATUS = new Set(['active', 'free-campaign']);
const TOOL_POINTS = { good: 1, basic: 0.6, poor: 0.3, none: 0 };

export const DEFAULT_POLICY = {
  version: 1,
  // Minimum quality (0-100) per execution tier. Free models that miss the bar are
  // NOT used — selection proceeds to cheapest-sufficient.
  requiredQuality: { monitor: 40, evaluate: 65, reconfigure: 80 },
  // Effective-cost blend, USD per maintenance run. api: token-priced per run from
  // taskProfiles (NOT $/1M compared directly to electricity). local: electricity.
  // Missing facts fall back to the cheapest *known* value in the pool; a model with
  // no known cost is never preferred on an assumed zero.
  costWeights: { api: 1, electricity: 1, speed: 0.02 },
  electricityPricePerKwh: 0.30,
  // Per-tier task profile: how big one maintenance invocation is. Drives the API
  // cost estimate (tokens x price) and the local electricity estimate (minutes).
  taskProfiles: {
    monitor:     { estimatedInputTokens: 8000,  estimatedOutputTokens: 800,  estimatedTaskMinutes: 1 },
    evaluate:    { estimatedInputTokens: 20000, estimatedOutputTokens: 3000, estimatedTaskMinutes: 3 },
    reconfigure: { estimatedInputTokens: 60000, estimatedOutputTokens: 8000, estimatedTaskMinutes: 8 },
  },
  // Tier weight profile used for per-tier quality scoring (see TIER_WEIGHTS in maintenance.mjs).
  qualityTier: { monitor: 'low', evaluate: 'mid', reconfigure: 'high' },
  // Escalation from evaluate to reconfigure. Any single condition suffices.
  escalation: {
    minCapabilities: 2,       // proposed changes span >= N capabilities
    minAgents: 3,             // or >= N distinct agents
    minQualitySwing: 15,      // or |proposed - current| quality delta >= N points
    maxScoreDelta: 4,         // or the winning margin is < N points (hard call)
    structuralEvents: ['removed', 'deprecated'], // provider/model exit is structural by default
    escalateOnLowConfidence: true,
    escalateOnStructural: false, // routing.json shape changes require a human anyway
    minEvaluateConfidence: 0.5,  // evaluate model self-confidence below this escalates
  },
};

export function validateExecPolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return ['exec-policy: root must be an object'];
  for (const key of Object.keys(policy)) {
    if (!['version', 'requiredQuality', 'costWeights', 'electricityPricePerKwh', 'taskProfiles', 'qualityTier', 'escalation', 'budget', 'calibration', 'capabilityRequirements', '$comment', 'description'].includes(key)) {
      errors.push(`exec-policy: unknown top-level key "${key}"`);
    }
  }
  if (policy.version !== 1) errors.push('exec-policy: version must be 1');
  for (const tier of EXEC_TIERS) {
    const q = policy.requiredQuality?.[tier];
    if (q !== undefined && (typeof q !== 'number' || q < 0 || q > 100)) errors.push(`exec-policy: requiredQuality.${tier} must be 0-100`);
  }
  if (policy.electricityPricePerKwh !== undefined && (typeof policy.electricityPricePerKwh !== 'number' || policy.electricityPricePerKwh < 0)) {
    errors.push('exec-policy: electricityPricePerKwh must be a number >= 0');
  }
  if (policy.taskProfiles !== undefined) {
    if (typeof policy.taskProfiles !== 'object' || policy.taskProfiles === null) { errors.push('exec-policy: taskProfiles must be an object'); }
    else for (const [tier, p] of Object.entries(policy.taskProfiles)) {
      for (const k of ['estimatedInputTokens', 'estimatedOutputTokens', 'estimatedTaskMinutes']) {
        if (p?.[k] !== undefined && (typeof p[k] !== 'number' || p[k] < 0)) errors.push(`exec-policy: taskProfiles.${tier}.${k} must be a number >= 0`);
      }
    }
  }
  if (policy.escalation !== undefined && (typeof policy.escalation !== 'object' || policy.escalation === null)) errors.push('exec-policy: escalation must be an object');
  if (policy.budget !== undefined) {
    if (typeof policy.budget !== 'object' || policy.budget === null) { errors.push('exec-policy: budget must be an object'); }
    else for (const k of ['maxEstimatedCostPerRunUsd', 'maxPremiumInvocationsPerRun', 'maxTotalInvocationsPerRun']) {
      if (policy.budget[k] !== undefined && (typeof policy.budget[k] !== 'number' || policy.budget[k] < 0)) errors.push(`exec-policy: budget.${k} must be a number >= 0`);
    }
  }
  if (policy.capabilityRequirements !== undefined) {
    if (typeof policy.capabilityRequirements !== 'object' || policy.capabilityRequirements === null || Array.isArray(policy.capabilityRequirements)) errors.push('exec-policy: capabilityRequirements must be an object');
    else for (const [cap, req] of Object.entries(policy.capabilityRequirements)) {
      if (!req || typeof req !== 'object' || Array.isArray(req)) { errors.push(`exec-policy: capabilityRequirements.${cap} must be an object`); continue; }
      for (const [dim, value] of Object.entries(req)) {
        if (!['coding', 'reasoning'].includes(dim) || typeof value !== 'number' || value < 0 || value > 100) errors.push(`exec-policy: capabilityRequirements.${cap}.${dim} must be coding/reasoning 0-100`);
      }
    }
  }
  if (policy.calibration !== undefined) {
    if (typeof policy.calibration !== 'object' || policy.calibration === null) { errors.push('exec-policy: calibration must be an object'); }
    else for (const k of ['minRuns', 'minMeaningfulEvents']) {
      if (policy.calibration[k] !== undefined && (typeof policy.calibration[k] !== 'number' || policy.calibration[k] < 0)) errors.push(`exec-policy: calibration.${k} must be a number >= 0`);
    }
  }
  return errors;
}

export function loadExecPolicy(path, defaults = DEFAULT_POLICY) {
  if (!path) return structuredClone(defaults);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validateExecPolicy(doc);
  if (errors.length) throw new Error(errors.join('\n'));
  return {
    ...structuredClone(defaults), ...doc,
    requiredQuality: { ...defaults.requiredQuality, ...doc.requiredQuality },
    costWeights: { ...defaults.costWeights, ...doc.costWeights },
    taskProfiles: { ...defaults.taskProfiles, ...doc.taskProfiles },
    qualityTier: { ...defaults.qualityTier, ...doc.qualityTier },
    escalation: { ...defaults.escalation, ...doc.escalation },
    budget: { ...defaults.budget, ...doc.budget },
    calibration: { ...defaults.calibration, ...doc.calibration },
    capabilityRequirements: { ...defaults.capabilityRequirements, ...doc.capabilityRequirements },
  };
}

/** Estimated electricity cost of one local inference run, USD. Null when unknown. */
export function localElectricityCost(local, pricePerKwh) {
  if (!local || typeof local.powerWatts !== 'number' || typeof local.taskMinutes !== 'number') return null;
  if (typeof pricePerKwh !== 'number') return null;
  return (local.powerWatts / 1000) * (local.taskMinutes / 60) * pricePerKwh;
}

/** API cost of one run, USD: inputTokens x $/1M-in + outputTokens x $/1M-out. Null when unpriced. */
export function apiCostPerRun(entry, profile = {}) {
  const c = entry?.cost;
  if (!c) return null;
  if (c.free === true) return 0;
  const i = c.usdPerMInput, o = c.usdPerMOutput;
  if (i == null && o == null) return null;
  const tin = profile.estimatedInputTokens ?? 0, tout = profile.estimatedOutputTokens ?? 0;
  return ((i ?? 0) * tin + (o ?? 0) * tout) / 1e6;
}

/**
 * Estimated cost of one maintenance run, USD — comparable across cloud and local.
 * cloud: token-priced API estimate from the tier task profile. local: electricity,
 * using per-model taskMinutes when present else the tier profile. A speed penalty
 * (slower models hold the pipeline longer) is added. Null components fall back to
 * the cheapest known value so an unknown cost is never treated as free.
 */
export function estimatedCostPerRun(entry, policy = DEFAULT_POLICY, pool = [], tier = 'monitor') {
  const w = policy.costWeights ?? DEFAULT_POLICY.costWeights;
  const profile = policy.taskProfiles?.[tier] ?? {};
  const price = policy.electricityPricePerKwh ?? DEFAULT_POLICY.electricityPricePerKwh;
  const api = apiCostPerRun(entry, profile);
  const local = entry?.location === 'local'
    ? { powerWatts: entry.local?.powerWatts, taskMinutes: entry.local?.taskMinutes ?? profile.estimatedTaskMinutes }
    : null;
  const elec = local ? localElectricityCost(local, price) : null;
  const knownApis = pool.map(e => apiCostPerRun(e, profile)).filter(v => v !== null);
  const knownElecs = pool.filter(e => e.location === 'local')
    .map(e => localElectricityCost({ powerWatts: e.local?.powerWatts, taskMinutes: e.local?.taskMinutes ?? profile.estimatedTaskMinutes }, price))
    .filter(v => v !== null);
  const apiUsed = api ?? (knownApis.length ? Math.min(...knownApis) : 0);
  const elecUsed = elec ?? (entry?.location === 'local' ? (knownElecs.length ? Math.min(...knownElecs) : 0) : 0);
  const speedPenalty = (100 - (entry?.scores?.speed ?? 50)) / 100;
  return {
    total: w.api * apiUsed + w.electricity * elecUsed + (w.speed ?? 0) * speedPenalty,
    api: apiUsed, apiKnown: api !== null,
    electricity: elecUsed, electricityKnown: elec !== null,
    speedPenalty: (w.speed ?? 0) * speedPenalty,
  };
}

/** Back-compat alias (Phase 2 name) — prefer estimatedCostPerRun. */
export const effectiveCost = estimatedCostPerRun;

/** 0-100 quality for a maintenance task role: coding/reasoning/speed/context/toolUse, tier-weighted. */
export function taskQuality(entry, tier = 'mid') {
  const s = scoreModel(entry, tier);
  return { quality: s.score === null ? null : Math.round(s.score * 10) / 10, confidence: s.confidence, unknown: s.unknown };
}

// 'Free' means zero API spend — a local model with cost.free still burns electricity,
// so it is not a free run and competes on estimatedCostPerRun like any other local.
const isFree = e => e?.location !== 'local' && (e?.cost?.free === true || ((e?.cost?.usdPerMInput ?? 1) === 0 && (e?.cost?.usdPerMOutput ?? 1) === 0));
const isUsable = e => USABLE_STATUS.has(e?.status) && e?.toolUse !== 'none';
const availOf = (e, availability) => {
  if (availability?.providers?.has(e.provider)) return availability.models.has(`${e.provider}/${e.model}`) ? 'available' : 'unavailable';
  return e?.availability ?? 'unknown'; // probe absent or provider unseen -> unknown, never "gone"
};

function candidateRecord(entry, tier, policy, pool, availability) {
  const q = taskQuality(entry, policy.qualityTier?.[tier] ?? 'mid');
  const cost = estimatedCostPerRun(entry, policy, pool, tier);
  const availabilityState = availOf(entry, availability);
  const reasons = [];
  if (!isUsable(entry)) reasons.push(`status "${entry.status}" or toolUse "${entry.toolUse}" is not usable`);
  if (availabilityState === 'unavailable') reasons.push('absent from a successful availability listing');
  if (q.quality === null) reasons.push('quality unknown — cannot be scored');
  else if (q.quality < (policy.requiredQuality?.[tier] ?? 0)) reasons.push(`quality ${q.quality} < requiredQuality ${policy.requiredQuality[tier]}`);
  return {
    model: `${entry.provider}/${entry.model}`, provider: entry.provider, entry,
    quality: q.quality, confidence: q.confidence, effectiveCost: Math.round(cost.total * 10000) / 10000,
    costDetail: { estimatedApiCostUsd: cost.apiKnown ? cost.api : null, electricityUsd: cost.electricityKnown ? cost.electricity : null, speedPenalty: cost.speedPenalty },
    location: entry.location === 'local' ? 'local' : 'cloud',
    availability: availabilityState, usable: reasons.length === 0, rejectedReasons: reasons,
  };
}

/**
 * Deterministic selection for one execution tier.
 * Order: eligible free cloud -> cheapest-sufficient cloud -> local fallback (same rule,
 * local entries only). Free never overrides the quality bar; 'unknown' availability is
 * eligible, 'unavailable' (absent from a successful listing) is not. Premium models
 * (catalog `premium: true`) are excluded from monitor/evaluate unless opts.allowPremium.
 * `ordered` is the full fallback chain (free-cloud, then cloud, then local by cost) for
 * the Phase 3 runner.
 */
export function selectTierModel(catalogModels, tier, policy = DEFAULT_POLICY, { availability = null, allowPremium = false } = {}) {
  const pool = (catalogModels ?? []).filter(e => allowPremium || tier === 'reconfigure' || e.premium !== true);
  const records = pool.map(e => candidateRecord(e, tier, policy, pool, availability));
  const eligible = records.filter(r => r.usable);
  const pick = list => list.slice().sort((a, b) => a.effectiveCost - b.effectiveCost || b.quality - a.quality)[0] ?? null;

  const cloud = eligible.filter(r => r.location === 'cloud');
  const local = eligible.filter(r => r.location === 'local');
  const freeCloud = cloud.filter(r => isFree(r.entry));
  const nonFreeCloud = cloud.filter(r => !isFree(r.entry));
  // cheapest-sufficient pool is cloud + local ranked by estimatedCostPerRun — a local
  // model wins it when its electricity estimate beats the cheapest cloud API run
  // (long task profiles make token cost dominate). 'local-fallback' is reported only
  // when NO cloud model is eligible at all.
  const sufficientPool = [...nonFreeCloud, ...local];
  const selected = pick(freeCloud) ?? pick(sufficientPool);
  const ordered = [
    ...freeCloud.slice().sort((a, b) => a.effectiveCost - b.effectiveCost || b.quality - a.quality),
    ...sufficientPool.slice().sort((a, b) => a.effectiveCost - b.effectiveCost || b.quality - a.quality),
  ];
  const path = selected === null ? 'none'
    : freeCloud.includes(selected) ? 'free-cloud'
    : nonFreeCloud.length === 0 ? 'local-fallback'
    : selected.location === 'local' ? 'cheapest-sufficient-local' : 'cheapest-sufficient-cloud';


  const selectionReason = selected === null ? 'no eligible model'
    : path === 'free-cloud' ? `free model meets requiredQuality ${policy.requiredQuality[tier]} (quality ${selected.quality})`
    : path === 'local-fallback' ? `no eligible cloud model; local fallback at $${selected.effectiveCost}/run estimated electricity`
    : `lowest estimated cost $${selected.effectiveCost}/run among eligible ${selected.location} models (quality ${selected.quality} >= ${policy.requiredQuality[tier]})`;

  return {
    tier, selected: selected ? { model: selected.model, provider: selected.provider, location: selected.location, quality: selected.quality, effectiveCostUsd: selected.effectiveCost, costDetail: selected.costDetail } : null,
    ordered: ordered.map(r => ({ model: r.model, provider: r.provider, location: r.location, quality: r.quality, effectiveCostUsd: r.effectiveCost, thinking: r.entry.thinking ?? null })),
    selectionPath: path, selectionReason,
    candidates: records.map(r => ({ model: r.model, location: r.location, quality: r.quality, effectiveCostUsd: r.effectiveCost, availability: r.availability, eligible: r.usable, rejectedReasons: r.rejectedReasons })),
    fallbackOccurred: path === 'local-fallback',
    requiredQuality: policy.requiredQuality?.[tier],
  };
}

/** Monitor output: did anything change, how severe, does evaluate need to run. */
export function buildMonitorOutput({ events = [], catalog, availability = null, availabilitySource = 'not-checked' }) {
  const reasons = [], affectedModels = new Set();
  for (const e of events ?? []) { reasons.push(`${e.type}: ${e.provider}/${e.model}${e.note ? ` — ${e.note}` : ''}`); affectedModels.add(`${e.provider}/${e.model}`); }
  const stale = [], removed = [], expired = [];
  for (const m of catalog?.models ?? []) {
    if (m.campaignExpired) { expired.push(`${m.provider}/${m.model}`); affectedModels.add(`${m.provider}/${m.model}`); }
    if (m.status === 'deprecated') { stale.push(`${m.provider}/${m.model}`); affectedModels.add(`${m.provider}/${m.model}`); }
    if (m.status === 'removed') { removed.push(`${m.provider}/${m.model}`); affectedModels.add(`${m.provider}/${m.model}`); }
  }
  if (expired.length) reasons.push(`free campaign cutoff reached: ${expired.join(', ')}`);
  if (stale.length) reasons.push(`catalog status deprecated: ${stale.join(', ')}`);
  if (removed.length) reasons.push(`catalog status removed: ${removed.join(', ')}`);
  let probeFailed = false;
  if (availability?.providers?.size) {
    const absent = (catalog?.models ?? []).filter(m => availability.providers.has(m.provider) && !availability.models.has(`${m.provider}/${m.model}`));
    if (absent.length) { reasons.push(`absent from availability listing: ${absent.map(m => `${m.provider}/${m.model}`).join(', ')}`); absent.forEach(m => affectedModels.add(`${m.provider}/${m.model}`)); }
  } else if (availabilitySource !== 'not-checked') probeFailed = true; // probe was attempted and failed -> unknown, not "gone"

  const types = new Set((events ?? []).map(e => e.type));
  const severity = removed.length || types.has('removed') ? 'high'
    : stale.length || expired.length || types.has('deprecated') || types.has('free-campaign-ended') ? 'medium'
    : reasons.length ? 'low' : 'none';
  return {
    changed: reasons.length > 0,
    reasons,
    affectedModels: [...affectedModels].sort(),
    severity,
    escalationRequired: severity === 'high', // probe failure alone never escalates
    infoStatus: { availability: availability?.source ?? availabilitySource, probeFailed, catalogEntries: catalog?.models?.length ?? 0 },
  };
}

/** Should evaluate escalate to reconfigure? Returns null or an escalation record. */
export function escalationDecision(maintResult, monitor, policy = DEFAULT_POLICY) {
  const esc = policy.escalation ?? DEFAULT_POLICY.escalation;
  const changes = maintResult.changes ?? [];
  const caps = new Set(), agents = new Set();
  for (const c of changes) {
    (c.affected?.capabilities ?? []).forEach(x => caps.add(x));
    (c.affected?.agents ?? []).forEach(x => agents.add(x));
  }
  const reasons = [];
  if (caps.size >= (esc.minCapabilities ?? 2)) reasons.push(`changes span ${caps.size} capabilities (>= ${esc.minCapabilities})`);
  if (agents.size >= (esc.minAgents ?? 3)) reasons.push(`changes affect ${agents.size} agents (>= ${esc.minAgents})`);
  const swing = Math.max(0, ...changes.map(c => Math.abs((c.scores?.proposed ?? 0) - (c.scores?.current ?? 0))));
  if (swing >= (esc.minQualitySwing ?? 15)) reasons.push(`largest quality swing ${swing.toFixed(1)} points (>= ${esc.minQualitySwing})`);
  const tight = changes.filter(c => c.scores?.delta !== null && c.scores?.delta !== undefined && c.scores.delta < (esc.maxScoreDelta ?? 4));
  if (tight.length) reasons.push(`${tight.length} change(s) decided within ${esc.maxScoreDelta} points — hard call`);
  if (esc.escalateOnLowConfidence && (changes.some(c => c.confidence === 'low') || (maintResult.decisions ?? []).some(d => d.decision === 'insufficient-data'))) {
    reasons.push('low-confidence data or insufficient-data decision present');
  }
  const structural = new Set(esc.structuralEvents ?? []);
  if ((maintResult.infoStatus?.eventsApplied ?? []).some(a => structural.has(a.split(':')[0]))) reasons.push('structural provider event (removed/deprecated) present');
  if (monitor?.severity === 'high') reasons.push('monitor severity is high');
  if (!reasons.length) return null;
  return { escalate: true, reasons, affectedCapabilities: [...caps].sort(), sourceTier: 'evaluate', targetTier: 'reconfigure' };
}

/** Advisory, capability-specific free-model plan. Never changes routing or bindings. */
export function planFreeCapacity({ routing, catalogModels, policy = DEFAULT_POLICY, availability = null }) {
  return Object.entries(routing.capabilities ?? {}).map(([capability, route]) => {
    const requirements = policy.capabilityRequirements?.[capability] ?? null;
    const vision = route.requires?.vision === true;
    const freeCandidates = (catalogModels ?? []).filter(m =>
      requirements && isUsable(m) && isFree(m) && availOf(m, availability) !== 'unavailable' &&
      (!vision || m.vision === true) &&
      Object.entries(requirements).every(([dim, min]) => typeof m.scores?.[dim] === 'number' && m.scores[dim] >= min))
      .sort((a, b) => {
        const tier = routing.backends?.[route.primary]?.tier;
        const qualityDelta = Object.keys(requirements).reduce((sum, dim) => sum + (a.scores[dim] - b.scores[dim]), 0);
        return (tier === 'low' || tier === 'free' ? qualityDelta : -qualityDelta) ||
          (b.scores?.speed ?? 0) - (a.scores?.speed ?? 0);
      })
      .map(m => ({ model: `${m.provider}/${m.model}`, scores: Object.fromEntries(Object.keys(requirements).map(dim => [dim, m.scores[dim]])),
        freeUntil: m.freeUntil ?? null, availability: availOf(m, availability) }));
    return { capability, requirements: { ...requirements, vision }, currentPrimary: route.primary,
      recommendedFree: freeCandidates[0]?.model ?? null, freeCandidates,
      fallbackBackends: [route.primary, ...(route.fallback ?? [])],
      note: !requirements ? 'no quality requirements configured; manual review required'
        : freeCandidates.length ? 'advisory only; verify actual task success and campaign entitlement before rebinding'
        : 'no free model meets the capability bar; retain current route or review paid fallback' };
  });
}

/**
 * Run the Phase 2 maintenance pipeline (decision layer only — no model is invoked).
 *   flow: monitor (selected model) -> if changed, evaluate + evaluateMaintenance() ->
 *         escalation? -> reconfigure tier selection -> proposal.
 * Returns a run report: per-tier selection, monitor output, evaluation result,
 * escalation record, and the Phase 1 proposal when produced. Nothing is applied.
 */
export function runMaintenancePlan({ routing, registry, agents = [], catalog, events = [], availability = null, policy = DEFAULT_POLICY, margin, asOf = new Date().toISOString() } = {}) {
  const effective = effectiveCatalog(catalog, events, asOf);
  const run = { version: 1, kind: 'model-maintenance-run', freeCapacityPlan: planFreeCapacity({ routing, catalogModels: effective, policy, availability }), tiers: [], monitor: null, evaluation: null, escalation: null, proposal: null, estimatedDecisionCostUsd: 0 };

  const monitorSel = selectTierModel(effective, 'monitor', policy, { availability });
  run.tiers.push({ role: 'monitor', ...monitorSel });
  run.estimatedDecisionCostUsd += monitorSel.selected?.effectiveCostUsd ?? 0;
  const monitor = buildMonitorOutput({ events, catalog: { ...catalog, models: effective }, availability, availabilitySource: availability?.source ?? 'not-checked' });
  run.monitor = monitor;
  if (!monitor.changed) { run.outcome = 'no-change'; return run; }

  const evalSel = selectTierModel(effective, 'evaluate', policy, { availability });
  run.tiers.push({ role: 'evaluate', ...evalSel });
  run.estimatedDecisionCostUsd += evalSel.selected?.effectiveCostUsd ?? 0;
  const result = evaluateMaintenance({ routing, registry, agents, catalog, events, availability, margin, asOf });
  run.evaluation = { changes: result.changes.length, decisions: result.decisions.map(d => ({ backend: d.backend, decision: d.decision, reason: d.reason })) };

  const esc = escalationDecision(result, monitor, policy);
  if (esc) {
    const recSel = selectTierModel(effective, 'reconfigure', policy, { availability });
    run.tiers.push({ role: 'reconfigure', ...recSel });
    run.estimatedDecisionCostUsd += recSel.selected?.effectiveCostUsd ?? 0;
    run.escalation = { ...escalationRecord(esc), estimatedDecisionCostUsd: Math.round(run.estimatedDecisionCostUsd * 10000) / 10000 };
  }
  run.proposal = result;
  if (run.escalation) for (const c of run.proposal.changes) c.escalation = run.escalation;
  run.estimatedDecisionCostUsd = Math.round(run.estimatedDecisionCostUsd * 10000) / 10000;
  run.outcome = result.changes.length ? 'proposal' : 'evaluated-no-change';
  return run;
}

function escalationRecord(esc) {
  return { escalationReason: esc.reasons.join('; '), sourceTier: esc.sourceTier, targetTier: esc.targetTier, affectedCapabilities: esc.affectedCapabilities };
}
