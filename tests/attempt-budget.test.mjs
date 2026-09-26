// Attempt-budget and candidate-progression regressions for run-muf7i8e2-48e3c7.
// Only ACTUAL invocations consume max_total_attempts_per_task — health skips,
// unavailable candidates, already-tried skips and enumeration do not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { DEFAULT_POLICY, mergePolicy } from '../lib/orchestrator/policy.mjs';
import { createAgentRunner } from '../lib/orchestrator/runner.mjs';
import { orchestrate } from '../lib/orchestrator/orchestrator.mjs';
import { createScriptedInvoker } from '../adapters/pi/lib/invoke.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
// cheap-code: cheap(pc/mc) -> local(pl/ml) -> sol(ps/ms); strong-code adds codex(px/mx).
const REG = { version: 1, backends: {
  local: { provider: 'pl', model: 'ml', thinking: 'off' },
  cheap: { provider: 'pc', model: 'mc', thinking: 'low' },
  sol:   { provider: 'ps', model: 'ms', thinking: 'high' },
  codex: { provider: 'px', model: 'mx', thinking: 'high' },
} };
const policyWith = over => mergePolicy(DEFAULT_POLICY, over ?? {});
const jsonReply = obj => `notes\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
const okReply = jsonReply({ status: 'completed', summary: 'done', acceptance: [{ id: 'A1', met: true, evidence: 'e' }] });
const spec = (id, agent, dependencies = [], extra = {}) => ({ id, title: `task ${id}`, goal: `goal ${id}`, agent, dependencies, acceptance: ['done'], ...extra });

// Health monitor stub: skip returns a reason for the listed modelIds (no invocation).
const healthSkip = (skipIds) => ({ skip: c => (skipIds.includes(c.modelId) ? 'usage_exhausted until later' : null), report() {} });

// Run one scout task with a scripted invoker; runner gets the SAME resolved policy
// so the invocations budget is enforced inside withEscalation.
async function runScenario(script, { policy: over = {}, health = null } = {}) {
  const policy = policyWith(over);
  const calls = [];
  const invoke = createScriptedInvoker(script, calls);
  const runner = createAgentRunner({ invoke, agents, routing, registry: REG, policy, health });
  const r = await orchestrate({ request: 'r', plan: [spec('a', 'scout')], agents, routing, registry: REG, policy, runner });
  return { r, calls };
}

// A: protocol failure on Qwen consumes 1 invocation; a health-skipped candidate consumes 0.
test('A: health-skipped candidate does not consume the attempt budget', async () => {
  const { r, calls } = await runScenario({ '*': req => req.modelId.startsWith('pc/') ? 'Done' : okReply }, { health: healthSkip(['pl/ml:off']) });
  assert.equal(r.status, 'completed');
  assert.deepEqual(calls.map(c => c.modelId), ['pc/mc:low', 'ps/ms:high']); // pl/ml skipped, never invoked
  const resultEvent = r.trace.find(e => e.type === 'result');
  assert.equal(resultEvent.counters.candidatesSkipped >= 1, true);
});

// B: after a protocol failure the NEXT untried candidate (FreeToken/local) is invocable.
test('B: protocol failure advances to the next untried candidate', async () => {
  const { r, calls } = await runScenario({ '*': req => req.modelId.startsWith('pc/') ? 'Done' : okReply });
  assert.equal(r.status, 'completed');
  assert.deepEqual(calls.map(c => c.modelId), ['pc/mc:low', 'pl/ml:off']);
});

// C: cheap-code exhausted -> strong-code escalation -> first eligible candidate runs.
test('C: escalation to strong-code re-resolves candidates (codex reachable)', async () => {
  const { r, calls } = await runScenario({ '*': req => req.modelId.startsWith('px/') ? okReply : 'Done' }, { policy: { limits: { max_retries: 4, model_attempts_per_task: 3, max_total_attempts_per_task: 8 } } });
  assert.equal(r.status, 'completed');
  assert.ok(calls.some(c => c.modelId === 'px/mx:high'), 'reached strong-code-only candidate');
});

// D: two health-skipped candidates consume zero budget.
test('D: skipped candidates do not increment invocationsStarted', async () => {
  const { r, calls } = await runScenario({ '*': req => req.modelId.startsWith('ps/') ? okReply : 'Done' }, { health: healthSkip(['pl/ml:off']) });
  assert.equal(r.status, 'completed');
  assert.deepEqual(calls.map(c => c.modelId), ['pc/mc:low', 'ps/ms:high']); // only 2 real invocations
});

// E: budget counts real invocations; the N+1th real invoke is never started.
test('E: max_total_attempts_per_task stops before the N+1th real invocation', async () => {
  const { r, calls } = await runScenario({ '*': () => 'Done' }, { policy: { limits: { max_retries: 6, model_attempts_per_task: 3, max_total_attempts_per_task: 4 } } });
  assert.equal(r.tasks[0].status, 'failed');
  assert.ok(calls.length <= 4, `real invocations ${calls.length} exceeded budget 4`);
});

// F: considered > invoked -> budget display uses invocationsStarted.
test('F: budget reflects invocationsStarted, not candidatesConsidered', async () => {
  const { r } = await runScenario({ '*': req => req.modelId.startsWith('pc/') ? 'Done' : okReply }, { health: healthSkip(['pl/ml:off', 'ps/ms:high']) });
  const resultEvent = r.trace.find(e => e.type === 'result');
  assert.equal(resultEvent.counters.invocationsStarted, 1);
  assert.ok(resultEvent.counters.candidatesConsidered >= resultEvent.counters.invocationsStarted);
});

// G: a model tried on cheap-code may be already-tried on strong-code, but a fresh
//    strong-code-only candidate (codex) is NOT wrongly excluded.
test('G: escalation resets attemptedModels so new-capability candidates run', async () => {
  const { r, calls } = await runScenario({ '*': req => req.modelId.startsWith('px/') ? okReply : 'Done' }, { policy: { limits: { max_retries: 4, model_attempts_per_task: 3, max_total_attempts_per_task: 8 } } });
  assert.equal(r.status, 'completed');
  assert.ok(calls.filter(c => c.modelId === 'px/mx:high').length >= 1, 'codex invoked after escalation');
});

// H: candidate identity is per-modelId — failing one model never marks a different
//    provider's model as tried.
test('H: candidate identity is per modelId, not per provider/backend', async () => {
  const { calls } = await runScenario({ '*': req => req.modelId.startsWith('pc/') ? 'Done' : okReply });
  assert.ok(calls.some(c => c.modelId === 'pl/ml:off'), 'pl/ml invoked despite pc/mc failure');
});
