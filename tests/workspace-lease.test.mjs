import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireWorkspaceLease, canonicalWorkspace } from '../lib/orchestrator/workspace-lease.mjs';
import { createAgentRunner } from '../lib/orchestrator/runner.mjs';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';

const fixture = fileURLToPath(new URL('./fixtures/workspace-lease-child.mjs', import.meta.url));
const setup = t => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-lease-test-'));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, workspace, lockDir: join(root, 'locks') };
};
function nextMessage(child) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { child.off('message', message); child.off('error', error); child.off('exit', exit); };
    const message = value => { cleanup(); resolve(value); };
    const error = value => { cleanup(); reject(value); };
    const exit = code => error(new Error(`fixture exited before message: ${code}`));
    child.once('message', message); child.once('error', error); child.once('exit', exit);
  });
}
function holder(t, workspace, lockDir) {
  const child = fork(fixture, [workspace, lockDir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
  return { child, exited, message: nextMessage(child) };
}

test('workspace aliases/subdirectories share ownership; other workspaces do not', t => {
  const { root, workspace, lockDir } = setup(t);
  mkdirSync(join(workspace, '.git')); mkdirSync(join(workspace, 'src'));
  const alias = join(root, 'alias'); symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const lease = acquireWorkspaceLease(workspace, { lockDir });
  try {
    assert.equal(canonicalWorkspace(alias), canonicalWorkspace(workspace));
    for (const path of [workspace, alias, join(workspace, 'src')]) {
      assert.throws(() => acquireWorkspaceLease(path, { lockDir }), { code: 'WORKSPACE_BUSY' });
    }
    const other = join(root, 'other'); mkdirSync(other);
    acquireWorkspaceLease(other, { lockDir }).release();
  } finally { lease.release(); }
  lease.release(); // idempotent, cannot release another owner's later token
  const next = acquireWorkspaceLease(alias, { lockDir });
  try { lease.release(); assert.throws(() => acquireWorkspaceLease(workspace, { lockDir }), { code: 'WORKSPACE_BUSY' }); }
  finally { next.release(); }
});

test('different processes contend, release, and recover only a dead owner', { timeout: 10000 }, async t => {
  const { workspace, lockDir } = setup(t);
  const first = holder(t, workspace, lockDir);
  assert.equal((await first.message).state, 'held');
  const second = holder(t, workspace, lockDir);
  assert.equal((await second.message).code, 'WORKSPACE_BUSY');
  await second.exited;
  const released = nextMessage(first.child); first.child.send('release');
  assert.equal((await released).state, 'released'); await first.exited;
  const crashed = holder(t, workspace, lockDir);
  assert.equal((await crashed.message).state, 'held');
  crashed.child.kill(); await crashed.exited;
  const recovered = acquireWorkspaceLease(workspace, { lockDir });
  recovered.release();
});

test('standard runner rejects a second writer before its baseline/child and releases after completion', async t => {
  const { workspace } = setup(t);
  const routing = loadRouting(fileURLToPath(new URL('../routing/routing.json', import.meta.url)));
  const { agents } = loadAgents(fileURLToPath(new URL('../agents', import.meta.url)), routing);
  const registry = { version: 1, backends: Object.fromEntries(Object.keys(routing.backends).map(key => [key, { provider: 'fixture', model: 'test' }])) };
  let start, release, writes = 0;
  const started = new Promise(resolve => { start = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const runner = createAgentRunner({ repoRoot: workspace, agents, routing, registry,
    invoke: async () => { throw new Error('unexpected oneshot'); },
    runSubagent: async () => {
      start(); await barrier;
      writeFileSync(join(workspace, 'shared.txt'), String(++writes));
      return { ok: true, text: JSON.stringify({ status: 'completed', summary: 'fixture', acceptance: [{ id: 'A1', met: true, evidence: 'write' }] }) };
    },
  });
  const task = { id: 'a', assignedAgent: 'coder', capability: 'strong-code', title: 'write', goal: 'write', dependencies: [], acceptance: ['write'], outputs: [] };
  const running = runner.run(task, { dependencyResults: [], runId: 'first' });
  try {
    await started;
    const refused = await runner.run({ ...task, id: 'b' }, { dependencyResults: [], runId: 'second' });
    assert.equal(refused.failureClass, 'POLICY_BLOCK'); assert.equal(refused.abort, true);
    assert.equal(writes, 0);
  } finally { release(); }
  assert.equal((await running).ok, true);
  assert.equal((await runner.run(task, { dependencyResults: [], runId: 'later' })).ok, true);
  assert.equal(readFileSync(join(workspace, 'shared.txt'), 'utf8'), '2');
});

test('standard runner releases a lease after a thrown child failure', async t => {
  const { workspace } = setup(t);
  const routing = loadRouting(fileURLToPath(new URL('../routing/routing.json', import.meta.url)));
  const { agents } = loadAgents(fileURLToPath(new URL('../agents', import.meta.url)), routing);
  const registry = { version: 1, backends: { sol: { provider: 'fixture', model: 'test' } } };
  const runner = createAgentRunner({ repoRoot: workspace, agents, routing, registry, maxModelAttempts: 1,
    invoke: async () => { throw new Error('unexpected oneshot'); }, runSubagent: async () => { throw new Error('fixture child failure'); },
  });
  const result = await runner.run({ id: 'a', assignedAgent: 'coder', capability: 'strong-code', title: 'write', goal: 'write', dependencies: [], acceptance: ['write'], outputs: [] });
  assert.equal(result.ok, false);
  acquireWorkspaceLease(workspace).release();
});
