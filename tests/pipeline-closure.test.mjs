// Direct-boundary and raw process-outcome regressions. No model/provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { toMarkdown } from '../lib/context-pack.mjs';
import { inspectPipelineGate, runPipeline, runTests } from '../lib/pipeline.mjs';
import { createAgentRunner } from '../lib/orchestrator/runner.mjs';

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const registry = { version: 1, backends: Object.fromEntries(Object.keys(routing.backends).map(key => [key, { provider: 'fixture', model: 'test' }])) };
const task = { id: 'a', assignedAgent: 'coder', capability: 'strong-code', title: 'fixture', goal: 'fixture', dependencies: [], acceptance: ['fixture'], outputs: [] };
const fileBlock = '=== FILE: main.txt ===\nSYNTHETIC_AGENT_CONTENT\n=== END ===';
function setup(t, { git = false, dirty = false, commands = ['node --test pass.test.mjs'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ludi-pipeline-closure-'));
  const repo = join(root, 'repo'); mkdirSync(repo);
  writeFileSync(join(repo, 'main.txt'), 'SYNTHETIC_COMMITTED_CONTENT\n');
  writeFileSync(join(repo, 'pass.test.mjs'), "import test from 'node:test';console.log('SYNTHETIC_STDOUT');test('fixture',()=>{});");
  writeFileSync(join(repo, 'fail.test.mjs'), "import test from 'node:test';test('fixture',()=>{throw new Error('SYNTHETIC_FAILURE');});");
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node marker.mjs' } }));
  writeFileSync(join(repo, 'marker.mjs'), "import {writeFileSync} from 'node:fs';writeFileSync('baseline-marker.txt','ran');");
  if (git) {
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
    }
  }
  if (dirty) writeFileSync(join(repo, 'main.txt'), 'SYNTHETIC_UNCOMMITTED_USER_WORK\n');
  const contextPack = { version: 1, task: 'fixture', goal: 'fixture', constraints: [], relevant_files: [{ path: 'main.txt' }], test_commands: commands, expected_output: 'fixture' };
  const packPath = join(root, 'pack.md'); writeFileSync(packPath, toMarkdown(contextPack));
  const outDir = join(root, 'output');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repo, outDir, packPath, contextPack };
}
function snapshot(repo) {
  const files = {};
  function walk(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name), key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(path, `${key}/`); else files[key] = readFileSync(path).toString('base64');
    }
  }
  walk(repo); return files;
}
const options = f => ({ repoRoot: f.repo, task: 'fixture', outDir: f.outDir, packPath: f.packPath, routing, registry, agents, maxAttempts: 1 });

test('direct dirty pipeline rejects before baseline/model/output writes, without caller checks or fake before snapshots', async t => {
  const f = setup(t, { git: true, dirty: true }); const before = snapshot(f.repo); let calls = 0;
  const result = await runPipeline({ ...options(f), dirtyContext: { before: { source: 'git', entries: {} } }, invoke: async () => { calls++; return { ok: true, text: fileBlock }; } });
  assert.equal(result.failureClass, 'USER_DECISION_REQUIRED'); assert.equal(calls, 0);
  assert.deepEqual(snapshot(f.repo), before); assert.equal(existsSync(f.outDir), false);
  assert.equal(existsSync(join(f.repo, 'baseline-marker.txt')), false);
  assert.deepEqual(result.executionAttempts, []); assert.deepEqual(result.verification, []);
});

test('direct clean pipeline succeeds; dirty approval keeps existing keyed proceed/abort semantics', async t => {
  const clean = setup(t, { git: true });
  assert.equal((await runPipeline({ ...options(clean), invoke: async () => ({ ok: true, text: fileBlock }) })).outcome, 'success');
  const dirty = setup(t, { git: true, dirty: true }); const before = snapshot(dirty.repo);
  const ask = inspectPipelineGate(dirty.repo); const key = ask.decision.key;
  for (const decision of [{ key: 'wrong-key', optionId: 'proceed' }, { key, optionId: 'abort' }]) {
    const result = await runPipeline({ ...options(dirty), dirtyContext: { decisions: [decision] }, invoke: async () => { throw new Error('must not launch'); } });
    assert.notEqual(result.outcome, 'success'); assert.deepEqual(snapshot(dirty.repo), before); assert.equal(existsSync(dirty.outDir), false);
  }
  const approved = await runPipeline({ ...options(dirty), dirtyContext: { decisions: [{ key, optionId: 'proceed' }] }, invoke: async () => ({ ok: true, text: fileBlock }) });
  assert.equal(approved.outcome, 'success'); assert.equal(readFileSync(join(dirty.repo, 'main.txt'), 'utf8'), 'SYNTHETIC_AGENT_CONTENT\n');
});

test('old CLI normal and dry-run paths reject dirty workspaces through the common gate', t => {
  const f = setup(t, { git: true, dirty: true }); const before = snapshot(f.repo);
  for (const extra of [[], ['--dry-run']]) {
    const result = spawnSync(process.execPath, [join(kit, 'scripts/run-pipeline.mjs'), '--repo', f.repo, '--task', 'fixture', '--out', f.outDir, '--pack', f.packPath, ...extra], {
      cwd: kit, encoding: 'utf8', timeout: 20000, env: { ...process.env, PI_CODING_AGENT_DIR: join(f.root, 'empty-agent-dir') },
    });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout); assert.equal(report.failureClass, 'USER_DECISION_REQUIRED');
    assert.equal(existsSync(f.outDir), false); assert.deepEqual(snapshot(f.repo), before);
  }
});

test('real process success/failure preserve exit, command and shell argv identity in saved verification', async t => {
  for (const [command, status, execution_status] of [['node --test pass.test.mjs', 0, 'completed_success'], ['node --test fail.test.mjs', 1, 'completed_failure']]) {
    const f = setup(t, { commands: [command] });
    const summary = await runPipeline({ ...options(f), invoke: async () => ({ ok: true, text: fileBlock }) });
    const saved = JSON.parse(readFileSync(join(f.outDir, 'trace.json'), 'utf8'));
    const record = saved.verification.at(-1);
    assert.equal(record.execution_status, execution_status); assert.equal(record.started, true);
    assert.equal(record.exit_code, status); assert.equal(record.status, status); assert.equal(record.signal, null);
    assert.equal(record.requested_command, command); assert.equal(record.actual_command, command);
    assert.equal(record.actual_command, record.invocation.argv.at(-1));
    assert.equal(record.result, status === 0 ? 'pass' : 'fail'); assert.equal(record.launch_error, null);
    assert.equal(typeof record.stdout, 'string'); assert.equal(typeof record.stderr, 'string');
    assert.ok(saved.executionAttempts.some(row => row.phase === 'baseline' && row.actual_command === 'npm test'));
    assert.deepEqual(summary.verification, saved.verification);
  }
  const f = setup(t); const command = '  node --test "pass.test.mjs"  ';
  const record = runTests(f.repo, command);
  assert.equal(record.ok, true); assert.equal(record.requested_command, command);
  assert.equal(record.actual_command, record.invocation.argv.at(-1)); assert.equal(record.actual_command, command);
});

test('launch failure keeps actual ENOENT diagnostic and never enters executed commandsRun', async t => {
  const f = setup(t);
  const missing = runTests(join(f.root, 'missing-cwd'), 'node --test pass.test.mjs');
  assert.equal(missing.execution_status, 'launch_failed'); assert.equal(missing.started, false);
  assert.equal(missing.exit_code, null); assert.equal(missing.actual_command, null);
  assert.match(missing.launch_error.code, /ENOENT|ENOTDIR/); assert.ok(missing.launch_error.message);
  const savedPath = process.env.PATH;
  try {
    const execute = createAgentRunner({ repoRoot: f.repo, outDir: f.outDir, agents, routing, registry, pipelineAgents: ['coder'], maxModelAttempts: 1,
      invoke: async req => {
        if (req.prompt.includes('Produce the Context Pack now')) return { ok: true, text: toMarkdown(f.contextPack) };
        process.env.PATH = ''; // only the post-apply shell cannot launch; baseline already finished
        return { ok: true, text: fileBlock };
      },
    });
    const result = await execute.run(task);
    assert.equal(result.result.status, 'failed'); assert.deepEqual(result.result.commandsRun, []);
    const record = result.result.verification[0];
    assert.equal(record.execution_status, 'launch_failed'); assert.equal(record.started, false);
    assert.equal(record.exit_code, null); assert.ok(record.launch_error.message); assert.equal(record.result, 'fail');
    const saved = JSON.parse(readFileSync(join(f.outDir, task.id, 'trace.json'), 'utf8'));
    assert.deepEqual(saved.verification[0], record);
    assert.deepEqual(result.verification, saved.verification);
    assert.deepEqual(result.executionAttempts, saved.executionAttempts);
    assert.deepEqual(result.baselineVerification, saved.baselineVerification);
  } finally { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; }
});

test('skipped and prevalidation-denied commands have no actual command or successful execution', async t => {
  const f = setup(t, { commands: [] }); rmSync(join(f.repo, 'package.json'));
  const noCommand = await runPipeline({ ...options(f), invoke: async () => ({ ok: true, text: fileBlock }) });
  assert.equal(noCommand.verification[0].execution_status, 'skipped');
  assert.equal(noCommand.verification[0].started, false); assert.equal(noCommand.verification[0].actual_command, null);
  assert.equal(noCommand.verification[0].exit_code, null); assert.equal(noCommand.verification[0].result, 'skipped');
  const denied = runTests(f.repo, 'git status; echo denied');
  assert.equal(denied.execution_status, 'not_started'); assert.equal(denied.started, false); assert.equal(denied.actual_command, null);
  assert.equal(denied.exit_code, null); assert.equal(denied.failureClass, 'POLICY_BLOCK');
});

test('timeout evidence remains started, unsuccessful and preserves signal/diagnostic (controlled subprocess result)', t => {
  const f = setup(t); const original = childProcess.spawnSync;
  try {
    childProcess.spawnSync = () => ({ pid: 123, status: null, signal: 'SIGTERM', stdout: 'partial', stderr: 'timeout', error: Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT' }) });
    syncBuiltinESMExports();
    const record = runTests(f.repo, 'node --test pass.test.mjs');
    assert.equal(record.execution_status, 'timeout'); assert.equal(record.started, true);
    assert.equal(record.ok, false); assert.equal(record.exit_code, null); assert.equal(record.signal, 'SIGTERM');
    assert.equal(record.error.code, 'ETIMEDOUT'); assert.equal(record.launch_error, null);
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
});

test('verification from a failed attempt is preserved in history, not left current after a later exception', async t => {
  const f = setup(t, { commands: ['node --test fail.test.mjs'] }); let calls = 0;
  const twoModels = { version: 1, backends: { devin: { provider: 'fixture', model: 'first' }, qoder: { provider: 'fixture', model: 'second' } } };
  const summary = await runPipeline({ ...options(f), registry: twoModels, maxAttempts: 2, invoke: async () => {
    if (++calls === 1) return { ok: true, text: fileBlock };
    throw new Error('SYNTHETIC_LATER_EXCEPTION');
  } });
  assert.notEqual(summary.outcome, 'success'); assert.deepEqual(summary.verification, []);
  assert.ok(summary.executionAttempts.some(v => v.execution_status === 'completed_failure' && v.exit_code === 1));
  assert.ok(summary.steps[0].verification.some(v => v.result === 'fail' && v.exit_code === 1));
  assert.match(summary.steps.at(-1).reason, /SYNTHETIC_LATER_EXCEPTION/);
});

test('normalizer command transformation keeps the original request separately from actual shell input', async t => {
  const f = setup(t);
  const requested = `node --test "${join(f.repo, 'pass.test.mjs').replace(/\\/g, '/')}"`;
  f.contextPack.test_commands = [requested]; writeFileSync(f.packPath, toMarkdown(f.contextPack));
  const summary = await runPipeline({ ...options(f), invoke: async () => ({ ok: true, text: fileBlock }) });
  assert.equal(summary.outcome, 'success');
  const saved = JSON.parse(readFileSync(join(f.outDir, 'trace.json'), 'utf8')).verification.at(-1);
  assert.equal(saved.requested_command, requested);
  assert.equal(saved.actual_command, process.platform === 'win32' ? 'node --test "pass.test.mjs"' : requested);
  assert.equal(saved.actual_command, saved.invocation.argv.at(-1));
  assert.equal(saved.execution_status, 'completed_success'); assert.equal(saved.exit_code, 0);
});

test('POLICY_BLOCK runner returns the complete saved baseline and denied-command evidence', async t => {
  for (const baseline of ['launch_failed', 'completed_success', 'skipped']) {
    const f = setup(t, { commands: ['git status | Select-String denied-evidence'] });
    if (baseline === 'skipped') rmSync(join(f.repo, 'package.json'));
    const originalPath = process.env.PATH, originalCache = process.env.NPM_CONFIG_CACHE;
    let calls = 0;
    try {
      if (baseline === 'launch_failed') process.env.PATH = join(f.root, 'missing-path');
      process.env.NPM_CONFIG_CACHE = join(f.root, 'npm-cache');
      const execute = createAgentRunner({ repoRoot: f.repo, outDir: f.outDir, agents, routing, registry,
        pipelineAgents: ['coder'], maxModelAttempts: 1, invoke: async () => {
          calls++; return { ok: true, text: toMarkdown(f.contextPack) };
        },
      });
      const returned = await execute.run(task);
      const saved = JSON.parse(readFileSync(join(f.outDir, task.id, 'trace.json'), 'utf8'));
      assert.equal(returned.ok, false); assert.equal(returned.failureClass, 'POLICY_BLOCK'); assert.equal(returned.abort, true);
      assert.equal(calls, 1, 'denied command prevents coder invocation');
      assert.deepEqual(returned.verification, saved.verification);
      assert.deepEqual(returned.executionAttempts, saved.executionAttempts);
      assert.deepEqual(returned.baselineVerification, saved.baselineVerification);
      assert.equal(returned.baselineVerification.execution_status, baseline);
      if (baseline === 'launch_failed') {
        assert.equal(returned.baselineVerification.started, false);
        assert.equal(returned.baselineVerification.exit_code, null);
        assert.equal(returned.baselineVerification.launch_error.code, 'ENOENT');
        assert.ok(returned.baselineVerification.launch_error.message);
      }
      const denied = returned.verification[0];
      assert.equal(denied.execution_status, 'not_started'); assert.equal(denied.started, false);
      assert.equal(denied.actual_command, null); assert.equal(denied.exit_code, null); assert.equal(denied.result, 'skipped');
      assert.equal(returned.executionAttempts.at(-1).phase, 'prevalidation');
      assert.equal(readFileSync(join(f.repo, 'main.txt'), 'utf8'), 'SYNTHETIC_COMMITTED_CONTENT\n');
    } finally {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      if (originalCache === undefined) delete process.env.NPM_CONFIG_CACHE; else process.env.NPM_CONFIG_CACHE = originalCache;
    }
  }
});
