import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { toMarkdown } from '../lib/context-pack.mjs';
import { normalizeContextPack } from '../lib/normalize.mjs';
import { coderPrompt, surveyRepo, applyFileBlocks, runTests, runPipeline } from '../lib/pipeline.mjs';
import { createAgentRunner } from '../lib/orchestrator/runner.mjs';

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const registry = { version: 1, backends: Object.fromEntries(Object.keys(routing.backends).map(key => [key, { provider: 'fixture', model: 'test' }])) };
const pack = (commands = []) => ({ version: 1, task: 'fixture', goal: 'fixture', constraints: [], relevant_files: [{ path: 'main.txt', reason: 'fixture' }], test_commands: commands, expected_output: 'fixture' });
const task = { id: 'a', assignedAgent: 'coder', capability: 'strong-code', title: 'fixture', goal: 'fixture', dependencies: [], acceptance: ['fixture'], outputs: [] };
function fixture(t, { packageTest = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ludi-pipeline-safety-'));
  const repo = join(root, 'repo'); mkdirSync(repo);
  writeFileSync(join(repo, 'main.txt'), 'baseline\n');
  if (packageTest !== null) writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'local-fixture', private: true, scripts: { test: packageTest } }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repo };
}
function invoker(contextPack) {
  const calls = [];
  return { calls, invoke: async req => {
    calls.push(req);
    return { ok: true, text: calls.length % 2 === 1 ? toMarkdown(contextPack) : '=== FILE: main.txt ===\ngenerated replacement\n=== END ===' };
  } };
}
function runner(repo, invoke) {
  return createAgentRunner({ repoRoot: repo, agents, routing, registry, invoke, pipelineAgents: ['coder'], maxModelAttempts: 1 });
}
const passTest = 'node -e "process.exit(0)"';
const failTest = 'node -e "process.exit(1)"';

test('pipeline commands are policy-checked before coder invocation or file application (scout and supplied pack)', async t => {
  const { root, repo } = fixture(t, { packageTest: passTest });
  const marker = join(root, 'outside-marker.txt');
  const command = process.platform === 'win32' ? "Set-Content -LiteralPath '../outside-marker.txt' -Value 'not a test'; exit 0" : "printf 'not a test' > ../outside-marker.txt";
  const contextPack = pack([command]);
  for (const source of ['scout', 'supplied']) {
    const { calls, invoke } = invoker(contextPack);
    const packPath = source === 'supplied' ? join(root, 'pack.md') : null;
    if (packPath) writeFileSync(packPath, toMarkdown(contextPack));
    const result = await runPipeline({ repoRoot: repo, agents, routing, registry, invoke, outDir: join(root, source), packPath });
    assert.equal(result.failureClass, 'POLICY_BLOCK');
    assert.equal(calls.length, source === 'scout' ? 1 : 0);
    assert.equal(readFileSync(join(repo, 'main.txt'), 'utf8'), 'baseline\n');
    assert.equal(existsSync(marker), false);
    assert.equal(result.verification[0].result, 'skipped');
  }
  for (const unsafe of [command, 'npm publish', 'git push', 'Remove-Item ../outside -Rec']) {
    assert.equal(runTests(repo, unsafe).failureClass, 'POLICY_BLOCK');
  }
  assert.equal(existsSync(marker), false);
});

test('relative traversal and sibling-prefix paths cannot leak into coder prompts or write outside', t => {
  const { root, repo } = fixture(t);
  const outside = join(root, 'repo-other'); mkdirSync(outside);
  const secret = join(outside, 'secret.txt'); writeFileSync(secret, 'SYNTHETIC_OUTSIDE_SENTINEL');
  const unsafe = ['../repo-other/secret.txt', '..\\repo-other\\secret.txt', secret];
  const input = { ...pack(), relevant_files: [...pack().relevant_files, ...unsafe.map(path => ({ path }))], relevant_snippets: [{ path: unsafe[0], content: 'fixture' }] };
  const normalized = normalizeContextPack(input, { repoRoot: repo });
  assert.deepEqual(normalized.errors, []);
  assert.deepEqual(normalized.pack.relevant_files.map(f => f.path), ['main.txt']);
  assert.equal(normalized.pack.relevant_snippets.length, 0);
  assert.equal(coderPrompt({ pack: normalized.pack, repoRoot: repo }).includes('SYNTHETIC_OUTSIDE_SENTINEL'), false);
  for (const path of unsafe) {
    assert.throws(() => coderPrompt({ pack: { ...pack(), relevant_files: [{ path }] }, repoRoot: repo }), /outside the repository/);
    assert.deepEqual(applyFileBlocks(repo, [{ path, content: 'unsafe' }], [{ path }]).rejected, [path]);
  }
  assert.equal(readFileSync(secret, 'utf8'), 'SYNTHETIC_OUTSIDE_SENTINEL');
  const created = applyFileBlocks(repo, [{ path: 'new/nested.txt', content: 'safe' }], [{ path: 'new/nested.txt' }]);
  assert.deepEqual(created.applied, ['new/nested.txt']);
  assert.equal(readFileSync(join(repo, 'new/nested.txt'), 'utf8'), 'safe\n');
});

test('junctions/symlinks cannot escape through existing or missing paths, including repository survey', t => {
  const { root, repo } = fixture(t);
  const outside = join(root, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'SYNTHETIC_OUTSIDE_SENTINEL');
  symlinkSync(outside, join(repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const path of ['linked/secret.txt', 'linked/new/sub/file.txt']) {
    const normalized = normalizeContextPack({ ...pack(), relevant_files: [...pack().relevant_files, { path }] }, { repoRoot: repo });
    assert.deepEqual(normalized.pack.relevant_files.map(f => f.path), ['main.txt']);
    assert.throws(() => coderPrompt({ pack: { ...pack(), relevant_files: [{ path }] }, repoRoot: repo }), /outside the repository/);
    assert.deepEqual(applyFileBlocks(repo, [{ path, content: 'unsafe' }], [{ path }]).rejected, [path]);
  }
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'SYNTHETIC_OUTSIDE_SENTINEL');
  assert.equal(existsSync(join(outside, 'new')), false);
  assert.equal(surveyRepo(repo).files.some(f => f.path.startsWith('linked')), false);
  mkdirSync(join(repo, 'inside'));
  symlinkSync(join(repo, 'inside'), join(repo, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(applyFileBlocks(repo, [{ path: 'alias/new.txt', content: 'safe' }], [{ path: 'alias/new.txt' }]).applied, ['alias/new.txt']);
  assert.equal(readFileSync(join(repo, 'inside/new.txt'), 'utf8'), 'safe\n');
});

test('pipeline dirty gate asks/aborts before baseline or model calls, honors proceed and tracks owned changes', async t => {
  const { repo } = fixture(t, { packageTest: 'node test-run.mjs' });
  writeFileSync(join(repo, 'test-run.mjs'), "import {writeFileSync} from 'node:fs';writeFileSync('test-marker.txt','ran');");
  const git = args => assert.equal(spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).status, 0);
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
  writeFileSync(join(repo, 'main.txt'), 'UNCOMMITTED_USER_WORK\n');
  const { calls, invoke } = invoker(pack(['npm test']));
  const execute = runner(repo, invoke);
  const ask = await execute.run(task);
  assert.equal(ask.failureClass, 'USER_DECISION_REQUIRED'); assert.equal(calls.length, 0);
  assert.equal(existsSync(join(repo, 'test-marker.txt')), false);
  const ctx = { dependencyResults: [], runDecisions: [{ key: ask.decision.key, optionId: 'abort' }] };
  const abort = await execute.run(task, ctx);
  assert.equal(abort.abort, true); assert.equal(calls.length, 0);
  assert.equal(readFileSync(join(repo, 'main.txt'), 'utf8'), 'UNCOMMITTED_USER_WORK\n');
  const proceed = await execute.run(task, { ...ctx, runDecisions: [{ key: ask.decision.key, optionId: 'proceed' }] });
  assert.equal(proceed.result.status, 'completed'); assert.equal(proceed.gate.action, 'proceed');
  assert.equal(calls.length, 2);
  const ownedPaths = proceed.worktree.agentChanges.map(change => change.path);
  assert.ok(ownedPaths.includes('main.txt')); assert.ok(ownedPaths.includes('test-marker.txt'));
  const retry = await execute.run({ ...task, id: 'b' }, { dependencyResults: [], ownedPaths });
  assert.equal(retry.result.status, 'completed'); assert.equal(calls.length, 4);
});

test('supplemental command cannot replace failing detected tests or produce a false pass', async t => {
  const { repo } = fixture(t, { packageTest: failTest });
  const { invoke } = invoker(pack(['git status']));
  const result = await runner(repo, invoke).run(task);
  assert.equal(result.result.status, 'failed');
  assert.deepEqual(result.result.verification.map(v => [v.command, v.result]), [['npm test', 'fail']]);
  assert.deepEqual(result.result.commandsRun, ['npm test']);
  assert.equal(result.result.summary.includes('passed'), false);
  assert.equal(result.worktree.agentChanges.some(change => change.path === 'main.txt'), true);
});

test('pipeline verification names the actual selected command when no default test command exists', async t => {
  const { repo } = fixture(t);
  writeFileSync(join(repo, 'check.test.mjs'), "import test from 'node:test';test('fixture',()=>{});");
  const command = 'node --test check.test.mjs';
  const { invoke } = invoker(pack([command]));
  const result = await runner(repo, invoke).run(task);
  assert.equal(result.result.status, 'completed');
  assert.deepEqual(result.result.verification.map(v => [v.command, v.result]), [[command, 'pass']]);
  assert.deepEqual(result.result.commandsRun, [command]);
  assert.ok(result.result.summary.includes(command));
  assert.equal(result.result.summary.includes('npm test'), false);
});
