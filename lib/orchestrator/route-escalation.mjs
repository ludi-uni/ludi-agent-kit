// Phase 6 route policy. Routes come ONLY from the existing routing ladder and
// adapter registry; unknown cost/capability/availability never grants autonomy.
import { resolveCapability } from '../resolve.mjs';

export const CAPABILITY_RANK = Object.freeze({ basic: 0, standard: 1, strong: 2, expert: 3 });
export const COST_RANK = Object.freeze({ free: 0, included: 0, low: 1, paid: 2, high: 3 });
export const AVAILABILITY = Object.freeze(['available', 'temporarily_unavailable', 'quota_exhausted', 'disabled', 'unknown']);
export const ESCALATION_LIMITS = Object.freeze({ maxEscalationsPerTask: 2, maxEscalationsPerRootTask: 3, maxEscalationsPerRun: 6 });
const transport = new Set(['transient_error', 'environment_limitation', 'external_blocker', 'requirement_ambiguity', 'task_too_large']);
const capabilityFailure = new Set(['agent_capability_mismatch', 'implementation_defect', 'invalid_output', 'no_progress']);

export function routeCatalog({ routing, registry, capability, role, availability = {} } = {}) {
  if (!routing?.capabilities?.[capability]) return [];
  const ladder = Object.values(routing.escalation?.ladders ?? {}).find(steps => steps.includes(capability));
  const capabilities = ladder ? ladder.slice(ladder.indexOf(capability)) : [capability];
  const seen = new Set(), out = [];
  for (const cap of capabilities) for (const candidate of resolveCapability(routing, registry, cap).candidates) {
    const binding = registry.backends[candidate.backend], backend = routing.backends?.[candidate.backend] ?? {};
    const roles = binding.roles ?? backend.roles ?? [];
    if (!Array.isArray(roles) || !roles.includes(role)) continue;
    const capability_class = binding.capability_class ?? backend.capability_class;
    const cost_class = binding.cost_class ?? backend.cost_class;
    const availability_class = availability[candidate.modelId] ?? availability[candidate.backend] ?? binding.availability_class ?? backend.availability_class ?? 'unknown';
    if (!(capability_class in CAPABILITY_RANK) || !(cost_class in COST_RANK) || !AVAILABILITY.includes(availability_class)) continue;
    const key = `${candidate.backend}|${candidate.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ capability: cap, backend: candidate.backend, provider: candidate.provider, model: candidate.model,
      modelId: candidate.modelId, capability_class, cost_class, availability_class, roles: [...roles],
      artifact_types: binding.artifact_types ?? backend.artifact_types ?? null });
  }
  return out;
}

export const routeIdentity = route => route ? `${route.backend}|${route.modelId}` : null;
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Interpret only an explicitly named, bound provider/backend/model; never guess a route from prose. */
export function routeLockFromUserDecisions(decisions = [], routes = [], knownBackends = []) {
  const known = [...routes, ...knownBackends.map(backend => ({ backend }))];
  for (const d of decisions.map(String)) for (const r of known) for (const [field, name] of [['modelId', r.modelId], ['backend', r.backend], ['provider', r.provider]]) {
    if (!name) continue;
    const escaped = escapeRegExp(name);
    if (new RegExp(`(?:\\bonly\\s+(?:the\\s+)?(?:provider\\s+|model\\s+|route\\s+)?${escaped}\\b|\\b${escaped}\\s*(?:だけ|のみ|\\s+only\\b))`, 'i').test(d)
      && (name.length >= 3 || new RegExp(`(?:route|provider|model)\\s+${escaped}\\b|\\b${escaped}\\s*(?:だけ|のみ)`, 'i').test(d)))
      return { [field]: name };
  }
  for (const d of decisions.map(String)) {
    const explicit = /\bonly\s+(?:the\s+)?(provider|model|route)\s+([\w./-]+)/i.exec(d);
    if (explicit) return { [explicit[1] === 'model' ? 'modelId' : explicit[1] === 'provider' ? 'provider' : 'backend']: explicit[2] };
  }
  return {};
}
export const routeDenied = (route, lock = {}, userDecisions = []) => {
  const text = userDecisions.map(String).join(' ').toLowerCase();
  if (lock.modelId && route.modelId !== lock.modelId) return true;
  if (lock.provider && route.provider !== lock.provider) return true;
  if (lock.backend && route.backend !== lock.backend) return true;
  if ((lock.allowedModels?.length && !lock.allowedModels.includes(route.modelId)) || lock.excludedModels?.includes(route.modelId)) return true;
  if (lock.excludedProviders?.includes(route.provider) || lock.excludedBackends?.includes(route.backend)) return true;
  if ((lock.prohibitPaid || /(?:no paid|paid models? prohibited|有料(?:モデル|route|ルート).*(?:禁止|使わない))/.test(text)) && COST_RANK[route.cost_class] > 0) return true;
  if (lock.maxCostClass && COST_RANK[route.cost_class] > COST_RANK[lock.maxCostClass]) return true;
  if (userDecisions.some(d => /(?:do not use|never use|使わない|禁止)/i.test(String(d)) &&
      [route.provider, route.modelId, route.backend].some(v => v && String(d).toLowerCase().includes(v.toLowerCase())))) return true;
  return false;
};

/** Select only an ordered, stronger, role/artifact-compatible route; return approval data instead of invoking a paid candidate. */
export function selectEscalationRoute({ task, currentRoute, routes = [], userDecisions = [], routeLock = task?.routeLock ?? {}, availability = {}, limits = ESCALATION_LIMITS,
  runEscalations = 0, rootEscalations = 0, reason = '', failureHistory = [], progressSnapshot = null } = {}) {
  routeLock = { ...routeLockFromUserDecisions(userDecisions, routes), ...routeLock };
  const base = { sourceTaskId: task?.id, currentRoute, failureHistory: failureHistory.slice(-8), progressSnapshot };
  if (!currentRoute || !(currentRoute.capability_class in CAPABILITY_RANK) || !(currentRoute.cost_class in COST_RANK)) return { action: 'stop', reason: 'unknown current route capability/cost; escalation requires explicit metadata', policyRule: 'escalate.unknown-route', ...base };
  if ((task?.escalationCount ?? 0) >= limits.maxEscalationsPerTask || rootEscalations >= limits.maxEscalationsPerRootTask || runEscalations >= limits.maxEscalationsPerRun) {
    return { action: 'stop', reason: 'ESCALATION_LIMIT_EXCEEDED', policyRule: 'guard.ESCALATION_LIMIT_EXCEEDED', ...base };
  }
  const visited = new Set((task?.routeHistory ?? []).map(routeIdentity));
  const visitedModels = new Set((task?.routeHistory ?? []).map(r => r.modelId));
  const currentRank = CAPABILITY_RANK[currentRoute.capability_class];
  const candidates = routes.filter(r => CAPABILITY_RANK[r.capability_class] > currentRank
    && !visited.has(routeIdentity(r)) && !visitedModels.has(r.modelId) && r.modelId !== currentRoute.modelId
    && (r.roles ?? []).includes(task.assignedAgent)
    && (!r.artifact_types || r.artifact_types.includes(task.artifact_type))
    && !routeDenied(r, routeLock, userDecisions)
    && (availability[r.modelId] ?? availability[r.backend] ?? r.availability_class) === 'available')
    .sort((a, b) => CAPABILITY_RANK[a.capability_class] - CAPABILITY_RANK[b.capability_class]
      || COST_RANK[a.cost_class] - COST_RANK[b.cost_class]
      || a.modelId.localeCompare(b.modelId));
  const affordable = candidates.filter(r => COST_RANK[r.cost_class] === 0 && COST_RANK[currentRoute.cost_class] === 0
    || routeLock.sameContract === true && COST_RANK[r.cost_class] <= COST_RANK[currentRoute.cost_class]);
  const proposedRoute = affordable[0] ?? candidates[0];
  if (!proposedRoute) return { action: 'stop', reason: 'no available, compatible and policy-allowed stronger route', policyRule: 'escalate.no-available-route', ...base };
  const detail = { ...base, proposedRoute, currentCapability: currentRoute.capability_class, proposedCapability: proposedRoute.capability_class,
    costClassChange: { from: currentRoute.cost_class, to: proposedRoute.cost_class } };
  if (!affordable.length) return { action: 'approval_required', reason: `${reason}; stronger route would incur additional cost or cost is not included`,
    policyRule: 'escalate.approval-required', escalation_request: { source_task_id: task.id, current_route: currentRoute, proposed_route: proposedRoute,
      reason, expected_capability_gain: `${currentRoute.capability_class} → ${proposedRoute.capability_class}`,
      cost_class_change: detail.costClassChange, alternatives_exhausted: candidates.filter(r => COST_RANK[r.cost_class] === 0).length === 0 }, ...detail };
  return { action: 'escalate', reason, policyRule: 'escalate.bounded-free-route', ...detail };
}

/** Apply only after cheaper correct actions have been evaluated by the Execution Manager. */
export function decideRouteEscalation({ task, baseDecision, currentRoute, routes, run, progressMetrics, failureHistory = [], routeLock,
  userDecisions = [], availability, limits, runEscalations, rootEscalations } = {}) {
  const classification = baseDecision?.failureClassification?.class;
  if (!task || !currentRoute || !routes?.length || !baseDecision || !capabilityFailure.has(classification) || transport.has(classification)) return { action: 'none' };
  if (['complete', 'continue', 'split', 'reassign', 'extend', 'retry'].includes(baseDecision.action)) return { action: 'none' };
  if (['guard.user_stop', 'guard.destructive_ambiguity', 'guard.environment_limitation'].includes(baseDecision.policyRule) || run?.abort || run?.gate) return { action: 'none' };
  const remaining = task.progressReport?.remaining_work ?? run?.result?.progressReport?.remaining_work ?? [];
  if (remaining.length > 2 || remaining.some(w => w.estimated_complexity === 'large') || task.estimatedComplexity === 'large') return { action: 'none' };
  if (progressMetrics?.progressMade && progressMetrics?.remainingWorkCount) return { action: 'none' };
  const signature = baseDecision.failureClassification?.signature;
  const same = failureHistory.some(h => routeIdentity(h.route) === routeIdentity(currentRoute) && h.signature === signature);
  const failedAcrossRoutes = (task.escalationCount ?? 0) > 0 && failureHistory.some(h => h.signature === signature && routeIdentity(h.route) !== routeIdentity(currentRoute));
  const mismatch = classification === 'agent_capability_mismatch' && !/role-mismatch/.test(baseDecision.policyRule);
  if (!mismatch && !same && !failedAcrossRoutes) {
    const budgetHasHeadroom = !task.budget || task.budget.turns.used < task.budget.turns.current_limit
      && task.budget.tool_calls.used < task.budget.tool_calls.current_limit;
    if (classification === 'implementation_defect' && !failureHistory.length && budgetHasHeadroom && (task.retryCount ?? 0) < 1) {
      return { action: 'retry', reason: 'one bounded same-route implementation retry before capability escalation', policyRule: 'escalate.safe-first-retry',
        retry_policy: { maxRetries: 1, attempt: 1, suppressIfSignature: signature, escalateModel: false } };
    }
    return { action: 'none' };
  }
  return selectEscalationRoute({ task, currentRoute, routes, routeLock, userDecisions, availability, limits, runEscalations, rootEscalations,
    reason: `${classification}: ${same ? 'repeated same-route failure signature' : failedAcrossRoutes ? 'failure persisted after stronger route' : 'confirmed capability mismatch'}`,  failureHistory,
    progressSnapshot: progressMetrics });
}
