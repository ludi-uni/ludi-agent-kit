// Failure-aware retry/escalation: protocol-quality failures advance to the next
// candidate (or escalate capability) instead of burning same-model retries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { DEFAULT_POLICY, mergePolicy } from '../lib/orchestrator/policy.mjs';
import { createAgentRunner } from '../lib/orchestrator/runner.mjs';
import { orchestrate } from '../lib/orchestrator/orchestrator.mjs';
import { isProtocolFailure, classifyRun } from '../lib/orchestrator/failures.mjs';
import { createScriptedInvoker } from '../adapters/pi/lib/invoke.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
// cheap-code chain resolves to cheap -> local -> sol (no qoder/devin in this registry)
const REG = { version: 1, backends: {
  local: { provider: 'pl', model: 'ml', thinking: 'off' },
  cheap: { provider: 'pc', model: 'mc', thinking: 'low' },
  sol:   { provider: 'ps', model: 'ms', thinking: 'high' },
  astra: { provider: 'pa', model: 'ma', thinking: 'medium', vision: true },
  codex: { provider: 'px', model: 'mx', thinking: 'high' },
} };
const policyWith = over => mergePolicy(DEFAULT_POLICY, over ?? {});
const jsonReply = obj => `notes\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
const spec = (id, agent, dependencies = [], extra = {}) => ({ id, title: `task ${id}`, goal: `goal ${id}`, agent, dependencies, acceptance: ['done'], ...extra });
const run = ({ policy, ...o }) => orchestrate({ request: 'r', agents, routing, registry: REG, policy: policyWith(policy), ...o });
const okReply = jsonReply({ status: 'completed', summary: 'done', acceptance: [{ id: 'A1', met: true, evidence: 'e' }] });

function scripted(mapper) {
  const calls = [];
  const invoke = createScriptedInvoker(mapper, calls);
  return { calls, runner: createAgentRunner({ invoke, agents, routing, registry: REG }) };
}

// A: MALFORMED_RESULT advances to the next candidate, not an infinite same-model retry.
test('A: malformed result -> next candidate within the same attempt', async () => {
  const { calls, runner } = scripted({ '*': req => req.modelId.startsWith('pc/') ? 'Done' : okReply });
  const r = await run({ plan: [spec('a', 'scout')], runner });
  assert.equal(r.status, 'completed');
  assert.equal(r.tasks[0].attempts, 1);             // no wasted orchestrator retry
  assert.deepEqual(calls.map(c => c.modelId), ['pc/mc:low', 'pl/ml:off']);
});

// B: turn-limit TIMEOUT with toolCalls=0 -> next candidate.
test('B: turn-limit timeout with no tool progress -> next candidate', async () => {
  assert.equal(isProtocolFailure('TIMEOUT', { child: { toolCalls: 0 } }), true);
  const { calls, runner } = scripted({ '*': req => req.modelId.startsWith('pc/') ? { ok: false, error: 'turn limit 12', failureClass: 'TIMEOUT', child: { toolCalls: 0 } } : okReply });
  const r = await run({ plan: [spec('a', 'scout')], runner });
  assert.equal(r.status, 'completed');
  assert.deepEqual(calls.map(c => c.modelId), ['pc/mc:low', 'pl/ml:off']);
});

// C: empty response -> next candidate.
test('C: empty response -> next candidate', async () => {
  assert.equal(classifyRun({ error: 'empty model response' }), 'EMPTY_RESPONSE');
  const { calls, runner } = scripted({ '*': req => req.modelId.startsWith('pc/') ? { ok: false, error: 'empty model response', failureClass: 'EMPTY_RESPONSE' } : okReply });
  const r = await run({ plan: [spec('a', 'scout')], runner });
  assert.equal(r.status, 'completed');
  assert.deepEqual(calls.map(c => c.modelId), ['pc/mc:low', 'pl/ml:off']);
});

// D: protocol failure on every cheap candidate -> escalate to strong-code.
test('D: cheap candidates exhausted by protocol failures -> escalate to strong-code', async () => {
  // Every candidate fails protocol on the FIRST pass; on escalation to strong-code
  // the codex candidate (px/mx, strong-only) succeeds.
  const { calls, runner } = scripted({ '*': req => req.modelId.startsWith('px/') ? okReply : 'Done' });
  const r = await run({ plan: [spec('a', 'scout')], runner, policy: { limits: { max_retries: 4, model_attempts_per_task: 3, max_total_attempts_per_task: 8 } } });
  assert.equal(r.status, 'completed');
  assert.ok(calls.some(c => c.modelId === 'px/mx:high'), 'reached a strong-code-only candidate');
  assert.ok(r.tasks[0].capability === 'strong-code' || r.autoDecisions.some(d => /escalate to strong-code/.test(d.choice)));
});

// E: recoverable failure (test failure) -> same-model feedback retry allowed.
test('E: recoverable failure keeps the same model retryable', async () => {
  let n = 0;
  const { calls, runner } = scripted({ '*': () => (++n === 1
    ? jsonReply({ status: 'failed', summary: 'tests failed', acceptance: [{ id: 'A1', met: false, evidence: 'x' }] })
    : okReply) });
  const r = await run({ plan: [spec('a', 'scout')], runner });
  assert.equal(r.status, 'completed');
  assert.equal(r.tasks[0].attempts, 2);                       // a real retry happened
  assert.deepEqual(calls.map(c => c.modelId), ['pc/mc:low', 'pc/mc:low']); // same model retried
});

// F: a different candidate is reached before the per-task attempt budget is spent.
test('F: candidate progression happens before maxAttempts is exhausted', async () => {
  const { calls, runner } = scripted({ '*': req => req.modelId.startsWith('pc/') ? 'Done' : okReply });
  const r = await run({ plan: [spec('a', 'scout')], runner });
  assert.equal(r.status, 'completed');
  assert.ok(calls.length >= 2 && calls[0].modelId !== calls[1].modelId, 'tried a different candidate');
});

// G: every candidate fails -> task ultimately fails.
test('G: all candidates fail -> task failed', async () => {
  const { runner } = scripted({ '*': () => 'Done' });
  const r = await run({ plan: [spec('a', 'scout')], runner, policy: { limits: { max_retries: 2, model_attempts_per_task: 3, max_total_attempts_per_task: 4 } } });
  assert.equal(r.tasks[0].status, 'failed');
  assert.equal(r.status, 'incomplete');
});

// H: a timeout WITH real tool progress stays retryable on the same model.
test('H: turn-limit timeout WITH tool progress is recoverable (same-model retry)', async () => {
  assert.equal(isProtocolFailure('TIMEOUT', { child: { toolCalls: 5 } }), false);
});

// Telemetry: protocol outcomes are recorded per provider/model (audit only).
test('telemetry: malformed/empty/turn_limit/structured_ok are counted per model', async () => {
  const recorded = [];
  const session = { recordProtocol: r => recorded.push(`${r.provider}/${r.model}:${r.kind}`) };
  const calls = [];
  const invoke = createScriptedInvoker({ '*': req => req.modelId.startsWith('pc/') ? 'Done' : okReply }, calls);
  const runner = createAgentRunner({ invoke, agents, routing, registry: REG, session });
  const r = await run({ plan: [spec('a', 'scout')], runner });
  assert.equal(r.status, 'completed');
  assert.ok(recorded.includes('pc/mc:malformed'), `malformed recorded: ${recorded}`);
  assert.ok(recorded.includes('pl/ml:structured_ok'), `structured_ok recorded: ${recorded}`);
});
