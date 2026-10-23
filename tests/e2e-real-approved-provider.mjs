// Opt-in live acceptance driver: node tests/e2e-real-approved-provider.mjs <kit-root> <qoder|devin>
// Consumes provider quota. Explicit user approval is required; never part of automatic tests.
// No user settings are written. All work is performed in a disposable fixture repository.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadRouting } from '../lib/routing.mjs';
import { loadPiRegistry } from '../adapters/pi/lib/model-registry.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { formatModelId } from '../lib/resolve.mjs';
import { loadPolicy, mergePolicy } from '../lib/orchestrator/policy.mjs';
import { openStore } from '../lib/orchestrator/store.mjs';
import { createHealthMonitor } from '../lib/orchestrator/health.mjs';
import { createAgentRunner } from '../lib/orchestrator/runner.mjs';
import { orchestrate, formatReport } from '../lib/orchestrator/orchestrator.mjs';
import { createPiSubagentRunner } from '../adapters/pi/lib/subagent.mjs';

assert.ok(process.argv[2] && process.argv[3], 'usage: node tests/e2e-real-approved-provider.mjs <kit-root> <qoder|devin> (requires user approval)');
const kit = resolve(process.argv[2]);
const backend = process.argv[3];
assert.ok(['qoder', 'devin'].includes(backend));
const sourceRouting = loadRouting(join(kit, 'routing/routing.json'));
const { registry: sourceRegistry } = loadPiRegistry(kit, sourceRouting);
const binding = sourceRegistry.backends[backend];
assert.ok(binding?.provider && binding?.model, 'selected model is not bound');
assert.ok(backend === 'qoder'
  ? /^qoder(?:-bridge)?$/.test(binding.provider) && binding.model === 'Qwen3.8-Flash'
  : binding.provider === 'devin' && /^swe-2(?:-high)?$/.test(binding.model), 'binding is outside user-approved models');
const expectedModel = formatModelId(binding);
const routing = structuredClone(sourceRouting);
routing.backends = { [backend]: routing.backends[backend] };
for (const capability of Object.values(routing.capabilities)) {
  capability.primary = backend;
  capability.fallback = [];
}
routing.escalation = { ladders: {} };
const registry = { ...sourceRegistry, backends: { [backend]: binding } };
// Load normal agent contracts before restricting runtime candidates.
const { agents, errors } = loadAgents(join(kit, 'agents'), sourceRouting);
assert.deepEqual(errors, []);
const root = mkdtempSync(join(tmpdir(), `ludi-approved-${backend}-`));
const repo = join(root, 'repo');
cpSync(join(kit, 'tests/fixtures/math-repo'), repo, { recursive: true });
for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', 'commit', '-qm', 'fixture']]) {
  const git = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
}
const test = () => spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], { cwd: repo, encoding: 'utf8', shell: process.platform === 'win32', timeout: 30000 });
const baseline = test();
assert.notEqual(baseline.status, 0, 'fixture must initially fail');
writeFileSync(join(root, 'baseline.log'), baseline.stdout + baseline.stderr);
const plan = [
  { id: 't1', title: 'Find the average() defect', goal: 'Read src/math.js and test/math.test.js. Deliberately reproduce the known failing average() test by running node --test test/math.test.js through ludi_exec. Name the file, function and root cause. Report its raw fail result with purpose reproduction and expected_result fail, and link command_result evidence to A2 as required by EXPECTED_FAILURE_REPRODUCTION. Do not edit files.', agent: 'scout', kind: 'investigate', dependencies: [], acceptance: ['the file and function are named', 'the cause is stated from source and the known failing test is deliberately reproduced'] },
  { id: 't2', title: 'Fix average()', goal: 'Change average() in src/math.js so it divides by values.length. Do not change tests or unrelated files.', agent: 'coder', kind: 'implement', dependencies: ['t1'], acceptance: ['src/math.js divides by values.length', 'no other source file was rewritten'] },
  { id: 't3', title: 'Run the tests', goal: 'Run npm test using ludi_exec and report the actual result. Do not edit files.', agent: 'tester', kind: 'verify', dependencies: ['t2'], acceptance: ['npm test was executed', 'the command exited successfully'] },
  { id: 't4', title: 'Review the diff', goal: 'Read git diff using ludi_exec and review it against the average() fix. Do not edit files or push.', agent: 'reviewer', kind: 'review', dependencies: ['t3'], acceptance: ['the diff matches the average() fix', 'no publish or destructive command is proposed'] },
].map(task => ({ ...task, capability: 'cheap-code', executionMode: 'subagent' }));
const { policy } = loadPolicy(join(kit, 'orchestration/decision-policy.json'));
const turnBudgets = Object.fromEntries(['default', 'scout', 'coder', 'tester', 'reviewer'].map(role => [role, Object.fromEntries(['simple', 'normal', 'heavy', 'repo-history-heavy'].map(c => [c, 8]))]));
const active = mergePolicy(policy, {
  decision_policy: { reassign_on_failure: false, max_parallel_tasks: 1 },
  limits: { max_tasks: 4, max_retries: 0, max_rounds: 4, max_rework_cycles: 0, model_attempts_per_task: 1, max_total_attempts_per_task: 1 },
  agent_runtime: { max_runtime_ms: 120000, max_tool_calls: 16, max_turns: 8, turn_budgets: turnBudgets, max_extensions: 0, max_tool_extensions: 0, absolute_max_turns: 8, absolute_max_tool_calls: 16 },
});
const session = openStore(join(root, 'state.db'));
const health = createHealthMonitor({ session, policy: active });
const launch = createPiSubagentRunner();
let invocations = 0;
const runner = createAgentRunner({
  invoke: () => { throw new Error('One-shot fallback is forbidden in this acceptance run'); },
  runSubagent: async req => {
    assert.equal(req.modelId, expectedModel);
    assert.ok(++invocations <= 4, 'global invocation cap exceeded');
    console.log(JSON.stringify({ event: 'launch', task: req.taskId, model: req.modelId, invocation: invocations }));
    const result = await launch(req);
    console.log(JSON.stringify({ event: 'arrival', task: req.taskId, ok: result.ok, failureClass: result.failureClass, error: result.error, tools: result.child?.toolCalls, turns: result.child?.turns }));
    return result;
  },
  agents, routing, registry, repoRoot: repo, policy: active, health, session, maxModelAttempts: 1,
});
console.log(JSON.stringify({ event: 'start', root, model: expectedModel }));
mkdirSync(join(kit, '.orchestration'), { recursive: true });
writeFileSync(join(kit, '.orchestration', 'latest-approved-e2e.json'), JSON.stringify({ root, repo, backend, model: expectedModel, startedAt: new Date().toISOString() }, null, 2));
try {
  const result = await orchestrate({ request: 'Fix the failing average() test. Use only the explicitly selected user-approved model. No unrelated files, external publication, package installs or destructive operations.', plan, agents, routing, registry, policy: active, runner, repoRoot: repo, session, health });
  writeFileSync(join(root, 'trace.json'), JSON.stringify(result, null, 2));
  console.log(formatReport(result));
  const finalTests = test();
  writeFileSync(join(root, 'final-tests.log'), finalTests.stdout + finalTests.stderr);
  const diff = spawnSync('git', ['diff', '--', 'src/math.js'], { cwd: repo, encoding: 'utf8' });
  writeFileSync(join(root, 'fix.diff'), diff.stdout ?? '');
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  const children = result.trace.filter(e => e.type === 'child');
  const summary = { root, runId: result.runId, status: result.status, model: expectedModel, invocations, finalTestExitCode: finalTests.status, worktree: status.stdout, tasks: result.tasks.map(t => ({ id: t.id, status: t.status })), children: children.map(c => ({ task: c.taskId, model: c.modelId, tools: c.toolCalls, turns: c.turns, status: c.status, failureClass: c.failureClass })) };
  writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  assert.equal(result.status, 'completed');
  assert.equal(result.escalations.length, 0);
  const investigation = result.tasks.find(t => t.id === 't1');
  assert.ok(investigation.evaluatorReasonCodes?.includes('EXPECTED_FAILURE_REPRODUCED'));
  assert.ok(investigation.result.verification.some(v => v.result === 'fail' && v.purpose === 'reproduction' && v.expected_result === 'fail'));
  assert.equal(invocations, 4);
  assert.ok(children.length >= 4 && children.every(c => c.modelId === expectedModel));
  assert.ok(children.some(c => (c.toolCalls ?? 0) > 0));
  assert.equal(finalTests.status, 0, finalTests.stdout + finalTests.stderr);
  assert.match(status.stdout, /src\/math\.js/);
  assert.equal(status.stdout.trim().split(/\r?\n/).length, 1, 'unexpected file changes');
  console.log('PASS: approved-model real tool-capable orchestration E2E');
} finally { session.close(); }
