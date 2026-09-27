// Public run-activity snapshots: atomic client file, live invocation events, and the
// significant-vs-high-frequency trace policy. All stubs — no pi process, no provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, renameSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { DEFAULT_POLICY } from '../lib/orchestrator/policy.mjs';
import { showRun } from '../lib/orchestrator/api.mjs';
import { openStore } from '../lib/orchestrator/store.mjs';
import { orchestrate } from '../lib/orchestrator/orchestrator.mjs';
import { createAgentRunner } from '../lib/orchestrator/runner.mjs';
import { runPiSubagent } from '../adapters/pi/lib/subagent.mjs';
import { createActivityTracker, activityFileName, readActivitySnapshot, sanitizeInvocationEvent, publishActivitySnapshot } from '../lib/orchestrator/activity.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const REG = { version: 1, backends: { local: { provider: 'pl', model: 'ml', thinking: 'off' } } };
const spec = (id, agent, dependencies = []) => ({ id, title: `task ${id}`, goal: `goal ${id}`, agent, dependencies, acceptance: ['done'] });
const completed = (task) => ({ ok: true, structured: true, modelId: 'fake', result: {
  status: 'completed', summary: `did ${task.id}`, artifacts: [], verification: ['checked'],
  acceptance: [{ id: 'A1', met: true, evidence: 'observed' }], remainingIssues: [], decisions: [], newTasks: [] } });
const tmpKit = () => mkdtempSync(join(tmpdir(), 'ludi-activity-'));

test('snapshot file is written atomically on bind and carries version+clientContext', () => {
  const dir = tmpKit();
  const activity = createActivityTracker({ kit: dir, clientContext: { kind: 'pi-web', sessionId: 'abc-123' } });
  activity.bindRun({ runId: 'run-1', repoRoot: '/repo' });
  const file = join(dir, '.orchestration', 'activity', 'clients', 'pi-web-abc-123.json');
  assert.equal(activityFileName({ kind: 'pi-web', sessionId: 'abc-123' }), 'pi-web-abc-123.json');
  assert.equal(activity.file, file);
  const doc = readActivitySnapshot(file);
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.clientContext, { kind: 'pi-web', sessionId: 'abc-123' });
  assert.equal(doc.runId, 'run-1');
  assert.equal(doc.repoRoot, '/repo');
  assert.equal(doc.activity.runId, 'run-1');
  assert.equal(doc.activity.state, 'running');
});

test('Windows sharing violation retries atomic replacement and keeps the prior document readable', () => {
  const dir = tmpKit(), file = join(dir, 'snapshot.json');
  publishActivitySnapshot(file, { runId: 'old' });
  let attempts = 0;
  const waits = [];
  publishActivitySnapshot(file, { runId: 'new' }, { windows: true, wait: ms => waits.push(ms), rename: (src, dest) => {
    attempts++;
    if (attempts < 3) {
      assert.equal(readActivitySnapshot(dest).runId, 'old');
      throw Object.assign(new Error('locked by reader'), { code: 'EPERM' });
    }
    renameSync(src, dest);
  } });
  assert.equal(readActivitySnapshot(file).runId, 'new');
  assert.deepEqual(waits, [10, 20]);
  assert.deepEqual(readdirSync(dir), ['snapshot.json']);
});

test('persistent snapshot failure does not fail a persisted run or strand temporary files', () => {
  const dir = tmpKit();
  const activity = createActivityTracker({ kit: dir, clientContext: { kind: 'pi-web', sessionId: 'locked' } });
  mkdirSync(activity.file, { recursive: true }); // a directory at the destination makes replacement impossible
  const warnings = [], originalWarn = console.warn;
  try {
    console.warn = message => warnings.push(message);
    assert.doesNotThrow(() => activity.bindRun({ runId: 'run-1', repoRoot: dir }));
    assert.equal(activity.getRunActivity('run-1').runId, 'run-1');
    assert.equal(warnings.length, 1);
    assert.deepEqual(readdirSync(dirname(activity.file)).filter(name => name.endsWith('.tmp')), []);
  } finally { console.warn = originalWarn; }
  rmSync(activity.file, { recursive: true });
  activity.syncTasks({ runId: 'run-1', tasks: [] });
  assert.equal(readActivitySnapshot(activity.file).runId, 'run-1');
});

test('orchestrator still completes and persists when its optional snapshot is locked', async () => {
  const dir = tmpKit(), session = openStore(join(dir, 'state.db'));
  const activity = createActivityTracker({ kit: dir, clientContext: { kind: 'pi-web', sessionId: 'busy-reader' } });
  mkdirSync(activity.file, { recursive: true });
  const originalWarn = console.warn;
  try {
    console.warn = () => {};
    const result = await orchestrate({ request: 'fixture', plan: [spec('t1', 'scout')], agents, routing, registry: REG,
      policy: DEFAULT_POLICY, runner: { run: async task => completed(task) }, session, activity, repoRoot: dir });
    assert.equal(result.status, 'completed');
    assert.equal(session.getRun(result.runId).status, 'completed');
    const report = showRun({ session }, result.runId).report;
    assert.equal(report, result.report);
    assert.match(report, /完了:/);
    assert.match(report, /未解決:/);
    session.updateRun(result.runId, { status: 'running' });
    assert.equal(showRun({ session }, result.runId).report, null, 'a resumed run must not show its previous final report');
  } finally { console.warn = originalWarn; session.close(); }
});

test('live invocation events update activeInvocations keyed runId+taskId+invocationId', () => {
  const activity = createActivityTracker({ kit: tmpKit(), clientContext: { kind: 'pi-web', sessionId: 's1' } });
  activity.bindRun({ runId: 'r1', repoRoot: null });
  activity.emit('invocation-start', { runId: 'r1', taskId: 't1', invocationId: 'i1', agent: 'coder', modelId: 'm1' });
  activity.emit('invocation-start', { runId: 'r1', taskId: 't1', invocationId: 'i2', agent: 'coder', modelId: 'm2' });
  let a = activity.getRunActivity('r1');
  assert.equal(a.activeInvocations.length, 2);
  activity.emit('invocation-turn', { runId: 'r1', taskId: 't1', invocationId: 'i1', turn: 3, turnCap: 12 });
  activity.emit('invocation-end', { runId: 'r1', taskId: 't1', invocationId: 'i1', status: 'finished' });
  a = activity.getRunActivity('r1');
  assert.equal(a.activeInvocations.length, 1);
  assert.equal(a.activeInvocations[0].invocationId, 'i2');
});

test('subscribeRunActivity notifies and getRunActivityByClient resolves the bound run', () => {
  const activity = createActivityTracker({ kit: tmpKit(), clientContext: { kind: 'pi-web', sessionId: 'sess' } });
  const seen = [];
  activity.subscribeRunActivity('rX', a => seen.push(a));
  activity.bindRun({ runId: 'rX', repoRoot: '/r' });
  activity.syncTasks({ runId: 'rX', tasks: [{ id: 't1', title: 'x', assignedAgent: 'coder', status: 'running', attempts: 1 }] });
  assert.ok(seen.length >= 2);
  const byClient = activity.getRunActivityByClient('pi-web', 'sess');
  assert.equal(byClient.runId, 'rX');
  assert.equal(byClient.totalTasks, 1);
  assert.equal(byClient.activeAgents, 1);
  const restarted = createActivityTracker({ kit: activity.file.split('.orchestration')[0], clientContext: { kind: 'pi-web', sessionId: 'sess' } });
  assert.equal(restarted.getRunActivityByClient('pi-web', 'sess')?.runId, 'rX');
  assert.equal(activity.getRunActivityByClient('pi-web', 'other'), null);
});

test('orchestrate emits significant invocation events to trace but not high-frequency turns', async () => {
  const dir = tmpKit();
  const session = openStore(join(dir, 'state.db'));
  const activity = createActivityTracker({ kit: dir, clientContext: { kind: 'pi-web', sessionId: 'z9' } });
  const runner = { async run(t, ctx) {
    ctx.onEvent?.('invocation-start', { taskId: t.id, invocationId: 'i1', agent: 'coder', modelId: 'm' });
    ctx.onEvent?.('invocation-turn', { taskId: t.id, invocationId: 'i1', turn: 1 });
    ctx.onEvent?.('invocation-tool', { taskId: t.id, invocationId: 'i1', tool: { name: 'read', file: 'a.mjs' } });
    ctx.onEvent?.('invocation-end', { taskId: t.id, invocationId: 'i1', status: 'finished' });
    return { ...completed(t), raw: 'PRIVATE_RAW_OUTPUT', steps: [{ modelId: 'm', capability: 'strong-code', ok: true,
      reason: 'PRIVATE_REASON', telemetry: { text: 'PRIVATE_TELEMETRY', commands: ['PRIVATE_COMMAND'] } }] };
  } };
  const r = await orchestrate({
    request: 'do', plan: [spec('a', 'coder')], agents, routing, registry: REG,
    policy: DEFAULT_POLICY, session, runner, activity,
  });
  assert.equal(r.status, 'completed');
  const types = session.loadTrace(r.runId).map(e => e.type);
  for (const k of ['invocation-start', 'invocation-tool', 'invocation-end']) assert.ok(types.includes(k), k);
  assert.ok(!types.includes('invocation-turn'), 'turns must not persist to trace');
  const resultEntry = session.loadTrace(r.runId).find(e => e.type === 'result');
  assert.equal(resultEntry.verdict, 'success');
  assert.equal(resultEntry.steps[0].modelId, 'm');
  assert.ok(!JSON.stringify(resultEntry).includes('PRIVATE_'), 'raw output and step telemetry must not persist');
  const doc = readActivitySnapshot(join(dir, '.orchestration', 'activity', 'clients', 'pi-web-z9.json'));
  assert.equal(doc.runId, r.runId);
  assert.equal(doc.activity.completedTasks, 1);
  assert.equal(doc.activity.state, 'completed');
  session.close();
});

test('parallel live progress, safe recent tools, extension and candidate change survive snapshots', () => {
  const a = createActivityTracker({ kit: tmpKit(), clientContext: { kind: 'pi-web', sessionId: 'session-a' } });
  a.bindRun({ runId: 'r', repoRoot: '/repo-a' });
  a.syncTasks({ runId: 'r', tasks: [{ id: 't1', status: 'running' }, { id: 't2', status: 'running' }] });
  a.emit('invocation-start', { runId: 'r', taskId: 't1', invocationId: 'i1', agent: 'scout', modelId: 'qoder/Qwen' });
  a.emit('invocation-start', { runId: 'r', taskId: 't2', invocationId: 'i2', agent: 'scout', modelId: 'freetoken/Free' });
  a.emit('invocation-turn', { runId: 'r', taskId: 't1', invocationId: 'i1', turn: 8, turnCap: 24, toolCalls: 7 });
  a.emit('invocation-tool', { runId: 'r', taskId: 't1', invocationId: 'i1', tool: { name: 'read', file: 'D:/repo/src/app.js', args: 'SECRET' } });
  a.emit('invocation-extension', { runId: 'r', taskId: 't1', invocationId: 'i1', oldLimit: 24, newLimit: 32 });
  a.emit('candidate-changed', { runId: 'r', taskId: 't2', invocationId: 'i2', fromModel: 'qoder/Qwen', toModel: 'freetoken/Free', reason: 'MALFORMED_RESULT' });
  const live = a.getRunActivity('r');
  assert.equal(live.activeAgents, 2);
  assert.equal(live.activeInvocations.find(i => i.invocationId === 'i1').turnLimit, 32);
  assert.equal(live.activeInvocations.find(i => i.invocationId === 'i1').turnsUsed, 8);
  assert.equal(live.activeInvocations.find(i => i.invocationId === 'i1').toolCalls, 7);
  assert.deepEqual(live.activeInvocations.find(i => i.invocationId === 'i1').recentTools, [{ tool: 'read', summary: 'app.js' }]);
  assert.equal(live.activeInvocations.find(i => i.invocationId === 'i2').toModel, 'freetoken/Free');
  a.syncTasks({ runId: 'r', tasks: [{ id: 't1', status: 'running' }, { id: 't2', status: 'running' }] });
  assert.equal(a.getRunActivity('r').tasks.find(t => t.taskId === 't2').fallbackTo, 'freetoken/Free');
  a.emit('fallback', { runId: 'r', taskId: 't2', from: 'cheap-code', to: 'strong-code' });
  assert.equal(a.getRunActivity('r').tasks.find(t => t.taskId === 't2').capability, 'strong-code');
  assert.equal(createActivityTracker({ kit: tmpKit(), clientContext: { kind: 'pi-web', sessionId: 'session-b' } }).getRunActivityByClient('pi-web', 'session-b'), null);
  a.emit('invocation-end', { runId: 'r', taskId: 't1', invocationId: 'i1', status: 'finished' });
  assert.equal(a.getRunActivity('r').activeInvocations.length, 1);
  a.syncTasks({ runId: 'r', tasks: [{ id: 't1', status: 'completed' }, { id: 't2', status: 'running' }] });
  assert.equal(a.getRunActivity('r').completedTasks, 1);
  a.finishRun('r');
  assert.equal(a.getRunActivity('r').activeInvocations.length, 0);
});

test('stub E2E: binding appears at send, model/tool/turn update before completion, unrelated session stays hidden', async () => {
  const dir = tmpKit();
  const session = openStore(join(dir, 'state.db'));
  const activity = createActivityTracker({ kit: dir, clientContext: { kind: 'pi-web', sessionId: 'owner-uuid' } });
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const runner = createAgentRunner({ agents, routing, registry: { version: 1, backends: { qoder: { provider: 'qoder', model: 'Qwen3.8-Flash', thinking: 'low' } } }, repoRoot: dir,
    invoke: async () => { throw new Error('unexpected oneshot'); },
    runSubagent: async req => {
      req.onEvent('invocation-turn', { turn: 8, turnCap: 24, toolCalls: 7 });
      req.onEvent('invocation-tool', { tool: { name: 'read', file: join(dir, 'src', 'small.js') } });
      started.resolve(req.modelId);
      await release.promise;
      return { ok: true, text: '```json\n{"status":"completed","summary":"done","acceptance":[{"id":"A1","met":true,"evidence":"checked"}]}\n```', child: { turns: 8, toolCalls: 7 } };
    },
  });
  const running = orchestrate({ request: 'small read-only fixture', plan: [spec('t1', 'scout')], agents, routing,
    registry: { version: 1, backends: { qoder: { provider: 'qoder', model: 'Qwen3.8-Flash', thinking: 'low' } } }, policy: DEFAULT_POLICY, runner, session, activity, repoRoot: dir });
  const modelId = await started.promise;
  const id = session.listRuns()[0].id;
  const bound = readActivitySnapshot(activity.file);
  assert.equal(bound.runId, id);
  assert.equal(bound.activity.state, 'running');
  assert.equal(bound.activity.activeInvocations[0].modelId, modelId);
  assert.equal(bound.activity.activeInvocations[0].turnsUsed, 8);
  assert.equal(bound.activity.activeInvocations[0].turnLimit, 24);
  assert.deepEqual(bound.activity.activeInvocations[0].recentTools, [{ tool: 'read', summary: 'small.js' }]);
  const other = createActivityTracker({ kit: dir, clientContext: { kind: 'pi-web', sessionId: 'other-uuid' } });
  assert.equal(other.getRunActivityByClient('pi-web', 'other-uuid'), null);
  release.resolve();
  const result = await running;
  assert.equal(result.status, 'completed');
  assert.equal(readActivitySnapshot(activity.file).activity.activeInvocations.length, 0);
  assert.equal(readActivitySnapshot(activity.file).activity.completedTasks, 1);
  session.close();
});

test('pi JSON tool/turn events propagate while child is still running', async () => {
  const observed = [];
  const spawnImpl = () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => {};
    setImmediate(() => {
      proc.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: { path: 'src/a.js', secret: 'HIDDEN' } }) + '\n');
      proc.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: { path: 'src/a.js' } }] } }) + '\n');
      proc.stdout.write(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'read', result: { text: 'HIDDEN' } }) + '\n');
      proc.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }) + '\n');
      proc.emit('close', 0);
    });
    return proc;
  };
  const result = await runPiSubagent({ modelId: 'stub/model', cwd: tmpKit(), toolNames: ['read'], prompt: 'fixture', limits: { max_turns: 8 }, onEvent: (type, data) => observed.push({ type, data }) }, { piEntry: 'fake-cli', spawnImpl });
  assert.equal(result.ok, true);
  assert.ok(observed.some(e => e.type === 'invocation-tool' && e.data.tool.name === 'read'));
  assert.ok(observed.some(e => e.type === 'invocation-tool-completed'));
  assert.ok(observed.some(e => e.type === 'invocation-turn' && e.data.turn === 2 && e.data.toolCalls === 1));
  assert.ok(!JSON.stringify(observed).includes('HIDDEN'));
});

test('runtime tool telemetry retains only compact progress fields', async () => {
  const secret = 'PRIVATE_PAYLOAD_'.repeat(1000);
  const spawnImpl = () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => {};
    setImmediate(() => {
      const calls = [
        { toolCallId: 'write1', toolName: 'write', args: { path: 'src/a.js', content: secret } },
        { toolCallId: 'exec1', toolName: 'ludi_exec', args: { command: `echo ${secret}` } },
      ];
      for (const c of calls) {
        proc.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [
          { type: 'toolCall', name: c.toolName, arguments: c.args },
        ] } }) + '\n');
        proc.stdout.write(JSON.stringify({ type: 'tool_execution_start', ...c }) + '\n');
        proc.stdout.write(JSON.stringify({ type: 'tool_execution_end', toolCallId: c.toolCallId, toolName: c.toolName, isError: false }) + '\n');
      }
      proc.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }) + '\n');
      proc.emit('close', 0);
    });
    return proc;
  };
  const result = await runPiSubagent({ modelId: 'stub/model', cwd: tmpKit(), toolNames: ['write', 'ludi_exec'], prompt: 'fixture',
    limits: { max_turns: 10, max_tool_calls: 10 } }, { piEntry: 'fake-cli', spawnImpl });
  assert.equal(result.ok, true);
  assert.equal(result.telemetry.uniqueFilesInspected, 1);
  assert.equal(result.telemetry.commands.length, 1);
  assert.match(result.telemetry.commands[0], /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(result.telemetry).includes(secret));
});

test('turn extension requires fresh successful work, not failed or stale tool calls', async () => {
  const runTurns = async outcomes => {
    const spawnImpl = () => {
      const proc = new EventEmitter();
      proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => {};
      setImmediate(() => {
        outcomes.forEach((success, i) => {
          const path = 'src/same.js';
          proc.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [
            { type: 'toolCall', name: 'edit', arguments: { path } },
          ] } }) + '\n');
          proc.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolCallId: `t${i}`, toolName: 'edit', args: { path } }) + '\n');
          proc.stdout.write(JSON.stringify({ type: 'tool_execution_end', toolCallId: `t${i}`, toolName: 'edit', isError: !success }) + '\n');
        });
        proc.emit('close', 0);
      });
      return proc;
    };
    return runPiSubagent({ modelId: 'stub/model', cwd: tmpKit(), toolNames: ['edit'], prompt: 'fixture',
      limits: { max_turns: 2, extension_turns: 2, max_extensions: 2, absolute_max_turns: 6, max_tool_calls: 20 } },
    { piEntry: 'fake-cli', spawnImpl });
  };
  const failed = await runTurns([false, false, false, false]);
  assert.equal(failed.child.extensionsGranted, 0);
  assert.equal(failed.child.stopReason, 'no-progress-turn-limit');
  const stale = await runTurns([true, true, false, false, false]);
  assert.equal(stale.child.extensionsGranted, 1);
  assert.equal(stale.child.finalTurnLimit, 4);
  assert.equal(stale.child.stopReason, 'no-progress-turn-limit');
  const productive = await runTurns([true, true, true, true, true]);
  assert.equal(productive.child.extensionsGranted, 2);
  assert.equal(productive.child.finalTurnLimit, 6);
});

test('tool budget extends only for fresh progress and stops at the absolute ceiling', async () => {
  const observed = [];
  let kills = 0;
  const spawnImpl = () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => { kills++; };
    setImmediate(() => {
      for (let i = 1; i <= 6; i++) {
        proc.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [
          { type: 'toolCall', name: 'read', arguments: { path: `src/${i}.js` } },
        ] } }) + '\n');
        proc.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolCallId: `r${i}`, toolName: 'read', args: { path: `src/${i}.js` } }) + '\n');
        proc.stdout.write(JSON.stringify({ type: 'tool_execution_end', toolCallId: `r${i}`, toolName: 'read', isError: false }) + '\n');
      }
      proc.emit('close', 0);
    });
    return proc;
  };
  const result = await runPiSubagent({ modelId: 'stub/model', cwd: tmpKit(), toolNames: ['read'], prompt: 'fixture',
    limits: { max_turns: 20, max_tool_calls: 2, extension_tool_calls: 2, max_tool_extensions: 1, absolute_max_tool_calls: 4 },
    onEvent: (type, data) => observed.push({ type, data }) }, { piEntry: 'fake-cli', spawnImpl });
  assert.equal(result.ok, false);
  assert.equal(result.child.stopReason, 'tool-call-limit');
  assert.equal(result.child.finalToolLimit, 4);
  assert.equal(result.child.toolExtensionsGranted, 1);
  assert.equal(observed.filter(e => e.type === 'invocation-tool-extension').length, 1);
  assert.ok(kills > 0);
});

test('tool budget extends again when editing the same file in each interval', async () => {
  const observed = [];
  const spawnImpl = () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => {};
    setImmediate(() => {
      for (let i = 0; i < 6; i++) {
        proc.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [
          { type: 'toolCall', name: 'edit', arguments: { path: 'src/same.js' } },
        ] } }) + '\n');
        proc.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolCallId: `e${i}`, toolName: 'edit', args: { path: 'src/same.js' } }) + '\n');
        proc.stdout.write(JSON.stringify({ type: 'tool_execution_end', toolCallId: `e${i}`, toolName: 'edit', isError: false }) + '\n');
      }
      proc.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }) + '\n');
      proc.emit('close', 0);
    });
    return proc;
  };
  const result = await runPiSubagent({ modelId: 'stub/model', cwd: tmpKit(), toolNames: ['edit'], prompt: 'fixture',
    limits: { max_turns: 20, max_tool_calls: 2, extension_tool_calls: 2, max_tool_extensions: 2, absolute_max_tool_calls: 6 },
    onEvent: (type, data) => observed.push({ type, data }) }, { piEntry: 'fake-cli', spawnImpl });
  assert.equal(result.ok, true);
  assert.equal(result.child.toolExtensionsGranted, 2);
  assert.equal(result.child.finalToolLimit, 6);
});

test('failed edits do not justify extending the tool budget', async () => {
  const spawnImpl = () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => {};
    setImmediate(() => {
      for (let i = 0; i < 4; i++) {
        proc.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [
          { type: 'toolCall', name: 'edit', arguments: { path: 'src/same.js' } },
        ] } }) + '\n');
        proc.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolCallId: `f${i}`, toolName: 'edit', args: { path: 'src/same.js' } }) + '\n');
        proc.stdout.write(JSON.stringify({ type: 'tool_execution_end', toolCallId: `f${i}`, toolName: 'edit', isError: true }) + '\n');
      }
      proc.emit('close', 0);
    });
    return proc;
  };
  const result = await runPiSubagent({ modelId: 'stub/model', cwd: tmpKit(), toolNames: ['edit'], prompt: 'fixture',
    limits: { max_turns: 20, max_tool_calls: 2, extension_tool_calls: 2, max_tool_extensions: 2, absolute_max_tool_calls: 6 } },
  { piEntry: 'fake-cli', spawnImpl });
  assert.equal(result.child.stopReason, 'tool-call-limit');
  assert.equal(result.child.toolExtensionsGranted, 0);
});

test('tool budget refuses repeated commands without new files', async () => {
  const observed = [];
  const spawnImpl = () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => {};
    setImmediate(() => {
      for (let i = 0; i < 4; i++) {
        proc.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [
          { type: 'toolCall', name: 'ludi_exec', arguments: { command: 'same command' } },
        ] } }) + '\n');
        proc.stdout.write(JSON.stringify({ type: 'tool_execution_start', toolCallId: `x${i}`, toolName: 'ludi_exec', args: { command: 'same command' } }) + '\n');
        proc.stdout.write(JSON.stringify({ type: 'tool_execution_end', toolCallId: `x${i}`, toolName: 'ludi_exec', isError: false }) + '\n');
      }
      proc.emit('close', 0);
    });
    return proc;
  };
  const result = await runPiSubagent({ modelId: 'stub/model', cwd: tmpKit(), toolNames: ['ludi_exec'], prompt: 'fixture',
    limits: { max_turns: 20, max_tool_calls: 2, extension_tool_calls: 2, max_tool_extensions: 2, absolute_max_tool_calls: 6 },
    onEvent: (type, data) => observed.push({ type, data }) }, { piEntry: 'fake-cli', spawnImpl });
  assert.equal(result.child.toolExtensionsGranted, 0);
  assert.equal(result.child.stopReason, 'tool-call-limit');
});

test('sanitizeInvocationEvent drops payload details and bounds strings', () => {
  const e = sanitizeInvocationEvent('invocation-tool', {
    runId: 'r', taskId: 't', invocationId: 'i',
    tool: { name: 'exec', file: 'x.mjs', arguments: { command: 'rm -rf /' } },
    raw: 'SECRET', prompt: 'PROMPT', text: 'OUTPUT',
  });
  assert.equal(e.tool.name, 'exec');
  assert.equal(e.tool.file, 'x.mjs');
  assert.equal(e.tool.arguments, undefined);
  assert.equal(e.raw, undefined);
  assert.equal(e.prompt, undefined);
  assert.equal(e.text, undefined);
});
