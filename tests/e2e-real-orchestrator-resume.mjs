// Opt-in real resume through the installed pi CLI (not part of `node --test`; spends a little quota).
//   node tests/e2e-real-orchestrator-resume.mjs
// Starts a process that completes scout, stops on an intentional user decision, then a second
// process answers and resumes. The completed scout task must not run again.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadRouting } from '../lib/routing.mjs';
import { loadRegistry } from '../lib/registry.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { loadPolicy, mergePolicy } from '../lib/orchestrator/policy.mjs';
import { openStore } from '../lib/orchestrator/store.mjs';
import { createHealthMonitor } from '../lib/orchestrator/health.mjs';
import { createAgentRunner } from '../lib/orchestrator/runner.mjs';
import { orchestrate, formatReport } from '../lib/orchestrator/orchestrator.mjs';
import { createPiInvoker } from '../adapters/pi/lib/invoke.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const here = fileURLToPath(import.meta.url);
const phase = process.argv[2] ?? 'all';

const plan = [
  { id: 't1', title: 'Locate the average() defect', goal: 'Find why the average() test fails in this repository. Do not change files.', agent: 'scout', kind: 'investigate', capability: 'cheap-code', dependencies: [],
    acceptance: ['the file and function containing the defect are named', 'the cause of the failing test is stated'] },
  { id: 't2', title: 'Ask whether to apply the fix', goal: [
    'Do not edit files.',
    'If the orchestrator already recorded a decision for "Apply the average() fix now?", return status "completed", quote that decision, and do not ask again.',
    'If no decision is recorded, do not choose. Return status "blocked" with exactly one decision and no acceptance met:',
    '{"key":"apply-fix","question":"Apply the average() fix now?","flags":["user_value_judgement"],"options":[{"id":"now","summary":"apply the fix now","reversible":false,"risk":"medium"},{"id":"later","summary":"leave the fixture for now","reversible":false,"risk":"medium"}]}',
  ].join('\n'), agent: 'scout', kind: 'investigate', capability: 'cheap-code', dependencies: ['t1'],
    acceptance: ['the user has chosen whether to apply the fix'] },
  { id: 't3', title: 'Confirm the recorded decision', goal: 'Quote the user decision already recorded for t2. Do not change files. Do not ask the user anything.', agent: 'reviewer', kind: 'review', capability: 'cheap-code', dependencies: ['t2'],
    acceptance: ['the user decision from t2 is quoted'] },
];

function context(repo) {
  const routing = loadRouting(join(kit, 'routing/routing.json'));
  const { registry } = loadRegistry(join(kit, 'adapters/pi/models.json'), join(kit, 'adapters/pi/models.local.json'), routing);
  const { agents } = loadAgents(join(kit, 'agents'), routing);
  const { policy } = loadPolicy(join(kit, 'orchestration/decision-policy.json'));
  // Stay on cheap-code so a hosted usage limit falls through to the local candidate instead of the hosted-only ladder.
  return { routing, registry, agents, policy: mergePolicy(policy, { decision_policy: { reassign_on_failure: false } }) };
}

if (phase === 'all') {
  const root = mkdtempSync(join(tmpdir(), 'ludi-real-resume-'));
  const repo = join(root, 'repo');
  const store = join(root, 'state.db');
  cpSync(join(kit, 'tests/fixtures/math-repo'), repo, { recursive: true });
  const start = spawnSync(process.execPath, [here, 'start', store, repo], { encoding: 'utf8', timeout: 300000 });
  if (start.status !== 0) { console.error(start.stdout); console.error(start.stderr); process.exit(start.status ?? 1); }
  const info = JSON.parse(start.stdout.trim().split(/\r?\n/).at(-1));
  console.log('start', info);
  assert.equal(info.runStatus, 'waiting_for_user');
  assert.equal(info.tasks.find(t => t.id === 't1').status, 'completed');
  assert.equal(info.tasks.find(t => t.id === 't2').status, 'waiting_for_user');
  assert.equal(info.tasks.find(t => t.id === 't3').status, 'blocked');
  const resume = spawnSync(process.execPath, [here, 'resume', store, repo, info.runId, info.decisionId], { encoding: 'utf8', timeout: 300000 });
  if (resume.status !== 0) { console.error(resume.stdout); console.error(resume.stderr); process.exit(resume.status ?? 1); }
  console.log(resume.stdout);
  console.log('PASS: real pi orchestrator resume');
} else if (phase === 'start') {
  const [, , , store, repo] = process.argv;
  const { routing, registry, agents, policy } = context(repo);
  const session = openStore(store);
  const health = createHealthMonitor({ session, policy });
  const runner = createAgentRunner({ invoke: createPiInvoker(), agents, routing, registry, repoRoot: repo, maxModelAttempts: policy.limits.model_attempts_per_task, health });
  try {
    const result = await orchestrate({ request: 'Diagnose the failing average() test and stop before applying a fix', plan, agents, routing, registry, policy, runner, repoRoot: repo, session, health });
    writeFileSync(join(repo, 'start-trace.json'), JSON.stringify(result, null, 2));
    console.log(formatReport(result));
    console.log(JSON.stringify({ runId: result.runId, runStatus: result.runStatus, decisionId: result.escalations[0]?.id, tasks: result.tasks.map(t => ({ id: t.id, status: t.status })) }));
    if (result.runStatus !== 'waiting_for_user') process.exitCode = 1;
  } finally { session.close(); }
} else if (phase === 'resume') {
  const [, , , store, repo, runId, decisionId] = process.argv;
  const { routing, registry, agents, policy } = context(repo);
  const session = openStore(store);
  const before = session.loadTrace(runId).filter(e => e.type === 'result' && e.taskId === 't1').length;
  const health = createHealthMonitor({ session, policy });
  const runner = createAgentRunner({ invoke: createPiInvoker(), agents, routing, registry, repoRoot: repo, maxModelAttempts: policy.limits.model_attempts_per_task, health });
  try {
    const result = await orchestrate({
      request: '', resumeRunId: runId, answers: [{ decisionId, answer: 'later' }],
      agents, routing, registry, policy, runner, repoRoot: repo, session, health,
    });
    const t1Runs = result.trace.filter(e => e.type === 'result' && e.taskId === 't1');
    writeFileSync(join(repo, 'resume-trace.json'), JSON.stringify({ status: result.status, runStatus: result.runStatus, tasks: result.tasks, t1Runs: t1Runs.length }, null, 2));
    console.log(formatReport(result));
    assert.equal(before, 1);
    assert.equal(t1Runs.length, 1, 'completed scout task was executed again');
    assert.equal(result.tasks.find(t => t.id === 't3').status, 'completed');
    assert.equal(result.status, 'completed');
  } finally { session.close(); }
} else {
  console.error(`unknown phase ${phase}`);
  process.exit(2);
}
