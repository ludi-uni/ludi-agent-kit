// Orchestrator Phase 1: planning, dependency ordering, concurrency, evaluation, retry/reassign, escalation gate,
// limits, dry-run and routing compatibility. No model calls: fake runners and the scripted invoker only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { resolveCapability } from '../lib/resolve.mjs';
import { DEFAULT_POLICY, mergePolicy, loadPolicy, validatePolicy } from '../lib/orchestrator/policy.mjs';
import { planRules, validatePlan, planWithModel } from '../lib/orchestrator/planner.mjs';
import { routeTask, nextLadderCapability } from '../lib/orchestrator/router.mjs';
import { evaluateDecision } from '../lib/orchestrator/escalation.mjs';
import { evaluateResult } from '../lib/orchestrator/evaluator.mjs';
import { createAgentRunner, parseStructuredResult } from '../lib/orchestrator/runner.mjs';
import { orchestrate, dryRun, formatPlan, formatReport } from '../lib/orchestrator/orchestrator.mjs';
import { createScriptedInvoker } from '../adapters/pi/lib/invoke.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const REG = { version: 1, backends: {
  local: { provider: 'pl', model: 'ml', thinking: 'off' },
  cheap: { provider: 'pc', model: 'mc', thinking: 'low' },
  sol:   { provider: 'ps', model: 'ms', thinking: 'high' },
  astra: { provider: 'pa', model: 'ma', thinking: 'medium', vision: true },
  codex: { provider: 'px', model: 'mx', thinking: 'high' },
} };
const policyWith = over => mergePolicy(DEFAULT_POLICY, over ?? {});

const completed = (task, extra = {}) => ({ ok: true, structured: true, modelId: 'fake', result: {
  status: 'completed', summary: `did ${task.id}`, artifacts: [], verification: ['checked'],
  acceptance: Array.from({ length: Math.max(task.acceptance.length, 1) }, (_, i) => ({ id: `A${i + 1}`, met: true, evidence: 'observed' })),
  remainingIssues: [], decisions: [], newTasks: [], ...extra } });
const blocked = decisions => ({ ok: true, structured: true, result: { status: 'blocked', summary: 'need a choice', artifacts: [], verification: [], acceptance: [], remainingIssues: [], decisions, newTasks: [] } });
function fakeRunner(handler) {
  const calls = [];
  return { calls, async run(task, ctx) { calls.push({ id: task.id, attempt: task.attempts, capability: task.capability, deps: ctx.dependencyResults.map(d => d.id), decisions: [...task.decisions] }); return handler(task, ctx, calls); } };
}
const spec = (id, agent, dependencies = [], extra = {}) => ({ id, title: `task ${id}`, goal: `goal ${id}`, agent, dependencies, acceptance: ['done'], ...extra });
const run = ({ policy, ...o }) => orchestrate({ request: 'r', agents, routing, registry: REG, policy: policyWith(policy), ...o });
const jsonReply = obj => `notes\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

// ---------- planning ----------
test('simple decomposition: a high-level request becomes >= 2 routed tasks with dependencies', () => {
  const p = planRules('Fix the failing average() test', { agents });
  assert.deepEqual(p.tasks.map(t => t.agent), ['scout', 'coder', 'tester', 'reviewer']);
  assert.deepEqual(p.tasks.map(t => t.dependencies), [[], ['t1'], ['t2'], ['t3']]);
  const ja = planRules('DOLL v2 Phase 2を進める', { agents });
  assert.equal(ja.tasks.length, 4);
  const ui = planRules('Update the settings screen UI and check it in the browser', { agents });
  assert.deepEqual(ui.tasks.map(t => t.agent), ['scout', 'coder', 'tester', 'visual', 'browser', 'reviewer']);
  assert.deepEqual(ui.tasks.at(-1).dependencies, ['t3', 't4', 't5']);
  const { errors, tasks } = validatePlan(ui.tasks, { agents, routing, policy: DEFAULT_POLICY });
  assert.deepEqual(errors, []);
  assert.ok(tasks.every(t => t.acceptance.length > 0));
});

test('plan validation rejects cycles, unknown deps/agents, self-assignment and task overflow', () => {
  const errs = s => validatePlan(s, { agents, routing, policy: policyWith({ limits: { max_tasks: 3 } }) }).errors.join('\n');
  assert.match(errs([spec('a', 'coder', ['b']), spec('b', 'coder', ['a'])]), /cycle/);
  assert.match(errs([spec('a', 'coder', ['zz'])]), /unknown task "zz"/);
  assert.match(errs([spec('a', 'ghost')]), /unknown agent/);
  assert.match(errs([spec('a', 'orchestrator')]), /cannot be assigned to the orchestrator/);
  assert.match(errs([1, 2, 3, 4].map(i => spec(`t${i}`, 'coder'))), /max_tasks=3/);
});

// ---------- loop ----------
test('dependency ordering: dependents run only after dependencies complete and receive their results', async () => {
  const runner = fakeRunner(t => completed(t));
  const r = await run({ request: 'Fix the failing average() test', runner });
  assert.equal(r.status, 'completed');
  assert.deepEqual(runner.calls.map(c => c.id), ['t1', 't2', 't3', 't4']);
  assert.deepEqual(runner.calls[1].deps, ['t1']);
  assert.deepEqual(runner.calls[2].deps, ['t2']);
});

test('parallel runnable tasks: independent tasks share a round; the join waits for all', async () => {
  const runner = fakeRunner(t => completed(t));
  const r = await run({ plan: [spec('a', 'scout'), spec('b', 'reviewer'), spec('c', 'visual'), spec('d', 'coder', ['a', 'b', 'c'])], runner });
  const rounds = r.trace.filter(e => e.type === 'round').map(e => e.running);
  assert.deepEqual(rounds, [['a', 'b', 'c'], ['d']]);
  assert.equal(r.status, 'completed');
});

test('max concurrency: never more than max_parallel_tasks agents in flight', async () => {
  let inFlight = 0, peak = 0;
  const runner = { async run(t) { inFlight++; peak = Math.max(peak, inFlight); await new Promise(r => setTimeout(r, 5)); inFlight--; return completed(t); } };
  const r = await run({ plan: [1, 2, 3, 4, 5].map(i => spec(`p${i}`, 'scout')), runner, policy: { decision_policy: { max_parallel_tasks: 2 } } });
  assert.equal(peak, 2);
  assert.deepEqual(r.trace.filter(e => e.type === 'round').map(e => e.running.length), [2, 2, 1]);
  assert.equal(r.status, 'completed');
});

test('successful task through the real runner: routing picks the model and a structured result is accepted', async () => {
  const calls = [];
  const invoke = createScriptedInvoker({ '*': req => jsonReply({ status: 'completed', summary: `ok from ${req.modelId}`, acceptance: [{ id: 'A1', met: true, evidence: 'ran check' }] }) }, calls);
  const runner = createAgentRunner({ invoke, agents, routing, registry: REG });
  const r = await run({ plan: [spec('a', 'scout'), spec('b', 'coder', ['a'])], runner });
  assert.equal(r.status, 'completed');
  assert.deepEqual(calls.map(c => c.modelId), ['pc/mc:low', 'ps/ms:high']);
  assert.equal(r.tasks[1].result.summary, 'ok from ps/ms:high');
  assert.match(formatReport(r), /完了:\n- \[a\]/);
  assert.match(formatReport(r), /ユーザー判断が必要:\n- なし/);
});

test('failed task is detected; dependents are blocked, not run', async () => {
  const runner = fakeRunner(t => (t.id === 'a' ? { ok: false, error: 'model unavailable' } : completed(t)));
  const r = await run({ plan: [spec('a', 'coder'), spec('b', 'reviewer', ['a'])], runner, policy: { limits: { max_retries: 0 } } });
  assert.equal(r.status, 'incomplete');
  assert.equal(r.tasks[0].status, 'failed');
  assert.match(r.tasks[0].blockedReason, /model unavailable/);
  assert.equal(r.tasks[1].status, 'blocked');
  assert.deepEqual(runner.calls.map(c => c.id), ['a']);
  assert.match(formatReport(r), /未解決:\n- \[a\].*failed/);
});

test('retry: a bare "Done" is a protocol failure; the SAME attempt advances to the next candidate', async () => {
  const replies = ['Done', jsonReply({ status: 'completed', summary: 'found files', acceptance: [{ id: 'A1', met: true, evidence: 'grep hits' }] })];
  const calls = [];
  const invoke = createScriptedInvoker({ '*': () => replies.shift() }, calls);
  const runner = createAgentRunner({ invoke, agents, routing, registry: REG });
  const r = await run({ plan: [spec('a', 'scout')], runner });
  assert.equal(r.status, 'completed');
  // New policy: MALFORMED_RESULT advances to the next candidate within the same
  // orchestrator attempt, so the task completes in ONE attempt across two models
  // rather than burning a same-model retry.
  assert.equal(r.tasks[0].attempts, 1);
  assert.equal(nextLadderCapability(routing, 'cheap-code'), 'strong-code');
  assert.deepEqual(calls.map(c => c.modelId), ['pc/mc:low', 'pl/ml:off']); // cheap -> local (next candidate)
});

test('retry exhaustion: attempts stop at max_retries + 1 and the task fails', async () => {
  const runner = fakeRunner(() => ({ ok: true, structured: false, result: { status: 'unknown', summary: 'Done' } }));
  const r = await run({ plan: [spec('a', 'coder')], runner, policy: { limits: { max_retries: 2 } } });
  assert.equal(runner.calls.length, 3);
  assert.equal(r.tasks[0].status, 'failed');
  assert.equal(r.status, 'incomplete');
});

test('rework: blocking review findings send work back to the implementer and schedule a re-review (bounded)', async () => {
  const runner = fakeRunner(t => (t.assignedAgent === 'reviewer' ? completed(t, { remainingIssues: [{ summary: 'null check missing', severity: 'high' }] }) : completed(t)));
  const r = await run({ request: 'Fix the failing average() test', runner, policy: { limits: { max_rework_cycles: 1 } } });
  assert.deepEqual(runner.calls.map(c => c.id), ['t1', 't2', 't3', 't4', 't5', 't6']);
  assert.equal(r.tasks[4].assignedAgent, 'coder');
  assert.equal(r.tasks[5].assignedAgent, 'reviewer');
  assert.equal(r.status, 'incomplete');
  assert.ok(r.unresolved.some(u => /blocking issues remain/.test(u)));
});

// ---------- escalation gate ----------
test('auto decision: reversible / low-risk / policy choices are made without asking the user', async () => {
  const lib = { key: 'lib', question: 'Library A or B?', recommended: 'a', options: [{ id: 'a', summary: 'A', reversible: true }, { id: 'b', summary: 'B', reversible: true }] };
  const runner = fakeRunner((t, _ctx, calls) => (calls.length === 1 ? blocked([lib]) : completed(t)));
  const r = await run({ plan: [spec('a', 'coder')], runner });
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.escalations, []);
  assert.equal(r.autoDecisions[0].step, 'reversible');
  assert.deepEqual(runner.calls[1].decisions.map(d => d.choice), ['a: A']);

  const p = DEFAULT_POLICY;
  const lowRisk = evaluateDecision({ question: 'Add a test?', options: [{ id: 'yes', risk: 'low', cost: 'low' }, { id: 'no', risk: 'medium' }] }, { policy: p });
  assert.deepEqual([lowRisk.action, lowRisk.step, lowRisk.optionId], ['decide', 'low-risk', 'yes']);
  const byPolicy = evaluateDecision({ question: 'Approach?', options: [{ id: 'new', risk: 'medium' }, { id: 'reuse', risk: 'medium', usesExistingAssets: true, maintainability: 'high' }] }, { policy: p });
  assert.deepEqual([byPolicy.action, byPolicy.step, byPolicy.optionId], ['decide', 'policy', 'reuse']);
  const ctx = evaluateDecision({ key: 'lib', question: 'again', options: [{ id: 'a' }, { id: 'b' }] }, { policy: p, decisionLog: [{ key: 'lib', action: 'decide', optionId: 'b', step: 'policy' }] });
  assert.deepEqual([ctx.step, ctx.optionId], ['context', 'b']);
});

test('auto decision: an unresolved-but-cheap choice becomes an experiment task, then the blocked task resumes', async () => {
  const d = { key: 'algo', question: 'Algorithm X or Y?', options: [{ id: 'x', risk: 'medium', estimatedHours: 1 }, { id: 'y', risk: 'medium', estimatedHours: 1.5 }] };
  const runner = fakeRunner((t, ctx, calls) => (t.id === 'a' && calls.filter(c => c.id === 'a').length === 1 ? blocked([d]) : completed(t)));
  const r = await run({ plan: [spec('a', 'coder')], runner });
  assert.equal(r.status, 'completed');
  const exp = r.tasks.find(t => t.kind === 'experiment');
  assert.ok(exp);
  assert.ok(r.tasks[0].dependencies.includes(exp.id));
  assert.deepEqual(runner.calls.map(c => c.id), ['a', exp.id, 'a']);
  assert.deepEqual(runner.calls[2].deps, [exp.id]);
});

test('user escalation: destructive / publish / high-cost / production decisions are detected and surfaced', async () => {
  const del = { question: 'Remove the old records?', flags: ['destructive_action'], options: [{ id: 'yes', reversible: false }, { id: 'no', reversible: true }] };
  const runner = fakeRunner(t => (t.id === 'a' ? blocked([del]) : completed(t)));
  const r = await run({ plan: [spec('a', 'coder'), spec('b', 'reviewer', ['a']), spec('c', 'scout')], runner });
  assert.equal(r.status, 'needs-user');
  assert.equal(r.escalations.length, 1);
  assert.deepEqual(r.escalations[0].flags, ['destructive_action']);
  assert.equal(r.tasks[0].status, 'blocked');
  assert.equal(r.tasks[1].status, 'blocked');
  assert.equal(r.tasks[2].status, 'completed', 'independent work continues');
  assert.match(formatReport(r), /ユーザー判断が必要:\n- \[a\] Remove the old records\?/);

  const { policy } = loadPolicy(join(kit, 'orchestration/decision-policy.json'));
  const kw = evaluateDecision({ question: 'Should we drop database tables now?', options: [{ id: 'a', reversible: true }, { id: 'b', reversible: true }] }, { policy });
  assert.deepEqual([kw.action, kw.flags], ['escalate', ['destructive_action']]);
  const cost = evaluateDecision({ question: 'Which GPU plan?', options: [{ id: 'big', costUsd: 500, reversible: true }, { id: 'small', costUsd: 5, reversible: true }] }, { policy });
  assert.deepEqual(cost.flags, ['high_cost']);
  const prod = evaluateDecision({ question: 'Deploy to production today?', options: [{ id: 'y', reversible: true }, { id: 'n', reversible: true }] }, { policy });
  assert.equal(prod.action, 'escalate');
  const off = evaluateDecision(del, { policy: policyWith({ decision_policy: { escalation: { destructive_action: false } } }) });
  assert.notEqual(off.step, 'hard-gate');
  const open = evaluateDecision({ question: 'Pick a brand color', options: [{ id: 'r', risk: 'medium' }, { id: 'b', risk: 'medium' }] }, { policy });
  assert.deepEqual([open.action, open.step], ['escalate', 'unresolved']);
});

// ---------- limits ----------
test('max rounds stops the loop and reports the limit; max tasks caps discovered work', async () => {
  const chain = [spec('a', 'scout'), spec('b', 'coder', ['a']), spec('c', 'coder', ['b']), spec('d', 'reviewer', ['c'])];
  const r = await run({ plan: chain, runner: fakeRunner(t => completed(t)), policy: { limits: { max_rounds: 2 } } });
  assert.equal(r.rounds, 2);
  assert.deepEqual(r.limitsHit, ['max_rounds']);
  assert.deepEqual(r.tasks.map(t => t.status), ['completed', 'completed', 'pending', 'pending']);
  assert.match(formatReport(r), /limit reached: max_rounds/);

  const spawner = fakeRunner(t => completed(t, { newTasks: [{ title: 'more', goal: 'more work', agent: 'scout', acceptance: ['x'] }] }));
  const r2 = await run({ plan: [spec('a', 'scout')], runner: spawner, policy: { limits: { max_tasks: 3, max_rounds: 20 } } });
  assert.equal(r2.tasks.length, 3);
  assert.ok(r2.limitsHit.includes('max_tasks'));
});

// ---------- evaluation ----------
test('result evaluation: acceptance needs evidence, outputs must exist, explicit failure is failure', () => {
  const task = { id: 'a', kind: 'implement', acceptance: ['x', 'y'], outputs: ['nope/missing.txt'] };
  const res = extra => ({ ok: true, structured: true, result: { status: 'completed', summary: 's', acceptance: [{ id: 'A1', met: true, evidence: 'e' }, { id: 'A2', met: true, evidence: 'e' }], remainingIssues: [], ...extra } });
  assert.equal(evaluateResult({ ...task, outputs: [] }, res()).verdict, 'success');
  assert.match(evaluateResult(task, res(), { repoRoot: kit }).reasons.join(), /required output missing/);
  assert.match(evaluateResult(task, res({ acceptance: [{ id: 'A1', met: true }] })).reasons.join(), /A1 claimed without evidence.*A2 not reported/);
  assert.match(evaluateResult(task, res({ status: 'failed' })).reasons.join(), /agent reported failure/);
  assert.match(evaluateResult(task, res({ remainingIssues: [{ summary: 'broken', blocking: true }] })).reasons.join(), /blocking issue/);
  assert.equal(parseStructuredResult('Done').structured, false);
  assert.equal(parseStructuredResult(jsonReply({ status: 'completed', summary: 'x' })).structured, true);
  // Observed from a real model: a ```bash block before the result block must not hide it.
  const mixed = '## test_commands\n```bash\nnpm test\n```\n\n## expected_output\ntext\n\n```json\n{"status":"completed","summary":"found"}\n```\n';
  assert.equal(parseStructuredResult(mixed).result.summary, 'found');
});

// ---------- dry run + routing compatibility ----------
test('dry run: plan and routing are shown without running any agent', async () => {
  const dry = await dryRun('DOLL v2 Phase 2を進める', { agents, routing, registry: REG, policy: DEFAULT_POLICY });
  assert.deepEqual(dry.errors, []);
  const text = formatPlan(dry);
  assert.match(text, /Task 1 \[t1\].*\n  capability: cheap-code\n  agent: scout\n  mode: subagent/);
  assert.match(text, /Task 2 \[t2\].*\n  capability: strong-code\n  agent: coder\n  mode: subagent/);
  assert.match(text, /tools: read, grep, find, ls, edit, write, ludi_exec/);
  assert.match(text, /Task 4 \[t4\].*\n  capability: deep-review\n  agent: reviewer/);
  assert.match(text, /depends_on: Task 3/);
  const cli = spawnSync(process.execPath, [join(kit, 'scripts/orchestrate.mjs'), '--dry-run', 'Fix the failing average() test'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Task 4 \[t4\]/);
  assert.doesNotMatch(cli.stdout, /pi exited/);
});

test('existing routing compatibility: agent capabilities and model chains come from routing.json + registry', async () => {
  const dry = await dryRun('Fix the failing average() test', { agents, routing, registry: REG, policy: DEFAULT_POLICY });
  for (const t of dry.tasks) {
    assert.equal(t.capability, agents.find(a => a.meta.name === t.assignedAgent).meta.capability);
    assert.deepEqual(t.models.candidates, resolveCapability(routing, REG, t.capability).candidates.map(c => c.modelId));
  }
  assert.deepEqual(routeTask({ id: 'x', capability: 'vision-reasoning' }, { agents, routing }), { agent: 'visual', capability: 'vision-reasoning' });
  assert.deepEqual(routeTask({ id: 'x', agent: 'scout', capability: 'strong-code' }, { agents, routing }), { agent: 'scout', capability: 'strong-code' });
  assert.match(routeTask({ id: 'x', agent: 'scout', capability: 'nope' }, { agents, routing }).error, /not defined in routing/);
  assert.equal(resolveCapability(routing, REG, 'orchestration').candidates[0].modelId, 'ps/ms:high');
});

test('model planner prefers Qoder and can fall back to Devin without Codex', async () => {
  const reg = { version: 1, backends: {
    qoder: { provider: 'qoder', model: 'Qwen3.8-Flash', thinking: 'low' },
    devin: { provider: 'devin', model: 'swe-2-high', thinking: 'high' },
    sol: { provider: 'openai-codex', model: 'gpt-5.6-sol', thinking: 'medium' },
  } };
  assert.deepEqual(resolveCapability(routing, reg, 'orchestration').candidates.map(c => c.modelId), [
    'qoder/Qwen3.8-Flash:low', 'devin/swe-2-high:high', 'openai-codex/gpt-5.6-sol:medium',
  ]);
  const calls = [];
  const plan = { tasks: [spec('t1', 'scout')] };
  const result = await planWithModel('Do X', { agents, routing, registry: reg, policy: DEFAULT_POLICY,
    invoke: createScriptedInvoker({
      'qoder/Qwen3.8-Flash:low': new Error('usage limit has been reached'),
      'devin/swe-2-high:high': jsonReply(plan),
    }, calls),
  });
  assert.equal(result.planner, 'model');
  assert.equal(result.modelId, 'devin/swe-2-high:high');
  assert.deepEqual(calls.map(c => c.modelId), ['qoder/Qwen3.8-Flash:low', 'devin/swe-2-high:high']);
});

test('model planner: the orchestrator agent plans via routing; invalid output falls back to rules', async () => {
  const plan = { tasks: [spec('t1', 'scout'), spec('t2', 'coder', ['t1'])] };
  const calls = [];
  const good = await planWithModel('Do X', { agents, routing, registry: REG, policy: DEFAULT_POLICY, invoke: createScriptedInvoker({ '*': jsonReply(plan) }, calls) });
  assert.equal(good.planner, 'model');
  assert.equal(calls[0].modelId, 'ps/ms:high');
  const bad = await planWithModel('Fix the bug', { agents, routing, registry: REG, policy: DEFAULT_POLICY, invoke: createScriptedInvoker({ '*': 'I think you should...' }) });
  assert.equal(bad.planner, 'rules');
  const r = await orchestrate({ request: 'Fix the bug', planner: 'model', agents, routing, registry: REG, policy: DEFAULT_POLICY, invoke: createScriptedInvoker({ '*': jsonReply({ tasks: [spec('t1', 'orchestrator')] }) }), runner: fakeRunner(t => completed(t)) });
  assert.equal(r.planner, 'rules');
  assert.equal(r.autoDecisions[0].subject, 'planner');
  assert.equal(r.status, 'completed');
});

test('codex quota 0: orchestrator completes on qoder/devin, then freetoken when they are exhausted', async () => {
  // Every openai-codex model reports usage-limit; routing must still reach qoder (cheap-code),
  // devin (strong-code/deep-review) and finally the freetoken local fallback.
  const reg = { version: 1, backends: {
    local: { provider: 'freetoken', model: 'Qwen3.6-35B-A3B-NVFP4', thinking: 'off' },
    cheap: { provider: 'openai-codex', model: 'gpt-5.6-luna', thinking: 'low' },
    sol: { provider: 'openai-codex', model: 'gpt-5.6-sol', thinking: 'medium' },
    astra: { provider: 'openai-codex', model: 'gpt-6-astra', thinking: 'medium', vision: true },
    codex: { provider: 'openai-codex', model: 'gpt-5.5', thinking: 'high' },
    qoder: { provider: 'qoder', model: 'Qwen3.8-Flash', thinking: 'low' },
    devin: { provider: 'devin', model: 'swe-2-high', thinking: 'high' },
  } };
  const OK = task => jsonReply({ status: 'completed', summary: `done ${task}`, acceptance: [{ id: 'A1', met: true, evidence: 'checked' }, { id: 'A2', met: true, evidence: 'none open' }] });
  const calls = [];
  const quotaErr = new Error('usage limit has been reached for this subscription period');
  const invoke = createScriptedInvoker({
    'openai-codex/gpt-5.6-luna:low': quotaErr, 'openai-codex/gpt-5.6-sol:medium': quotaErr,
    'openai-codex/gpt-5.5:high': quotaErr, 'openai-codex/gpt-6-astra:medium': quotaErr,
    'qoder/Qwen3.8-Flash:low': () => OK('via qoder'),
    'devin/swe-2-high:high': () => OK('via devin'),
    'freetoken/Qwen3.6-35B-A3B-NVFP4:off': () => OK('via freetoken'),
  }, calls);
  const { createHealthMonitor } = await import('../lib/orchestrator/health.mjs');
  const health = createHealthMonitor({ policy: DEFAULT_POLICY });
  const runner = createAgentRunner({ invoke, agents, routing, registry: reg, repoRoot: kit, health });
  const r = await orchestrate({ request: 'Fix the failing average() test', agents, routing, registry: reg, policy: DEFAULT_POLICY, runner, repoRoot: kit, health });
  assert.equal(r.status, 'completed');
  // cheap-code tasks ran on qoder (cheap/local codex slots skipped or failed), strong/deep on devin.
  assert.deepEqual(calls.map(c => c.modelId), ['qoder/Qwen3.8-Flash:low', 'devin/swe-2-high:high', 'qoder/Qwen3.8-Flash:low', 'devin/swe-2-high:high']);
});

test('decision policy file is valid, overridable and validated', () => {
  const { policy, sources } = loadPolicy(join(kit, 'orchestration/decision-policy.json'));
  assert.equal(sources.length, 1);
  assert.deepEqual(validatePolicy(policy), []);
  assert.equal(policy.decision_policy.max_parallel_tasks, 3);
  const bad = policyWith({ decision_policy: { max_parallel_tasks: 0, escalation: { nuke: true }, default_behavior: { reversible_decision: 'maybe' } }, limits: { max_retries: -1 } });
  const errs = validatePolicy(bad).join('\n');
  for (const needle of ['max_parallel_tasks', 'unknown flag "nuke"', 'reversible_decision', 'max_retries']) assert.ok(errs.includes(needle), needle);
});

// ---------- regression: investigation split + blocking semantics + retry display ----------
test('history detection: natural Japanese request splits investigation', () => {
  // The exact request from run-mufhpr52-d5c2f3 must detect history + ui and split.
  const p = planRules('コミットや指示から僕の好みを推測して、このリポジトリを改善できますか', { agents });
  const scouts = p.tasks.filter(t => t.agent === 'scout');
  assert.ok(scouts.length >= 2, `expected split investigation, got ${scouts.length} scout task(s)`);
  assert.ok(scouts.some(t => /history|commit/i.test(t.title)), 'expected a history-focused scout');
  assert.ok(scouts.some(t => /synth/i.test(t.title)), 'expected a synthesis scout');
});

test('history detection: single-commit fix does NOT split', () => {
  const p = planRules('このコミットを修正して', { agents });
  const scouts = p.tasks.filter(t => t.agent === 'scout');
  assert.equal(scouts.length, 1);
  assert.match(scouts[0].title, /Investigate scope/);
});

test('blocking issues: advisory on investigation is success, decision-shaped is blocked', () => {
  const task = { id: 'a', kind: 'investigate', acceptance: ['x'], outputs: [] };
  const res = extra => ({ ok: true, structured: true, result: { status: 'completed', summary: 's', acceptance: [{ id: 'A1', met: true, evidence: 'e' }], remainingIssues: [], ...extra } });
  // Advisory: multiple valid directions / open questions -> still success.
  const advisory = res({ remainingIssues: [{ summary: '改善の方向性が未指定 — 複数の改善候補がある', blocking: true }] });
  const ev1 = evaluateResult(task, advisory);
  assert.equal(ev1.verdict, 'blocked'); // decision-shaped -> needs_decision path
  assert.ok(ev1.decisions.length > 0);
  // Safety: destructive/uncommitted-conflict -> failure.
  const safety = res({ remainingIssues: [{ summary: '未コミット変更を上書きする危険がある', blocking: true }] });
  assert.equal(evaluateResult(task, safety).verdict, 'failure');
  // Pure advisory (not decision-shaped, not safety) -> success.
  const note = res({ remainingIssues: [{ summary: 'context-pack/SPEC.mdは見つからなかった', blocking: true }] });
  assert.equal(evaluateResult(task, note).verdict, 'success');
});

test('blocking issues: implementation still fails on blocking issues', () => {
  const task = { id: 'a', kind: 'implement', acceptance: ['x'], outputs: [] };
  const res = { ok: true, structured: true, result: { status: 'completed', summary: 's', acceptance: [{ id: 'A1', met: true, evidence: 'e' }], remainingIssues: [{ summary: 'broken', blocking: true }] } };
  assert.equal(evaluateResult(task, res).verdict, 'failure');
});

test('runner-level decision (dirty worktree) becomes blocked, not failure', () => {
  const task = { id: 'a', kind: 'implement', acceptance: ['x'] };
  const run = { ok: false, error: 'workspace has 342 uncommitted change(s)', decision: { key: 'worktree-dirty:a', question: 'proceed?', options: [{ id: 'proceed' }, { id: 'abort' }] } };
  const ev = evaluateResult(task, run);
  assert.equal(ev.verdict, 'blocked');
  assert.equal(ev.decisions[0].key, 'worktree-dirty:a');
});

test('retry display uses attempt count, not retry/max_retries fraction', async () => {
  const r = await run({ plan: [spec('a', 'scout')], runner: fakeRunner(() => ({ ok: false, error: 'x' })), policy: { limits: { max_retries: 2, max_total_attempts_per_task: 4 } } });
  const report = formatReport(r);
  assert.doesNotMatch(report, /retry \d+\/\d+/);
  assert.match(report, /attempt \d+/);
});
