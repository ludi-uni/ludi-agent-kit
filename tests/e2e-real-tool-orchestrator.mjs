// Opt-in tool-capable run through the installed pi CLI (not part of `node --test`).
//   node tests/e2e-real-tool-orchestrator.mjs
// Scout reads the fixture, coder edits average(), tester runs the tests, reviewer checks the diff.
// All four stay on cheap-code so a hosted usage limit can fall through to the local model.
import { mkdtempSync, cpSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadRouting } from '../lib/routing.mjs';
import { loadPiRegistry } from '../adapters/pi/lib/model-registry.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { loadPolicy, mergePolicy } from '../lib/orchestrator/policy.mjs';
import { openStore } from '../lib/orchestrator/store.mjs';
import { createHealthMonitor } from '../lib/orchestrator/health.mjs';
import { createAgentRunner } from '../lib/orchestrator/runner.mjs';
import { orchestrate, formatReport } from '../lib/orchestrator/orchestrator.mjs';
import { createPiInvoker } from '../adapters/pi/lib/invoke.mjs';
import { createPiSubagentRunner } from '../adapters/pi/lib/subagent.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'ludi-real-tools-'));
const repo = join(root, 'repo');
const storePath = join(root, 'state.db');
cpSync(join(kit, 'tests/fixtures/math-repo'), repo, { recursive: true });
for (const args of [['init'], ['add', '-A'], ['-c', 'user.email=ludi@example.com', '-c', 'user.name=ludi', 'commit', '-m', 'fixture']]) {
  const git = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (git.status !== 0) { console.error(git.stderr); process.exit(git.status ?? 1); }
}

const plan = [
  { id: 't1', title: 'Find the average() defect', goal: 'Read the repository and name the file, function, and cause of the failing average() test. Do not edit files.', agent: 'scout', kind: 'investigate', capability: 'cheap-code', executionMode: 'subagent', dependencies: [], acceptance: ['the file and function are named', 'the cause is stated from the source'] },
  { id: 't2', title: 'Fix average()', goal: 'Change average() so it divides by values.length. Do not change tests or unrelated files.', agent: 'coder', kind: 'implement', capability: 'cheap-code', executionMode: 'subagent', dependencies: ['t1'], acceptance: ['src/math.js divides by values.length', 'no other source file was rewritten'] },
  { id: 't3', title: 'Run the tests', goal: 'Run npm test in this repository and report the result. Do not edit files.', agent: 'tester', kind: 'verify', capability: 'cheap-code', executionMode: 'subagent', dependencies: ['t2'], acceptance: ['npm test was executed', 'the command exited successfully'] },
  { id: 't4', title: 'Review the diff', goal: 'Review the uncommitted diff against the goal. Do not edit files or push.', agent: 'reviewer', kind: 'review', capability: 'cheap-code', executionMode: 'subagent', dependencies: ['t3'], acceptance: ['the diff matches the average() fix', 'no publish or destructive command is proposed'] },
];

const routing = loadRouting(join(kit, 'routing/routing.json'));
const { registry } = loadPiRegistry(kit, routing);
const { agents } = loadAgents(join(kit, 'agents'), routing);
const { policy } = loadPolicy(join(kit, 'orchestration/decision-policy.json'));
const active = mergePolicy(policy, { decision_policy: { reassign_on_failure: false }, limits: { max_retries: 1 }, agent_runtime: { max_runtime_ms: 180000, max_tool_calls: 25, max_turns: 8 } });
const session = openStore(storePath);
const health = createHealthMonitor({ session, policy: active });
const runner = createAgentRunner({
  invoke: createPiInvoker(), runSubagent: createPiSubagentRunner(), agents, routing, registry, repoRoot: repo, policy: active, health,
  maxModelAttempts: active.limits.model_attempts_per_task,
});
try {
  const result = await orchestrate({ request: 'Fix the failing average() test', plan, agents, routing, registry, policy: active, runner, repoRoot: repo, session, health });
  writeFileSync(join(root, 'trace.json'), JSON.stringify(result, null, 2));
  console.log(formatReport(result));
  const children = result.trace.filter(e => e.type === 'child');
  console.log(JSON.stringify({ runId: result.runId, status: result.status, children: children.map(c => ({ task: c.taskId, id: c.childSessionId, tools: c.toolCalls, turns: c.turns, status: c.status })), tasks: result.tasks.map(t => ({ id: t.id, status: t.status, files: t.result?.filesChanged ?? [] })) }, null, 2));
  assert.equal(result.status, 'completed');
  assert.equal(result.escalations.length, 0);
  assert.ok(children.length >= 4, 'child sessions missing');
  assert.ok(children.some(c => (c.toolCalls ?? 0) > 0), 'no tool call was recorded');
  assert.ok(result.tasks.find(t => t.id === 't2').result.filesChanged.some(f => f.includes('math.js')));
  const tests = spawnSync('npm', ['test'], { cwd: repo, encoding: 'utf8', shell: true });
  assert.equal(tests.status, 0, tests.stdout + tests.stderr);
  console.log('PASS: real pi tool-capable E2E');
} finally {
  session.close();
}
