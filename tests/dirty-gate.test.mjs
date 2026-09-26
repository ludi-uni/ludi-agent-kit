// Dirty-worktree gate state machine: user answers are honoured, agent-owned changes
// are not "dirty", non-git workspaces are never gated, read-only work continues.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { DEFAULT_POLICY, mergePolicy } from '../lib/orchestrator/policy.mjs';
import { createAgentRunner, evaluateDirtyGate, DIRTY_GATE_TYPE } from '../lib/orchestrator/runner.mjs';
import { captureWorktree } from '../lib/orchestrator/worktree.mjs';
import { orchestrate } from '../lib/orchestrator/orchestrator.mjs';
import { openStore } from '../lib/orchestrator/store.mjs';

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
const json = obj => `note\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
const okResult = extra => json({ status: 'completed', summary: 'done', acceptance: [{ id: 'A1', met: true, evidence: 'ran' }, { id: 'A2', met: true, evidence: 'ran' }], ...extra });
const spec = (id, agent, dependencies = [], extra = {}) => ({ id, title: `task ${id}`, goal: `goal ${id}`, agent, dependencies, acceptance: ['done'], ...extra });
const dbPath = () => join(mkdtempSync(join(tmpdir(), 'ludi-gate-')), 'state.db');

function gitRepo({ dirty = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ludi-gate-repo-'));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' }).status, 0, 'git init');
  writeFileSync(join(root, 'base.txt'), 'base\n');
  spawnSync('git', ['add', '.'], { cwd: root });
  spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'], { cwd: root });
  for (const f of dirty) writeFileSync(join(root, f), 'user edit\n');
  return root;
}

/** Subagent stub: writes `writes` files into cwd (simulating agent edits) then replies. */
function subagentStub({ writes = [], reply = okResult() } = {}) {
  const calls = [];
  const runSubagent = async req => {
    calls.push({ taskId: req.taskId, modelId: req.modelId });
    for (const f of writes) writeFileSync(join(req.cwd, f), `agent ${calls.length}\n`);
    const r = typeof reply === 'function' ? reply(req, calls.length) : reply;
    return typeof r === 'string' ? { ok: true, text: r, child: { childSessionId: `c${calls.length}`, toolCalls: 3 } } : r;
  };
  return { calls, runSubagent };
}

const runOrch = ({ repoRoot, runner, plan, session = null, policy, ...o }) => orchestrate({
  request: 'implement it', plan, agents, routing, registry: REG, policy: policyWith(policy), runner, repoRoot, session, ...o,
});

// ---------- unit: evaluateDirtyGate ----------
test('unit: gate classifies clean / owned-only / unrelated / non-git / answered', () => {
  const git = paths => ({ source: 'git', entries: Object.fromEntries(paths.map(p => [p, { code: ' M', hash: 'x' }])) });
  assert.equal(evaluateDirtyGate({ before: git([]) }).gate, false);
  assert.equal(evaluateDirtyGate({ before: git(['a.txt']), ownedPaths: ['a.txt'] }).gate, false);
  const ask = evaluateDirtyGate({ before: git(['a.txt', 'b.txt']), ownedPaths: ['a.txt'] });
  assert.equal(ask.action, 'ask');
  assert.deepEqual(ask.paths, ['b.txt']);
  assert.match(ask.key, new RegExp(`^${DIRTY_GATE_TYPE}:`));
  assert.equal(ask.decision.decisionType, DIRTY_GATE_TYPE);
  // Same condition, answered by id/type (not by parsing the question).
  assert.equal(evaluateDirtyGate({ before: git(['a.txt', 'b.txt']), ownedPaths: ['a.txt'], decisions: [{ key: ask.key, optionId: 'proceed' }] }).action, 'proceed');
  assert.equal(evaluateDirtyGate({ before: git(['a.txt', 'b.txt']), ownedPaths: ['a.txt'], decisions: [{ key: ask.key, optionId: 'abort' }] }).action, 'abort');
  // A different dirty set is a different question.
  assert.equal(evaluateDirtyGate({ before: git(['c.txt']), decisions: [{ key: ask.key, optionId: 'proceed' }] }).action, 'ask');
  // Non-git inventory is never dirty.
  assert.equal(evaluateDirtyGate({ before: { source: 'files', entries: { 'x.js': 'h', 'y.js': 'h' } } }).gate, false);
  assert.equal(evaluateDirtyGate({ before: { available: false, entries: {} } }).gate, false);
});

// ---------- A: dirty -> decision -> proceed -> resume -> no re-ask ----------
test('A: dirty -> decision -> proceed -> resume -> implementation runs once, no second question', async () => {
  const repo = gitRepo({ dirty: ['user.txt'] });
  const path = dbPath();
  const session = openStore(path);
  const { calls, runSubagent } = subagentStub({ writes: ['agent.txt'] });
  const runner = createAgentRunner({ invoke: async () => ({ ok: false, error: 'no' }), runSubagent, agents, routing, registry: REG, repoRoot: repo });
  const first = await runOrch({ repoRoot: repo, runner, plan: [spec('t1', 'coder', [], { kind: 'implement' })], session });
  assert.equal(first.runStatus, 'waiting_for_user');
  assert.equal(first.escalations.length, 1);
  assert.match(first.escalations[0].question, /pre-existing uncommitted/);
  assert.equal(calls.length, 0, 'no subagent launched before the decision');
  assert.ok(first.trace.some(e => e.type === 'gate' && e.action === 'ask'));
  const decisionId = first.escalations[0].id;
  session.close();

  const again = openStore(path);
  const resumed = await runOrch({ repoRoot: repo, runner, plan: null, session: again, resumeRunId: first.runId, answers: [{ decisionId, answer: 'proceed' }] });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed.tasks.map(t => [t.id, t.status, t.blockedReason])));
  assert.equal(resumed.escalations.length, 0, 'no second question');
  assert.equal(calls.length, 1, 'implementation ran exactly once');
  assert.equal(again.listDecisions(first.runId, 'pending').length, 0);
  const t = again.loadTasks(first.runId)[0];
  assert.equal(t.decisions[0].optionId, 'proceed');
  assert.ok(t.ownedPaths.includes('agent.txt'));
  assert.ok(resumed.trace.some(e => e.type === 'gate' && e.action === 'proceed'));
  again.close();
});

// ---------- B: dirty -> abort -> terminal, no re-ask ----------
test('B: dirty -> abort -> task is blocked terminally and never re-asked', async () => {
  const repo = gitRepo({ dirty: ['user.txt'] });
  const path = dbPath();
  const session = openStore(path);
  const { calls, runSubagent } = subagentStub();
  const runner = createAgentRunner({ invoke: async () => ({ ok: false, error: 'no' }), runSubagent, agents, routing, registry: REG, repoRoot: repo });
  const first = await runOrch({ repoRoot: repo, runner, plan: [spec('t1', 'coder', [], { kind: 'implement' }), spec('t2', 'tester', ['t1'], { kind: 'verify' })], session });
  const decisionId = first.escalations[0].id;
  session.close();
  const again = openStore(path);
  const resumed = await runOrch({ repoRoot: repo, runner, plan: null, session: again, resumeRunId: first.runId, answers: [{ decisionId, answer: 'abort' }] });
  assert.equal(resumed.escalations.length, 0);
  assert.equal(calls.length, 0, 'nothing implemented');
  const t1 = resumed.tasks.find(t => t.id === 't1');
  assert.equal(t1.status, 'blocked');
  assert.match(t1.blockedReason, /aborted by user decision/);
  assert.equal(t1.attempts, 2, 'the abort attempt did not retry');
  assert.equal(resumed.tasks.find(t => t.id === 't2').status, 'blocked');
  assert.equal(resumed.runStatus, 'failed');
  assert.ok(resumed.trace.some(e => e.type === 'task-blocked'));
  // Resuming again does not revive the question.
  const third = await runOrch({ repoRoot: repo, runner, plan: null, session: again, resumeRunId: first.runId });
  assert.equal(third.escalations.length, 0);
  assert.equal(calls.length, 0);
  again.close();
});

// ---------- C: coder changed -> TEST_FAILURE -> retry: own changes are not dirty ----------
test('C: coder edits, fails tests, retries: its own changes do not trigger the gate', async () => {
  const repo = gitRepo();
  const { calls, runSubagent } = subagentStub({ writes: ['src.js'], reply: (_req, n) => (n === 1
    ? json({ status: 'failed', summary: 'tests failed: 1 failing', acceptance: [{ id: 'A1', met: false, evidence: 'npm test: 1 failing' }], verification: [{ command: 'npm test', result: 'fail' }] })
    : okResult()) });
  const runner = createAgentRunner({ invoke: async () => ({ ok: false, error: 'no' }), runSubagent, agents, routing, registry: REG, repoRoot: repo });
  const r = await runOrch({ repoRoot: repo, runner, plan: [spec('t1', 'coder', [], { kind: 'implement' })] });
  assert.equal(r.status, 'completed', JSON.stringify(r.tasks[0]));
  assert.equal(calls.length, 2);
  assert.equal(r.escalations.length, 0, 'retry on own dirty tree asked nothing');
  assert.equal(r.tasks[0].attempts, 2);
  assert.deepEqual(r.tasks[0].ownedPaths, ['src.js']);
  assert.ok(!r.trace.some(e => e.type === 'gate'));
});

// ---------- D: reviewer finding -> rework: original implement changes are owned ----------
test('D: review finds blocking issue -> rework task runs without the gate on the first implementation\'s changes', async () => {
  const repo = gitRepo();
  const { calls, runSubagent } = subagentStub({ writes: ['impl.js'], reply: req => {
    if (req.taskId === 'rev') return json({ status: 'completed', summary: 'reviewed', acceptance: [{ id: 'A1', met: true, evidence: 'read diff' }], remainingIssues: [{ summary: 'missing null check', blocking: true }] });
    if (req.taskId === 't3') return okResult(); // re-review: clean
    return okResult();
  } });
  // Use the subagent path for reviewer too by making every agent run through the same stub.
  const runner = createAgentRunner({ invoke: async () => ({ ok: false, error: 'no' }), runSubagent, agents, routing, registry: REG, repoRoot: repo });
  const r = await runOrch({ repoRoot: repo, runner, plan: [spec('t1', 'coder', [], { kind: 'implement' }), spec('rev', 'reviewer', ['t1'], { kind: 'review' })], policy: { limits: { max_rework_cycles: 1 } } });
  assert.equal(r.status, 'completed', JSON.stringify(r.tasks.map(t => [t.id, t.kind, t.status, t.blockedReason])));
  assert.equal(r.escalations.length, 0, 'rework asked nothing about the tree the first implement dirtied');
  const rework = r.tasks.find(t => t.kind === 'implement' && t.id !== 't1');
  assert.ok(rework, 'a rework task was added');
  assert.equal(rework.status, 'completed');
  assert.ok(calls.some(c => c.taskId === rework.id));
  assert.ok(!r.trace.some(e => e.type === 'gate'));
});

// ---------- E: pre-existing unrelated changes -> gate before implementation ----------
test('E: pre-existing unrelated dirty files gate implementation (session-less run -> blocked)', async () => {
  const repo = gitRepo({ dirty: ['unrelated.txt'] });
  const { calls, runSubagent } = subagentStub();
  const runner = createAgentRunner({ invoke: async () => ({ ok: false, error: 'no' }), runSubagent, agents, routing, registry: REG, repoRoot: repo });
  const r = await runOrch({ repoRoot: repo, runner, plan: [spec('t1', 'coder', [], { kind: 'implement' })] });
  assert.equal(calls.length, 0);
  assert.equal(r.status, 'needs-user');
  assert.equal(r.tasks[0].status, 'blocked');
  assert.match(r.escalations[0].question, /unrelated\.txt/);
  assert.deepEqual(r.escalations[0].options.map(o => o.id), ['proceed', 'abort']);
});

// ---------- F: read-only investigate on a dirty tree continues ----------
test('F: read-only investigation on a dirty tree is not gated', async () => {
  const repo = gitRepo({ dirty: ['user.txt'] });
  const { calls, runSubagent } = subagentStub();
  const runner = createAgentRunner({ invoke: async () => ({ ok: false, error: 'no' }), runSubagent, agents, routing, registry: REG, repoRoot: repo });
  const r = await runOrch({ repoRoot: repo, runner, plan: [spec('s', 'scout', [], { kind: 'investigate', executionMode: 'subagent' }), spec('rv', 'reviewer', ['s'], { kind: 'review' })] });
  assert.equal(r.status, 'completed', JSON.stringify(r.tasks.map(t => [t.id, t.status, t.blockedReason])));
  assert.equal(calls.length, 2);
  assert.equal(r.escalations.length, 0);
});

// ---------- G: non-git workspace is never gated by inventory count ----------
test('G: non-git workspace: file inventory count is not a dirty count', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ludi-gate-nogit-'));
  for (let i = 0; i < 12; i++) writeFileSync(join(repo, `f${i}.txt`), 'x\n');
  const before = captureWorktree(repo);
  assert.equal(before.source, 'files');
  assert.ok(Object.keys(before.entries).length >= 12);
  const { calls, runSubagent } = subagentStub({ writes: ['out.js'] });
  const runner = createAgentRunner({ invoke: async () => ({ ok: false, error: 'no' }), runSubagent, agents, routing, registry: REG, repoRoot: repo });
  const r = await runOrch({ repoRoot: repo, runner, plan: [spec('t1', 'coder', [], { kind: 'implement' })] });
  assert.equal(r.status, 'completed', JSON.stringify(r.tasks[0]));
  assert.equal(calls.length, 1);
  assert.equal(r.escalations.length, 0);
  assert.ok(!r.trace.some(e => e.type === 'gate'));
});
