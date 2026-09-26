// Escalation gate: resolve a sub-agent's decision request without the user whenever policy allows.
// Order: hard gate -> current-run decision -> persistent decision memory -> single option ->
//        reversible -> low risk -> project policy -> small experiment -> escalate to user.
// Hard gate is always first, so a remembered answer never authorizes an irreversible action.
import { ESCALATION_FLAGS } from './policy.mjs';

const LEVEL = { none: 0, low: 0, medium: 1, high: 2 };
const level = v => LEVEL[v] ?? 1;

export const decisionKey = d => String(d.key ?? d.question ?? '').trim().toLowerCase();

/** Flags that force user escalation: declared by the agent, derived from numbers, or matched by policy keywords. */
export function escalationFlags(decision, policy) {
  const dp = policy.decision_policy;
  const found = new Set((decision.flags ?? []).filter(f => ESCALATION_FLAGS.includes(f)));
  for (const o of decision.options ?? []) {
    for (const f of o.flags ?? []) if (ESCALATION_FLAGS.includes(f)) found.add(f);
    if (typeof o.costUsd === 'number' && o.costUsd >= dp.high_cost_threshold_usd) found.add('high_cost');
    if (typeof o.estimatedWeeks === 'number' && o.estimatedWeeks >= dp.major_direction_change_weeks) found.add('major_direction_change');
  }
  const text = [decision.question, ...(decision.options ?? []).map(o => o.summary)].join('\n').toLowerCase();
  for (const [flag, words] of Object.entries(dp.escalation_keywords ?? {})) if (words.some(w => text.includes(w.toLowerCase()))) found.add(flag);
  return [...found].filter(f => dp.escalation[f] !== false);
}

function policyScore(o, dp) {
  let s = 0;
  if (dp.prefer_existing_assets && o.usesExistingAssets === true) s += 1;
  if (dp.prefer_maintainability && o.maintainability) s += { high: 1, medium: 0, low: -1 }[o.maintainability] ?? 0;
  if (dp.prefer_reversible_actions && o.reversible === true) s += 1;
  return s;
}

function best(options, score) {
  let top = null, topScore = -Infinity, tie = false;
  for (const o of options) {
    const s = score(o);
    if (s > topScore) { top = o; topScore = s; tie = false; } else if (s === topScore) tie = true;
  }
  return { option: top, tie };
}

/**
 * @returns {{ action: 'decide'|'experiment'|'escalate', step: string, optionId?: string, reason: string, flags: string[], experiment?: object }}
 */
export function evaluateDecision(decision, { policy, decisionLog = [], memory = [] }) {
  const dp = policy.decision_policy;
  const options = Array.isArray(decision.options) ? decision.options.filter(o => o && o.id) : [];
  const key = decisionKey(decision);
  const flags = escalationFlags(decision, policy);
  const out = (action, step, reason, extra = {}) => ({ action, step, reason, flags, key, question: decision.question, ...extra });

  if (flags.length) return out('escalate', 'hard-gate', `requires user: ${flags.join(', ')}`);

  const prior = decisionLog.find(e => e.key === key && e.action === 'decide');
  if (prior && options.some(o => o.id === prior.optionId)) return out('decide', 'context', `already decided earlier in this run (${prior.step})`, { optionId: prior.optionId });
  const remembered = memory.find(m => m.key === key && options.some(o => o.id === m.decision?.optionId));
  if (remembered) return out('decide', 'memory', `persistent decision memory (${remembered.scope})`, { optionId: remembered.decision.optionId, memoryId: remembered.id, scope: remembered.scope });
  if (options.length === 1) return out('decide', 'context', 'only one viable option', { optionId: options[0].id });
  if (!options.length) return out('escalate', 'no-options', 'decision request has no options to choose from');

  const full = o => (o.id === decision.recommended ? 2 : 0) + policyScore(o, dp) - level(o.risk) - level(o.cost);
  const reversible = decision.reversible === true || options.every(o => o.reversible === true);
  if (reversible && dp.default_behavior.reversible_decision === 'auto') {
    return out('decide', 'reversible', 'reversible decision; chose the best-scoring option', { optionId: best(options, full).option.id });
  }
  const lowRisk = options.filter(o => o.risk === 'low' && level(o.cost ?? 'low') === 0);
  if (lowRisk.length && dp.default_behavior.low_risk_decision === 'auto') {
    return out('decide', 'low-risk', 'low cost and low risk option available', { optionId: best(lowRisk, full).option.id });
  }
  const byPolicy = best(options, o => policyScore(o, dp));
  if (!byPolicy.tie && policyScore(byPolicy.option, dp) > 0) {
    return out('decide', 'policy', 'project policy (existing assets / maintainability / reversibility) prefers one option', { optionId: byPolicy.option.id });
  }
  const limit = dp.poc.prefer_if_estimated_hours_lte;
  const triedExperiment = decisionLog.some(e => e.key === key && e.action === 'experiment');
  const hours = decision.experiment?.estimatedHours ?? Math.max(...options.map(o => o.estimatedHours ?? Infinity));
  if (!triedExperiment && Number.isFinite(hours) && hours <= limit) {
    return out('experiment', 'experiment', `a small experiment (~${hours}h <= ${limit}h) can settle it`, {
      experiment: { goal: decision.experiment?.goal ?? `Compare options for "${decision.question}": ${options.map(o => `${o.id} (${o.summary ?? ''})`).join('; ')}. Recommend one with evidence.`, agent: decision.experiment?.agent, estimatedHours: hours },
    });
  }
  return out('escalate', 'unresolved', triedExperiment ? 'experiment already ran and the choice is still open' : 'not reversible, not low risk, and policy does not discriminate');
}
