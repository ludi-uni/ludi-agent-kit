// Persistent orchestration: resume, decisions, memory, backend health, crash recovery, idempotency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { withEscalation } from '../lib/pipeline.mjs';
import { DEFAULT_POLICY, mergePolicy } from '../lib/orchestrator/policy.mjs';
import { openStore } from '../lib/orchestrator/store.mjs';
import { newTask } from '../lib/orchestrator/task-store.mjs';
import { classifyBackendFailure, createHealthMonitor } from '../lib/orchestrator/health.mjs';
import { evaluateDecision } from '../lib/orchestrator/escalation.mjs';
import { orchestrate } from '../lib/orchestrator/orchestrator.mjs';
import { loadOrchestrationContext, startOrchestration } from '../lib/orchestrator/api.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const REG = { version: 1, backends: {
  local: { provider: 'pl', model: 'ml', thinking: 'off' },
  cheap: { provider: 'pc', model: 'mc', thinking: 'low' },
  sol: { provider: 'ps', model: 'ms', thinking: 'high' },
  astra: { provider: 'pa', model: 'ma', thinking: 'medium', vision: true },
  codex: { provider: 'px', model: 'mx', thinking: 'high' },
} };
const policyWith = over => mergePolicy(DEFAULT_POLICY, over ?? {});
const spec = (id, agent, dependencies = []) => ({ id, title: `task ${id}`, goal: `goal ${id}`, agent, dependencies, acceptance: ['done'] });
const completed = (task, extra = {}) => ({ ok: true, structured: true, modelId: 'fake', result: {
  status: 'completed', summary: `did ${task.id}`, artifacts: [], verification: ['checked'],
  acceptance: [{ id: 'A1', met: true, evidence: 'observed' }], remainingIssues: [], decisions: [], newTasks: [], ...extra } });
const blocked = decisions => ({ ok: true, structured: true, result: { status: 'blocked', summary: 'need a choice', artifacts: [], verification: [], acceptance: [], remainingIssues: [], decisions, newTasks: [] } });
const dbPath = () => join(mkdtempSync(join(tmpdir(), 'ludi-orch-')), 'state.db');

test('unbound task capability fails before a run is created with the user binding path', async () => {
  const path = dbPath();
  const session = openStore(path);
  const userPath = join(dirname(path), 'agent', 'ludi-agent-kit', 'models.local.json');
  try {
    await assert.rejects(orchestrate({ request: 'implement', plan: [spec('a', 'coder')], agents, routing,
      registry: { version: 1, backends: { devin: { provider: 'TODO-provider', model: 'TODO-model' } } },
      bindingPath: userPath, policy: DEFAULT_POLICY, session, runner: { async run() { throw new Error('should not run'); } },
    }), error => error.message.includes('strong-code') && error.message.includes(userPath));
    assert.deepEqual(session.listRuns(), []);
    await assert.rejects(orchestrate({ request: 'plan', planner: 'model', agents, routing,
      registry: { version: 1, backends: {} }, bindingPath: userPath, policy: DEFAULT_POLICY, session,
      invoke: async () => { throw new Error('should not plan'); },
    }), /required capability "orchestration"/);
    assert.deepEqual(session.listRuns(), []);
  } finally { session.close(); }
});

test('API start uses the user-level binding path without touching the real agent directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ludi-model-home-'));
  const isolatedKit = mkdtempSync(join(tmpdir(), 'ludi-model-kit-'));
  cpSync(join(kit, 'routing'), join(isolatedKit, 'routing'), { recursive: true, filter: path => !path.endsWith('.local.json') });
  cpSync(join(kit, 'agents'), join(isolatedKit, 'agents'), { recursive: true });
  mkdirSync(join(isolatedKit, 'adapters', 'pi'), { recursive: true });
  mkdirSync(join(isolatedKit, 'orchestration'), { recursive: true });
  copyFileSync(join(kit, 'adapters/pi/models.json'), join(isolatedKit, 'adapters/pi/models.json'));
  copyFileSync(join(kit, 'orchestration/decision-policy.json'), join(isolatedKit, 'orchestration/decision-policy.json'));
  const ctx = loadOrchestrationContext({ kit: isolatedKit, storePath: dbPath(), modelOptions: { env: {}, home } });
  try {
    await assert.rejects(startOrchestration(ctx, { request: 'implement', plan: [spec('a', 'coder')],
      runner: { async run() { throw new Error('should not run'); } } }),
    error => error.message.includes(join(home, '.pi', 'agent', 'ludi-agent-kit', 'models.local.json')));
    assert.deepEqual(ctx.session.listRuns(), []);
  } finally { ctx.session.close(); }
});

test('persistent run creation stores the run, tasks and trace', async () => {
  const session = openStore(dbPath());
  const r = await orchestrate({
    request: 'Fix the failing average() test', plan: [spec('a', 'scout'), spec('b', 'coder', ['a'])],
    agents, routing, registry: REG, policy: DEFAULT_POLICY, session,
    runner: { async run(t) { return completed(t); } },
  });
  assert.equal(r.runStatus, 'completed');
  assert.equal(r.tasks.length, 2);
  assert.equal(session.getRun(r.runId).status, 'completed');
  assert.equal(session.loadTasks(r.runId).length, 2);
  const types = session.loadTrace(r.runId).map(e => e.type);
  for (const kind of ['plan', 'routing', 'round', 'result']) assert.ok(types.includes(kind), kind);
  session.close();
});

test('round limit survives restart and a completed task is not rerun', async () => {
  const path = dbPath();
  const session = openStore(path);
  const calls = [];
  const first = await orchestrate({
    request: 'r', plan: [spec('a', 'scout'), spec('b', 'coder', ['a'])],
    agents, routing, registry: REG, policy: policyWith({ limits: { max_rounds: 1 } }), session,
    runner: { async run(t) { calls.push(t.id); return completed(t); } },
  });
  assert.deepEqual(calls, ['a']);
  assert.equal(first.tasks.find(t => t.id === 'a').status, 'completed');
  session.close();
  const again = openStore(path);
  const calls2 = [];
  const second = await orchestrate({
    request: 'ignored', resumeRunId: first.runId, agents, routing, registry: REG, policy: policyWith({ limits: { max_rounds: 100 } }), session: again,
    runner: { async run(t) { calls2.push(t.id); return completed(t); } },
  });
  assert.deepEqual(calls2, []);
  assert.equal(second.rounds, 1);
  assert.equal(second.tasks.find(t => t.id === 'a').attempts, 1);
  again.close();
});

test('waiting_for_user, answer, resume, and duplicate answer are idempotent', async () => {
  const path = dbPath();
  const session = openStore(path);
  const ask = { key: 'lib', question: 'Library A or B?', options: [{ id: 'a', summary: 'A', risk: 'medium', cost: 'medium' }, { id: 'b', summary: 'B', risk: 'medium', cost: 'medium' }] };
  const first = await orchestrate({
    request: 'choose', plan: [spec('s', 'scout'), spec('a', 'coder', ['s']), spec('b', 'reviewer', ['a'])],
    agents, routing, registry: REG, policy: DEFAULT_POLICY, session,
    runner: { async run(t) { return t.id === 'a' && !(t.decisions ?? []).length ? blocked([ask]) : completed(t); } },
  });
  assert.equal(first.runStatus, 'waiting_for_user');
  assert.equal(first.tasks.find(t => t.id === 's').status, 'completed');
  assert.equal(first.tasks.find(t => t.id === 'a').status, 'waiting_for_user');
  assert.equal(first.tasks.find(t => t.id === 'b').status, 'blocked');
  const decisionId = first.escalations[0].id;
  assert.equal(session.listDecisions(first.runId, 'pending').length, 1);
  session.close();

  const mid = openStore(path);
  const once = mid.answerDecision({ runId: first.runId, decisionId, answer: 'a' });
  const twice = mid.answerDecision({ runId: first.runId, decisionId, answer: 'a' });
  const other = mid.answerDecision({ runId: first.runId, decisionId, answer: 'b' });
  assert.equal(once.idempotent, false);
  assert.equal(twice.idempotent, true);
  assert.equal(twice.same, true);
  assert.equal(other.same, false);
  assert.equal(mid.getDecision(decisionId).status, 'answered');
  assert.equal(mid.loadTasks(first.runId).find(t => t.id === 'a').decisions.length, 1);
  const memory = mid.listMemory();
  assert.equal(memory.length, 1);
  assert.equal(memory[0].scope, 'repository');
  assert.equal(memory[0].decision.optionId, 'a');
  mid.close();

  const next = openStore(path);
  const calls = [];
  const resumed = await orchestrate({
    request: '', resumeRunId: first.runId, agents, routing, registry: REG, policy: DEFAULT_POLICY, session: next,
    runner: { async run(t) { calls.push(t.id); return completed(t); } },
  });
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(calls, ['a', 'b']);
  const callsAgain = [];
  const again = await orchestrate({
    request: '', resumeRunId: first.runId, answers: [{ decisionId, answer: 'a' }], agents, routing, registry: REG, policy: DEFAULT_POLICY, session: next,
    runner: { async run(t) { callsAgain.push(t.id); return completed(t); } },
  });
  assert.equal(again.status, 'completed');
  assert.deepEqual(callsAgain, []);
  next.close();
});

test('natural-language option answers are remembered; ambiguous answers remain pending', async () => {
  const session = openStore(dbPath());
  try {
    const ask = { key: 'approval', question: 'Proceed or abort?', flags: ['destructive_action'], options: [{ id: 'proceed', summary: 'Proceed' }, { id: 'abort', summary: 'Abort' }] };
    const first = await orchestrate({ request: 'r', plan: [spec('a', 'scout')], agents, routing, registry: REG, policy: DEFAULT_POLICY, session,
      runner: { async run() { return blocked([ask]); } } });
    const decisionId = first.escalations[0].id;
    assert.throws(() => session.answerDecision({ runId: first.runId, decisionId, answer: 'maybe later' }), /select an option id/);
    assert.equal(session.getDecision(decisionId).status, 'pending');
    const answered = session.answerDecision({ runId: first.runId, decisionId, answer: 'yes, proceed with care' });
    assert.equal(answered.optionId, 'proceed');
    assert.equal(session.lookupMemory({ key: 'approval', scopeKey: 'default' })[0].decision.optionId, 'proceed');
  } finally { session.close(); }
});

test('decision memory is reused across runs; run-local decisions and hard gates win', async () => {
  const path = dbPath();
  const session = openStore(path);
  const ask = { key: 'approach', question: 'Approach?', options: [{ id: 'a', summary: 'A', risk: 'medium', cost: 'medium' }, { id: 'b', summary: 'B', risk: 'medium', cost: 'medium' }] };
  const first = await orchestrate({
    request: 'one', plan: [spec('a', 'coder')], agents, routing, registry: REG, policy: DEFAULT_POLICY, session,
    runner: { async run(t) { return t.decisions?.length ? completed(t) : blocked([ask]); } },
  });
  session.answerDecision({ runId: first.runId, decisionId: first.escalations[0].id, answer: 'b' });
  await orchestrate({ request: '', resumeRunId: first.runId, agents, routing, registry: REG, policy: DEFAULT_POLICY, session, runner: { async run(t) { return completed(t); } } });
  const calls = [];
  const second = await orchestrate({
    request: 'two', plan: [spec('a', 'coder')], agents, routing, registry: REG, policy: DEFAULT_POLICY, session,
    runner: { async run(t) { calls.push((t.decisions ?? []).map(d => d.choice)); return t.decisions?.length ? completed(t) : blocked([ask]); } },
  });
  assert.equal(second.status, 'completed');
  assert.equal(second.escalations.length, 0);
  assert.ok(second.autoDecisions.some(d => d.step === 'memory' && d.choice.startsWith('b')));
  assert.ok(second.trace.some(e => e.type === 'memory-lookup'));
  assert.equal(calls.at(-1)[0].startsWith('b'), true);

  const reversible = { key: 'tmp', question: 'Which name?', options: [{ id: 'x', summary: 'X', reversible: true }, { id: 'y', summary: 'Y', reversible: true }] };
  await orchestrate({
    request: 'auto', plan: [spec('a', 'coder')], agents, routing, registry: REG, policy: DEFAULT_POLICY, session,
    runner: { async run(t) { return t.decisions?.length ? completed(t) : blocked([reversible]); } },
  });
  assert.equal(session.listMemory().filter(m => m.key === 'tmp').length, 0);

  const local = evaluateDecision(ask, { policy: DEFAULT_POLICY, decisionLog: [{ key: 'approach', action: 'decide', optionId: 'a', step: 'policy' }], memory: [{ key: 'approach', scope: 'global', decision: { optionId: 'b' } }] });
  assert.deepEqual([local.step, local.optionId], ['context', 'a']);
  session.saveMemory({ scope: 'global', key: 'remove', decision: { optionId: 'yes' }, rationale: 'prior run' });
  const hard = evaluateDecision({ key: 'remove', flags: ['destructive_action'], question: 'Remove the old records?', options: [{ id: 'yes' }, { id: 'no' }] }, { policy: DEFAULT_POLICY, memory: session.lookupMemory({ key: 'remove', scopeKey: 'default' }) });
  assert.equal(hard.step, 'hard-gate');
  const gated = await orchestrate({
    request: 'danger', plan: [spec('a', 'coder')], agents, routing, registry: REG, policy: DEFAULT_POLICY, session,
    runner: { async run() { return blocked([{ key: 'remove', flags: ['destructive_action'], question: 'Remove the old records?', options: [{ id: 'yes', summary: 'delete' }, { id: 'no', summary: 'keep' }] }]); } },
  });
  assert.equal(gated.runStatus, 'waiting_for_user');
  session.close();
});

test('backend usage exhaustion is skipped until its TTL, including the next run', async () => {
  const session = openStore(dbPath());
  const now = { at: '2026-09-23T00:00:00.000Z' };
  const health = createHealthMonitor({ session, policy: DEFAULT_POLICY, now: () => now.at });
  health.bindRun('run-a');
  const calls = [];
  const fn = async c => { calls.push(c.modelId); return c.provider === 'pc' ? { ok: false, reason: 'Codex error: The usage limit has been reached' } : { ok: true, reason: 'ok' }; };
  const first = await withEscalation({ routing, registry: REG, capability: 'cheap-code', agent: 'scout', pack: {}, maxAttempts: 3, trace: [], skip: health.skip, onFailure: health.report, fn });
  assert.equal(first.ok, true);
  assert.deepEqual(calls, ['pc/mc:low', 'pl/ml:off']);
  calls.length = 0;
  health.bindRun('run-b');
  await withEscalation({ routing, registry: REG, capability: 'cheap-code', agent: 'scout', pack: {}, maxAttempts: 3, trace: [], skip: health.skip, onFailure: health.report, fn: async c => { calls.push(c.modelId); return { ok: true, reason: 'ok' }; } });
  assert.deepEqual(calls, ['pl/ml:off']);
  now.at = '2026-09-23T07:00:00.000Z';
  calls.length = 0;
  await withEscalation({ routing, registry: REG, capability: 'cheap-code', agent: 'scout', pack: {}, maxAttempts: 1, trace: [], skip: health.skip, onFailure: health.report, fn: async c => { calls.push(c.modelId); return { ok: true, reason: 'ok' }; } });
  assert.deepEqual(calls, ['pc/mc:low']);
  assert.equal(classifyBackendFailure('usage limit has been reached'), 'usage_exhausted');
  assert.equal(classifyBackendFailure('plain bug'), null);
  session.close();
});

test('rate limit is scoped to the run that observed it', async () => {
  const session = openStore(dbPath());
  const health = createHealthMonitor({ session, policy: DEFAULT_POLICY, now: () => '2026-09-23T00:00:00.000Z' });
  health.bindRun('run-a');
  health.report({ provider: 'ps', model: 'ms' }, 'rate limit exceeded');
  assert.match(health.skip({ provider: 'ps', model: 'ms' }), /rate_limited/);
  health.bindRun('run-b');
  assert.equal(health.skip({ provider: 'ps', model: 'ms' }), null);
  session.close();
});

test('stale running task is recovered to pending and keeps its attempt count', async () => {
  const path = dbPath();
  const session = openStore(path);
  const runId = session.createRun({ request: 'r', policy: DEFAULT_POLICY });
  const store = session.openTaskStore(runId);
  store.add(newTask({ id: 't1', title: 't', goal: 'g', capability: 'cheap-code', assignedAgent: 'scout', acceptance: ['done'] }));
  store.update('t1', { status: 'running', attempts: 1 });
  session.close();
  const next = openStore(path);
  assert.equal(next.loadTasks(runId)[0].status, 'running');
  assert.deepEqual(next.recoverStale(runId), ['t1']);
  const task = next.loadTasks(runId)[0];
  assert.equal(task.status, 'pending');
  assert.equal(task.attempts, 1);
  next.close();
});

test('retry count, task limit and trace survive a restart', async () => {
  const path = dbPath();
  const session = openStore(path);
  const exhausted = await orchestrate({
    request: 'r', plan: [spec('a', 'coder')], agents, routing, registry: REG, policy: policyWith({ limits: { max_retries: 1 } }), session,
    runner: { async run() { return { ok: false, error: 'nope' }; } },
  });
  assert.equal(exhausted.tasks[0].status, 'failed');
  assert.equal(exhausted.tasks[0].attempts, 2);
  const traceBefore = session.loadTrace(exhausted.runId).length;
  session.close();
  const reopened = openStore(path);
  const calls = [];
  const after = await orchestrate({
    request: '', resumeRunId: exhausted.runId, agents, routing, registry: REG, policy: DEFAULT_POLICY, session: reopened,
    runner: { async run(t) { calls.push(t.id); return completed(t); } },
  });
  assert.deepEqual(calls, []);
  assert.equal(after.tasks[0].attempts, 2);
  assert.ok(reopened.loadTrace(exhausted.runId).length > traceBefore);
  assert.ok(reopened.loadTrace(exhausted.runId).some(e => e.type === 'resume'));

  const limited = await orchestrate({
    request: 'cap', plan: [spec('a', 'scout')], agents, routing, registry: REG, policy: policyWith({ limits: { max_tasks: 1 } }), session: reopened,
    runner: { async run(t) { return completed(t, { newTasks: [{ title: 'more', goal: 'g', agent: 'scout', acceptance: ['x'] }] }); } },
  });
  assert.ok(limited.limitsHit.includes('max_tasks'));
  assert.equal(limited.tasks.length, 1);
  reopened.close();
  const third = openStore(path);
  const extra = [];
  const resumed = await orchestrate({
    request: '', resumeRunId: limited.runId, agents, routing, registry: REG, policy: policyWith({ limits: { max_tasks: 50 } }), session: third,
    runner: { async run(t) { extra.push(t.id); return completed(t, { newTasks: [{ title: 'more', goal: 'g', agent: 'scout', acceptance: ['x'] }] }); } },
  });
  assert.deepEqual(extra, []);
  assert.equal(resumed.tasks.length, 1);
  assert.ok(resumed.limitsHit.includes('max_tasks'));
  third.close();
});

test('multiple runs stay independent', async () => {
  const session = openStore(dbPath());
  const runner = { async run(t) { return completed(t); } };
  const a = await orchestrate({ request: 'alpha request', plan: [spec('a', 'scout')], agents, routing, registry: REG, policy: DEFAULT_POLICY, session, runner });
  const b = await orchestrate({ request: 'beta request', plan: [spec('a', 'reviewer')], agents, routing, registry: REG, policy: DEFAULT_POLICY, session, runner });
  const rows = session.listRuns();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.status === 'completed' && r.completed === 1 && r.total === 1 && r.pendingDecisions === 0));
  assert.notEqual(a.runId, b.runId);
  const waiting = session.listRuns({ status: 'waiting_for_user' });
  assert.equal(waiting.length, 0);
  session.close();
});

test('a second session cannot resume a live run or reset its running task', async () => {
  const path = dbPath();
  const firstStore = openStore(path);
  const secondStore = openStore(path);
  let enter, finish;
  const entered = new Promise(resolve => { enter = resolve; });
  const hold = new Promise(resolve => { finish = resolve; });
  const running = orchestrate({ request: 'r', plan: [spec('a', 'scout')], agents, routing, registry: REG, policy: DEFAULT_POLICY, session: firstStore,
    runner: { async run(t) { enter(); await hold; return completed(t); } } });
  try {
    await entered;
    const id = secondStore.listRuns()[0].id;
    const before = secondStore.loadTasks(id)[0];
    assert.equal(before.status, 'running');
    await assert.rejects(orchestrate({ request: '', resumeRunId: id, agents, routing, registry: REG, policy: DEFAULT_POLICY, session: secondStore,
      runner: { async run() { throw new Error('duplicate execution'); } } }), /already active/);
    assert.equal(secondStore.loadTasks(id)[0].status, 'running');
    assert.equal(secondStore.loadTasks(id)[0].attempts, before.attempts);
    assert.equal(secondStore.loadTrace(id).some(e => e.type === 'resume'), false);
  } finally {
    finish();
    await running;
    secondStore.close();
    firstStore.close();
  }
});

test('experiment dependency survives an unrelated user escalation', async () => {
  const session = openStore(dbPath());
  const choose = { key: 'choice', question: 'Which approach?', options: [{ id: 'a', summary: 'A', risk: 'medium' }, { id: 'b', summary: 'B', risk: 'medium' }], experiment: { estimatedHours: 1 } };
  const approval = { key: 'approval', question: 'Allow publication?', flags: ['external_publish'], options: [{ id: 'yes', summary: 'Yes' }, { id: 'no', summary: 'No' }] };
  let calls = 0;
  try {
    const first = await orchestrate({ request: 'r', plan: [spec('a', 'scout')], agents, routing, registry: REG, policy: DEFAULT_POLICY, session,
      runner: { async run(t) { if (t.kind === 'experiment') return completed(t, { acceptance: [{ id: 'A1', met: true, evidence: 'observed' }, { id: 'A2', met: true, evidence: 'observed' }] }); calls++; return calls === 1 ? blocked([choose, approval]) : completed(t); } } });
    const experiment = first.tasks.find(t => t.kind === 'experiment');
    assert.ok(experiment);
    assert.equal(first.runStatus, 'waiting_for_user');
    assert.ok(session.loadTasks(first.runId).find(t => t.id === 'a').dependencies.includes(experiment.id));
    session.answerDecision({ runId: first.runId, decisionId: first.escalations[0].id, answer: 'yes' });
    const resumed = await orchestrate({ request: '', resumeRunId: first.runId, agents, routing, registry: REG, policy: DEFAULT_POLICY, session,
      runner: { async run(t) { calls++; return completed(t); } } });
    assert.equal(resumed.tasks.find(t => t.id === 'a').status, 'completed');
    assert.ok(resumed.tasks.find(t => t.id === 'a').dependencies.includes(experiment.id));
  } finally { session.close(); }
});

test('process restart: list, answer, resume, and crash recovery', () => {
  const path = dbPath();
  const child = join(kit, 'tests/fixtures/orch-persist-child.mjs');
  const cli = join(kit, 'scripts/orchestrate.mjs');
  const start = spawnSync(process.execPath, [child, 'start', path], { encoding: 'utf8' });
  assert.equal(start.status, 0, start.stderr);
  const info = JSON.parse(start.stdout);
  assert.equal(info.runStatus, 'waiting_for_user');
  assert.equal(info.tasks.find(t => t.id === 't1').status, 'completed');
  const list = spawnSync(process.execPath, [cli, '--list', '--store', path], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, new RegExp(info.runId));
  assert.match(list.stdout, /waiting_for_user/);
  const decisions = spawnSync(process.execPath, [cli, '--decisions', '--resume', info.runId, '--store', path], { encoding: 'utf8' });
  assert.match(decisions.stdout, new RegExp(info.decisionId));
  const resume = spawnSync(process.execPath, [child, 'resume', path, info.runId, info.decisionId], { encoding: 'utf8' });
  assert.equal(resume.status, 0, resume.stderr + resume.stdout);
  const out = JSON.parse(resume.stdout);
  assert.equal(out.status, 'completed');
  assert.deepEqual(out.calls.map(c => c.id), ['t2', 't3']);

  const crashDb = dbPath();
  const marker = join(dirname(crashDb), 'marker.json');
  const crash = spawnSync(process.execPath, [child, 'crash', crashDb, marker], { encoding: 'utf8' });
  assert.equal(crash.status, 99, crash.stderr);
  const session = openStore(crashDb);
  const runs = session.listRuns({ status: 'running' });
  assert.equal(runs.length, 1);
  const tasks = session.loadTasks(runs[0].id);
  assert.equal(tasks[0].status, 'running');
  assert.equal(tasks[0].attempts, 1);
  session.close();
  const recovered = spawnSync(process.execPath, [child, 'resume', crashDb, runs[0].id, '-'], { encoding: 'utf8' });
  assert.equal(recovered.status, 0, recovered.stderr + recovered.stdout);
  const done = JSON.parse(recovered.stdout);
  assert.equal(done.status, 'completed');
  assert.equal(done.tasks[0].attempts, 2);
  assert.deepEqual(done.calls.map(c => c.id), ['t1']);
});
