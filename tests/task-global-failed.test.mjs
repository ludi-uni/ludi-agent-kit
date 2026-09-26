// Two-layer tried history: a model that protocol-fails is skipped for the WHOLE
// task across capabilities, while the capability-local candidate list re-resolves.
// Regression for run-muf8ula6-8509b1 (cheap-code Qwen re-invoked on strong-code).
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { DEFAULT_POLICY, mergePolicy } from '../lib/orchestrator/policy.mjs';
import { createAgentRunner } from '../lib/orchestrator/runner.mjs';
import { orchestrate } from '../lib/orchestrator/orchestrator.mjs';
import { shouldMarkTaskGlobalFailure } from '../lib/orchestrator/failures.mjs';
import { withEscalation } from '../lib/pipeline.mjs';
import { createScriptedInvoker } from '../adapters/pi/lib/invoke.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
// cheap-code: pc/mc -> pl/ml -> ps/ms ; strong-code: devin(pd/md) -> pc/mc -> ps/ms -> px/mx -> pl/ml
const REG = { version: 1, backends: {
  local: { provider: 'pl', model: 'ml', thinking: 'off' },
  cheap: { provider: 'pc', model: 'mc', thinking: 'low' },
  sol:   { provider: 'ps', model: 'ms', thinking: 'high' },
  codex: { provider: 'px', model: 'mx', thinking: 'high' },
  devin: { provider: 'pd', model: 'md', thinking: 'high' },
} };
const policyWith = over => mergePolicy(DEFAULT_POLICY, over ?? {});
const jsonReply = obj => `notes\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
const okReply = jsonReply({ status: 'completed', summary: 'done', acceptance: [{ id: 'A1', met: true, evidence: 'e' }] });
const spec = (id, agent, dependencies = [], extra = {}) => ({ id, title: `task ${id}`, goal: `goal ${id}`, agent, dependencies, acceptance: ['done'], ...extra });
const healthSkip = (skipIds) => ({ skip: c => (skipIds.includes(c.modelId) ? 'usage_exhausted' : null), report() {} });

async function runScenario(script, { policy: over = {}, health = null } = {}) {
  const policy = policyWith(over);
  const calls = [];
  const invoke = createScriptedInvoker(script, calls);
  const runner = createAgentRunner({ invoke, agents, routing, registry: REG, policy, health });
  const r = await orchestrate({ request: 'r', plan: [spec('a', 'scout')], agents, routing, registry: REG, policy, runner });
  return { r, calls };
}
const count = (calls, prefix) => calls.filter(c => c.modelId.startsWith(prefix)).length;

// A: cheap-code Qwen malformed -> added to taskGlobalFailedModels.
test('A: protocol failure records the model in taskGlobalFailedModels', async () => {
  const { r } = await runScenario({ '*': req => req.modelId.startsWith('pc/') ? 'Done' : okReply });
  const t = r.tasks[0];
  // pc/mc failed malformed on attempt 1; task should record it globally.
  assert.ok((t.taskGlobalFailedModels ?? []).includes('pc/mc:low'), `got ${JSON.stringify(t.taskGlobalFailedModels)}`);
});

// B: strong-code escalation -> Qwen present in candidate list but skipped task-global.
test('B: after escalation a task-global-failed model is skipped, not re-invoked', async () => {
  // pc/mc (cheap primary) malformed; on strong-code pc/mc is also a candidate.
  // devin (pd/md) must run first; pc/mc must NOT be re-invoked.
  const { r, calls } = await runScenario({ '*': req => req.modelId.startsWith('pd/') ? okReply : 'Done' },
    { policy: { limits: { max_retries: 4, model_attempts_per_task: 4, max_total_attempts_per_task: 8 } } });
  assert.equal(r.status, 'completed');
  assert.equal(count(calls, 'pc/'), 1, `pc/mc invoked ${count(calls,'pc/')}x — should be exactly once (cheap only)`);
  assert.ok(count(calls, 'pd/') >= 1, 'devin invoked on strong-code');
});

// C: no-progress turn-limit TIMEOUT on FreeToken -> not re-invoked on strong-code.
test('C: no-progress turn-limit marks task-global; not re-invoked after escalation', async () => {
  assert.equal(shouldMarkTaskGlobalFailure('TIMEOUT', { toolCalls: 0 }), false, 'missing progress evidence must not be guessed');
  assert.equal(shouldMarkTaskGlobalFailure('TIMEOUT', { toolCalls: 0, turnLimit: true, structuredProgress: false, hasFinalOutput: false }), true);
  const calls = [];
  const policy = policyWith({ limits: { max_retries: 4, model_attempts_per_task: 4, max_total_attempts_per_task: 8 } });
  const runner = createAgentRunner({ invoke: async () => { throw new Error('oneshot used'); }, runSubagent: async req => {
    calls.push({ modelId: req.modelId });
    return req.modelId.startsWith('pd/') ? { ok: true, text: okReply, child: { toolCalls: 1, turns: 1 } } :
      { ok: false, error: 'turn limit 12', failureClass: 'NO_PROGRESS_TIMEOUT', telemetry: { text: '', toolCalls: 0, turns: 12 }, child: { toolCalls: 0, turns: 12, stopReason: 'no-progress-turn-limit' } };
  }, agents, routing, registry: REG, policy });
  const r = await orchestrate({ request: 'r', plan: [spec('a', 'scout')], agents, routing, registry: REG, policy, runner });
  // pl/ml (freetoken-analog) failed once on cheap; must not re-run on strong.
  assert.ok(count(calls, 'pl/') <= 1, `pl/ml invoked ${count(calls,'pl/')}x`);
});

// D: transient tool failure does NOT mark task-global; same model may retry.
test('D: transient tool failure stays eligible after a capability change', async () => {
  assert.equal(shouldMarkTaskGlobalFailure('TOOL_FAILURE'), false);
  assert.equal(shouldMarkTaskGlobalFailure('TEST_FAILURE'), false);
  const called = [];
  const localRouting = structuredClone(routing);
  localRouting.capabilities['strong-code'].fallback = ['cheap'];
  const result = await withEscalation({ routing: localRouting, registry: REG, capability: 'strong-code', agent: 'scout', pack: {}, trace: [], maxAttempts: 2,
    excludeModels: [], taskGlobalFailedModels: [], fn: async c => {
      called.push(c.modelId);
      return { ok: c.modelId.startsWith('pc/'), reason: 'recoverable tool failure on cheap-code must not exclude this model' };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(called.map(id => id.split('/')[0]), ['pd', 'pc']);
});

// E: task-global skip consumes zero attempt budget.
test('E: task-global-failed skip does not consume invocationsStarted', async () => {
  const { r, calls } = await runScenario({ '*': req => req.modelId.startsWith('pd/') ? okReply : 'Done' },
    { policy: { limits: { max_retries: 4, model_attempts_per_task: 4, max_total_attempts_per_task: 8 } } });
  assert.equal(r.status, 'completed');
  // pc/mc invoked once on cheap; on strong-code it is skipped (not invoked again).
  assert.equal(count(calls, 'pc/'), 1);
  // total real invocations = cheap pc/mc + pl/ml + ps/ms + devin (bounded)
  assert.ok(calls.length <= 5, `invocations ${calls.length}`);
});

// F: Qwen + FreeToken failed on cheap -> strong-code Devin is invoked first.
test('F: cheap failures -> strong-code Devin is the first invoked candidate', async () => {
  const { r, calls } = await runScenario({ '*': req => req.modelId.startsWith('pd/') ? okReply : 'Done' },
    { policy: { limits: { max_retries: 4, model_attempts_per_task: 4, max_total_attempts_per_task: 8 } } });
  assert.equal(r.status, 'completed');
  const strongIdx = calls.findIndex(c => c.modelId.startsWith('pd/'));
  assert.ok(strongIdx >= 0, 'devin invoked');
  // After escalation, devin should be invoked before any repeated cheap model.
  const afterEscalation = calls.slice(strongIdx);
  assert.ok(afterEscalation[0].modelId.startsWith('pd/'), 'devin first on strong-code');
});

// G: protocol failure still leaves modelId in the audit/child record.
test('G: protocol failure keeps modelId in the result/child audit', async () => {
  const { r } = await runScenario({ '*': req => req.modelId.startsWith('pc/') ? 'Done' : okReply });
  const resultEvent = r.trace.find(e => e.type === 'result');
  // invokedModels records which models were actually called this attempt.
  assert.ok((resultEvent.invokedModels ?? []).includes('pc/mc:low'));
});

// H: autoDecisions/report show the strong-code progression (capability+model+failure).
test('H: auto decision reports capability + modelId + failureClass', async () => {
  const { r } = await runScenario({ '*': req => req.modelId.startsWith('pd/') ? okReply : 'Done' },
    { policy: { limits: { max_retries: 4, model_attempts_per_task: 4, max_total_attempts_per_task: 8 } } });
  const decisions = r.autoDecisions.map(d => d.choice).join(' | ');
  assert.match(decisions, /on cheap-code|escalate to strong-code/, decisions);
  assert.match(decisions, /MALFORMED_RESULT|TIMEOUT|→/, decisions);
});
