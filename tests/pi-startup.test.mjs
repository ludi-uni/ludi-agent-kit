// Hermetic tests for adapters/pi/lib/startup-check.mjs.
// Every test uses temp fixtures and injected child-process mocks; none require the
// real pi CLI, pwsh, or the user's agent dir. The real offline check is opt-in via
// `node scripts/check-pi.mjs` (or tests/e2e-*) run by the operator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCheckArgs, isolatedEnv, syntheticSettings, validateLayout,
  validateCommands, validateState, validateStats, rpcProbe, runStartupCheck,
  EXPECTED_SKILLS, REQUESTS, removeIsolatedTree,
} from '../adapters/pi/lib/startup-check.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function responseFor(id, data) {
  return { id, type: 'response', command: REQUESTS.find(r => r.id === id).type, success: true, data };
}

function goodData() {
  return {
    'ludi-startup-commands': { commands: fixtureCommands(currentAgent) },
    'ludi-startup-state': { isStreaming: false, isCompacting: false, messageCount: 0, pendingMessageCount: 0 },
    'ludi-startup-stats': { userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 },
  };
}

let currentAgent = null;

/** Mock child process: writable stdin, pausable stdout, controllable lifetime. */
function fakeChild({ respond = 'auto', neverClose = false, exitCode = 0, onWrite = null } = {}) {
  const proc = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.writes = [];
  proc.stdin.write = chunk => { proc.stdin.writes.push(chunk); onWrite?.(chunk); return true; };
  proc.stdin.end = () => {
    proc.stdin.ended = true;
    if (!neverClose) queueMicrotask(() => proc.emit('close', exitCode, null));
    return proc.stdin;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdout.setEncoding = () => {};
  proc.stderr.setEncoding = () => {};
  proc.kill = signal => { proc.killed = signal; if (!neverClose) queueMicrotask(() => proc.emit('close', null, 'SIGTERM')); return true; };
  if (respond === 'auto') {
    proc.stdin.write = chunk => {
      proc.stdin.writes.push(chunk);
      onWrite?.(chunk);
      const req = JSON.parse(chunk);
      queueMicrotask(() => proc.stdout.emit('data', JSON.stringify(responseFor(req.id, goodData()[req.id])) + '\n'));
      return true;
    };
  }
  return proc;
}

const realSpawnSyncOk = () => ({ status: 0, stdout: '', stderr: '', error: null });

// ---- arg parsing ------------------------------------------------------------

test('parseCheckArgs accepts only documented flags', () => {
  assert.deepEqual(parseCheckArgs([]), { json: false, keepTemp: false, timeoutMs: 60000, help: false });
  assert.deepEqual(parseCheckArgs(['--json', '--keep-temp', '--timeout-ms=1000']), { json: true, keepTemp: true, timeoutMs: 1000, help: false });
  for (const bad of ['-ApplySettings', '--apply', '--foo', '--timeout-ms=abc', '--timeout-ms=-5', '--timeout-ms=0.5', '--timeout-ms=2147483648', '--json=x']) {
    assert.throws(() => parseCheckArgs([bad]), /usage/);
  }
});

// ---- isolated env -----------------------------------------------------------

test('isolatedEnv redirects all state into the temp root and never forwards credentials or parent pi env', () => {
  const env = {
    PATH: 'C:\\bin', SystemRoot: 'C:\\Windows',
    OPENAI_API_KEY: 'sk-secret', ANTHROPIC_API_KEY: 'x', HTTP_PROXY: 'http://p',
    PI_CODING_AGENT_DIR: 'C:\\real-agent', LUDI_PI_ENTRY: 'C:\\pi.js',
    HOME: 'C:\\Users\\real', USERPROFILE: 'C:\\Users\\real', APPDATA: 'C:\\real\\app',
  };
  const child = isolatedEnv(env, { agentDir: 'T:\\agent', root: 'T:\\root' });
  assert.equal(child.PATH, 'C:\\bin');
  assert.equal(child.PI_CODING_AGENT_DIR, 'T:\\agent');
  assert.equal(child.HOME, 'T:\\root');
  assert.equal(child.USERPROFILE, 'T:\\root');
  assert.equal(child.APPDATA, 'T:\\root\\appdata');
  assert.equal(child.PI_OFFLINE, '1');
  for (const k of Object.keys(env)) {
    if (/KEY|TOKEN|SECRET|PROXY|AUTH/i.test(k)) assert.ok(!(k in child), `${k} must not propagate`);
  }
  assert.ok(!('LUDI_PI_ENTRY' in child));
  for (const k of Object.keys(child)) {
    assert.ok(!/API_KEY|TOKEN|SECRET|PROXY|AUTH/i.test(k), `child env must not carry ${k}`);
  }
});

// ---- structural layout validation ------------------------------------------

test('validateLayout: full kit layout passes all checks', () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-pi-layout-'));
  try {
    const agent = join(root, 'agent');
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, 'AGENTS.md'), '<!-- Generated by ludi-agent-kit/adapters/pi/sync-pi.ps1; do not edit. -->\npolicy\n');
    mkdirSync(join(agent, 'skills')); mkdirSync(join(agent, 'agents')); mkdirSync(join(agent, 'extensions'));
    for (const s of EXPECTED_SKILLS) symlinkSync(join(kit, 'skills', s), join(agent, 'skills', s), 'junction');
    symlinkSync(join(kit, 'agents'), join(agent, 'agents', 'ludi-agent-kit'), 'junction');
    symlinkSync(join(kit, 'adapters', 'pi', 'loop-guard'), join(agent, 'extensions', 'ludi-agent-kit'), 'junction');
    symlinkSync(join(kit, 'adapters', 'pi', 'orchestrator-ext'), join(agent, 'extensions', 'ludi-orchestrator'), 'junction');
    const r = validateLayout(agent, kit);
    assert.deepEqual(r.errors, []);
    assert.ok(r.checks.every(c => c.status === 'pass'), r.checks.filter(c => c.status !== 'pass').map(c => `${c.name}: ${c.message}`).join('; '));
    assert.ok(r.evidence.agents.includes('coder') && r.evidence.agents.includes('scout'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validateLayout fails when a link is missing, an extra extension exists, or an extra agent dir is installed', () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-pi-layout-bad-'));
  try {
    const agent = join(root, 'agent');
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, 'AGENTS.md'), '<!-- Generated by ludi-agent-kit -->\n');
    mkdirSync(join(agent, 'skills')); mkdirSync(join(agent, 'agents')); mkdirSync(join(agent, 'extensions'));
    // missing skills, wrong agents link target, extra extension, second agents entry
    mkdirSync(join(agent, 'agents', 'other-agent'));
    mkdirSync(join(agent, 'extensions', 'unrelated-ext'));
    const r = validateLayout(agent, kit);
    const names = r.checks.filter(c => c.status === 'fail').map(c => c.name);
    for (const s of EXPECTED_SKILLS) assert.ok(names.includes(`link:skills/${s}`), `expected link:skills/${s} failure`);
    assert.ok(names.includes('link:agents/ludi-agent-kit'));
    assert.ok(names.includes('link:extensions/ludi-agent-kit'));
    assert.ok(names.includes('link:extensions/ludi-orchestrator'));
    assert.ok(names.includes('agents:exclusive'));
    assert.ok(names.includes('extensions:set'));
    assert.ok(r.errors.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- command validation -----------------------------------------------------

function fixtureCommands(agent) {
  return [
    { name: 'orchestrate', source: 'extension', sourceInfo: { path: join(agent, 'extensions', 'ludi-orchestrator', 'index.js') } },
    ...EXPECTED_SKILLS.map(s => ({ name: `skill:${s}`, source: 'skill', sourceInfo: { path: join(agent, 'skills', s, 'SKILL.md') } })),
    { name: 'llama', source: 'builtin' },
  ];
}

function withFixtureAgent(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ludi-pi-cmds-'));
  try {
    const agent = join(root, 'agent');
    mkdirSync(join(agent, 'skills'), { recursive: true });
    mkdirSync(join(agent, 'extensions'), { recursive: true });
    for (const s of EXPECTED_SKILLS) symlinkSync(join(kit, 'skills', s), join(agent, 'skills', s), 'junction');
    symlinkSync(join(kit, 'adapters', 'pi', 'orchestrator-ext'), join(agent, 'extensions', 'ludi-orchestrator'), 'junction');
    return fn(agent);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('validateCommands accepts the expected orchestrate + three skills and ignores extra builtins', () => {
  withFixtureAgent(agent => {
    const r = validateCommands(fixtureCommands(agent), { agentDir: agent, kitRoot: kit });
    assert.deepEqual(r.errors, []);
    assert.equal(r.evidence.length, 4);
    assert.ok(r.commandNames.includes('llama'));
  });
});

test('validateCommands fails on missing, duplicated, wrong-source or wrong-path registrations', () => {
  withFixtureAgent(agent => {
    const base = fixtureCommands(agent);
    for (const mutate of [
      c => c.filter(x => x.name !== 'orchestrate'),
      c => [...c, { ...c[0] }],
      c => c.map(x => x.name === 'orchestrate' ? { ...x, source: 'prompt' } : x),
      c => c.map(x => x.name === 'orchestrate' ? { ...x, sourceInfo: { path: join(kit, 'adapters', 'pi', 'orchestrator-ext', 'index.js') } } : x),
      c => c.filter(x => x.name !== 'skill:pi-workflow'),
      c => c.map(x => x.name === 'skill:visual-verification' ? { ...x, sourceInfo: { path: join(agent, 'skills', 'pi-workflow') } } : x),
    ]) {
      const r = validateCommands(mutate(base), { agentDir: agent, kitRoot: kit });
      assert.ok(r.errors.length > 0, `expected failure for ${mutate.toString().slice(0, 60)}: ${JSON.stringify(r.evidence)}`);
    }
  });
});

// ---- state/stats validation -------------------------------------------------

test('validateState requires idle with no messages and no session file', () => {
  assert.deepEqual(validateState({ isStreaming: false, isCompacting: false, messageCount: 0, pendingMessageCount: 0 }).errors, []);
  for (const bad of [
    { isStreaming: true, isCompacting: false, messageCount: 0, pendingMessageCount: 0 },
    { isStreaming: false, isCompacting: true, messageCount: 0, pendingMessageCount: 0 },
    { isStreaming: false, isCompacting: false, messageCount: 1, pendingMessageCount: 0 },
    { isStreaming: false, isCompacting: false, messageCount: 0, pendingMessageCount: 2 },
    { isStreaming: false, isCompacting: false, messageCount: 0, pendingMessageCount: 0, sessionFile: 'x.jsonl' },
    {},
  ]) {
    assert.ok(validateState(bad).errors.length > 0, JSON.stringify(bad));
  }
});

test('validateStats requires zero messages, tools, tokens and cost', () => {
  const zero = { userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
  assert.deepEqual(validateStats(zero).errors, []);
  for (const bad of [
    { ...zero, userMessages: 1 },
    { ...zero, toolCalls: 3 },
    { ...zero, tokens: { ...zero.tokens, output: 5 } },
    { ...zero, cost: 0.01 },
    { ...zero, contextUsage: { tokens: 100 } },
    { ...zero, tokens: undefined },
    { ...zero, tokens: { input: 0 } },
    { ...zero, tokens: { ...zero.tokens, reasoning: 1 } },
    { ...zero, cost: undefined },
  ]) {
    assert.ok(validateStats(bad).errors.length > 0, JSON.stringify(bad));
  }
});

// ---- RPC probe driver --------------------------------------------------------

test('rpcProbe: happy path returns three correlated responses and clean exit', async () => {
  const agent = 'fake';
  currentAgent = agent;
  const proc = fakeChild();
  const r = await rpcProbe(proc, { timeoutMs: 2000, killGraceMs: 50 });
  assert.deepEqual(r.errors, []);
  assert.equal(r.responses.size, 3);
  assert.equal(r.exit.code, 0);
  assert.equal(r.killed, false);
});

test('rpcProbe tolerates arbitrary chunk boundaries and CRLF', async () => {
  currentAgent = 'fake';
  const responses = REQUESTS.map(r => JSON.stringify(responseFor(r.id, goodData()[r.id]))).join('\r\n') + '\r\n';
  const chunks = [];
  for (let i = 0; i < responses.length; i += 7) chunks.push(responses.slice(i, i + 7));
  const proc = fakeChild({ respond: 'manual' });
  const p = rpcProbe(proc, { timeoutMs: 2000, killGraceMs: 50 });
  for (const chunk of chunks) proc.stdout.emit('data', chunk);
  proc.stdin.end();
  const r = await p;
  assert.equal(r.responses.size, 3);
  assert.deepEqual(r.errors, []);
});

test('rpcProbe fails on malformed JSON, unknown ids, command mismatch and duplicates', async () => {
  for (const record of [
    'not json{',
    JSON.stringify({ id: 'bogus', type: 'response', command: 'get_commands', success: true }),
    JSON.stringify({ id: 'ludi-startup-commands', type: 'response', command: 'get_state', success: true }),
  ]) {
    const proc = fakeChild({ respond: 'manual' });
    const p = rpcProbe(proc, { timeoutMs: 2000, killGraceMs: 50 });
    proc.stdout.emit('data', record + '\n');
    proc.stdin.end();
    const r = await p;
    assert.ok(r.errors.length > 0, record);
    assert.ok(r.unexpected.length > 0);
  }
  // duplicate response
  const proc = fakeChild({ respond: 'manual' });
  const p = rpcProbe(proc, { timeoutMs: 2000, killGraceMs: 50 });
  const rec = JSON.stringify(responseFor('ludi-startup-commands', { commands: [] }));
  proc.stdout.emit('data', rec + '\n' + rec + '\n');
  proc.stdin.end();
  const r = await p;
  assert.ok(r.errors.some(e => e.includes('重複')), r.errors.join(';'));
});

test('rpcProbe reports early exit before all responses and nonzero exit', async () => {
  const proc = fakeChild({ respond: 'manual' });
  const p = rpcProbe(proc, { timeoutMs: 2000, killGraceMs: 50 });
  proc.emit('close', 2, null);
  const r = await p;
  assert.ok(r.errors.some(e => e.includes('終了')), r.errors.join(';'));
  assert.equal(r.exit.code, 2);
});

test('rpcProbe fails on success:false responses', async () => {
  const proc = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = () => true;
  proc.stdin.end = () => queueMicrotask(() => proc.emit('close', 0, null));
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
  proc.stdout.setEncoding = proc.stderr.setEncoding = () => {};
  proc.kill = () => true;
  const p = rpcProbe(proc, { timeoutMs: 2000, killGraceMs: 50 });
  proc.stdout.emit('data', JSON.stringify({ id: 'ludi-startup-commands', type: 'response', command: 'get_commands', success: false, error: 'boom' }) + '\n');
  proc.stdin.end();
  const r = await p;
  assert.ok(r.errors.some(e => e.includes('boom')), r.errors.join(';'));
});

test('rpcProbe terminates the child on activity records and on timeout', async () => {
  // activity record
  const proc = fakeChild({ respond: 'manual', neverClose: true });
  const p = rpcProbe(proc, { timeoutMs: 2000, killGraceMs: 30 });
  proc.stdout.emit('data', JSON.stringify({ type: 'agent_start' }) + '\n');
  const r = await p;
  assert.equal(r.killed, true);
  assert.ok(r.errors.some(e => e.includes('アクティビティ')));
  // timeout
  const proc2 = fakeChild({ respond: 'manual', neverClose: true });
  proc2.kill = () => { queueMicrotask(() => proc2.emit('close', null, 'SIGKILL')); return true; };
  const r2 = await rpcProbe(proc2, { timeoutMs: 80, killGraceMs: 30 });
  assert.equal(r2.timedOut, true);
  assert.equal(r2.killed, true);
});

test('rpcProbe bounds stdout/stderr and kills on overflow', async () => {
  const proc = fakeChild({ respond: 'manual', neverClose: true });
  const p = rpcProbe(proc, { timeoutMs: 5000, killGraceMs: 30, maxStdoutBytes: 100 });
  proc.stdout.emit('data', 'x'.repeat(200));
  const r = await p;
  assert.equal(r.outputOverflow, true);
  assert.equal(r.killed, true);
  const proc2 = fakeChild({ respond: 'manual', neverClose: true });
  const p2 = rpcProbe(proc2, { timeoutMs: 5000, killGraceMs: 30, maxStderrBytes: 10 });
  proc2.stderr.emit('data', 'e'.repeat(50));
  const r2 = await p2;
  assert.ok(r2.errors.some(e => e.includes('stderr')));
});

test('rpcProbe counts UTF-8 bytes and rejects an unterminated final record', async () => {
  const proc = fakeChild({ respond: 'manual' });
  const p = rpcProbe(proc, { timeoutMs: 1000, killGraceMs: 10, maxStdoutBytes: 100 });
  proc.stdout.emit('data', 'あ'.repeat(40)); // 120 bytes, not 40 bytes
  assert.equal((await p).outputOverflow, true);
  const truncated = fakeChild({ respond: 'manual' });
  const pending = rpcProbe(truncated, { timeoutMs: 1000, killGraceMs: 10 });
  truncated.stdout.emit('data', JSON.stringify(responseFor(REQUESTS[0].id, {})));
  truncated.emit('close', 0, null);
  assert.ok((await pending).errors.some(e => e.includes('LF')));
});

test('rpcProbe handles spawn errors without leaving timers running', async () => {
  const proc = fakeChild({ respond: 'manual' });
  const pending = rpcProbe(proc, { timeoutMs: 1000, killGraceMs: 10 });
  proc.emit('error', new Error('injected spawn failure'));
  const result = await pending;
  assert.ok(result.errors.some(e => e.includes('injected spawn failure')));
});

test('rpcProbe retains Unicode separators within JSON strings', async () => {
  currentAgent = 'fake';
  const proc = fakeChild({ respond: 'manual' });
  const pending = rpcProbe(proc, { timeoutMs: 1000, killGraceMs: 10 });
  for (const req of REQUESTS) proc.stdout.emit('data', JSON.stringify({ ...responseFor(req.id, goodData()[req.id]), note: 'line\u2028paragraph\u2029intact' }) + '\n');
  const result = await pending;
  assert.deepEqual(result.errors, []);
  assert.equal(result.responses.size, 3);
});

function populateLayout(_command, args) {
  assert.ok(args.includes('-Apply') && !args.includes('-ApplySettings'));
  const agent = args[args.indexOf('-AgentDir') + 1];
  currentAgent = agent;
  for (const name of ['skills', 'agents', 'extensions']) mkdirSync(join(agent, name), { recursive: true });
  writeFileSync(join(agent, 'AGENTS.md'), '<!-- Generated by ludi-agent-kit -->\n');
  for (const skill of EXPECTED_SKILLS) symlinkSync(join(kit, 'skills', skill), join(agent, 'skills', skill), 'junction');
  symlinkSync(join(kit, 'agents'), join(agent, 'agents', 'ludi-agent-kit'), 'junction');
  symlinkSync(join(kit, 'adapters/pi/loop-guard'), join(agent, 'extensions/ludi-agent-kit'), 'junction');
  symlinkSync(join(kit, 'adapters/pi/orchestrator-ext'), join(agent, 'extensions/ludi-orchestrator'), 'junction');
  return { status: 0, stdout: '', stderr: '' };
}

test('runStartupCheck refuses to adopt a nonempty directory without modifying it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-check-unowned-'));
  try {
    writeFileSync(join(root, 'sentinel'), 'preserve');
    const report = await runStartupCheck({ platform: 'win32', piEntry: 'fixture', tmpRoot: root,
      spawnSyncImpl: () => { throw new Error('must not launch'); } });
    assert.equal(report.ok, false);
    assert.ok(report.errors.some(e => e.includes('tmpRoot')));
    assert.equal(existsSync(join(root, 'sentinel')), true);
    assert.equal(existsSync(join(root, 'agent')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed layout is cleaned up before any Pi process can load its extensions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-check-bad-layout-'));
  const report = await runStartupCheck({ platform: 'win32', piEntry: 'fixture', tmpRoot: root,
    spawnSyncImpl: realSpawnSyncOk, spawnImpl: () => { throw new Error('must not launch'); } });
  assert.equal(report.ok, false);
  assert.equal(report.cleanup.tempRootRemoved, true);
  assert.equal(existsSync(root), false);
});

test('cleanup failure cannot produce a successful report', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-check-cleanup-fail-'));
  const originalRm = fs.rmSync;
  fs.rmSync = (path, ...args) => { if (path === root) throw new Error('injected cleanup failure'); return originalRm(path, ...args); };
  syncBuiltinESMExports();
  try {
    const report = await runStartupCheck({ platform: 'win32', piEntry: 'fixture', tmpRoot: root,
      spawnSyncImpl: populateLayout, spawnImpl: () => fakeChild(), timeoutMs: 1000 });
    assert.equal(report.ok, false);
    assert.equal(report.cleanup.tempRootRemoved, false);
    assert.match(report.cleanup.error, /injected cleanup failure/);
  } finally { fs.rmSync = originalRm; syncBuiltinESMExports(); originalRm(root, { recursive: true, force: true }); }
});

test('cleanup refuses a replaced root junction without following its target', () => {
  const parent = mkdtempSync(join(tmpdir(), 'ludi-check-root-link-'));
  const target = join(parent, 'target');
  mkdirSync(target);
  writeFileSync(join(target, 'sentinel'), 'preserve');
  const link = join(parent, 'link');
  symlinkSync(target, link, 'junction');
  try {
    assert.throws(() => removeIsolatedTree(link), /削除を拒否/);
    assert.equal(existsSync(join(target, 'sentinel')), true);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

// ---- runStartupCheck orchestration ------------------------------------------

test('runStartupCheck fails explicitly on non-Windows platforms', async () => {
  const r = await runStartupCheck({ platform: 'linux', spawnImpl: () => fakeChild(), spawnSyncImpl: realSpawnSyncOk });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('Windows')));
});

test('runStartupCheck fails explicitly when pi entry is missing', async () => {
  const r = await runStartupCheck({ platform: 'win32', piEntry: null, env: { PATH: '' }, spawnSyncImpl: realSpawnSyncOk });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('pi CLI')));
});

test('runStartupCheck fails when sync-pi.ps1 exits nonzero (spawnSync error and status)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-check-run-'));
  const root2 = mkdtempSync(join(tmpdir(), 'ludi-check-run-'));
  try {
    const base = { kitRoot: kit, platform: 'win32', piEntry: join(root, 'fake.js'), env: {}, tmpRoot: root, keepTemp: true, timeoutMs: 2000 };
    const r1 = await runStartupCheck({ ...base, spawnSyncImpl: () => ({ status: 3, stderr: 'conflict', stdout: '' }), spawnImpl: () => fakeChild() });
    assert.equal(r1.ok, false);
    assert.ok(r1.errors.some(e => e.includes('status=3')));
    const r2 = await runStartupCheck({ ...base, tmpRoot: root2, spawnSyncImpl: () => ({ error: new Error('spawn pwsh ENOENT'), status: null }), spawnImpl: () => fakeChild() });
    assert.equal(r2.ok, false);
    assert.ok(r2.errors.some(e => e.includes('pwsh')));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

test('runStartupCheck happy path with fully mocked sync + RPC', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-check-happy-'));
  try {
    const agent = join(root, 'agent');
    // populate as -Apply would, since sync is mocked
    const syncImpl = () => {
      mkdirSync(join(agent, 'skills'), { recursive: true });
      mkdirSync(join(agent, 'agents'), { recursive: true });
      mkdirSync(join(agent, 'extensions'), { recursive: true });
      writeFileSync(join(agent, 'AGENTS.md'), '<!-- Generated by ludi-agent-kit/adapters/pi/sync-pi.ps1; do not edit. -->\n');
      for (const s of EXPECTED_SKILLS) symlinkSync(join(kit, 'skills', s), join(agent, 'skills', s), 'junction');
      symlinkSync(join(kit, 'agents'), join(agent, 'agents', 'ludi-agent-kit'), 'junction');
      symlinkSync(join(kit, 'adapters', 'pi', 'loop-guard'), join(agent, 'extensions', 'ludi-agent-kit'), 'junction');
      symlinkSync(join(kit, 'adapters', 'pi', 'orchestrator-ext'), join(agent, 'extensions', 'ludi-orchestrator'), 'junction');
      return { status: 0, stdout: '', stderr: '' };
    };
    currentAgent = agent;
    const r = await runStartupCheck({
      kitRoot: kit, platform: 'win32', piEntry: join(root, 'fake-pi.js'), env: {},
      tmpRoot: root, keepTemp: true, timeoutMs: 3000, killGraceMs: 50,
      spawnSyncImpl: syncImpl, spawnImpl: () => fakeChild(),
    });
    assert.deepEqual(r.errors, [], JSON.stringify(r.checks.filter(c => c.status === 'fail'), null, 2));
    assert.equal(r.ok, true);
    assert.equal(r.cleanup.kept, true);
    assert.ok(r.checks.some(c => c.name === 'cmd:orchestrate' && c.status === 'pass'));
    assert.ok(r.limitations.some(l => l.includes('pi-subagents')));
    // keepTemp means the agent dir remains for inspection
    assert.ok(existsSync(agent));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runStartupCheck default cleanup removes only the owned temp root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-check-clean-'));
  const agent = join(root, 'agent');
  const syncImpl = () => {
    mkdirSync(join(agent, 'skills'), { recursive: true });
    mkdirSync(join(agent, 'agents'), { recursive: true });
    mkdirSync(join(agent, 'extensions'), { recursive: true });
    writeFileSync(join(agent, 'AGENTS.md'), '<!-- Generated by ludi-agent-kit -->\n');
    for (const s of EXPECTED_SKILLS) symlinkSync(join(kit, 'skills', s), join(agent, 'skills', s), 'junction');
    symlinkSync(join(kit, 'agents'), join(agent, 'agents', 'ludi-agent-kit'), 'junction');
    symlinkSync(join(kit, 'adapters', 'pi', 'loop-guard'), join(agent, 'extensions', 'ludi-agent-kit'), 'junction');
    symlinkSync(join(kit, 'adapters', 'pi', 'orchestrator-ext'), join(agent, 'extensions', 'ludi-orchestrator'), 'junction');
    return { status: 0, stdout: '', stderr: '' };
  };
  currentAgent = agent;
  const r = await runStartupCheck({
    kitRoot: kit, platform: 'win32', piEntry: join(root, 'fake-pi.js'), env: {},
    tmpRoot: root, keepTemp: false, timeoutMs: 3000, killGraceMs: 50,
    spawnSyncImpl: syncImpl, spawnImpl: () => fakeChild(),
  });
  assert.equal(r.ok, true);
  assert.equal(r.cleanup.tempRootRemoved, true);
  assert.equal(existsSync(root), false);
  // kit tree untouched: links were junctions, removal must not follow them
  assert.ok(existsSync(join(kit, 'skills', 'pi-workflow', 'SKILL.md')));
});

test('runStartupCheck fails on nonzero usage even when registrations are correct', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-check-usage-'));
  try {
    const agent = join(root, 'agent');
    const syncImpl = () => {
      mkdirSync(join(agent, 'skills'), { recursive: true });
      mkdirSync(join(agent, 'agents'), { recursive: true });
      mkdirSync(join(agent, 'extensions'), { recursive: true });
      writeFileSync(join(agent, 'AGENTS.md'), '<!-- Generated by ludi-agent-kit -->\n');
      for (const s of EXPECTED_SKILLS) symlinkSync(join(kit, 'skills', s), join(agent, 'skills', s), 'junction');
      symlinkSync(join(kit, 'agents'), join(agent, 'agents', 'ludi-agent-kit'), 'junction');
      symlinkSync(join(kit, 'adapters', 'pi', 'loop-guard'), join(agent, 'extensions', 'ludi-agent-kit'), 'junction');
      symlinkSync(join(kit, 'adapters', 'pi', 'orchestrator-ext'), join(agent, 'extensions', 'ludi-orchestrator'), 'junction');
      return { status: 0, stdout: '', stderr: '' };
    };
    currentAgent = agent;
    const badStats = () => {
      const data = goodData();
      data['ludi-startup-stats'].toolCalls = 2;
      data['ludi-startup-stats'].tokens.output = 42;
      const proc = fakeChild();
      const origWrite = proc.stdin.write;
      proc.stdin.write = chunk => {
        const req = JSON.parse(chunk);
        queueMicrotask(() => proc.stdout.emit('data', JSON.stringify(responseFor(req.id, data[req.id])) + '\n'));
        return true;
      };
      return proc;
    };
    const r = await runStartupCheck({
      kitRoot: kit, platform: 'win32', piEntry: join(root, 'fake-pi.js'), env: {},
      tmpRoot: root, keepTemp: true, timeoutMs: 3000, killGraceMs: 50,
      spawnSyncImpl: syncImpl, spawnImpl: badStats,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('stats:tokens')) || r.errors.some(e => e.includes('stats:counts')), r.errors.join(';'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runStartupCheck fails when child writes to stderr or exits nonzero', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-check-stderr-'));
  try {
    const agent = join(root, 'agent');
    const syncImpl = () => {
      mkdirSync(join(agent, 'skills'), { recursive: true });
      mkdirSync(join(agent, 'agents'), { recursive: true });
      mkdirSync(join(agent, 'extensions'), { recursive: true });
      writeFileSync(join(agent, 'AGENTS.md'), '<!-- Generated by ludi-agent-kit -->\n');
      for (const s of EXPECTED_SKILLS) symlinkSync(join(kit, 'skills', s), join(agent, 'skills', s), 'junction');
      symlinkSync(join(kit, 'agents'), join(agent, 'agents', 'ludi-agent-kit'), 'junction');
      symlinkSync(join(kit, 'adapters', 'pi', 'loop-guard'), join(agent, 'extensions', 'ludi-agent-kit'), 'junction');
      symlinkSync(join(kit, 'adapters', 'pi', 'orchestrator-ext'), join(agent, 'extensions', 'ludi-orchestrator'), 'junction');
      return { status: 0, stdout: '', stderr: '' };
    };
    currentAgent = agent;
    const noisy = () => {
      const proc = fakeChild();
      queueMicrotask(() => proc.stderr.emit('data', 'extension load warning\n'));
      return proc;
    };
    const r = await runStartupCheck({
      kitRoot: kit, platform: 'win32', piEntry: join(root, 'fake-pi.js'), env: {},
      tmpRoot: root, keepTemp: true, timeoutMs: 3000, killGraceMs: 50,
      spawnSyncImpl: syncImpl, spawnImpl: noisy,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('stderr')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
