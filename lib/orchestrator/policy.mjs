// Decision policy + orchestration limits. Defaults here are overlaid by orchestration/decision-policy.json
// and an optional decision-policy.local.json, so behavior is configuration, not code.
import { readFileSync, existsSync } from 'node:fs';

export const ESCALATION_FLAGS = [
  'external_publish', 'destructive_action', 'production_risk', 'high_cost',
  'project_cancellation', 'major_direction_change', 'user_value_judgement',
];
const AUTO_MODES = new Set(['auto', 'escalate']);

export const DEFAULT_POLICY = {
  version: 1,
  decision_policy: {
    prefer_maintainability: true,
    prefer_existing_assets: true,
    prefer_reversible_actions: true,
    max_parallel_tasks: 3,
    poc: { prefer_if_estimated_hours_lte: 2 },
    escalation: Object.fromEntries(ESCALATION_FLAGS.map(f => [f, true])),
    escalation_keywords: {},
    high_cost_threshold_usd: 50,
    major_direction_change_weeks: 2,
    default_behavior: { reversible_decision: 'auto', low_risk_decision: 'auto' },
    reassign_on_failure: true,
  },
  limits: {
    max_tasks: 12, max_retries: 2, max_rounds: 12, max_rework_cycles: 1,
    // Attempt budget. model_attempts_per_task caps candidates tried per task
    // attempt (candidate progression within an attempt). max_total_attempts_per_task
    // caps total model calls across retries so a protocol-failing model cannot
    // consume the whole budget before a different candidate is reached.
    model_attempts_per_task: 3, max_total_attempts_per_task: 4,
  },
  backend_health: { usage_exhausted_ttl_hours: 6, rate_limited_ttl_minutes: 15, unavailable_ttl_minutes: 10 },
  verification: { require_tester: true, require_reviewer: true },
  agent_runtime: {
    max_runtime_ms: 600000, max_tool_calls: 40, max_turns: 12,
    // Per-role / per-complexity turn budgets. A task's initial turn budget is
    // turn_budgets[<role>][<complexity>] falling back to turn_budgets[<role>].normal
    // then max_turns. Bounded progress extension: when a subagent reaches its
    // initial budget but is still making meaningful progress, it may be granted up
    // to extension_turns more turns, at most max_extensions times, never exceeding
    // absolute_max_turns. No unbounded growth.
    turn_budgets: {
      default:    { simple: 12, normal: 16, heavy: 20, 'repo-history-heavy': 24 },
      scout:      { simple: 12, normal: 16, heavy: 20, 'repo-history-heavy': 24 },
      coder:      { simple: 16, normal: 20, heavy: 24, 'repo-history-heavy': 24 },
      tester:     { simple: 12, normal: 16, heavy: 20, 'repo-history-heavy': 20 },
      reviewer:   { simple: 12, normal: 16, heavy: 20, 'repo-history-heavy': 20 },
    },
    extension_turns: 8, max_extensions: 2, absolute_max_turns: 32,
  },
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

export function mergePolicy(base, override) {
  if (!isObj(override)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(override)) out[k] = isObj(v) && isObj(out[k]) ? mergePolicy(out[k], v) : structuredClone(v);
  return out;
}

export function validatePolicy(p) {
  const errors = [];
  const err = m => errors.push(`policy: ${m}`);
  if (!isObj(p)) return ['policy: root must be an object'];
  if (p.version !== 1) err('version must be 1');
  const d = p.decision_policy, l = p.limits;
  if (!isObj(d)) err('decision_policy must be an object');
  else {
    for (const k of ['prefer_maintainability', 'prefer_existing_assets', 'prefer_reversible_actions', 'reassign_on_failure']) if (typeof d[k] !== 'boolean') err(`decision_policy.${k} must be boolean`);
    if (!Number.isInteger(d.max_parallel_tasks) || d.max_parallel_tasks < 1) err('decision_policy.max_parallel_tasks must be an integer >= 1');
    if (typeof d.poc?.prefer_if_estimated_hours_lte !== 'number') err('decision_policy.poc.prefer_if_estimated_hours_lte must be a number');
    for (const [k, v] of Object.entries(d.escalation ?? {})) {
      if (!ESCALATION_FLAGS.includes(k)) err(`decision_policy.escalation has unknown flag "${k}"`);
      if (typeof v !== 'boolean') err(`decision_policy.escalation.${k} must be boolean`);
    }
    for (const [k, v] of Object.entries(d.escalation_keywords ?? {})) {
      if (!ESCALATION_FLAGS.includes(k)) err(`decision_policy.escalation_keywords has unknown flag "${k}"`);
      if (!Array.isArray(v) || v.some(s => typeof s !== 'string')) err(`decision_policy.escalation_keywords.${k} must be a string array`);
    }
    for (const k of ['reversible_decision', 'low_risk_decision']) if (!AUTO_MODES.has(d.default_behavior?.[k])) err(`decision_policy.default_behavior.${k} must be auto|escalate`);
  }
  if (!isObj(l)) err('limits must be an object');
  else for (const k of ['max_tasks', 'max_retries', 'max_rounds', 'max_rework_cycles', 'model_attempts_per_task', 'max_total_attempts_per_task']) {
    const min = k === 'max_retries' || k === 'max_rework_cycles' ? 0 : 1;
    if (l[k] !== undefined && (!Number.isInteger(l[k]) || l[k] < min)) err(`limits.${k} must be an integer >= ${min}`);
  }
  const h = p.backend_health;
  if (h !== undefined) {
    if (!isObj(h)) err('backend_health must be an object');
    else {
      if (typeof h.usage_exhausted_ttl_hours !== 'number' || h.usage_exhausted_ttl_hours <= 0) err('backend_health.usage_exhausted_ttl_hours must be a number > 0');
      for (const k of ['rate_limited_ttl_minutes', 'unavailable_ttl_minutes']) if (typeof h[k] !== 'number' || h[k] <= 0) err(`backend_health.${k} must be a number > 0`);
    }
  }
  if (p.verification !== undefined) {
    if (!isObj(p.verification)) err('verification must be an object');
    else for (const k of ['require_tester', 'require_reviewer']) if (p.verification[k] !== undefined && typeof p.verification[k] !== 'boolean') err(`verification.${k} must be boolean`);
  }
  if (p.agent_runtime !== undefined) {
    const ar = p.agent_runtime;
    if (!isObj(ar)) err('agent_runtime must be an object');
    else {
      for (const k of ['max_runtime_ms', 'max_tool_calls', 'max_turns']) if (!Number.isInteger(ar[k]) || ar[k] < 1) err(`agent_runtime.${k} must be an integer >= 1`);
      for (const k of ['extension_turns', 'max_extensions', 'absolute_max_turns']) if (ar[k] !== undefined && (!Number.isInteger(ar[k]) || ar[k] < 0)) err(`agent_runtime.${k} must be an integer >= 0`);
      if (ar.absolute_max_turns !== undefined && ar.absolute_max_turns < ar.max_turns) err('agent_runtime.absolute_max_turns must be >= max_turns');
      if (ar.turn_budgets !== undefined) {
        if (!isObj(ar.turn_budgets)) err('agent_runtime.turn_budgets must be an object');
        else for (const [role, tiers] of Object.entries(ar.turn_budgets)) {
          if (!isObj(tiers)) err(`agent_runtime.turn_budgets.${role} must be an object`);
          else for (const [tier, v] of Object.entries(tiers)) if (!Number.isInteger(v) || v < 1) err(`agent_runtime.turn_budgets.${role}.${tier} must be an integer >= 1`);
        }
      }
    }
  }
  return errors;
}

/** DEFAULT_POLICY <- policyPath <- localPath (each optional). Throws on invalid result. */
export function loadPolicy(policyPath, localPath = null) {
  let p = DEFAULT_POLICY;
  const sources = [];
  for (const path of [policyPath, localPath]) {
    if (!path || !existsSync(path)) continue;
    const { $comment, ...rest } = JSON.parse(readFileSync(path, 'utf8'));
    p = mergePolicy(p, rest);
    sources.push(path);
  }
  const errors = validatePolicy(p);
  if (errors.length) throw new Error(errors.join('\n'));
  return { policy: p, sources };
}
