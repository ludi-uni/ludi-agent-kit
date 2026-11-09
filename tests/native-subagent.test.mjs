// Native launcher tests: fake event bus + fake runtime-agent owner only.
// No providers, no pi process, no user writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeSubagentRunner, createHostSubagentRunner, renderGuardModule, RUNTIME_AGENT_REGISTER_EVENT, DELEGATION_REQUEST_EVENT, DELEGATION_STARTED_EVENT, DELEGATION_UPDATE_EVENT, DELEGATION_RESPONSE_EVENT, DELEGATION_CANCEL_EVENT } from '../adapters/pi/lib/native-subagent.mjs';
import { createNativeGuard, GUARD_TOOL } from '../adapters/pi/lib/native-guard.mjs';
import { runCommand } from '../adapters/pi/shell-gate/run-command.mjs';
import { createAgentRunner } from '../lib/orchestrator/runner.mjs';
import { acquireWorkspaceLease } from '../lib/orchestrator/workspace-lease.mjs';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
// Two real candidates on the strong-code chain -> proves no fallback.
const REG = { version: 1, backends: {
  devin: { provider: 'pd', model: 'md' },
  qoder: { provider: 'pq', model: 'mq' },
  sol: { provider: 'ps', model: 'ms' },
  codex: { provider: 'px', model: 'mx' },
  local: { provider: 'pl', model: 'ml' },
  cheap: { provider: 'pc', model: 'mc' },
} };
const DONE = `\`\`\`json\n${JSON.stringify({ status: 'completed', summary: 'done', acceptance: [{ id: 'A1', met: true, evidence: 'x' }] })}\n\`\`\``;

// Fake pi: one real EventEmitter; emit/on delegate to the emitter's own
// prototype methods (the previous version recursed into itself forever).
function fakePi({ registerResult, autoQuiescence = true } = {}) {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const pi = { events, emitted: [], registrations: [] };
  pi.events.emit = (name, payload) => {
    if (name === DELEGATION_RESPONSE_EVENT && autoQuiescence) {
      const request = sentRequests(pi).find(r => r.requestId === payload?.requestId && r.ownerRunId === payload.ownerRunId && r.nodeId === payload.nodeId);
      if (request) {
        try { writeFileSync(guardConfig(pi, request).sidecarPath, JSON.stringify({ version: 1, shutdown: true, pendingTools: 0, reason: null })); }
        catch { /* an already settled duplicate has no guard directory */ }
      }
    }
    pi.emitted.push({ name, payload });
    return EventEmitter.prototype.emit.call(events, name, payload);
  };
  pi.events.on = (name, fn) => { EventEmitter.prototype.on.call(events, name, fn); return () => events.off(name, fn); };
  if (registerResult !== null) {
    pi.events.on(RUNTIME_AGENT_REGISTER_EVENT, req => {
      pi.registrations.push(req);
      req.result = typeof registerResult === 'function' ? registerResult(req)
        : registerResult ?? { ok: true, registration: { dispose() { this.disposed = true; } } };
    });
  }
  pi.events.on(DELEGATION_REQUEST_EVENT, request => pi.events.emit(DELEGATION_STARTED_EVENT, {
    requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId,
  }));
  return pi;
}
function guardConfig(pi, request) {
  const registration = pi.registrations.find(r => r.name === request.agent);
  const source = readFileSync(registration.definition.subagentOnlyExtensions[0], 'utf8');
  return JSON.parse(source.match(/const CONFIG = (.+);/)[1]).guard;
}
const reqBase = (over = {}) => ({ modelId: 'provider/model:high', systemPrompt: 'sys', prompt: 'task prompt', cwd: tmpdir(), protectWorkspace: () => {}, toolNames: ['read', 'ludi_exec'], access: { filesystem: 'read-write', shell: 'limited', git: 'read', network: false }, limits: { max_runtime_ms: 60000, max_tool_calls: 7, max_turns: 4 }, taskId: 't1', runId: 'r1', agent: 'coder', ...over });
const terminalFor = (req, over = {}) => ({ requestId: req.requestId, ownerRunId: req.ownerRunId, nodeId: req.nodeId, status: 'completed', result: { kind: 'text', text: DONE }, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 3, toolCalls: 2, durationMs: 5 }, runId: 'native-run-1', model: req.model, ...over });
const sentRequests = pi => pi.emitted.filter(e => e.name === DELEGATION_REQUEST_EVENT).map(e => e.payload);
const sentCancels = pi => pi.emitted.filter(e => e.name === DELEGATION_CANCEL_EVENT).map(e => e.payload);
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

test('happy path: registers a guarded runtime agent, dispatches exact tuple, returns real metrics', async t => {
  const pi = fakePi();
  const runner = createNativeSubagentRunner({ pi, cancelGraceMs: 20 });
  t.after(() => runner.dispose());
  const promise = runner.runSubagent(reqBase());
  await tick();
  const sent = sentRequests(pi)[0];
  assert.ok(sent);
  assert.equal(sent.context, 'fresh');
  assert.equal(sent.model, 'provider/model');
  assert.equal(sent.thinking, 'high');
  assert.equal(sent.skill, false);
  assert.deepEqual(sent.intercomBridge, { mode: 'off' });
  assert.deepEqual(sent.toolBudget, { hard: 7, block: '*' });
  assert.match(sent.task, /Reserve the final allowed turn for the final JSON result/);
  assert.match(sent.task, /When 3 turns remain or before the last 5 tool calls/);
  assert.match(sent.task, /a writer partial is saved for parent assessment/);
  const reg = pi.registrations[0];
  assert.ok(reg.name.startsWith('ludi-coder-'));
  assert.deepEqual(reg.definition.tools, ['read', 'ludi_exec', GUARD_TOOL]);
  assert.equal(reg.definition.allowNestedSubagents, false);
  assert.equal(reg.definition.inheritProjectContext, false);
  assert.equal(reg.definition.inheritSkills, false);
  assert.deepEqual(reg.definition.extensions, []); // ambient/configured denied
  assert.equal(reg.definition.subagentOnlyExtensions.length, 1);
  assert.equal(reg.definition.defaultTimeoutMs, 60000);
  // Foreign events for the same node are ignored before ours arrives.
  pi.events.emit(DELEGATION_RESPONSE_EVENT, { requestId: sent.requestId, ownerRunId: 'other', nodeId: sent.nodeId, status: 'completed', result: { kind: 'text', text: 'foreign' } });
  pi.events.emit(DELEGATION_UPDATE_EVENT, { ...sent, currentTool: 'read', toolCount: 1, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1 } });
  pi.events.emit(DELEGATION_RESPONSE_EVENT, terminalFor(sent));
  const out = await promise;
  assert.equal(out.ok, true);
  assert.equal(out.transport, 'native');
  assert.equal(out.text, DONE);
  assert.equal(out.nativeRunId, 'native-run-1');
  assert.equal(out.child.turns, 3);
  assert.equal(out.child.toolCalls, 2);
  assert.equal(out.child.childSessionId, 'native-run-1');
});

test('tool-budget stop preserves guard snapshot without accepting completed claim or falling back', async t => {
  const pi = fakePi();
  const native = createNativeSubagentRunner({ pi, cancelGraceMs: 20 });
  t.after(() => native.dispose());
  const workspace = mkdtempSync(join(tmpdir(), 'ludi-native-partial-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  let dispatches = 0;
  const agent = createAgentRunner({ repoRoot: workspace, agents, routing, registry: REG,
    invoke: async () => { throw new Error('oneshot forbidden'); }, runSubagent: async req => {
      dispatches++;
      const promise = native.runSubagent(req); await tick();
      const sent = sentRequests(pi).at(-1);
      assert.match(sent.task, /NATIVE_HANDOFF_BOUNDS/);
      assert.ok(sent.task.includes(resolve(kit, 'context-pack/SPEC.md')));
      writeFileSync(`${guardConfig(pi, sent).sidecarPath}.output`, DONE);
      // Installed owner does not project finalOutput on non-completed statuses.
      pi.events.emit(DELEGATION_RESPONSE_EVENT, terminalFor(sent, { status: 'tool_budget_exhausted', result: undefined }));
      return promise;
    } });
  const out = await agent.run({ id: 'a', assignedAgent: 'scout', capability: 'cheap-code', title: 'inspect', goal: 'inspect',
    kind: 'investigate', dependencies: [], acceptance: ['inspect'], outputs: [] }, { dependencyResults: [], runId: 'r1' });
  assert.equal(dispatches, 1);
  assert.equal(out.ok, false);
  assert.equal(out.abort, true);
  assert.equal(out.failureClass, 'TOOL_BUDGET_EXHAUSTED');
  assert.equal(out.child.guardQuiescent, true);
  assert.equal(out.child.terminalStatus, 'tool_budget_exhausted');
  assert.equal(out.result.status, 'partial');
  assert.equal(out.partialHandoff.claimedStatus, 'completed');
  assert.equal(out.partialHandoff.status, 'unaccepted');
  assert.equal(out.partialHandoff.text, DONE);
});

test('rules residual launcher receives only unused cumulative allowance without local extension', async t => {
  const workspace = mkdtempSync(join(tmpdir(), 'ludi-native-residual-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  let calls = 0;
  const agent = createAgentRunner({ repoRoot: workspace, agents, routing, registry: REG,
    invoke: async () => { throw new Error('oneshot forbidden'); }, runSubagent: async req => {
      calls++;
      assert.equal(req.limits.max_tool_calls, 3);
      assert.equal(req.limits.max_turns, 2);
      assert.equal(req.limits.max_tool_extensions, 0);
      assert.equal(req.limits.max_extensions, 0);
      return { ok: true, text: DONE, terminal: true, transport: 'native', child: {} };
    } });
  const out = await agent.run({ id: 'a.c1', assignedAgent: 'scout', capability: 'cheap-code', title: 'inspect residual', goal: 'inspect residual',
    kind: 'investigate', dependencies: [], acceptance: ['inspect'], outputs: [],
    rulesContinuation: { maxTurns: 48, turnsUsed: 46, maxTools: 80, toolCallsUsed: 77 } }, { dependencyResults: [], runId: 'r1' });
  assert.equal(calls, 1);
  assert.equal(out.ok, true);
});

test('normal partial text remains a successful transport outcome, unlike a hard-stop result', async t => {
  const pi = fakePi();
  const native = createNativeSubagentRunner({ pi, cancelGraceMs: 20 });
  t.after(() => native.dispose());
  const promise = native.runSubagent(reqBase()); await tick();
  const sent = sentRequests(pi)[0];
  const text = '```json\n' + JSON.stringify({ status: 'partial', summary: 'verified work saved; compile check remains' }) + '\n```';
  pi.events.emit(DELEGATION_RESPONSE_EVENT, terminalFor(sent, { result: { kind: 'text', text } }));
  const result = await promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, text);
  assert.equal(result.abort, undefined);
  assert.equal(result.partialHandoff, undefined);
  assert.equal(result.child.guardQuiescent, true);
});

test('guard warns before hard limit and snapshots only bounded final assistant text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ludi-guard-handoff-'));
  try {
    const handlers = {};
    const path = join(dir, 'state.json');
    createNativeGuard({ maxTurns: 5, maxToolCalls: 7, allowedTools: ['read'], sidecarPath: path })({
      on: (name, fn) => { handlers[name] = fn; }, registerTool() {},
    });
    const ctx = { abort() { throw new Error('warning must not abort'); } };
    handlers.tool_call({ toolName: 'read', toolCallId: 'a' }, ctx);
    assert.equal(handlers.tool_result({ toolCallId: 'a', content: [{ type: 'text', text: 'file' }] }), undefined);
    handlers.tool_call({ toolName: 'read', toolCallId: 'b' }, ctx);
    const warning = handlers.tool_result({ toolCallId: 'b', content: [{ type: 'text', text: 'evidence' }] });
    assert.equal(warning.content[0].text, 'evidence');
    assert.match(warning.content[1].text, /LUDI_HANDOFF.*2\/7/);
    handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text: DONE }] } });
    assert.equal(readFileSync(`${path}.output`, 'utf8'), DONE);
    // A later tool-use message invalidates any older apparent final answer.
    handlers.message_end({ message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read' }] } });
    assert.throws(() => readFileSync(`${path}.output`), { code: 'ENOENT' });
    handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1024 * 1024 + 1) }] } });
    assert.throws(() => readFileSync(`${path}.output`), { code: 'ENOENT' });
    handlers.message_end({ message: { role: 'toolResult', content: [{ type: 'text', text: DONE }] } });
    assert.throws(() => readFileSync(`${path}.output`), { code: 'ENOENT' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('absent owner (no result) reports unavailable pre-dispatch; host may pick subprocess once', async () => {
  const pi = fakePi({ registerResult: null });
  const runner = createNativeSubagentRunner({ pi, cancelGraceMs: 20 });
  const out = await runner.runSubagent(reqBase());
  assert.equal(out.ok, false);
  assert.equal(out.unavailable, true);
  assert.equal(sentRequests(pi).length, 0); // never dispatched

  const calls = { sub: 0 };
  const host = createHostSubagentRunner({
    native: async () => ({ ok: false, unavailable: true }),
    subprocess: async () => { calls.sub++; return { ok: true, text: 'sub' }; },
  });
  const viaHost = await host(reqBase());
  assert.equal(viaHost.transport, 'subprocess');
  assert.equal(viaHost.transportFallback, 'no-native-owner');
  assert.equal(calls.sub, 1);
});

test('unexpected native rejection/malformed return is uncertain, terminal and retained', async () => {
  let fallbackCalls = 0;
  for (const invalid of ['throw', null, {}]) {
    const host = createHostSubagentRunner({ native: async () => {
      if (invalid === 'throw') throw new Error('HTTP 500 after possible dispatch');
      return invalid;
    }, subprocess: async () => { fallbackCalls++; } });
    const result = await host(reqBase());
    assert.equal(result.ok, false);
    assert.equal(result.abort, true);
    assert.equal(result.terminal, true);
    assert.equal(result.unconfirmedStop, true);
    assert.equal(typeof result.retainWorkspaceUntil.then, 'function');
  }
  assert.equal(fallbackCalls, 0);
});

test('explicit registration rejection is terminal; no subprocess fallback', async () => {
  const pi = fakePi({ registerResult: { ok: false, error: new Error('name collision') } });
  const runner = createNativeSubagentRunner({ pi, cancelGraceMs: 20 });
  const calls = { sub: 0 };
  const host = createHostSubagentRunner({ native: r => runner.runSubagent(r), subprocess: async () => { calls.sub++; return { ok: true }; } });
  const out = await host(reqBase());
  assert.equal(out.ok, false);
  assert.equal(out.abort, true);
  assert.match(out.error, /rejected|collision/);
  assert.equal(calls.sub, 0);
});

test('post-admission failure is terminal: exactly one native dispatch, zero candidate/subprocess retries', async t => {
  const pi = fakePi();
  const runner = createNativeSubagentRunner({ pi, cancelGraceMs: 20 });
  t.after(() => runner.dispose());
  const workspace = mkdtempSync(join(tmpdir(), 'ludi-native-nofallback-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const calls = { native: 0, sub: 0 };
  const runSubagent = createHostSubagentRunner({
    native: async req => { calls.native++; const p = runner.runSubagent(req); await tick(); const sent = sentRequests(pi).at(-1); pi.events.emit(DELEGATION_RESPONSE_EVENT, terminalFor(sent, { status: 'failed', error: 'child exploded', result: undefined })); return p; },
    subprocess: async () => { calls.sub++; return { ok: true, text: 'sub' }; },
  });
  const agent = createAgentRunner({ repoRoot: workspace, agents, routing, registry: REG,
    invoke: async () => { throw new Error('oneshot'); }, runSubagent });
  const task = { id: 'a', assignedAgent: 'coder', capability: 'strong-code', title: 'w', goal: 'w', dependencies: [], acceptance: ['w'], outputs: [] };
  const out = await agent.run(task, { dependencyResults: [], runId: 'r1' });
  assert.equal(out.ok, false);
  assert.equal(out.abort, true);
  assert.equal(calls.native, 1); // strong-code has 5 bound candidates; none retried
  assert.equal(calls.sub, 0);
  assert.equal(sentRequests(pi).length, 1);
});

test('completed-but-malformed text is terminal: no candidate advance', async t => {
  const pi = fakePi();
  const runner = createNativeSubagentRunner({ pi, cancelGraceMs: 20 });
  t.after(() => runner.dispose());
  const workspace = mkdtempSync(join(tmpdir(), 'ludi-native-malformed-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const calls = { native: 0 };
  const runSubagent = async req => { calls.native++; const p = runner.runSubagent(req); await tick(); const sent = sentRequests(pi).at(-1); pi.events.emit(DELEGATION_RESPONSE_EVENT, terminalFor(sent, { result: { kind: 'text', text: 'no json block here' } })); return p; };
  const agent = createAgentRunner({ repoRoot: workspace, agents, routing, registry: REG,
    invoke: async () => { throw new Error('oneshot'); }, runSubagent });
  const task = { id: 'a', assignedAgent: 'coder', capability: 'strong-code', title: 'w', goal: 'w', dependencies: [], acceptance: ['w'], outputs: [] };
  const out = await agent.run(task, { dependencyResults: [], runId: 'r1' });
  // A native terminal verdict is final for the task: malformed output does
  // not advance to another model candidate and never hits subprocess.
  assert.equal(calls.native, 1);
  assert.equal(sentRequests(pi).length, 1);
  assert.equal(out.ok, false);
  assert.equal(out.failureClass, 'MALFORMED_RESULT');
});

test('full-tuple proof: foreign/partial invalid_request never settles a live attempt or its lease', async t => {
  const pi = fakePi();
  const runner = createNativeSubagentRunner({ pi, cancelGraceMs: 15 });
  const root = mkdtempSync(join(tmpdir(), 'ludi-native-tuple-'));
  const workspace = join(root, 'w'); mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seen = [];
  const agent = createAgentRunner({ repoRoot: workspace, agents, routing, registry: REG,
    invoke: async () => { throw new Error('oneshot'); },
    runSubagent: async req => { const p = runner.runSubagent({ ...req, limits: { ...req.limits, max_runtime_ms: 50 } }); await tick(); seen.push(...sentRequests(pi)); return p; } });
  const task = { id: 'a', assignedAgent: 'coder', capability: 'strong-code', title: 'w', goal: 'w', dependencies: [], acceptance: ['w'], outputs: [] };
  const outPromise = agent.run(task, { dependencyResults: [], runId: 'r1' });
  await tick(10);
  const sent = seen[0];
  // Same requestId but foreign/missing ownerRunId or nodeId: must NOT settle.
  pi.events.emit(DELEGATION_RESPONSE_EVENT, { requestId: sent.requestId, status: 'invalid_request', error: 'foreign' });
  pi.events.emit(DELEGATION_RESPONSE_EVENT, { requestId: sent.requestId, ownerRunId: 'other', nodeId: sent.nodeId, status: 'invalid_request' });
  pi.events.emit(DELEGATION_RESPONSE_EVENT, { requestId: sent.requestId, ownerRunId: sent.ownerRunId, nodeId: 'other', status: 'invalid_request' });
  const out = await outPromise;
  assert.equal(out.ok, false);
  assert.equal(out.abort, true);
  assert.equal(out.child.stopReason, 'unconfirmed-stop');
  // The retention Promise is private process state — stripped before it can
  // reach task/trace JSON; only the marker remains.
  assert.equal(out.retainWorkspaceUntil, undefined);
  assert.equal(out.workspaceRetained, true);
  assert.throws(() => acquireWorkspaceLease(workspace), { code: 'WORKSPACE_BUSY' });
  // The matching late terminal releases the retained lease.
  pi.events.emit(DELEGATION_RESPONSE_EVENT, terminalFor(sent, { status: 'cancelled' }));
  await tick(20);
  acquireWorkspaceLease(workspace).release();
});

test('dispose cancels via the same path and keeps proof resources until terminal', async () => {
  const pi = fakePi();
  const runner = createNativeSubagentRunner({ pi, cancelGraceMs: 20 });
  const promise = runner.runSubagent(reqBase({ limits: { max_runtime_ms: 60_000, max_tool_calls: 7, max_turns: 4 } }));
  await tick();
  const sent = sentRequests(pi)[0];
  runner.dispose();
  // Cancel went out through the exact-tuple path.
  assert.deepEqual(sentCancels(pi).at(-1), { requestId: sent.requestId, ownerRunId: sent.ownerRunId, nodeId: sent.nodeId });
  // Proof resources are retained: the attempt stays active until a terminal.
  assert.equal(runner.activeCount(), 1);
  const out = await promise; // entered grace on dispose-cancel, no terminal yet
  assert.equal(out.ok, false);
  assert.equal(out.abort, true);
  assert.equal(out.unconfirmedStop, true);
  assert.equal(runner.activeCount(), 1); // listener+registration+guard retained
  // Late exact terminal still cleans up.
  pi.events.emit(DELEGATION_RESPONSE_EVENT, terminalFor(sent, { status: 'cancelled' }));
  await tick(10);
  assert.equal(runner.activeCount(), 0);
  runner.dispose(); // idempotent
});

test('emit throw after a listener started execution is treated as uncertain admission', async () => {
  const pi = fakePi();
  const sawRequest = [];
  pi.events.on(DELEGATION_REQUEST_EVENT, req => sawRequest.push(req)); // owner observes first
  pi.events.on(DELEGATION_REQUEST_EVENT, () => { throw new Error('later listener exploded'); }); // then throws
  const runner = createNativeSubagentRunner({ pi, cancelGraceMs: 10 });
  const out = await runner.runSubagent(reqBase({ limits: { max_runtime_ms: 60_000, max_tool_calls: 7, max_turns: 4 } }));
  assert.equal(sawRequest.length, 1); // dispatched before the throw
  assert.equal(sentCancels(pi).length, 1); // exact cancel sent
  assert.equal(out.ok, false);
  assert.equal(out.abort, true);
  assert.equal(out.unconfirmedStop, true);
  assert.match(out.error, /emit threw/);
  runner.dispose();
});

test('pre-aborted signal refuses before registration or dispatch; no subprocess fallback', async () => {
  const pi = fakePi();
  const runner = createNativeSubagentRunner({ pi, cancelGraceMs: 20 });
  const controller = new AbortController();
  controller.abort();
  const calls = { sub: 0 };
  const host = createHostSubagentRunner({ native: r => runner.runSubagent(r), subprocess: async () => { calls.sub++; return { ok: true }; } });
  const out = await host(reqBase({ signal: controller.signal }));
  assert.equal(out.ok, false);
  assert.equal(out.abort, true);
  assert.equal(pi.registrations.length, 0);
  assert.equal(sentRequests(pi).length, 0);
  assert.equal(calls.sub, 0);
});

test('writer protection must succeed before any native delegation', async () => {
  const pi = fakePi();
  const native = createNativeSubagentRunner({ pi, cancelGraceMs: 20 });
  const refused = await native.runSubagent(reqBase({ protectWorkspace: () => { throw new Error('protection unavailable'); } }));
  assert.equal(refused.ok, false);
  assert.equal(refused.abort, true);
  assert.equal(sentRequests(pi).length, 0);
  assert.equal(native.activeCount(), 0);
  const missing = await native.runSubagent(reqBase({ protectWorkspace: undefined }));
  assert.equal(missing.ok, false);
  assert.equal(sentRequests(pi).length, 0);
});

test('malformed explicit limits refuse instead of silently widening', async () => {
  const pi = fakePi();
  const runner = createNativeSubagentRunner({ pi, cancelGraceMs: 20 });
  for (const bad of [{ max_turns: 0 }, { max_turns: 'x' }, { max_tool_calls: -1 }, { max_tool_calls: 1.5 }, { max_runtime_ms: -5 }]) {
    const out = await runner.runSubagent(reqBase({ limits: { ...reqBase().limits, ...bad } }));
    assert.equal(out.ok, false, JSON.stringify(bad));
    assert.equal(out.abort, true);
  }
  assert.equal(pi.registrations.length, 0);
  assert.equal(sentRequests(pi).length, 0);
});

test('forbidden tools and shell/filesystem widening are refused pre-launch', async () => {
  const pi = fakePi();
  const runner = createNativeSubagentRunner({ pi, cancelGraceMs: 20 });
  for (const tools of [['powershell'], ['bash'], ['subagent'], ['read', 'edit']]) {
    const out = await runner.runSubagent(reqBase({ toolNames: tools, access: { filesystem: 'read', shell: 'false' } }));
    assert.equal(out.ok, false, tools.join(','));
    assert.equal(out.abort, true);
  }
  // ludi_exec without shell access is refused.
  const noShell = await runner.runSubagent(reqBase({ toolNames: ['read', 'ludi_exec'], access: { filesystem: 'read', shell: 'false' } }));
  assert.equal(noShell.ok, false);
  assert.equal(pi.registrations.length, 0);
});

test('concurrent native launches keep immutable shell policy and identity separate', async () => {
  const pi = fakePi();
  const native = createNativeSubagentRunner({ pi, cancelGraceMs: 20 });
  const originalMode = process.env.LUDI_SHELL_MODE;
  const originalNetwork = process.env.LUDI_SHELL_NETWORK;
  let firstSettled = false;
  const first = native.runSubagent(reqBase({ taskId: 'read-only', toolNames: ['read'],
    access: { filesystem: 'read', shell: 'false', network: false } })).then(r => { firstSettled = true; return r; });
  const second = native.runSubagent(reqBase({ taskId: 'shell', access: { filesystem: 'read-write', shell: 'limited', network: false } }));
  await tick();
  const requests = sentRequests(pi);
  const policies = pi.registrations.map(r => JSON.parse(readFileSync(r.definition.subagentOnlyExtensions[0], 'utf8').match(/const CONFIG = (.+);/)[1]).shell);
  assert.equal(policies[0].shell, 'false');
  assert.equal(policies[1].shell, 'limited');
  assert.equal(policies[1].requireConfirmedExit, true);
  assert.notEqual(requests[0].agent, requests[1].agent);
  pi.events.emit(DELEGATION_RESPONSE_EVENT, terminalFor(requests[1], { runId: 'native-second' }));
  assert.equal((await second).ok, true);
  assert.equal(firstSettled, false);
  pi.events.emit(DELEGATION_RESPONSE_EVENT, terminalFor(requests[0], { runId: 'native-first' }));
  assert.equal((await first).ok, true);
  assert.equal(process.env.LUDI_SHELL_MODE, originalMode);
  assert.equal(process.env.LUDI_SHELL_NETWORK, originalNetwork);
  assert.equal(native.activeCount(), 0);
});

test('guard stop metadata overrides a nominally completed native terminal', async () => {
  const pi = fakePi({ autoQuiescence: false });
  const native = createNativeSubagentRunner({ pi, cancelGraceMs: 20 });
  const pending = native.runSubagent(reqBase());
  await tick();
  const request = sentRequests(pi)[0];
  writeFileSync(guardConfig(pi, request).sidecarPath, JSON.stringify({ version: 1,
    shutdown: true, pendingTools: 0, reason: 'turn-limit', toolCalls: 1 }));
  pi.events.emit(DELEGATION_RESPONSE_EVENT, terminalFor(request));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.abort, true);
  assert.equal(result.failureClass, 'TIMEOUT');
  assert.equal(result.child.status, 'failed');
  assert.equal(result.child.stopReason, 'guard-turn-limit');
  assert.equal(result.child.guardQuiescent, true);
  assert.equal(result.text, undefined);
  assert.equal(result.partialHandoff.status, 'unaccepted');
  assert.equal(result.partialHandoff.text, DONE);
});

test('opaque model IDs with colon tags retain their exact model and thinking', async () => {
  const pi = fakePi();
  const runner = createNativeSubagentRunner({ pi, cancelGraceMs: 20 });
  const pending = runner.runSubagent(reqBase({ modelId: 'provider/owner/model:q8:low' }));
  await tick();
  const request = sentRequests(pi)[0];
  assert.equal(request.model, 'provider/owner/model:q8');
  assert.equal(request.thinking, 'low');
  pi.events.emit(DELEGATION_RESPONSE_EVENT, terminalFor(request, { thinking: 'low' }));
  assert.equal((await pending).ok, true);
});

test('model, thinking and malformed usage are refused after terminal', async t => {
  const pi = fakePi();
  const runner = createNativeSubagentRunner({ pi, cancelGraceMs: 20 });
  t.after(() => runner.dispose());
  const promise = runner.runSubagent(reqBase());
  await tick();
  const sent = sentRequests(pi)[0];
  pi.events.emit(DELEGATION_RESPONSE_EVENT, terminalFor(sent, { model: 'other/model' }));
  const out = await promise;
  assert.equal(out.ok, false);
  assert.equal(out.abort, true);
  assert.match(out.error, /pinned/);

  const p2 = runner.runSubagent(reqBase({ taskId: 't2' }));
  await tick();
  const sent2 = sentRequests(pi).at(-1);
  pi.events.emit(DELEGATION_RESPONSE_EVENT, terminalFor(sent2, { thinking: 'low', usage: { ...terminalFor(sent2).usage, turns: -1 } }));
  // thinking mismatch fires before usage validation
  const out2 = await p2;
  assert.equal(out2.ok, false);
  assert.equal(out2.abort, true);
});

test('missing metrics stay absent — never 0', async t => {
  const pi = fakePi();
  const runner = createNativeSubagentRunner({ pi, cancelGraceMs: 20 });
  t.after(() => runner.dispose());
  const promise = runner.runSubagent(reqBase());
  await tick();
  const sent = sentRequests(pi)[0];
  pi.events.emit(DELEGATION_RESPONSE_EVENT, terminalFor(sent, { usage: undefined, runId: undefined }));
  const out = await promise;
  assert.equal(out.ok, true);
  assert.equal(out.usage, undefined);
  assert.equal(out.nativeRunId, undefined);
  assert.equal(out.child.turns, null);
  assert.equal(out.child.toolCalls, null);
});

test('guard: excess turn prevented at turn_start; tool blocks are sticky; sidecar records reason', () => {
  const handlers = {}; const tools = {};
  const pi = { on: (n, f) => { (handlers[n] ??= []).push(f); }, registerTool: t => { tools[t.name] = t; } };
  let aborted = 0;
  const ctx = { abort: () => { aborted++; } };
  const dir = mkdtempSync(join(tmpdir(), 'ludi-guard-'));
  try {
    createNativeGuard({ maxTurns: 2, maxToolCalls: 2, allowedTools: ['read', GUARD_TOOL], sidecarPath: join(dir, 'guard-stop.json') })(pi);
    assert.ok(tools[GUARD_TOOL]);
    assert.equal(tools[GUARD_TOOL].exposure, 'hidden');
    const call = handlers.tool_call[0];
    const turn = handlers.turn_start[0];
    assert.equal(call({ toolName: 'read', toolCallId: 'read-1' }, ctx), undefined); // 1st
    assert.equal(call({ toolName: 'read' }, ctx), undefined); // 2nd — at cap
    const over = call({ toolName: 'read' }, ctx); // exceeds
    assert.equal(over.block, true);
    assert.equal(over.terminate, true);
    // Sticky: every later allowed-name call is still blocked.
    assert.equal(call({ toolName: 'read' }, ctx).block, true);
    // Sidecar recorded the first stop reason with observed counts only.
    const sidecar = JSON.parse(readFileSync(join(dir, 'guard-stop.json'), 'utf8'));
    assert.equal(sidecar.reason, 'tool-call-limit');
    assert.equal(sidecar.toolCalls, 2);
    // turn_start BEFORE provider work: index 0,1 allowed; index 2 = excess.
    turn({ turnIndex: 0 }, ctx); turn({ turnIndex: 1 }, ctx);
    assert.ok(aborted >= 1); // tripped earlier by tool breach
    turn({ turnIndex: 2 }, ctx);
    assert.ok(aborted >= 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a native terminal alone cannot release a writer while the guard still has a pending tool', async t => {
  let signalReleased;
  const released = new Promise(resolve => { signalReleased = resolve; });
  const pi = fakePi({ autoQuiescence: false, registerResult: () => ({ ok: true,
    registration: { dispose() { signalReleased(); } } }) });
  const native = createNativeSubagentRunner({ pi, cancelGraceMs: 10 });
  const workspace = mkdtempSync(join(tmpdir(), 'ludi-native-quiescence-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const runner = createAgentRunner({ repoRoot: workspace, agents, routing, registry: REG,
    invoke: async () => { throw new Error('oneshot forbidden'); }, runSubagent: req => native.runSubagent(req) });
  const pending = runner.run({ id: 'a', assignedAgent: 'coder', capability: 'strong-code', title: 'x', goal: 'x',
    dependencies: [], acceptance: ['x'], outputs: [] }, { dependencyResults: [], runId: 'quiescence-owner' });
  await tick(5);
  const request = sentRequests(pi)[0];
  const path = guardConfig(pi, request).sidecarPath;
  writeFileSync(path, JSON.stringify({ version: 1, shutdown: true, pendingTools: 1, reason: null }));
  pi.events.emit(DELEGATION_RESPONSE_EVENT, terminalFor(request, { status: 'cancelled', result: undefined }));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.workspaceRetained, true);
  assert.equal(result.retainWorkspaceUntil, undefined);
  assert.equal(result.child.stopReason, 'guard-quiescence-unconfirmed');
  assert.throws(() => acquireWorkspaceLease(workspace), { code: 'WORKSPACE_BUSY' });
  writeFileSync(path, JSON.stringify({ version: 1, shutdown: true, pendingTools: 0, reason: null }));
  let timeout;
  try {
    await Promise.race([released, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('guard proof was not observed')), 2000); })]);
    await tick(); // let the retained-proof continuation release its lease
  } finally { clearTimeout(timeout); }
  acquireWorkspaceLease(workspace).release();
  assert.equal(native.activeCount(), 0);
});

test('guard quiescence requires shutdown and the matching result for every pending tool', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ludi-guard-quiet-'));
  try {
    const handlers = {};
    const path = join(dir, 'state.json');
    createNativeGuard({ maxTurns: 2, maxToolCalls: 2, allowedTools: ['read'], sidecarPath: path })({
      on: (name, fn) => { handlers[name] = fn; }, registerTool() {},
    });
    handlers.tool_call({ toolName: 'read', toolCallId: 'owned-call' }, { abort() {} });
    handlers.session_shutdown();
    assert.equal(JSON.parse(readFileSync(path)).pendingTools, 1);
    handlers.tool_result({ toolCallId: 'foreign-call' });
    assert.equal(JSON.parse(readFileSync(path)).pendingTools, 1);
    handlers.tool_result({ toolCallId: 'owned-call' });
    const state = JSON.parse(readFileSync(path));
    assert.equal(state.shutdown, true);
    assert.equal(state.pendingTools, 0);
    assert.equal(handlers.tool_call({ toolName: 'read', toolCallId: 'too-late' }, { abort() {} }).block, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard: forbidden tools trip a sticky refusal', () => {
  const handlers = {};
  createNativeGuard({ maxTurns: 2, maxToolCalls: 2, allowedTools: ['read'] })({ on: (name, fn) => { handlers[name] = fn; }, registerTool() {} });
  assert.equal(handlers.tool_call({ toolName: 'powershell' }, { abort() {} }).block, true);
  assert.equal(handlers.tool_call({ toolName: 'read' }, { abort() {} }).block, true);
});

test('guard: final turn at the cap is not aborted', () => {
  const handlers = {}; const tools = {};
  const pi = { on: (n, f) => { (handlers[n] ??= []).push(f); }, registerTool: t => { tools[t.name] = t; } };
  let aborted = false;
  createNativeGuard({ maxTurns: 3, maxToolCalls: 10, allowedTools: ['read'] })(pi);
  const turn = handlers.turn_start[0];
  const ctx = { abort: () => { aborted = true; } };
  turn({ turnIndex: 0 }, ctx); assert.equal(aborted, false);
  turn({ turnIndex: 1 }, ctx); assert.equal(aborted, false);
  turn({ turnIndex: 2 }, ctx); assert.equal(aborted, false); // final allowed turn
  turn({ turnIndex: 3 }, ctx); assert.equal(aborted, true); // excess prevented
});

test('shell gate runCommand: abort stops the process and reports error, never success', async () => {
  const killed = [];
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
  proc.kill = () => { killed.push(true); proc.emit('close', 130); };
  const spawnImpl = () => proc;
  const controller = new AbortController();
  const p = runCommand('git status', tmpdir(), controller.signal, { spawnImpl, killGraceMs: 10 });
  await tick(1);
  controller.abort();
  const res = await p;
  assert.equal(killed.length, 1);
  assert.equal(res.code, 130);
  assert.match(res.stderr, /cancelled/);
});

test('shell gate runCommand: unconfirmed kill resolves as an error, not success', async t => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
  proc.kill = () => {}; // never emits close
  const controller = new AbortController();
  const p = runCommand('git status', tmpdir(), controller.signal, { spawnImpl: () => proc, killGraceMs: 10 });
  await tick(1);
  controller.abort();
  const res = await p; // resolves after the bounded kill-grace as unconfirmed error
  assert.equal(res.unconfirmed, true);
  assert.notEqual(res.code, 0);
});

test('native shell waits beyond kill grace until a real close', async () => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => {};
  const controller = new AbortController();
  let settled = false;
  const pending = runCommand('git status', tmpdir(), controller.signal, { spawnImpl: () => proc,
    killGraceMs: 5, requireConfirmedExit: true }).then(result => { settled = true; return result; });
  controller.abort();
  await tick(20);
  assert.equal(settled, false);
  proc.emit('close', 0);
  const result = await pending;
  assert.notEqual(result.code, 0, 'an aborted command is not successful even when close says zero');
});

test('Windows native shell requires confirmation for its owned process tree too', async () => {
  const proc = new EventEmitter(), killer = new EventEmitter();
  proc.pid = 12345; proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
  let calls = 0;
  const controller = new AbortController();
  let settled = false;
  const pending = runCommand('git status', tmpdir(), controller.signal, {
    platform: 'win32', requireConfirmedExit: true, killGraceMs: 5,
    spawnImpl: (_executable, args) => {
      if (calls++ === 0) return proc;
      assert.deepEqual(args, ['/PID', '12345', '/T', '/F']);
      return killer;
    },
  }).then(result => { settled = true; return result; });
  controller.abort();
  proc.emit('close', 0);
  await tick(15);
  assert.equal(settled, false);
  killer.emit('close', 0);
  assert.notEqual((await pending).code, 0);
});

test('shell gate runCommand: pre-aborted signal refuses before spawn', async () => {
  let spawned = 0;
  const controller = new AbortController(); controller.abort();
  const res = await runCommand('x', tmpdir(), controller.signal, { spawnImpl: () => { spawned++; } });
  assert.equal(spawned, 0);
  assert.notEqual(res.code, 0);
});

test('renderGuardModule emits fixed JSON config and kit imports only', () => {
  const src = renderGuardModule({ maxTurns: 4, maxToolCalls: 7, allowedTools: ['read', GUARD_TOOL], shell: 'limited', network: false, sidecarPath: 'C:/x/guard-stop.json' });
  assert.match(src, /createNativeGuard/);
  assert.match(src, /createShellGate/);
  assert.match(src, /"maxTurns":4/);
  assert.match(src, /"maxToolCalls":7/);
  assert.match(src, /"allowedTools":\["read","ludi_guard"\]/);
  assert.match(src, /guard-stop\.json/);
});
