// Phase 3 — maintenance runner: actually invoke the selected tier models through the
// adapter invoker (pi CLI), with ordered fallback, one schema retry, and a deterministic
// authority boundary. The deterministic engine (lib/maintenance.mjs + maintenance-exec.mjs)
// decides eligible models, requiredQuality, cost, availability and escalation conditions;
// the LLM only interprets and annotates. A model recommendation for a model not in the
// catalog is rejected. This runner writes nothing but the run report assembled by the
// caller — never ~/.pi, settings.json, models*.json or routing.json.
import { selectTierModel, escalationDecision, DEFAULT_POLICY } from './maintenance-exec.mjs';
import { effectiveCatalog } from './maintenance.mjs';

// ---------------------------------------------------------------------------
// Structured output schemas (validated structurally; no external deps)
// ---------------------------------------------------------------------------

export const MONITOR_SCHEMA = {
  name: 'monitor-report', type: 'object',
  required: ['decision', 'confidence', 'reasoningSummary'],
  properties: {
    decision: { enum: ['changed', 'no-change'] },
    confidence: { type: 'number', min: 0, max: 1 },
    reasoningSummary: { type: 'string' },
    affectedModels: { type: 'array', items: 'string' },
    affectedCapabilities: { type: 'array', items: 'string' },
    severity: { enum: ['none', 'low', 'medium', 'high'] },
    evaluateNeeded: { type: 'boolean' },
    recommendedActions: { type: 'array', items: 'string' },
  },
};

export const EVALUATE_SCHEMA = {
  name: 'evaluate-report', type: 'object',
  required: ['decision', 'confidence', 'reasoningSummary'],
  properties: {
    decision: { enum: ['keep', 'propose', 'insufficient-data'] },
    confidence: { type: 'number', min: 0, max: 1 },
    reasoningSummary: { type: 'string' },
    affectedCapabilities: { type: 'array', items: 'string' },
    recommendedActions: { type: 'array', items: 'string' },
    proposalNotes: { type: 'array', items: 'string' },
    recommendedModels: { type: 'array', items: 'string', description: 'provider/model ids — must exist in the catalog' },
  },
};

export const RECONFIGURE_SCHEMA = {
  name: 'reconfigure-report', type: 'object',
  required: ['decision', 'confidence', 'reasoningSummary'],
  properties: {
    decision: { enum: ['keep', 'propose', 'insufficient-data'] },
    confidence: { type: 'number', min: 0, max: 1 },
    reasoningSummary: { type: 'string' },
    affectedCapabilities: { type: 'array', items: 'string' },
    recommendedActions: { type: 'array', items: 'string' },
    proposalNotes: { type: 'array', items: 'string' },
    recommendedModels: { type: 'array', items: 'string' },
    routingNotes: { type: 'array', items: 'string' },
  },
};

export const TIER_SCHEMAS = { monitor: MONITOR_SCHEMA, evaluate: EVALUATE_SCHEMA, reconfigure: RECONFIGURE_SCHEMA };

/** Structural JSON-schema validation. Returns error strings (empty = valid). */
export function validateStructuredOutput(schema, obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return [`${schema.name}: output must be a JSON object`];
  for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${schema.name}: missing required "${key}"`);
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (!(key in obj)) continue;
    const v = obj[key];
    if (prop.type === 'string' && typeof v !== 'string') errors.push(`${schema.name}.${key} must be a string`);
    if (prop.type === 'number' && (typeof v !== 'number' || Number.isNaN(v))) errors.push(`${schema.name}.${key} must be a number`);
    if (prop.type === 'boolean' && typeof v !== 'boolean') errors.push(`${schema.name}.${key} must be a boolean`);
    if (prop.type === 'array' && !Array.isArray(v)) errors.push(`${schema.name}.${key} must be an array`);
    if (prop.type === 'array' && Array.isArray(v) && prop.items === 'string' && v.some(x => typeof x !== 'string')) errors.push(`${schema.name}.${key} items must be strings`);
    if (prop.enum && !prop.enum.includes(v)) errors.push(`${schema.name}.${key} must be one of ${prop.enum.join('|')}`);
    if (prop.type === 'number' && typeof v === 'number') {
      if (prop.min !== undefined && v < prop.min) errors.push(`${schema.name}.${key} < ${prop.min}`);
      if (prop.max !== undefined && v > prop.max) errors.push(`${schema.name}.${key} > ${prop.max}`);
    }
  }
  return errors;
}

/** Extract the first JSON object from model output (tolerates code fences / prose around it). */
export function extractJson(text) {
  const s = String(text ?? '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompts — each tier is asked ONLY for its own responsibility. The deterministic
// facts are supplied; the model interprets, never decides the final config.
// ---------------------------------------------------------------------------

const COMMON = `You are one stage of a deterministic model-maintenance pipeline. The engine has already computed the facts below; your job is to interpret them, not to change configuration. Reply with ONE JSON object only (no prose, no markdown fence) matching the required keys. Never invent provider/model ids that are not in the supplied catalog.`;

export function buildTierPrompt(tier, { monitor, evaluation, catalogKeys, escalation } = {}) {
  const facts = [];
  if (monitor) facts.push(`monitor findings (deterministic): ${JSON.stringify({ changed: monitor.changed, reasons: monitor.reasons, affectedModels: monitor.affectedModels, severity: monitor.severity })}`);
  if (evaluation) facts.push(`evaluation result (deterministic): ${JSON.stringify(evaluation)}`);
  if (catalogKeys) facts.push(`catalog models (only these ids exist): ${catalogKeys.join(', ')}`);
  if (escalation) facts.push(`escalation record: ${JSON.stringify(escalation)}`);

  const schemas = {
    monitor: `{"decision":"changed|no-change","confidence":0-1,"reasoningSummary":"...","affectedModels":["p/m"],"affectedCapabilities":["..."],"severity":"none|low|medium|high","evaluateNeeded":true|false,"recommendedActions":["..."]}`,
    evaluate: `{"decision":"keep|propose|insufficient-data","confidence":0-1,"reasoningSummary":"...","affectedCapabilities":["..."],"recommendedActions":["..."],"proposalNotes":["..."],"recommendedModels":["p/m"]}`,
    reconfigure: `{"decision":"keep|propose|insufficient-data","confidence":0-1,"reasoningSummary":"...","affectedCapabilities":["..."],"recommendedActions":["..."],"proposalNotes":["..."],"recommendedModels":["p/m"],"routingNotes":["..."]}`,
  };
  const duties = {
    monitor: 'Organise the event/catalog/availability diffs. Say whether anything changed, which models/capabilities are affected, the severity, and whether the evaluate stage is needed. Do NOT propose routing changes.',
    evaluate: 'Read the deterministic evaluation. Say whether the kept/proposed bindings are reasonable, give your confidence, and add short proposal notes. Only recommend catalog models.',
    reconfigure: 'Re-review the whole routing picture for this structural/multi-capability change. Output is advisory notes for a proposal only — no config is applied.',
  };
  return `${COMMON}\n\nSTAGE: ${tier}\nTASK: ${duties[tier]}\n\nFACTS:\n${facts.join('\n')}\n\nREQUIRED JSON SHAPE:\n${schemas[tier]}`;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const isQuota = e => /usage limit|insufficient_quota|quota/i.test(String(e ?? ''));

/**
 * Invoke one tier: try the ordered candidate chain until a call succeeds AND returns
 * schema-valid output. One retry on malformed output (same model). Premium candidates
 * are only in the chain when allowPremium (reconfigure conditions) applies.
 * Returns { tier, selected, output|null, attempts[], fallbackOccurred, degradedToDeterministic }.
 */
export async function invokeTier(tier, selection, { invoke, catalogKeys = new Set(), policy = DEFAULT_POLICY, timeoutMs } = {}) {
  const schema = TIER_SCHEMAS[tier];
  const chain = selection?.ordered ?? [];
  const attempts = [];
  let retried = false;
  for (let i = 0; i < chain.length; i++) {
    const cand = chain[i];
    const modelId = `${cand.provider}/${cand.model}${cand.thinking ? `:${cand.thinking}` : ''}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = Date.now();
      const rec = { model: cand.model, modelId, location: cand.location, estimatedCostUsd: cand.effectiveCostUsd, attempt: attempt + 1, retry: attempt > 0 };
      attempts.push(rec);
      let res;
      try { res = await invoke({ modelId, prompt: buildTierPrompt(tier, {}), timeoutMs }); }
      catch (e) { res = { ok: false, error: e.message }; }
      rec.latencyMs = res?.durationMs ?? Date.now() - started;
      if (!res?.ok) {
        rec.ok = false; rec.error = res?.error ?? 'invoke failed';
        rec.failureClass = isQuota(rec.error) ? 'quota' : /timeout|timed out/i.test(rec.error) ? 'timeout' : 'invoke';
        break; // next candidate
      }
      const parsed = extractJson(res.text);
      const errs = parsed ? validateStructuredOutput(schema, parsed) : ['no JSON object in output'];
      rec.ok = true; rec.tokens = res.tokens ?? null; rec.actualCostUsd = res.costUsd ?? null;
      if (!errs.length) {
        rec.schemaValid = true;
        const rejected = (parsed.recommendedModels ?? []).filter(id => !catalogKeys.has(id));
        if (rejected.length) { parsed.recommendedModels = (parsed.recommendedModels ?? []).filter(id => catalogKeys.has(id)); parsed.rejectedRecommendations = rejected; }
        return { tier, selected: cand, output: parsed, attempts, fallbackOccurred: i > 0, degradedToDeterministic: false };
      }
      rec.schemaValid = false; rec.schemaErrors = errs;
      if (retried || attempt === 1) break; // one retry across the run for this tier
      retried = true;
    }
  }
  return { tier, selected: null, output: null, attempts, fallbackOccurred: chain.length > 1, degradedToDeterministic: true };
}

function auditOf(tierResult) {
  return {
    tier: tierResult.tier,
    selectedModel: tierResult.selected?.model ?? null,
    fallbackChain: tierResult.attempts.map(a => `${a.model}${a.retry ? ' (retry)' : ''}:${a.ok ? (a.schemaValid ? 'ok' : 'schema-invalid') : `fail:${a.failureClass}`}`),
    invocations: tierResult.attempts.map(a => ({
      model: a.model, ok: a.ok, retry: a.retry, failureClass: a.failureClass ?? null,
      schemaValid: a.schemaValid ?? null, schemaErrors: a.schemaErrors ?? null,
      latencyMs: a.latencyMs, tokens: a.tokens ?? null, estimatedCostUsd: a.estimatedCostUsd, actualCostUsd: a.actualCostUsd ?? null,
    })),
    fallbackOccurred: tierResult.fallbackOccurred,
    degradedToDeterministic: tierResult.degradedToDeterministic,
  };
}

/**
 * Phase 3 run: monitor -> evaluate -> reconfigure, invoking real models via `invoke`
 * (the pi adapter invoker signature: ({modelId, prompt}) -> {ok, text, durationMs}).
 * Deterministic results stay authoritative; LLM outputs annotate the run report.
 * `plan` is a Phase 2 runMaintenancePlan result (or null to recompute decisions here).
 * `tierAllowed(tier)` (Phase 5 budget gate): when false the tier is not invoked —
 * the audit records skippedByBudget and the run continues deterministically.
 */
export async function runMaintenanceLive({ routing, registry, agents = [], catalog, events = [], availability = null, policy = DEFAULT_POLICY, margin, invoke, plan = null, tierAllowed = () => true } = {}) {
  if (typeof invoke !== 'function') throw new Error('runMaintenanceLive: invoke function is required');
  const effective = effectiveCatalog(catalog, events);
  const catalogKeys = new Set(effective.map(m => `${m.provider}/${m.model}`));
  const run = plan ?? { version: 1, kind: 'model-maintenance-run', tiers: [], monitor: null, evaluation: null, escalation: null, proposal: null, estimatedDecisionCostUsd: 0 };
  run.invocations = [];

  // monitor
  const monitorSel = selectTierModel(effective, 'monitor', policy, { availability });
  const mon = tierAllowed('monitor')
    ? await invokeTier('monitor', monitorSel, { invoke, catalogKeys, policy })
    : { tier: 'monitor', selected: null, output: null, attempts: [], fallbackOccurred: false, degradedToDeterministic: true, skippedByBudget: true };
  run.invocations.push({ ...auditOf(mon), skippedByBudget: mon.skippedByBudget === true });
  const monOut = mon.output;
  if (!run.monitor) {
    const { buildMonitorOutput } = await import('./maintenance-exec.mjs');
    run.monitor = buildMonitorOutput({ events, catalog: { ...catalog, models: effective }, availability, availabilitySource: availability?.source ?? 'not-checked' });
  }
  run.monitor.llm = monOut ? { decision: monOut.decision, confidence: monOut.confidence, severity: monOut.severity, evaluateNeeded: monOut.evaluateNeeded, reasoningSummary: monOut.reasoningSummary } : null;
  // deterministic authority: changed flag comes from the engine, not the LLM
  if (!run.monitor.changed) { run.outcome = 'no-change'; run.tiers.push({ role: 'monitor', ...monitorSel }); return run; }
  run.tiers.push({ role: 'monitor', ...monitorSel });

  // evaluate
  const evalSel = selectTierModel(effective, 'evaluate', policy, { availability });
  const evalRes = tierAllowed('evaluate')
    ? await invokeTier('evaluate', evalSel, { invoke, catalogKeys, policy })
    : { tier: 'evaluate', selected: null, output: null, attempts: [], fallbackOccurred: false, degradedToDeterministic: true, skippedByBudget: true };
  run.invocations.push({ ...auditOf(evalRes), skippedByBudget: evalRes.skippedByBudget === true });
  run.tiers.push({ role: 'evaluate', ...evalSel });
  if (!run.proposal) {
    const { evaluateMaintenance } = await import('./maintenance.mjs');
    run.proposal = evaluateMaintenance({ routing, registry, agents, catalog, events, availability, margin });
    run.evaluation = { changes: run.proposal.changes.length, decisions: run.proposal.decisions.map(d => ({ backend: d.backend, decision: d.decision, reason: d.reason })) };
  }
  const evalOut = evalRes.output;
  if (evalOut) {
    run.proposal.llmReview = { decision: evalOut.decision, confidence: evalOut.confidence, reasoningSummary: evalOut.reasoningSummary, proposalNotes: evalOut.proposalNotes ?? [], rejectedRecommendations: evalOut.rejectedRecommendations };
  }

  // escalation: deterministic conditions OR evaluate confidence below the bar
  let esc = run.escalation?.escalationReason ? run.escalation : null;
  if (!esc) {
    const det = escalationDecision(run.proposal, run.monitor, policy);
    const lowConf = evalOut && typeof evalOut.confidence === 'number' && evalOut.confidence < (policy.escalation?.minEvaluateConfidence ?? 0.5);
    if (det || lowConf) {
      const base = det ?? { reasons: [], affectedCapabilities: evalOut?.affectedCapabilities ?? [] };
      const reasons = [...base.reasons];
      if (lowConf) reasons.push(`evaluate model confidence ${evalOut.confidence} < ${policy.escalation?.minEvaluateConfidence ?? 0.5}`);
      esc = { escalationReason: reasons.join('; '), sourceTier: 'evaluate', targetTier: 'reconfigure', affectedCapabilities: base.affectedCapabilities };
    }
  }
  if (esc) {
    const recSel = selectTierModel(effective, 'reconfigure', policy, { availability });
    const rec = tierAllowed('reconfigure')
      ? await invokeTier('reconfigure', recSel, { invoke, catalogKeys, policy })
      : { tier: 'reconfigure', selected: null, output: null, attempts: [], fallbackOccurred: false, degradedToDeterministic: true, skippedByBudget: true };
    run.invocations.push({ ...auditOf(rec), skippedByBudget: rec.skippedByBudget === true });
    run.tiers.push({ role: 'reconfigure', ...recSel });
    run.escalation = { ...esc, estimatedDecisionCostUsd: null };
    if (rec.output) run.proposal.reconfigureReview = { decision: rec.output.decision, confidence: rec.output.confidence, reasoningSummary: rec.output.reasoningSummary, routingNotes: rec.output.routingNotes ?? [], rejectedRecommendations: rec.output.rejectedRecommendations };
    for (const c of run.proposal.changes ?? []) c.escalation = run.escalation;
  }
  run.outcome = (run.proposal?.changes?.length ?? 0) ? 'proposal' : 'evaluated-no-change';
  return run;
}
