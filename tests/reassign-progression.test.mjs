// REASSIGN failure (MODEL_FAILURE / BACKEND_LIMIT) candidate semantics: a dead
// candidate is never re-invoked on the same-capability retry; untried candidates
// (e.g. local) are reached; health skips never consume the attempt budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { DEFAULT_POLICY, mergePolicy } from '../lib/orchestrator/policy.mjs';
import { createAgentRunner } from '../lib/orchestrator/runner.mjs';
import { orchestrate } from '../lib/orchestrator/orchestrator.mjs';
import { createHealthMonitor } from '../lib/orchestrator/health.mjs';
import { createScriptedInvoker } from '../adapters/pi/lib/invoke.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
// strong-code chain: devin -> qoder -> sol -> codex -> local
const REG = { version: 1, backends: {
  local: { provider: 'pl', model: 'ml', thinking: 'off' },
  cheap: { provider: 'pc', model: 'mc', thinking: 'low' },
  sol:   { provider: 'ps', model: 'ms', thinking: 'high' },
  codex: { provider: 'px', model: 'mx', thinking: 'high' },
  qoder: { provider: 'pq', model: 'mq', thinking: 'low' },
  devin: { provider: 'pd', model: 'md', thinking: 'high' },
} };
const policyWith = over => mergePolicy(DEFAULT_POLICY, over ?? {});
const jsonReply = obj => `notes\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
const okReply = jsonReply({ status: 'completed', summary: 'done', acceptance: [{ id: 'A1', met: true, evidence: 'e' }] });
const spec = (id, agent, extra = {}) => ({ id, title: `task ${id}`, goal: `goal ${id}`, agent, dependencies: [], acceptance: ['done'], ...extra });
const run = ({ policy, ...o }) => orchestrate({ request: 'r', agents, routing, registry: REG, policy: policyWith(policy), ...o });
// Unclassified backend error: NOT matched by classifyBackendFailure, so health never skips it.
const DEAD = new Error('pi exited 1: upstream returned status 402');
const count = (calls, id) => calls.filter(c => c.modelId === id).length;

function scripted(mapper, { health = null } = {}) {
  const calls = [];
  const invoke = createScriptedInvoker(mapper, calls);
  return { calls, runner: createAgentRunner({ invoke, agents, routing, registry: REG, health, maxModelAttempts: 3 }) };
}

// A: strong-code (ladder end): devin/qoder/sol die with MODEL_FAILURE -> retry does
// not re-invoke any of them; codex (untried) is reached.
test('A: strong-code end of ladder: dead candidates are excluded on retry, untried candidate reached', async () => {
  const { calls, runner } = scripted({ 'pd/md:high': DEAD, 'pq/mq:low': DEAD, 'ps/ms:high': DEAD, '*': okReply });
  const r = await run({ plan: [spec('a', 'coder')], runner, policy: { limits: { max_retries: 2, model_attempts_per_task: 3, max_total_attempts_per_task: 8 } } });
  assert.equal(r.status, 'completed', JSON.stringify(r.tasks[0]));
  assert.deepEqual(calls.map(c => c.modelId), ['pd/md:high', 'pq/mq:low', 'ps/ms:high', 'px/mx:high']);
  assert.equal(count(calls, 'ps/ms:high'), 1, 'the last dead candidate was not re-invoked');
  assert.equal(r.tasks[0].attempts, 2);
  const retry = r.trace.find(e => e.type === 'retry');
  assert.equal(retry.failureClass, 'MODEL_FAILURE');
  assert.ok(r.autoDecisions.some(d => /next untried candidate on strong-code/.test(d.choice)));
});

// B: unclassified quota error on every hosted candidate: the same model is never
// re-run "just because" it was last; the task fails cleanly once nothing is left.
test('B: unclassified quota error is not health-skipped, yet no model runs twice', async () => {
  const { calls, runner } = scripted({ '*': DEAD });
  const r = await run({ plan: [spec('a', 'coder')], runner, policy: { limits: { max_retries: 5, model_attempts_per_task: 3, max_total_attempts_per_task: 20 } } });
  assert.equal(r.tasks[0].status, 'failed');
  const ids = calls.map(c => c.modelId);
  assert.equal(new Set(ids).size, ids.length, `a model was invoked twice: ${ids.join(',')}`);
  assert.deepEqual(ids, ['pd/md:high', 'pq/mq:low', 'ps/ms:high', 'px/mx:high', 'pl/ml:off']);
  assert.match(r.tasks[0].blockedReason, /no untried model candidate left on strong-code/);
  assert.equal(r.tasks[0].attempts, 2, 'no extra rounds spent invoking nothing');
});

// C: local is reached even with the default budget (4) when the first pass consumes 3.
test('C: untried local candidate is reached with the default attempt budget', async () => {
  const { calls, runner } = scripted({ 'pd/md:high': DEAD, 'pq/mq:low': DEAD, 'ps/ms:high': DEAD, 'px/mx:high': DEAD, '*': okReply });
  const r = await run({ plan: [spec('a', 'coder')], runner, policy: { limits: { max_retries: 2, model_attempts_per_task: 4, max_total_attempts_per_task: 5 } } });
  assert.equal(r.status, 'completed', JSON.stringify(r.tasks[0]));
  assert.equal(calls.at(-1).modelId, 'pl/ml:off');
  assert.equal(count(calls, 'px/mx:high'), 1);
});

// D: attempt budget counts real invocations only; health skips are free.
test('D: health-skipped candidates cost no budget; budget counts invocations only', async () => {
  const policy = policyWith({ limits: { max_retries: 2, model_attempts_per_task: 3, max_total_attempts_per_task: 3 } });
  const health = createHealthMonitor({ policy });
  health.bindRun('run-x');
  // devin and qoder are known-exhausted before the run.
  health.report({ provider: 'pd', model: 'md' }, 'usage limit has been reached');
  health.report({ provider: 'pq', model: 'mq' }, 'usage limit has been reached');
  const { calls, runner } = scripted({ 'ps/ms:high': DEAD, 'px/mx:high': DEAD, '*': okReply }, { health });
  const r = await run({ plan: [spec('a', 'coder')], runner, policy: policy });
  assert.equal(r.status, 'completed', JSON.stringify(r.tasks[0]));
  assert.deepEqual(calls.map(c => c.modelId), ['ps/ms:high', 'px/mx:high', 'pl/ml:off']);
  assert.equal(r.tasks[0].totalModelAttempts, 3, 'exactly three real invocations counted');
  const first = r.trace.find(e => e.type === 'result');
  assert.equal(first.counters.candidatesSkipped, 2);
  assert.equal(first.counters.invocationsStarted, 3);
});

// E: recoverable failure (TEST_FAILURE) still keeps the same model retryable (unchanged semantics).
test('E: recoverable failure keeps the last model retryable (feedback retry)', async () => {
  let n = 0;
  const { calls, runner } = scripted({ '*': () => (++n === 1 ? jsonReply({ status: 'failed', summary: 'tests failed', acceptance: [{ id: 'A1', met: false, evidence: '1 failing' }] }) : okReply) });
  const r = await run({ plan: [spec('a', 'coder')], runner });
  assert.equal(r.status, 'completed');
  assert.deepEqual(calls.map(c => c.modelId), ['pd/md:high', 'pd/md:high']);
});
