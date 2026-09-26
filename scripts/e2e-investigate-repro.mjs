// Read-only reproduction for run-muf1egtr-d13d8a: a single investigate task on a
// small fixture repo. Verifies (1) correct repo cwd, (2) cheap-code primary chain
// order, (3) local fallback after a primary failure, (4) expired health marks
// re-enter the candidate pool, (5) scout completion. No code changes.
//   node scripts/e2e-investigate-repro.mjs
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
const root = mkdtempSync(join(tmpdir(), 'ludi-repro-'));
const repo = join(root, 'repo');
const storePath = join(root, 'state.db');
cpSync(join(kit, 'tests/fixtures/math-repo'), repo, { recursive: true });
for (const args of [['init'], ['add', '-A'], ['-c', 'user.email=ludi@example.com', '-c', 'user.name=ludi', 'commit', '-m', 'fixture']]) {
  const git = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (git.status !== 0) { console.error(git.stderr); process.exit(git.status ?? 1); }
}

const plan = [
  { id: 't1', title: 'Investigate entrypoint and test command', goal: 'Read the repository and report: the main entrypoint and the exact test command. Do not edit files.', agent: 'scout', kind: 'investigate', capability: 'cheap-code', executionMode: 'subagent', dependencies: [], acceptance: ['the main entrypoint file is named', 'the exact test command is named'] },
];

const routing = loadRouting(join(kit, 'routing/routing.json'));
const { registry } = loadPiRegistry(kit, routing);
const { agents } = loadAgents(join(kit, 'agents'), routing);
const { policy } = loadPolicy(join(kit, 'orchestration/decision-policy.json'));
const active = mergePolicy(policy, { limits: { max_retries: 1 }, agent_runtime: { max_runtime_ms: 300000, max_tool_calls: 25, max_turns: 8 } });
const session = openStore(storePath);
const health = createHealthMonitor({ session, policy: active });

// (4) Seed an EXPIRED usage_exhausted mark on the cheap primary: it must not block candidacy.
session.recordHealth({ provider: 'openai-codex', model: 'gpt-5.6-luna', state: 'usage_exhausted', reason: 'stale test mark', runId: '', ttlMs: -1000, now: new Date(Date.now() - 60_000).toISOString() });
const staleSkip = session.activeHealth({ provider: 'openai-codex', model: 'gpt-5.6-luna', runId: 'probe', now: new Date().toISOString() });
console.log('expired health mark active?', staleSkip ? `BUG still active until ${staleSkip.expiresAt}` : 'no (correctly ignored)');

const runner = createAgentRunner({
  invoke: createPiInvoker(), runSubagent: createPiSubagentRunner(), agents, routing, registry, repoRoot: repo, policy: active, health,
  maxModelAttempts: active.limits.model_attempts_per_task,
});
try {
  const result = await orchestrate({ request: 'Investigate only: identify the main entrypoint and the test command for this repo', plan, agents, routing, registry, policy: active, runner, repoRoot: repo, session, health });
  writeFileSync(join(root, 'trace.json'), JSON.stringify(result, null, 2));
  console.log(formatReport(result));
  const steps = result.trace.filter(e => e.type === 'result').flatMap(e => e.steps ?? []);
  console.log('MODEL STEPS:', JSON.stringify(steps.map(s => ({ backend: s.backend, modelId: s.modelId, skipped: !!s.skipped, ok: s.ok, reason: s.reason })), null, 2));
  const t1 = result.tasks.find(t => t.id === 't1');
  console.log('t1:', t1.status, '| summary:', String(t1.result?.summary ?? '').slice(0, 300));
  if (result.status === 'completed') console.log('PASS: read-only investigate E2E');
  else { console.log('FAIL: investigate did not complete'); process.exitCode = 1; }
} finally {
  session.close();
}
