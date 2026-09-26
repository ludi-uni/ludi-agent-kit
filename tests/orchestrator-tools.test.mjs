// Tool-capable execution: mode selection, permissions, git baseline, shell gate, failure class, child trace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents, parseFrontmatter } from '../lib/agents.mjs';
import { DEFAULT_POLICY, mergePolicy } from '../lib/orchestrator/policy.mjs';
import { accessOf, piToolsForAccess, resolveExecutionMode, declaredMode } from '../lib/orchestrator/permissions.mjs';
import { decideShell } from '../lib/orchestrator/shell-policy.mjs';
import { captureWorktree, diffWorktree } from '../lib/orchestrator/worktree.mjs';
import { classifyRun } from '../lib/orchestrator/failures.mjs';
import { parseStructuredResult, createAgentRunner, guardWorkspace } from '../lib/orchestrator/runner.mjs';
import { evaluateResult } from '../lib/orchestrator/evaluator.mjs';
import { buildTaskContract } from '../lib/orchestrator/contract.mjs';
import { orchestrate, dryRun } from '../lib/orchestrator/orchestrator.mjs';
import { openStore } from '../lib/orchestrator/store.mjs';
import { inspectPiEvents, runPiSubagent } from '../adapters/pi/lib/subagent.mjs';
import { createScriptedInvoker } from '../adapters/pi/lib/invoke.mjs';

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
const json = obj => `note\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
const done = { status: 'completed', summary: 'checked files', acceptance: [{ id: 'A1', met: true, evidence: 'read src' }] };
const spec = (id, agent, dependencies = [], extra = {}) => ({ id, title: `task ${id}`, goal: `goal ${id}`, agent, dependencies, acceptance: ['done'], ...extra });

test('tool capability is parsed separately from the pi tool-name list', () => {
  const scout = agents.find(a => a.meta.name === 'scout');
  const coder = agents.find(a => a.meta.name === 'coder');
  assert.equal(scout.meta.execution, 'subagent');
  assert.deepEqual(accessOf(scout), { filesystem: 'read', shell: 'limited', git: 'read', network: false });
  assert.deepEqual(piToolsForAccess(accessOf(coder)), ['read', 'grep', 'find', 'ls', 'edit', 'write', 'ludi_exec']);
  assert.ok(!piToolsForAccess(accessOf(scout)).includes('edit'));
  assert.ok(!piToolsForAccess(accessOf(coder)).includes('powershell'));
  const parsed = parseFrontmatter('---\nname: x\ndescription: d\ncapability: cheap-code\nexecution:\n  preferred_mode: oneshot\naccess:\n  filesystem: read-write\n  shell: false\n  git: none\n  network: false\n---\nbody');
  assert.equal(parsed.meta.execution.preferred_mode, 'oneshot');
  assert.equal(parsed.meta.access.filesystem, 'read-write');
});

test('runner selects subagent, falls back to oneshot, and keeps pipeline for --apply', async () => {
  const coder = agents.find(a => a.meta.name === 'coder');
  assert.equal(declaredMode(coder, {}), 'subagent');
  assert.equal(resolveExecutionMode(coder, {}, { hasSubagent: false }), 'oneshot');
  assert.equal(resolveExecutionMode(coder, {}, { hasSubagent: true }), 'subagent');
  assert.equal(resolveExecutionMode(coder, {}, { hasSubagent: true, pipelineAgents: ['coder'] }), 'pipeline');
  let sub = 0;
  const subRunner = createAgentRunner({
    invoke: async () => { throw new Error('oneshot used'); },
    runSubagent: async () => { sub++; return { ok: true, text: json(done), child: { childSessionId: 'c1', toolCalls: 1, turns: 1 } }; },
    agents, routing, registry: REG,
  });
  const subResult = await subRunner.run({ id: 'a', title: 't', goal: 'g', capability: 'cheap-code', assignedAgent: 'scout', acceptance: ['done'], dependencies: [], outputs: [], attemptsLog: [] }, { dependencyResults: [] });
  assert.equal(subResult.executor, 'subagent');
  assert.equal(sub, 1);
  const one = createAgentRunner({ invoke: createScriptedInvoker({ '*': json(done) }), agents, routing, registry: REG });
  const oneResult = await one.run({ id: 'a', title: 't', goal: 'g', capability: 'cheap-code', assignedAgent: 'scout', acceptance: ['done'], dependencies: [], outputs: [] }, { dependencyResults: [] });
  assert.equal(oneResult.executor, 'oneshot');
});

test('structured result accepts needs_decision and tolerates malformed text', () => {
  const blocked = parseStructuredResult(json({ status: 'needs_decision', summary: 'which file', decisions: [{ question: 'which?' }] }));
  assert.equal(blocked.result.status, 'blocked');
  assert.equal(blocked.structured, true);
  const bad = parseStructuredResult('実装しました');
  assert.equal(bad.structured, false);
  assert.equal(bad.failureClass, 'MALFORMED_RESULT');
});

test('git baseline ignores existing dirty files and reports new agent changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-wt-'));
  assert.equal(spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' }).status, 0, 'git init');
  writeFileSync(join(root, 'keep.txt'), 'user\n');
  spawnSync('git', ['add', 'keep.txt'], { cwd: root });
  spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'base'], { cwd: root });
  writeFileSync(join(root, 'keep.txt'), 'user edited\n');
  const before = captureWorktree(root);
  assert.equal(before.source, 'git');
  writeFileSync(join(root, 'agent.txt'), 'new\n');
  const delta = diffWorktree(before, captureWorktree(root));
  assert.deepEqual(delta.map(d => d.path), ['agent.txt']);
  assert.equal(delta[0].kind, 'untracked');
  const outside = guardWorkspace({ path: join(root, '..', 'elsewhere') }, root);
  assert.match(outside, /outside/);
});

test('safe shell is allowed and dangerous shell becomes a user decision', () => {
  assert.equal(decideShell('npm test', { shell: 'limited' }).allow, true);
  assert.equal(decideShell('git diff -- src', { shell: 'limited' }).allow, true);
  assert.equal(decideShell('git push origin main', { shell: 'true' }).allow, false);
  assert.equal(decideShell('npm publish', { shell: 'true' }).allow, false);
  assert.equal(decideShell('rm -rf /', { shell: 'true' }).allow, false);
  const ev = evaluateResult({ id: 'a', kind: 'implement', acceptance: ['done'] }, {
    ok: true, structured: true,
    result: { status: 'completed', summary: 'pushed', acceptance: [{ id: 'A1', met: true, evidence: 'ran' }], commandsRun: ['git push'], remainingIssues: [], newTasks: [] },
  });
  assert.equal(ev.verdict, 'blocked');
  assert.ok(ev.decisions[0].flags.includes('external_publish'));
});

test('subagent decisions stay with the orchestrator and are not a direct user question', async () => {
  const ask = { key: 'name', question: 'Which module name?', options: [{ id: 'a', summary: 'A', reversible: true }, { id: 'b', summary: 'B', reversible: true }] };
  const calls = [];
  const runner = createAgentRunner({
    invoke: async () => { throw new Error('no'); },
    runSubagent: async req => { calls.push(req.prompt); return calls.length === 1 ? { ok: true, text: json({ status: 'blocked', summary: 'need a name', decisions: [ask] }), child: { childSessionId: 'c-ask' } } : { ok: true, text: json(done), child: { childSessionId: 'c-go' } }; },
    agents, routing, registry: REG,
  });
  const result = await orchestrate({ request: 'r', plan: [spec('a', 'coder')], agents, routing, registry: REG, policy: DEFAULT_POLICY, runner });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.escalations, []);
  assert.match(calls[1], /DECISIONS_ALREADY_MADE/);
});

test('backend limit reassigns and the next attempt sees the previous failure', async () => {
  const seen = [];
  const runner = createAgentRunner({
    maxModelAttempts: 1,
    invoke: async () => { throw new Error('no'); },
    runSubagent: async req => {
      seen.push({ capability: req.capability, prompt: req.prompt });
      if (seen.length === 1) return { ok: false, error: 'usage limit has been reached', failureClass: 'BACKEND_LIMIT', child: { childSessionId: 'c-limit' } };
      return { ok: true, text: json(done), child: { childSessionId: 'c2' } };
    },
    agents, routing, registry: REG,
  });
  const result = await orchestrate({
    request: 'r', plan: [spec('a', 'scout')], agents, routing, registry: REG, policy: DEFAULT_POLICY, runner,
  });
  assert.deepEqual(seen.map(s => s.capability), ['cheap-code', 'strong-code']);
  assert.match(seen[1].prompt, /BACKEND_LIMIT/);
  assert.equal(classifyRun({ error: 'usage limit has been reached' }), 'BACKEND_LIMIT');
  assert.equal(result.status, 'completed');
});

test('test failure retries the same capability', async () => {
  const caps = [];
  const runner = {
    async run(task) {
      caps.push(task.capability);
      if (caps.length === 1) return { ok: true, structured: true, failureClass: 'TEST_FAILURE', result: { status: 'failed', summary: 'tests failed', acceptance: [], remainingIssues: [], decisions: [], newTasks: [], commandsRun: [], verification: [{ command: 'npm test', result: 'fail' }] } };
      return { ok: true, structured: true, result: { status: 'completed', summary: 'tests passed', acceptance: [{ id: 'A1', met: true, evidence: 'npm test' }], remainingIssues: [], decisions: [], newTasks: [], commandsRun: ['npm test'], verification: [{ command: 'npm test', result: 'pass' }] } };
    },
  };
  const result = await orchestrate({ request: 'r', plan: [spec('a', 'tester')], agents, routing, registry: REG, policy: DEFAULT_POLICY, runner });
  assert.deepEqual(caps, ['cheap-code', 'cheap-code']);
  assert.equal(result.status, 'completed');
});

test('child session is stored on the trace and a completed task is not run again', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ludi-child-')), 'state.db');
  const session = openStore(path);
  let calls = 0;
  const runner = createAgentRunner({
    invoke: async () => { throw new Error('no'); },
    runSubagent: async () => { calls++; return { ok: true, text: json(done), child: { childSessionId: 'child-abc', toolCalls: 3, turns: 2 } }; },
    agents, routing, registry: REG,
  });
  const first = await orchestrate({ request: 'look', plan: [spec('a', 'scout')], agents, routing, registry: REG, policy: DEFAULT_POLICY, runner, session });
  assert.equal(calls, 1);
  assert.ok(session.loadTrace(first.runId).some(e => e.type === 'child' && e.childSessionId === 'child-abc'));
  session.close();
  const again = openStore(path);
  const second = await orchestrate({ request: '', resumeRunId: first.runId, agents, routing, registry: REG, policy: DEFAULT_POLICY, runner, session: again });
  assert.equal(calls, 1);
  assert.equal(second.status, 'completed');
  again.close();
});

test('timeout and tool-call limits stop the child without treating it as a backend failure', async () => {
  const hanging = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => {};
    proc.stderr.setEncoding = () => {};
    proc.kill = () => {};
    return proc;
  };
  const timed = await runPiSubagent({ modelId: 'pc/mc:low', prompt: 'x', systemPrompt: 's', toolNames: ['read'], limits: { max_runtime_ms: 20 } }, { piEntry: 'pi-entry', spawnImpl: hanging, timeoutMs: 30 });
  assert.equal(timed.failureClass, 'TIMEOUT');
  const events = [{ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: { path: 'a' } }, { type: 'text', text: 'seen' }] } }];
  assert.equal(inspectPiEvents(events).toolCalls, 1);
  assert.equal(inspectPiEvents(events).text, 'seen');
  assert.match(inspectPiEvents([{ type: 'message_end', message: { role: 'assistant', content: [], errorMessage: 'usage limit has been reached', stopReason: 'error' } }]).error, /usage limit/);
});

test('contract names the workspace and forbids publish', () => {
  const text = buildTaskContract({ id: 'a', title: 'Fix', goal: 'fix it', acceptance: ['tests pass'], attemptsLog: [{ attempt: 1, failureClass: 'TEST_FAILURE', reasons: ['red'], filesChanged: ['src/a.js'], verification: [] }] }, { workspace: { path: 'D:/repo', repository: 'D:/repo' }, access: accessOf(agents.find(a => a.meta.name === 'coder')) });
  assert.match(text, /WORKSPACE/);
  assert.match(text, /FORBIDDEN_ACTIONS/);
  assert.match(text, /git push/);
  assert.match(text, /PREVIOUS_ATTEMPTS/);
  assert.match(text, /filesystem: read-write/);
});

test('dry-run describes the subagent and does not launch one', async () => {
  let launched = 0;
  const dry = await dryRun('Fix the failing average() test', { agents, routing, registry: REG, policy: DEFAULT_POLICY, cwd: kit, runSubagent: () => { launched++; } });
  assert.equal(launched, 0);
  assert.equal(dry.tasks.find(t => t.assignedAgent === 'coder').executionMode, 'subagent');
  assert.ok(dry.tasks.find(t => t.assignedAgent === 'coder').tools.includes('ludi_exec'));
  assert.equal(dry.tasks.find(t => t.assignedAgent === 'tester').workspace.path, kit);
});
