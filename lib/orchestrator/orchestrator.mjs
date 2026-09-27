// Orchestration loop: plan -> route -> delegate (bounded concurrency) -> evaluate -> retry / reassign /
// decide / add work -> integrated report. With a store session the same loop is resumable: task state,
// counters, decisions and trace are written before and after each unit of work.
import { planRules, planWithModel, validatePlan } from './planner.mjs';
import { createTaskStore, createNullProjectStore, newTask, runnableTasks, strandedTasks } from './task-store.mjs';
import { resolveTaskModels, nextLadderCapability, agentForCapability } from './router.mjs';
import { evaluateResult } from './evaluator.mjs';
import { evaluateDecision, decisionKey } from './escalation.mjs';
import { classifyRun, REASSIGN_CLASSES, isProtocolFailure, shouldMarkTaskGlobalFailure } from './failures.mjs';
import { declaredMode, accessOf, piToolsForAccess, workspaceOf } from './permissions.mjs';
import { resolveCapability } from '../resolve.mjs';

const STOP = new Set(['failed', 'blocked', 'waiting_for_user']);

async function makePlan(request, { planner, plan, agents, routing, registry, policy, invoke, cwd, trace, health }) {
  if (plan) return { planner: 'explicit', tasks: plan };
  if (planner === 'model') return planWithModel(request, { agents, routing, registry, policy, invoke, cwd, trace, health });
  return planRules(request, { agents, policy });
}

/** Plan and route only; no agent runs (model planner still calls the orchestrator model once). */
export async function dryRun(request, { planner = 'rules', plan = null, agents, routing, registry, policy, invoke = null, cwd }) {
  const p = await makePlan(request, { planner, plan, agents, routing, registry, policy, invoke, cwd, trace: [] });
  const { errors, tasks } = validatePlan(p.tasks, { agents, routing, policy });
  return {
    mode: 'dry-run', request, planner: p.planner, fallbackReason: p.fallbackReason, errors,
    limits: policy.limits, maxParallelTasks: policy.decision_policy.max_parallel_tasks,
    tasks: tasks.map(t => {
      const m = resolveTaskModels(t, { routing, registry });
      const agent = agents.find(a => a.meta.name === t.assignedAgent);
      const access = accessOf(agent);
      return {
        ...t, executionMode: declaredMode(agent, t), tools: piToolsForAccess(access), access, workspace: workspaceOf(t, cwd),
        models: { chain: m.chain, candidates: m.candidates.map(c => c.modelId), unbound: m.unbound, placeholder: m.placeholder },
      };
    }),
  };
}

export function formatPlan(dry) {
  const index = Object.fromEntries(dry.tasks.map((t, i) => [t.id, `Task ${i + 1}`]));
  const lines = [`Plan: ${dry.tasks.length} tasks (planner: ${dry.planner}${dry.fallbackReason ? `, fallback: ${dry.fallbackReason}` : ''})`, ''];
  dry.tasks.forEach((t, i) => {
    lines.push(`Task ${i + 1} [${t.id}] ${t.title}`, `  capability: ${t.capability}`, `  agent: ${t.assignedAgent}`, `  mode: ${t.executionMode}`);
    lines.push(`  workspace: ${t.workspace?.path ?? '(cwd)'}`);
    lines.push(`  tools: ${(t.tools ?? []).join(', ') || '(none)'}`);
    lines.push(`  model: ${t.models.candidates.length ? t.models.candidates.join(' -> ') : `(unbound: ${[...t.models.placeholder, ...t.models.unbound].join(', ')})`}`);
    if (t.acceptance?.length) lines.push(`  acceptance: ${t.acceptance.join('; ')}`);
    if (t.dependencies.length) lines.push(`  depends_on: ${t.dependencies.map(d => index[d] ?? d).join(', ')}`);
    lines.push('');
  });
  if (dry.errors.length) lines.push('Errors:', ...dry.errors.map(e => `- ${e}`));
  return lines.join('\n').trimEnd();
}

function runStatusOf(status, escalations, tasks) {
  if (escalations.length || tasks.some(t => t.status === 'waiting_for_user')) return 'waiting_for_user';
  if (status === 'completed') return 'completed';
  return 'failed';
}

/** Dependents parked because a dependency was waiting become pending once that dependency can run again. */
function releaseRecoverable(store) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of store.list()) {
      if (t.status !== 'blocked' || !String(t.blockedReason ?? '').startsWith('dependency ')) continue;
      const stopping = t.dependencies.some(id => STOP.has(store.get(id)?.status));
      if (!stopping) { store.update(t.id, { status: 'pending', blockedReason: undefined }); changed = true; }
    }
  }
}

export async function orchestrate(options) {
  const { session, resumeRunId } = options;
  let ownedRun = resumeRunId ?? null;
  let token = session && resumeRunId ? session.claimRun(resumeRunId) : null;
  try {
    return await orchestrateImpl({ ...options, onRunCreated(id) {
      ownedRun = id;
      token = session.claimRun(id);
    } });
  } finally {
    if (token && ownedRun) {
      try { session.releaseRun(ownedRun, token); } catch { /* preserve the original run result/error; dead owners are reclaimed */ }
    }
  }
}

async function orchestrateImpl({ request: requestArg, planner = 'rules', plan = null, agents, routing, registry, policy, runner, invoke = null, repoRoot = null, projectStore = createNullProjectStore(), now = () => new Date().toISOString(), session = null, resumeRunId = null, answers = [], health = null, activity = null, bindingPath = null, onRunCreated = () => {}, onProgress = null }) {
  let request = requestArg;
  let activePolicy = policy;
  let dp = activePolicy.decision_policy, limits = activePolicy.limits;
  let runId = null, p = { planner }, round = 0, reworkCycles = 0, seq = 0;
  const trace = [], autoDecisions = [], escalations = [], unresolved = [], decisionLog = [];
  const limitsHit = new Set();
  let store = null, planning = true, recovered = [];
  // Progress is advisory UI output; a broken subscriber must not abort the run.
  const progress = message => { try { onProgress?.(message); } catch { /* optional observer */ } };
  progress(resumeRunId ? `再開: run ${resumeRunId} の状態を確認しています` : '開始: 依頼を確認し、実行計画を作成しています');
  const requireModels = capabilities => {
    for (const capability of new Set(capabilities)) {
      if (!resolveCapability(routing, registry, capability).candidates.length) {
        throw new Error(`No bound model for required capability "${capability}". Set a provider/model binding in ${bindingPath ?? 'your adapter models.local.json'} (see adapters/pi/models.local.example.json).`);
      }
    }
  };
  const scopeKeyOf = () => repoRoot ?? (runId ? session?.getRun(runId)?.scopeKey : null) ?? 'default';
  // Live-activity bridge: the tracker decides whether an event type is significant
  // (persist to the run trace) or high-frequency (live snapshot only, e.g. turns).
  const event = (type, data = {}) => {
    const entry = { at: now(), round, type, ...data };
    const persist = activity?.emit?.(type, { runId, ...data })?.persist ?? true;
    if (!persist) return entry;
    trace.push(entry);
    if (session && runId) session.appendTrace(runId, entry);
    return entry;
  };
  const syncActivity = (state = null) => { if (activity && runId) activity.syncTasks({ runId, tasks: store ? store.list() : [], state }); };
  const persistMeta = (status = 'running') => {
    if (!session || !runId) return;
    session.updateRun(runId, {
      status, round, reworkCycles, seq, planner: p.planner,
      counters: { autoDecisions, unresolved, limitsHit: [...limitsHit], decisionLog },
    });
  };
  const decide = d => { autoDecisions.push(d); event('auto-decision', d); persistMeta(); };
  const hitLimit = (limit, detail) => { limitsHit.add(limit); event('limit', { limit, detail }); persistMeta(); };

  if (resumeRunId) {
    if (!session) throw new Error('orchestrate: resume requires a persistent store');
    const run = session.getRun(resumeRunId);
    if (!run) throw new Error(`orchestrate: run not found: ${resumeRunId}`);
    if (run.status === 'cancelled') throw new Error(`orchestrate: run ${resumeRunId} is cancelled`);
    runId = run.id;
    request = run.request;
    activePolicy = run.policySnapshot?.limits ? run.policySnapshot : policy;
    dp = activePolicy.decision_policy; limits = activePolicy.limits;
    p = { planner: run.planner ?? planner };
    round = run.round; reworkCycles = run.reworkCycles; seq = run.seq;
    for (const l of run.counters.limitsHit ?? []) limitsHit.add(l);
    autoDecisions.push(...(run.counters.autoDecisions ?? []));
    unresolved.push(...(run.counters.unresolved ?? []));
    decisionLog.push(...(run.counters.decisionLog ?? []));
    trace.push(...session.loadTrace(runId));
    health?.bindRun?.(runId);
    activity?.bindRun?.({ runId, repoRoot: run.repoRoot ?? repoRoot });
    recovered = session.recoverStale(runId);
    for (const a of answers) {
      const res = session.answerDecision({ runId, decisionId: a.decisionId, answer: a.answer, scopeKey: scopeKeyOf() });
      if (res.idempotent && !res.same) unresolved.push(`decision ${a.decisionId} already answered; kept the first answer`);
    }
    store = session.openTaskStore(runId);
    requireModels(store.list().filter(t => !['completed', 'failed', 'cancelled'].includes(t.status)).map(t => t.capability));
    releaseRecoverable(store);
    planning = store.size() === 0;
    for (const d of session.listDecisions(runId, 'pending')) escalations.push(toEscalation(d));
    event('resume', { runId, recovered, planning, answers: answers.map(a => a.decisionId) });
  }

  try {
  if (planning) {
    if (!plan && planner === 'model') requireModels(['orchestration']);
    p = await makePlan(request, { planner, plan, agents, routing, registry, policy: activePolicy, invoke, cwd: repoRoot ?? process.cwd(), trace, health });
    const v = validatePlan(p.tasks, { agents, routing, policy: activePolicy });
    if (!v.errors.length) requireModels(v.tasks.map(t => t.capability));
    if (session && !runId) {
      runId = session.createRun({ request, policy, repoRoot, planner, scopeKey: repoRoot ?? 'default' });
      onRunCreated(runId);
      activity?.bindRun?.({ runId, repoRoot });
    }
    health?.bindRun?.(runId);
    store = store ?? (session ? session.openTaskStore(runId) : createTaskStore());
    if (p.fallbackReason) decide({ subject: 'planner', choice: 'rules planner', reason: `model plan unusable (${p.fallbackReason}); reversible`, step: 'reversible' });
    event('plan', { planner: p.planner, tasks: v.tasks.map(t => ({ id: t.id, agent: t.assignedAgent, capability: t.capability, dependencies: t.dependencies })), errors: v.errors });
    if (v.errors.length) return finish('plan-invalid', v.errors);
    progress(`計画: ${v.tasks.length} 件のタスクを準備しました${runId ? ` (run ${runId})` : ''}`);
    for (const t of v.tasks) {
      store.add(newTask(t));
      seq = Math.max(seq, Number(/^t(\d+)$/.exec(t.id)?.[1] ?? 0));
      const m = resolveTaskModels(t, { routing, registry });
      event('routing', { taskId: t.id, capability: t.capability, agent: t.assignedAgent, candidates: m.candidates.map(c => c.modelId) });
    }
    persistMeta('running');
    syncActivity('running');
    await projectStore.onPlan(store.snapshot());
  } else {
    syncActivity('running');
    progress(`再開状況: ${store.list().filter(t => t.status === 'completed').length}/${store.size()} 件完了${runId ? ` (run ${runId})` : ''}`);
    await projectStore.onPlan(store.snapshot());
  }

  function addTask(spec, sourceId) {
    if (store.size() >= limits.max_tasks) { hitLimit('max_tasks', spec.title); unresolved.push(`not added (max_tasks=${limits.max_tasks}): ${spec.title}`); return null; }
    let id; do id = `t${++seq}`; while (store.has(id));
    const { errors, tasks } = validatePlan([{ ...spec, id, dependencies: spec.dependencies ?? (sourceId ? [sourceId] : []) }], { agents, routing, policy: activePolicy, existingIds: store.list().map(t => t.id) });
    if (errors.length) { unresolved.push(`discovered task rejected: ${errors.join('; ')}`); event('task-rejected', { spec, errors }); return null; }
    store.add(newTask({ ...tasks[0], origin: sourceId ?? 'orchestrator' }));
    persistMeta();
    event('task-added', { taskId: id, source: sourceId, agent: tasks[0].assignedAgent });
    return id;
  }

  function retryOrFail(t, run, reasons) {
    const failureClass = classifyRun({ ...run, failureClass: run?.failureClass });
    // Models actually invoked this attempt (NOT health-skipped / already-tried /
    // unavailable candidates). invocationsStarted is the attempt-budget unit.
    const invoked = run?.invokedModels ?? (run?.modelId ? [run.modelId] : []);
    const counters = run?.counters ?? { candidatesConsidered: invoked.length, candidatesSkipped: 0, invocationsStarted: invoked.length };
    const record = { attempt: t.attempts, failureClass, reasons, summary: run?.result?.summary ?? run?.error ?? '', modelId: run?.modelId ?? invoked.at(-1), counters, filesChanged: run?.worktree?.agentChanges?.map(c => c.path) ?? run?.result?.filesChanged ?? [], commandsRun: run?.result?.commandsRun ?? [], verification: run?.result?.verification ?? [] };
    const attemptsLog = [...(t.attemptsLog ?? []), record];
    // Accumulate the modelIds this task should NOT retry. On a protocol failure OR a
    // backend/model failure (REASSIGN_CLASSES: the model/backend itself is dead) every
    // invoked model is excluded so the retry advances to an untried candidate. Only on
    // a recoverable failure (test/tool) does the LAST invoked model stay retryable so a
    // same-model feedback retry is still possible.
    const protocol = isProtocolFailure(failureClass, run);
    const reassign = REASSIGN_CLASSES.has(failureClass);
    const toExclude = protocol || reassign ? invoked : invoked.slice(0, -1);
    const attemptedModels = [...new Set([...(t.capabilityLocalTriedModels ?? t.attemptedModels ?? []), ...toExclude].filter(Boolean))];
    // TASK-GLOBAL failed models: a model that hit a protocol-quality failure
    // (malformed / empty / no-progress turn-limit) is skipped for the WHOLE task,
    // even after a capability escalation re-resolves the candidate list. The main
    // loop already accumulated per-invocation protocol failures onto the task; if
    // this attempt's overall failure is itself a global failure, add its models too.
    const taskGlobalFailedModels = [...new Set([...(run?.taskGlobalFailedModels ?? t.taskGlobalFailedModels ?? [])].filter(Boolean))];
    // Attempt budget counts ACTUAL invocations only — never health skips,
    // unavailable candidates, already-tried skips, or enumeration. The counter was
    // already incremented in the main loop for this result; reuse the fresh value.
    const totalModelAttempts = run?.totalModelAttempts ?? (t.totalModelAttempts ?? 0) + counters.invocationsStarted;
    const budgetLeft = limits.max_total_attempts_per_task == null || totalModelAttempts < limits.max_total_attempts_per_task;
    // How many candidates remain untried at the CURRENT capability (excluding both
    // capability-local tried AND task-global-failed models).
    const untriedAtCapability = () => {
      try { return resolveTaskModels(t, { routing, registry }).candidates.filter(c => !attemptedModels.includes(c.modelId) && !taskGlobalFailedModels.includes(c.modelId)).length; }
      catch { return 0; }
    };
    // Escalate capability when (a) a hard backend/model failure, or (b) a protocol
    // failure with no untried candidate left at this capability. The next attempt
    // re-resolves the NEW capability's candidate list from live routing.
    const escalateNow = dp.reassign_on_failure && (reassign || (protocol && untriedAtCapability() === 0));
    const next = escalateNow ? nextLadderCapability(routing, t.capability) : null;
    // Nothing left to invoke at this capability and no ladder step: fail now instead
    // of spending rounds on attempts that would invoke nothing.
    const nothingLeft = !next && (protocol || reassign) && invoked.length > 0 && untriedAtCapability() === 0;
    if (nothingLeft) {
      store.update(t.id, { status: 'failed', blockedReason: `no untried model candidate left on ${t.capability}: ${reasons.join('; ')}`, attemptsLog, failureClass, attemptedModels, taskGlobalFailedModels, totalModelAttempts });
      event('task-failed', { taskId: t.id, reasons, failureClass, totalModelAttempts, exhaustedCandidates: true });
      return;
    }
    if ((t.attempts > limits.max_retries || !budgetLeft) && !next) {
      const why = !budgetLeft ? `model attempt budget exhausted (${totalModelAttempts}/${limits.max_total_attempts_per_task})` : reasons.join('; ');
      store.update(t.id, { status: 'failed', blockedReason: why, attemptsLog, failureClass, attemptedModels, taskGlobalFailedModels, totalModelAttempts });
      event('task-failed', { taskId: t.id, reasons, failureClass, totalModelAttempts });
      return;
    }
    const patch = { status: 'pending', feedback: reasons, attemptsLog, failureClass, totalModelAttempts, taskGlobalFailedModels };
    const was = t.capability;
    if (next) {
      // Capability escalation -> re-resolve the new capability's candidates and
      // reset the CAPABILITY-LOCAL tried list. taskGlobalFailedModels is NOT reset:
      // a model that protocol-failed stays skipped across capabilities.
      patch.capability = next;
      patch.attemptedModels = [];
      patch.capabilityLocalTriedModels = [];
    } else {
      patch.attemptedModels = attemptedModels;
      patch.capabilityLocalTriedModels = attemptedModels;
    }
    store.update(t.id, patch);
    event('retry', { taskId: t.id, attempt: t.attempts, failureClass, from: was, to: next ?? was, modelId: record.modelId, protocol, invoked, counters, taskGlobalFailedModels, reasons });
    if (next) event('fallback', { taskId: t.id, from: was, to: next });
    // Report the concrete model progression: which model failed (capability +
    // modelId + failureClass) and what action follows. This makes strong-code
    // escalations visible in the user-facing report, not just the internal trace.
    const failedModel = record.modelId ? `${record.modelId} on ${was}` : was;
    const action = next ? `escalate to ${next}` : protocol || reassign ? `next untried candidate on ${was}` : `retry ${was} with feedback`;
    const choice = `${failedModel} → ${failureClass} → ${action}`;
    decide({ taskId: t.id, subject: `${t.id} failed attempt ${t.attempts}`, capability: was, modelId: record.modelId, failureClass, action, choice, reason: `${failureClass}: ${reasons[0]}; attempt ${t.attempts}`, step: 'policy' });
  }

  function gate(t, requests) {
    const made = [], waitFor = [], drafts = [];
    let escalate = false;
    for (const raw of requests) {
      // Agents may return a plain question in decisions instead of the object schema.
      // Normalize it before policy evaluation and SQLite binding (undefined question
      // otherwise aborts the entire persistent run).
      const d = typeof raw === 'string' ? { question: raw } : raw;
      const invalidOptions = d?.options != null && (!Array.isArray(d.options)
        || d.options.some(o => !o || typeof o !== 'object' || (o.flags != null && !Array.isArray(o.flags))));
      const invalid = !d || typeof d.question !== 'string' || !d.question.trim() ? 'missing question'
        : invalidOptions || (d.flags != null && !Array.isArray(d.flags)) ? 'malformed options or flags' : null;
      if (invalid) {
        const reason = `invalid decision request (${invalid})`;
        store.update(t.id, { status: 'failed', blockedReason: reason });
        event('task-failed', { taskId: t.id, reasons: [reason] });
        return store.get(t.id);
      }
      const memory = session ? session.lookupMemory({ key: decisionKey(d), scopeKey: scopeKeyOf() }) : [];
      const g = evaluateDecision(d, { policy: activePolicy, decisionLog, memory });
      const log = { ...g, taskId: t.id };
      if (g.step === 'memory') event('memory-lookup', { taskId: t.id, key: g.key, optionId: g.optionId, memoryId: g.memoryId, scope: g.scope });
      if (g.action === 'experiment') {
        const agent = g.experiment.agent ?? agentForCapability(agents, 'strong-code')?.meta.name ?? t.assignedAgent;
        const id = addTask({ title: `Experiment: ${d.question}`, goal: g.experiment.goal, agent, kind: 'experiment', dependencies: [],
          acceptance: ['each option was tried or assessed with concrete evidence', 'one option is recommended with rationale'] }, null);
        if (id) { waitFor.push(id); decisionLog.push(log); decide({ taskId: t.id, subject: d.question, choice: `run experiment ${id}`, reason: g.reason, step: g.step }); continue; }
        log.action = 'escalate'; log.reason = 'experiment needed but no task budget left';
      }
      decisionLog.push(log);
      if (log.action === 'decide') {
        const o = d.options.find(x => x.id === g.optionId);
        const choice = o.summary ? `${o.id}: ${o.summary}` : o.id;
        made.push({ question: d.question, choice, reason: `${g.step}: ${g.reason}` });
        decide({ taskId: t.id, subject: d.question, choice, reason: g.reason, step: g.step });
      } else {
        escalate = true;
        drafts.push({
          taskId: t.id, question: d.question, options: d.options ?? [], reason: log.reason,
          escalationType: (g.flags ?? [])[0] ?? g.step, flags: g.flags ?? [], key: g.key, recommended: d.recommended,
        });
      }
    }
    const decisions = [...t.decisions, ...made];
    if (escalate) {
      const patch = { status: session ? 'waiting_for_user' : 'blocked', decisions, dependencies: [...t.dependencies, ...waitFor], blockedReason: 'waiting for user decision' };
      let ids = [];
      if (session) ids = session.persistWaiting(runId, { ...store.get(t.id), ...patch, updatedAt: now() }, drafts);
      store.update(t.id, patch);
      drafts.forEach((draft, i) => {
        const e = { id: ids[i], taskId: t.id, question: draft.question, reason: draft.reason, flags: draft.flags, options: draft.options.map(o => ({ id: o.id, summary: o.summary })), recommended: draft.recommended };
        escalations.push(e); event('escalation', e);
      });
      return store.get(t.id);
    }
    if (t.attempts > limits.max_retries) return store.update(t.id, { status: 'failed', decisions, blockedReason: 'retry limit reached while resolving decisions' });
    store.update(t.id, { status: 'pending', decisions, dependencies: [...t.dependencies, ...waitFor] });
  }

  function rework(t, issues) {
    const list = issues.map(i => i.summary).join('; ');
    if (reworkCycles >= limits.max_rework_cycles) { unresolved.push(`${t.id} review: blocking issues remain after ${reworkCycles} rework cycle(s): ${list}`); persistMeta(); return; }
    reworkCycles++;
    const impl = store.list().filter(x => x.kind === 'implement').at(-1);
    const fix = addTask({ title: `Rework after review ${t.id}`, goal: `Address these review findings: ${list}${impl ? `\nOriginal goal: ${impl.goal}` : ''}`, agent: impl?.assignedAgent ?? agentForCapability(agents, 'strong-code')?.meta.name, kind: 'implement',
      acceptance: ['every listed finding is fixed or explicitly rebutted with evidence', 'the relevant tests were run and pass, or the failure is reported'] }, t.id);
    if (!fix) return;
    addTask({ title: `Re-review after ${fix}`, goal: t.goal, agent: t.assignedAgent, kind: 'review', acceptance: t.acceptance, dependencies: [fix] }, null);
    decide({ taskId: t.id, subject: `review ${t.id} found blocking issues`, choice: `send back to ${store.get(fix).assignedAgent} (${fix}) and re-review`, reason: `rework cycle ${reworkCycles}/${limits.max_rework_cycles}`, step: 'policy' });
  }

  const depResults = t => t.dependencies.map(id => store.get(id)).map(d => ({ id: d.id, agent: d.assignedAgent, title: d.title, ...(d.result ?? {}) }));
  // Paths changed by ANY agent of this run so far (retry / rework must not treat them
  // as pre-existing dirty changes) and every answered decision in the run (a rework
  // task inherits the dirty-gate answer given for the original implementation).
  const ownedPaths = () => [...new Set(store.list().flatMap(x => x.ownedPaths ?? []))];
  const runDecisions = () => store.list().flatMap(x => x.decisions ?? []);

  while (true) {
    const ready = runnableTasks(store);
    if (!ready.length) break;
    if (round >= limits.max_rounds) { hitLimit('max_rounds', `${ready.length} runnable task(s) left`); break; }
    round++;
    const batch = ready.slice(0, dp.max_parallel_tasks);
    for (const t of batch) store.update(t.id, { status: 'running', attempts: t.attempts + 1 });
    persistMeta('running');
    syncActivity('running');
    event('round', { running: batch.map(t => t.id), deferred: ready.slice(batch.length).map(t => t.id) });
    progress(`実行中: ${batch.map(t => `[${t.id}] ${t.title} (${t.assignedAgent})`).join('、')}`);
    const owned = ownedPaths(), decided = runDecisions();
    const runs = await Promise.all(batch.map(t => Promise.resolve().then(() => runner.run(t, { dependencyResults: depResults(t), runId, ownedPaths: owned, runDecisions: decided, onEvent: (type, data) => event(type, { runId, ...data }) })).catch(e => ({ ok: false, error: e.message })).then(run => {
      progress(`報告受信: [${t.id}] ${t.assignedAgent} — ${first(run.result?.summary ?? run.error ?? '結果を評価しています')}`);
      return run;
    })));

    for (const [i, t] of batch.entries()) {
      const run = runs[i];
      const ev = evaluateResult(t, run, { repoRoot });
      if (run.child) event('child', run.child);
      event('result', { taskId: t.id, agent: t.assignedAgent, capability: t.capability, attempt: t.attempts, executor: run.executor, modelId: run.modelId, verdict: ev.verdict, reasons: ev.reasons, failureClass: classifyRun(run), steps: run.steps, counters: run.counters, invokedModels: run.invokedModels, raw: run.raw });
      // Accumulate real invocations on EVERY result (success or failure) so the
      // budget reflects actual model calls, not just failed attempts.
      const invokedThisRound = run?.counters?.invocationsStarted ?? (run?.invokedModels?.length ?? (run?.modelId ? 1 : 0));
      const totalModelAttempts = (t.totalModelAttempts ?? 0) + invokedThisRound;
      run.totalModelAttempts = totalModelAttempts; // hand the fresh count to retryOrFail
      // Mark task-global failed models from EVERY invocation that hit a protocol
      // failure — even when the task ultimately recovers on a later candidate.
      // This is what stops a malformed/empty/no-progress-timeout model from being
      // re-invoked after a capability escalation.
      const globalFailedNow = (run?.steps ?? []).filter(s => s.protocolFailure && shouldMarkTaskGlobalFailure(s.protocolFailure, {
        toolCalls: s.child?.toolCalls ?? s.telemetry?.toolCalls,
        turnLimit: ['no-progress-turn-limit', 'absolute-turn-limit'].includes(s.child?.stopReason) || /turn limit/i.test(s.reason ?? ''),
        structuredProgress: s.child?.structuredProgress ?? (s.protocolFailure === 'NO_PROGRESS_TIMEOUT' ? false : undefined),
        hasFinalOutput: s.child?.hasFinalOutput ?? (s.protocolFailure === 'NO_PROGRESS_TIMEOUT' ? false : undefined),
      })).map(s => s.modelId).filter(Boolean);
      const taskGlobalFailedModels = [...new Set([...(t.taskGlobalFailedModels ?? []), ...globalFailedNow])];
      run.taskGlobalFailedModels = taskGlobalFailedModels;
      for (const step of run.steps ?? []) {
        if (step.skipped && step.reason === 'task-global-failed') {
          decide({ taskId: t.id, subject: `${t.id} candidate skip`, capability: step.capability, modelId: step.modelId, failureClass: 'task-global-failed', action: 'skip', choice: `${step.modelId} on ${step.capability} → task-global-failed skip`, reason: 'protocol failure on an earlier capability', step: 'policy' });
        } else if (!step.ok && !step.skipped && step.modelId && step.failureClass && step.capability === 'strong-code') {
          decide({ taskId: t.id, subject: `${t.id} candidate failed`, capability: step.capability, modelId: step.modelId, failureClass: step.failureClass, action: 'next candidate', choice: `${step.modelId} on ${step.capability} → ${step.failureClass} → next candidate`, reason: step.reason, step: 'policy' });
        }
      }
      const changedNow = (run?.worktree?.agentChanges ?? []).map(c => c.path);
      const ownedNow = [...new Set([...(t.ownedPaths ?? []), ...changedNow])];
      store.update(t.id, { result: run.result ?? { status: 'failed', summary: run.error }, modelId: run.modelId, totalModelAttempts, taskGlobalFailedModels, ownedPaths: ownedNow });
      if (run.gate) event('gate', { taskId: t.id, gateType: run.gate.type, action: run.gate.action, key: run.gate.key, paths: run.gate.paths });
      if (run.abort) {
        // Runner-level terminal stop (e.g. user answered "abort" to the dirty-worktree
        // gate): the task is blocked for good; never retried, never re-asked.
        store.update(t.id, { status: 'blocked', blockedReason: run.error ?? 'aborted by user decision' });
        event('task-blocked', { taskId: t.id, reason: run.error, gate: run.gate });
        await projectStore.onTaskUpdate(structuredClone(store.get(t.id)));
        progress(`評価: [${t.id}] blocked — ${first(run.error)}`);
        continue;
      }
      if (ev.verdict === 'success') {
        if (t.attempts > 1 && run.modelId && t.capability === 'strong-code') {
          decide({ taskId: t.id, subject: `${t.id} escalated invocation`, capability: t.capability, modelId: run.modelId, failureClass: null, action: 'completed', choice: `${run.modelId} on ${t.capability} → completed`, reason: 'escalation recovered the task', step: 'policy' });
        }
        store.update(t.id, { status: 'completed', feedback: [] });
        for (const spec of ev.newTasks) addTask(spec, t.id);
        if (ev.blockingIssues.length) rework(t, ev.blockingIssues);
      } else if (ev.verdict === 'blocked') {
        gate(t, ev.decisions);
      } else {
        retryOrFail(t, run, ev.reasons);
      }
      await projectStore.onTaskUpdate(structuredClone(store.get(t.id)));
      syncActivity();
      progress(`評価: [${t.id}] ${store.get(t.id).status} (${store.list().filter(x => x.status === 'completed').length}/${store.size()} 件完了)`);
    }
  }

  for (let stranded = strandedTasks(store); stranded.length; stranded = strandedTasks(store)) {
    for (const t of stranded) {
      const dep = t.dependencies.map(d => store.get(d)).find(d => d && STOP.has(d.status));
      store.update(t.id, { status: 'blocked', blockedReason: `dependency ${dep.id} is ${dep.status}` });
    }
  }
  } catch (e) {
    // Exception-safe termination: never leave the run (or its in-flight tasks) as
    // `running` in the store. If the store itself is unwritable we report that
    // limitation instead of masking the original error.
    const persisted = terminateOnError(e);
    progress(`終了: エラー${runId ? ` (run ${runId})` : ''} — ${first(e.message)}`);
    const err = new Error(`orchestrate: ${e.message}${persisted.ok ? '' : ` (run state could not be persisted: ${persisted.error})`}`);
    err.cause = e; err.runId = runId; err.persisted = persisted.ok;
    throw err;
  }
  const open = store.list().filter(t => t.status !== 'completed');
  const status = escalations.length ? 'needs-user' : open.length || unresolved.length ? 'incomplete' : 'completed';
  return finish(status, []);

  function terminateOnError(e) {
    if (!session || !runId) return { ok: true, skipped: true };
    try {
      session.transaction(() => {
        for (const t of session.loadTasks(runId)) {
          if (t.status !== 'running') continue;
          session.saveTask(runId, { ...t, status: 'failed', blockedReason: `run aborted by error: ${String(e.message).slice(0, 300)}` });
        }
        session.appendTrace(runId, { at: now(), round, type: 'error', message: String(e.message).slice(0, 2000), stack: String(e.stack ?? '').slice(0, 4000) });
        session.updateRun(runId, { status: 'failed', round, reworkCycles, seq, planner: p.planner, counters: { autoDecisions, unresolved: [...unresolved, `run aborted: ${e.message}`], limitsHit: [...limitsHit], decisionLog } });
      });
      syncActivity('failed');
      activity?.finishRun?.(runId);
      return { ok: true };
    } catch (e2) {
      return { ok: false, error: e2.message };
    }
  }

  async function finish(status, errors) {
    const tasks = store ? store.snapshot() : [];
    const runStatus = session ? runStatusOf(status, escalations, tasks) : undefined;
    if (session && runId) persistMeta(runStatus);
    syncActivity(runStatus ?? status);
    if (['completed', 'failed', 'cancelled'].includes(runStatus ?? status)) activity?.finishRun?.(runId);
    const result = { status, runStatus, runId, request, planner: p.planner, rounds: round, reworkCycles, errors, tasks, autoDecisions, escalations, unresolved, limitsHit: [...limitsHit], trace, recovered };
    await projectStore.onFinal(result);
    progress(`終了: ${status} (${tasks.filter(t => t.status === 'completed').length}/${tasks.length} 件完了)${runId ? ` — run ${runId}` : ''}`);
    return result;
  }
}

export function toEscalation(d) {
  return { id: d.id, taskId: d.taskId, question: d.question, reason: d.reason, flags: d.flags ?? [], options: (d.options ?? []).map(o => ({ id: o.id, summary: o.summary })), recommended: d.recommended };
}

const first = (s, n = 160) => { const line = String(s ?? '').split(/\r?\n/).find(x => x.trim()) ?? ''; return line.length > n ? `${line.slice(0, n)}…` : line; };

/** Human-facing summary. Detailed agent exchanges stay in result.trace. */
export function formatReport(result) {
  const done = result.tasks.filter(t => t.status === 'completed');
  const open = result.tasks.filter(t => t.status !== 'completed');
  const head = result.runId ? `状態: ${result.status} (run ${result.runId}, ${result.runStatus})` : `状態: ${result.status}`;
  const lines = [`${head} (tasks ${done.length}/${result.tasks.length}, rounds ${result.rounds})`, '', '完了:'];
  lines.push(...(done.length ? done.map(t => `- [${t.id}] ${t.title}: ${first(t.result?.summary)}`) : ['- なし']));
  lines.push('', '自動判断:');
  lines.push(...(result.autoDecisions.length ? result.autoDecisions.map(d => `- ${d.subject} → ${d.choice}（${d.reason}）`) : ['- なし']));
  lines.push('', '未解決:');
  const openLines = [
    ...result.errors.map(e => `- ${e}`),
    ...open.map(t => `- [${t.id}] ${t.title}: ${t.status}${t.blockedReason ? ` — ${first(t.blockedReason, 240)}` : ''}`),
    ...result.unresolved.map(u => `- ${u}`),
    ...result.limitsHit.map(l => `- limit reached: ${l}`),
  ];
  lines.push(...(openLines.length ? openLines : ['- なし']));
  lines.push('', 'ユーザー判断が必要:');
  lines.push(...(result.escalations.length ? result.escalations.map(e => `- [${e.taskId}]${e.id ? ` ${e.id}` : ''} ${e.question} — ${e.reason}${e.options.length ? ` (options: ${e.options.map(o => o.summary ? `${o.id}=${o.summary}` : o.id).join(' / ')})` : ''}`) : ['- なし']));
  return lines.join('\n');
}

export function formatRunList(rows) {
  if (!rows.length) return 'runs: none';
  return rows.map(r => `${r.id}  ${r.status}  ${r.completed}/${r.total}  decisions:${r.pendingDecisions}  ${r.updatedAt}  ${String(r.request).replace(/\s+/g, ' ').slice(0, 72)}`).join('\n');
}
