import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { DEFAULT_POLICY, mergePolicy } from '../lib/orchestrator/policy.mjs';
import { createAgentRunner } from '../lib/orchestrator/runner.mjs';
import { orchestrate, formatReport } from '../lib/orchestrator/orchestrator.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = structuredClone(loadRouting(join(root, 'routing/routing.json')));
routing.capabilities['cheap-code'].fallback = ['local'];
routing.capabilities['strong-code'].fallback = ['qoder', 'codex', 'local'];
const { agents } = loadAgents(join(root, 'agents'), routing);
const registry = { version: 1, backends: {
  qoder: { provider: 'qoder', model: 'Qwen3.8-Flash' },
  local: { provider: 'freetoken', model: 'FreeToken' },
  devin: { provider: 'devin', model: 'SWE-2' },
  codex: { provider: 'codex', model: 'quota-0' },
} };
const policy = mergePolicy(DEFAULT_POLICY, { limits: { max_retries: 3, model_attempts_per_task: 2, max_total_attempts_per_task: 4 } });
const task = { id: 't1', title: 'fixture', goal: 'complete fixture', agent: 'scout', dependencies: [], acceptance: ['done'] };

test('Codex quota 0 E2E: cheap protocol failures remain excluded on strong-code; three invocations and pipeline continues', async () => {
  const calls = [];
  const health = { skip: c => c.provider === 'codex' ? 'quota-0' : null, report() {} };
  const runner = createAgentRunner({ agents, routing, registry, policy, health,
    invoke: async () => { throw new Error('unexpected oneshot'); },
    runSubagent: async c => {
      calls.push(c.modelId);
      if (c.provider === 'qoder') return { ok: true, text: 'not structured', child: { toolCalls: 2, turns: 3 } };
      if (c.provider === 'freetoken') return { ok: false, error: 'turn limit 12', failureClass: 'NO_PROGRESS_TIMEOUT',
        telemetry: { text: '', toolCalls: 0, turns: 12 }, child: { toolCalls: 0, turns: 12, stopReason: 'no-progress-turn-limit' } };
      if (c.provider === 'devin') return { ok: true, text: '```json\n{"status":"completed","summary":"done","acceptance":[{"id":"A1","met":true,"evidence":"verified"}]}\n```', child: { toolCalls: 1, turns: 2 } };
      throw new Error(`unexpected invocation: ${c.modelId}`);
    },
  });
  const result = await orchestrate({ request: 'fixture', plan: [task], agents, routing, registry, policy, runner, health });
  const t = result.tasks[0];
  assert.equal(result.status, 'completed');
  assert.equal(t.status, 'completed');
  assert.equal(t.totalModelAttempts, 3, JSON.stringify({ calls, trace: result.trace.filter(e => e.type === 'result' || e.type === 'retry' || e.type === 'fallback'), task: t }, null, 2));
  assert.deepEqual(calls.map(id => id.split('/')[0]), ['qoder', 'freetoken', 'devin']);
  assert.ok(t.taskGlobalFailedModels.some(id => id.startsWith('qoder/')));
  assert.ok(t.taskGlobalFailedModels.some(id => id.startsWith('freetoken/')));
  assert.deepEqual(t.capabilityLocalTriedModels, []);
  const strong = result.trace.find(e => e.type === 'result' && e.capability === 'strong-code');
  assert.equal(strong.counters.invocationsStarted, 1);
  assert.equal(strong.counters.candidatesSkipped, 2);
  assert.ok(strong.steps.some(s => s.reason === 'task-global-failed' && s.modelId.startsWith('qoder/')));
  assert.ok(strong.steps.some(s => s.reason === 'task-global-failed' && s.modelId.startsWith('freetoken/')));
  assert.ok(strong.steps.some(s => s.reason === 'quota-0' && s.modelId.startsWith('codex/')) === false, 'health candidate after success is not reached');
  const failedChild = result.trace.find(e => e.type === 'child' && e.modelId.startsWith('freetoken/'));
  assert.equal(failedChild.capability, 'cheap-code');
  assert.equal(failedChild.provider, 'freetoken');
  assert.equal(failedChild.toolCalls, 0);
  assert.equal(failedChild.turns, 12);
  assert.equal(failedChild.failureClass, 'NO_PROGRESS_TIMEOUT');
  assert.equal(typeof failedChild.durationMs, 'number');
  assert.match(formatReport(result), /devin\/SWE-2 on strong-code → completed/);
  assert.match(formatReport(result), /task-global-failed skip/);
});
