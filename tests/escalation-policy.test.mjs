import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITY_RANK, COST_RANK, routeCatalog, routeLockFromUserDecisions, selectEscalationRoute, decideRouteEscalation } from '../lib/orchestrator/route-escalation.mjs';
import { decideExecution, decideExecutionEscalation } from '../lib/orchestrator/execution-manager.mjs';

const backends = {
  a: { capability_class: 'standard', cost_class: 'free', roles: ['coder'], availability_class: 'available' },
  b: { capability_class: 'strong', cost_class: 'free', roles: ['coder'], availability_class: 'available' },
  bi: { capability_class: 'strong', cost_class: 'included', roles: ['coder'], availability_class: 'available' },
  c: { capability_class: 'expert', cost_class: 'paid', roles: ['coder'], availability_class: 'available' },
  low: { capability_class: 'basic', cost_class: 'free', roles: ['coder'], availability_class: 'available' },
  review: { capability_class: 'expert', cost_class: 'free', roles: ['reviewer'], availability_class: 'available' },
  doc: { capability_class: 'expert', cost_class: 'free', roles: ['coder'], artifact_types: ['documentation'], availability_class: 'available' },
};
const routing = { version: 1, backends, capabilities: { 'strong-code': { primary: 'a', fallback: ['b', 'bi', 'c', 'low', 'review', 'doc'] } }, escalation: { ladders: { code: ['strong-code'] } } };
const registry = { version: 1, backends: Object.fromEntries(Object.keys(backends).map(id => [id, { provider: 'fixture', model: id }])) };
const routes = routeCatalog({ routing, registry, capability: 'strong-code', role: 'coder' });
const current = routes[0];
const task = () => ({ id: 't2', assignedAgent: 'coder', artifact_type: 'code_change', routeHistory: [current], escalationCount: 0 });
const select = (override = {}) => selectEscalationRoute({ task: task(), currentRoute: current, routes, reason: 'confirmed capability mismatch', ...override });
const base = (classification, action = 'stop', policyRule = 'stop.no-actionable-path') => ({ action, policyRule,
  failureClassification: { class: classification, signature: classification } });
const decide = (classification, override = {}) => decideRouteEscalation({ task: task(), baseDecision: base(classification), currentRoute: current,
  routes, run: { ok: false }, progressMetrics: { progressMade: false, remainingWorkCount: 0 }, ...override });

test('route capability rank and cost class have explicit comparable order', () => {
  assert.ok(CAPABILITY_RANK.strong > CAPABILITY_RANK.standard);
  assert.ok(CAPABILITY_RANK.expert > CAPABILITY_RANK.strong);
  assert.equal(COST_RANK.free, COST_RANK.included);
  assert.ok(COST_RANK.paid > COST_RANK.free);
  assert.equal(routes.find(r => r.backend === 'c').cost_class, 'paid');
});

test('stronger free and stronger included are autonomously allowed, never jump directly to expert', () => {
  assert.equal(select().action, 'escalate');
  assert.equal(select().proposedRoute.backend, 'b');
  const included = select({ currentRoute: { ...current, cost_class: 'included' }, routes: routes.filter(r => r.backend !== 'b') });
  assert.equal(included.action, 'escalate');
  assert.equal(included.proposedRoute.backend, 'bi');
});

test('free -> paid requires approval with complete structured request', () => {
  const outcome = select({ routes: routes.filter(r => ['a', 'c'].includes(r.backend)) });
  assert.equal(outcome.action, 'approval_required');
  assert.equal(outcome.escalation_request.source_task_id, 't2');
  assert.equal(outcome.escalation_request.current_route.modelId, 'fixture/a');
  assert.equal(outcome.escalation_request.proposed_route.modelId, 'fixture/c');
  assert.equal(outcome.escalation_request.alternatives_exhausted, true);
  assert.deepEqual(outcome.costClassChange, { from: 'free', to: 'paid' });
});

test('task/root/run caps, visited routes, unavailable and quota-exhausted routes are excluded', () => {
  for (const input of [{ task: { ...task(), escalationCount: 2 } }, { rootEscalations: 3 }, { runEscalations: 6 }])
    assert.match(select(input).reason, /ESCALATION_LIMIT_EXCEEDED/);
  assert.equal(select({ task: { ...task(), routeHistory: [current, routes[1]] } }).proposedRoute.backend, 'bi');
  assert.equal(select({ availability: { b: 'quota_exhausted' } }).proposedRoute.backend, 'bi');
  assert.equal(select({ availability: { b: 'temporarily_unavailable', bi: 'disabled' } }).action, 'approval_required');
  assert.equal(select({ availability: { b: 'quota_exhausted', bi: 'disabled', c: 'unknown' } }).action, 'stop');
  assert.equal(select({ routes: routes.filter(r => ['a', 'low'].includes(r.backend)) }).action, 'stop');
});

test('user locks, paid prohibition and artifact/role restrictions are hard filters', () => {
  assert.deepEqual(routeLockFromUserDecisions(['fixture/b だけ'], routes), { modelId: 'fixture/b' });
  assert.equal(select({ userDecisions: ['only route b'] }).action, 'escalate');
  assert.equal(select({ userDecisions: ['only route a'] }).action, 'stop');
  assert.equal(select({ routeLock: { backend: 'a' } }).action, 'stop');
  assert.equal(select({ routeLock: { excludedProviders: ['fixture'] } }).action, 'stop');
  assert.equal(select({ routeLock: { prohibitPaid: true }, routes: routes.filter(r => ['a', 'c'].includes(r.backend)) }).action, 'stop');
  assert.equal(select({ userDecisions: ['No paid models'], routes: routes.filter(r => ['a', 'c'].includes(r.backend)) }).action, 'stop');
  assert.equal(select({ routes: routes.filter(r => ['a', 'review', 'doc'].includes(r.backend)) }).action, 'stop');
});

test('Execution Manager emits structured escalate from an eligible route candidate', () => {
  const d = decideExecutionEscalation(base('agent_capability_mismatch'), { task: task(), currentRoute: current, routes,
    run: { ok: false }, progressMetrics: { progressMade: false, remainingWorkCount: 0 } });
  assert.equal(d.action, 'escalate');
  assert.equal(d.source_task_id, 't2');
  assert.equal(d.policyRule, 'escalate.bounded-free-route');
});

test('strategy A/E repeated capability failure or confirmed mismatch escalates; bounded same-route retry precedes it', () => {
  assert.equal(decide('agent_capability_mismatch').action, 'escalate');
  const first = decide('implementation_defect');
  assert.equal(first.action, 'retry');
  const previous = [{ route: current, signature: 'implementation_defect' }];
  assert.equal(decide('implementation_defect', { failureHistory: previous, task: { ...task(), retryCount: 1 } }).action, 'escalate');
});

test('strategy B/C/D: size, environment and transient transport never trigger model escalation', () => {
  assert.equal(decide('task_too_large').action, 'none');
  assert.equal(decide('environment_limitation').action, 'none');
  assert.equal(decide('transient_error').action, 'none');
  assert.equal(decide('implementation_defect', { baseDecision: base('implementation_defect', 'split') }).action, 'none');
  assert.equal(decide('implementation_defect', { baseDecision: base('implementation_defect', 'retry') }).action, 'none');
});

test('strategy F/G: paid-only approval; unavailable stronger route never invoked', () => {
  assert.equal(decide('agent_capability_mismatch', { routes: [current, routes.find(r => r.backend === 'c')] }).action, 'approval_required');
  assert.equal(decide('agent_capability_mismatch', { availability: { b: 'quota_exhausted', bi: 'disabled', c: 'disabled' } }).action, 'stop');
});

test('near-complete progress uses continuation/extension before escalation', () => {
  for (const action of ['continue', 'extend', 'split', 'reassign', 'complete']) assert.equal(decide('implementation_defect', {
    baseDecision: base('implementation_defect', action) }).action, 'none');
  assert.equal(decide('implementation_defect', { progressMetrics: { progressMade: true, remainingWorkCount: 1 } }).action, 'none');
});

test('execution manager still gives transient retry, partial continuation, and environment stop priority', () => {
  const t = task();
  const socket = decideExecution({ task: t, run: { ok: false, error: 'UND_ERR_SOCKET' }, terminationReason: 'process_error' });
  assert.equal(socket.action, 'retry');
  assert.equal(decide('transient_error', { baseDecision: socket }).action, 'none');
  const env = decideExecution({ task: t, run: { ok: false, error: 'shell allowlist restricted' }, terminationReason: 'environment_block' });
  assert.equal(env.action, 'stop');
  assert.equal(decide('environment_limitation', { baseDecision: env }).action, 'none');
});
