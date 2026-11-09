import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRunner } from '../lib/orchestrator/runner.mjs';

const routing = { version: 1, backends: { first: {}, second: {} }, capabilities: {
  code: { primary: 'first', fallback: ['second'] },
} };
const reply = '```json\n' + JSON.stringify({ status: 'completed', summary: 'done',
  acceptance: [{ id: 'A1', met: true, evidence: 'fixture' }] }) + '\n```';

async function run({ mode = 'subagent', role = 'scout', roles = ['tester'], secondRoles,
  executionRoute, health } = {}) {
  const calls = [];
  const registry = { version: 1, backends: {
    first: { provider: 'p', model: 'first', ...(roles === null ? {} : { roles }) },
    second: { provider: 'p', model: 'second', ...(secondRoles ? { roles: secondRoles } : {}) },
  } };
  const agents = [{ meta: { name: role, capability: 'code', execution: mode,
    access: { filesystem: 'read', shell: 'none', git: 'read', network: false } }, body: 'Read-only fixture.' }];
  const invoke = async req => { calls.push(req.modelId); return { ok: true, text: reply }; };
  const runner = createAgentRunner({ agents, routing, registry, invoke,
    ...(mode === 'subagent' ? { runSubagent: invoke } : {}), maxModelAttempts: 1, health });
  const result = await runner.run({ id: 't1', title: 'fixture', goal: 'fixture',
    capability: 'code', assignedAgent: role, acceptance: ['done'], dependencies: [], executionRoute });
  return { calls, result };
}

for (const mode of ['subagent', 'oneshot']) {
  test(`${mode}: excluded worker role is skipped before invocation without spending budget`, async () => {
    const { calls, result } = await run({ mode });
    assert.deepEqual(calls, ['p/second']);
    assert.equal(result.ok, true);
    assert.ok(result.steps.some(s => s.skipped && s.reason === 'role-not-allowed'));
    assert.equal(result.counters.invocationsStarted, 1);
  });
}

test('another allowed worker retains the original primary', async () => {
  const { calls, result } = await run({ role: 'tester' });
  assert.deepEqual(calls, ['p/first']);
  assert.equal(result.ok, true);
});

test('absent explicit role metadata preserves legacy selection', async () => {
  const { calls, result } = await run({ roles: null });
  assert.deepEqual(calls, ['p/first']);
  assert.equal(result.ok, true);
});

test('all candidates denied starts no invocation', async () => {
  const { calls, result } = await run({ secondRoles: ['tester'] });
  assert.deepEqual(calls, []);
  assert.equal(result.ok, false);
});

test('pinned route cannot bypass explicit role restrictions or retarget', async () => {
  const { calls, result } = await run({ executionRoute: { backend: 'first', modelId: 'p/first' } });
  assert.deepEqual(calls, []);
  assert.equal(result.ok, false);
});

test('health gate still rejects a role-permitted candidate', async () => {
  const { calls, result } = await run({ health: { skip: () => 'fixture-unavailable', report() {} } });
  assert.deepEqual(calls, []);
  assert.equal(result.ok, false);
  assert.ok(result.steps.some(s => s.skipped && s.reason === 'fixture-unavailable'));
});
