// Opt-in real orchestrator run through the installed pi CLI (not part of `node --test`; spends a little quota).
//   node tests/e2e-real-orchestrator.mjs
// Two read-only tasks on the math fixture, both routed to the cheap-code capability to keep cost low:
// scout investigates, reviewer (role kept, model route overridden) checks the finding. No files are written.
import { mkdtempSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadRouting } from '../lib/routing.mjs';
import { loadPiRegistry } from '../adapters/pi/lib/model-registry.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { loadPolicy } from '../lib/orchestrator/policy.mjs';
import { createAgentRunner } from '../lib/orchestrator/runner.mjs';
import { orchestrate, formatReport } from '../lib/orchestrator/orchestrator.mjs';
import { createPiInvoker } from '../adapters/pi/lib/invoke.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { registry } = loadPiRegistry(kit, routing);
const { agents } = loadAgents(join(kit, 'agents'), routing);
const { policy } = loadPolicy(join(kit, 'orchestration/decision-policy.json'));
const repo = mkdtempSync(join(tmpdir(), 'ludi-real-orch-'));
cpSync(join(kit, 'tests/fixtures/math-repo'), repo, { recursive: true });

const plan = [
  { id: 't1', title: 'Locate the average() defect', goal: 'Find why the average() test fails in this repository. Do not change files.', agent: 'scout', kind: 'investigate', capability: 'cheap-code', dependencies: [],
    acceptance: ['the file and function containing the defect are named', 'the cause of the failing test is stated'] },
  { id: 't2', title: 'Check the diagnosis', goal: 'Check whether the diagnosis from t1 is correct against the source. Do not change files.', agent: 'reviewer', kind: 'review', capability: 'cheap-code', dependencies: ['t1'],
    acceptance: ['the diagnosis is confirmed or refuted with a code reference'] },
];
const runner = createAgentRunner({ invoke: createPiInvoker(), agents, routing, registry, repoRoot: repo, maxModelAttempts: policy.limits.model_attempts_per_task });
const result = await orchestrate({ request: 'Diagnose the failing average() test', plan, agents, routing, registry, policy, runner, repoRoot: repo });
const traceFile = join(repo, 'orchestration-trace.json');
writeFileSync(traceFile, JSON.stringify(result, null, 2));
console.log(formatReport(result));
console.log(JSON.stringify({ trace: traceFile, runs: result.trace.filter(e => e.type === 'result').map(e => ({ task: e.taskId, attempt: e.attempt, modelId: e.modelId, verdict: e.verdict, reasons: e.reasons, ms: e.steps?.reduce((s, x) => s + (x.durationMs ?? 0), 0) })) }, null, 2));
assert.equal(result.tasks.length, 2);
assert.ok(result.tasks.every(t => ['completed', 'failed', 'blocked'].includes(t.status)), 'every task reached a terminal state');
assert.equal(result.status, 'completed');
console.log('PASS: real pi orchestrator E2E');
