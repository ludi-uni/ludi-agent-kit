// Orchestration loop: plan -> route -> delegate (bounded concurrency) -> evaluate -> retry / reassign /
// decide / add work -> integrated report. With a store session the same loop is resumable: task state,
// counters, decisions and trace are written before and after each unit of work.
import { planRules, planWithModel, validatePlan, parseJsonBlock } from './planner.mjs';
import { planFromReport, ROLE_AGENTS } from './adaptive-planner.mjs';
import { captureWorktree } from './worktree.mjs';
import { parseProgressReport, progressMetrics, classifyTermination, buildContinuationTask } from './progress-contract.mjs';
import { decideExecution, decideExecutionEscalation, buildSplitTasks } from './execution-manager.mjs';
import { createTaskBudget, decideBudgetExtension } from './budget-policy.mjs';
import { routeCatalog, routeDenied, routeLockFromUserDecisions, ESCALATION_LIMITS } from './route-escalation.mjs';
import { parseReviewFinding, findingSignature, decideReviewFinding, focusedRepairSpec, normalizeLegacyReviewIssue, completionGate, REVIEW_LIMITS } from './review-policy.mjs';
import { createTaskStore, createNullProjectStore, newTask, runnableTasks, strandedTasks } from './task-store.mjs';
import { resolveTaskModels, nextLadderCapability, agentForCapability } from './router.mjs';
import { evaluateResult } from './evaluator.mjs';
import { evaluateDecision, decisionKey } from './escalation.mjs';
import { classifyRun, REASSIGN_CLASSES, isProtocolFailure, shouldMarkTaskGlobalFailure } from './failures.mjs';
import { declaredMode, accessOf, piToolsForAccess, workspaceOf } from './permissions.mjs';
import { resolveCapability } from '../resolve.mjs';

const STOP = new Set(['partial', 'failed', 'blocked', 'waiting_for_user', 'superseded']);
export const DEFAULT_RUN_BUDGET_CAPS = Object.freeze({ maxExecutionDecisionsPerRun: 60, maxGeneratedTasksPerRun: 24, maxExtensionsPerRun: 6 });

async function makePlan(request, { planner, plan, agents, routing, registry, policy, invoke, cwd, trace, health }) {
  if (planner === 'adaptive') return { planner: 'adaptive', tasks: [], error: 'adaptive planning requires a read-only design child; dry-run cannot execute it' };
  if (plan) return { planner: 'explicit', tasks: plan };
  if (planner === 'model') return planWithModel(request, { agents, routing, registry, policy, invoke, cwd, trace, health });
  return planRules(request, { agents, policy });
}

/** Plan and route only; no agent runs (model planner still calls the orchestrator model once). */
export async function dryRun(request, { planner = 'rules', plan = null, agents, routing, registry, policy, invoke = null, cwd }) {
  const p = await makePlan(request, { planner, plan, agents, routing, registry, policy, invoke, cwd, trace: [] });
  const { errors, tasks } = validatePlan(p.tasks, { agents, routing, policy });
  return {
    mode: 'dry-run', request, planner: p.planner, fallbackReason: p.fallbackReason, errors: p.error ? [p.error] : errors,
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

async function orchestrateImpl({ request: requestArg, planner = 'rules', plan = null, acceptanceCriteria = null, agents, routing, registry, policy, runner, invoke = null, repoRoot = null, projectStore = createNullProjectStore(), now = () => new Date().toISOString(), session = null, resumeRunId = null, answers = [], health = null, activity = null, bindingPath = null, onRunCreated = () => {}, onProgress = null, runBudgetCaps = DEFAULT_RUN_BUDGET_CAPS, routeLocks = {}, routeAvailability = {} }) {
  let request = requestArg;
  let activePolicy = policy;
  let dp = activePolicy.decision_policy, limits = activePolicy.limits;
  let runId = null, p = { planner }, round = 0, reworkCycles = 0, seq = 0;
  const trace = [], autoDecisions = [], escalations = [], unresolved = [], decisionLog = [];
  const limitsHit = new Set();
  let runBudget = { execution_decisions: 0, generated_tasks: 0, task_extensions: 0, retries: 0, continuations: 0, reassignments: 0, escalations: 0, rootEscalations: {} };
  let effectiveRunBudgetCaps = { ...DEFAULT_RUN_BUDGET_CAPS, ...runBudgetCaps };
  let reviewFindings = [], findingDecisions = [], planDiffs = [], reviewRounds = 0, replanCount = 0, finalGate = null;
  const pendingReplans = [];
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
      counters: { autoDecisions, unresolved, limitsHit: [...limitsHit], decisionLog, runBudget, runBudgetCaps: effectiveRunBudgetCaps,
        reviewFindings, findingDecisions, planDiffs, reviewRounds, replanCount },
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
    // The abort marker is historical trace, not a live blocker after a clean
    // checkpoint resumes. Keep it if an in-flight task was actually lost.
    const lostTask = session.loadTasks(runId).some(t => t.blockedReason?.startsWith('run aborted by error:'));
    unresolved.push(...(run.counters.unresolved ?? []).filter(x => lostTask || !x.startsWith('run aborted: ')));
    decisionLog.push(...(run.counters.decisionLog ?? []));
    runBudget = { ...runBudget, ...(run.counters.runBudget ?? {}) };
    effectiveRunBudgetCaps = { ...effectiveRunBudgetCaps, ...(run.counters.runBudgetCaps ?? {}) };
    reviewFindings = run.counters.reviewFindings ?? [];
    findingDecisions = run.counters.findingDecisions ?? [];
    planDiffs = run.counters.planDiffs ?? [];
    reviewRounds = run.counters.reviewRounds ?? 0;
    replanCount = run.counters.replanCount ?? 0;
    for (const f of reviewFindings) if (f.status === 'open' && !f.replanAttempted
      && (f.failedRepairHistory?.length || findingDecisions.some(d => d.sourceFindingId === f.id && d.action === 'replan')))
      pendingReplans.push(f.id);
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
    for (const t of store.list().filter(x => x.status === 'waiting_for_user' && x.escalationRequest))
      escalations.push({ taskId: t.id, question: '追加費用のあるモデルへの昇格には明示的な承認が必要です',
        reason: t.escalationRequest.reason, options: [], escalationRequest: t.escalationRequest });
    event('resume', { runId, recovered, planning, answers: answers.map(a => a.decisionId) });
  }

  function ledgerForReplanValidation(ledger, targetIds = []) {
    const pendingCoverage = new Set(store.list().filter(t => ['pending', 'running'].includes(t.status))
      .flatMap(t => t.acceptanceIds ?? []));
    // Existing live tasks still own their criteria. This projection is used
    // only for plan coverage validation; it never mutates the acceptance ledger.
    return ledger.map(c => c.status !== 'satisfied' && !targetIds.includes(c.id) && pendingCoverage.has(c.id)
      ? { ...c, status: 'satisfied' } : c);
  }

  async function designFirstPlan(replan = null) {
    if (!session) throw new Error('adaptive planning requires a persistent session');
    if (plan) throw new Error('adaptive planning does not accept an explicit execution plan');
    if (!runner?.run) throw new Error('adaptive planning requires a design-child runner');
    const designAgent = agents.find(a => a.meta.name === 'design-planner');
    if (!designAgent) throw new Error('adaptive planning requires the design-planner agent');
    requireModels([designAgent.meta.capability]);
    if (!runId) {
      runId = session.createRun({ request, policy: activePolicy, repoRoot, planner: 'adaptive', scopeKey: repoRoot ?? 'default' });
      onRunCreated(runId);
      activity?.bindRun?.({ runId, repoRoot });
    }
    p = { planner: 'adaptive' };
    health?.bindRun?.(runId);
    store = store ?? session.openTaskStore(runId);
    // A minimal immutable goal criterion is retained when the caller did not supply a
    // separate acceptance list; the child may add detail but may not erase this anchor.
    if (!session.getAcceptanceLedger(runId).length) {
      const seeds = acceptanceCriteria?.length ? acceptanceCriteria : [{ id: 'AC1', description: session.getRun(runId).canonicalGoal.goalSummary, source: 'user_request' }];
      for (const criterion of seeds) session.addAcceptanceCriterion(runId, criterion);
    }
    const goal = session.getRun(runId).canonicalGoal;
    const ledger = session.getAcceptanceLedger(runId);
    const worktree = repoRoot ? captureWorktree(repoRoot) : { source: null, entries: {} };
    const childId = replan ? `design-planner-replan-${replanCount + 1}` : 'design-planner-1';
    const attemptId = session.createPlanningAttempt(runId, childId);
    const childTask = newTask({ id: childId, title: 'Design and decompose the canonical goal', goal: goal.goalSummary,
      kind: 'design-plan', artifact_type: 'design_report', assignedAgent: designAgent.meta.name, capability: designAgent.meta.capability,
      acceptance: ['produce a complete structured planning report'] });
    if (replan) childTask.replanContext = replan;
    childTask.planningContext = { canonicalGoal: goal, acceptanceLedger: ledger,
      workspace: { path: repoRoot ?? process.cwd(), repository: repoRoot }, knownConstraints: goal.constraints,
      existingUserDecisions: goal.userDecisions, dirtyWorktree: { source: worktree.source ?? null, paths: Object.keys(worktree.entries ?? {}).sort() } };
    event('planning-start', { attemptId, childTaskId: childId });
    let child;
    try { child = await runner.run(childTask, { dependencyResults: [], runId, ownedPaths: [], runDecisions: [], onEvent: (type, data) => event(type, { runId, ...data }) }); }
    catch (error) { child = { ok: false, error: error.message }; }
    const report = child?.result?.planningReport;
    let result;
    if (!child?.ok || child?.result?.status !== 'completed') {
      result = { ok: false, code: 'PLANNING_FAILED', errors: [child?.error ?? child?.result?.summary ?? 'design child did not complete'], tasks: [] };
    } else if (child.structured !== true || !report || typeof report !== 'object') {
      result = { ok: false, code: 'PLANNING_INCOMPLETE', errors: ['design child did not provide a structured planningReport'], tasks: [] };
    } else {
      const normalized = replan ? { ...report, work_items: (report.work_items ?? []).map(item => ({ ...item,
        id: `rp${replanCount + 1}-${item.id}`, depends_on: (item.depends_on ?? []).map(id => `rp${replanCount + 1}-${id}`) })) } : report;
      const incorrectlyRegenerated = replan ? normalized.work_items.filter(item => item.acceptance_ids.some(id => ledger.some(c => c.id === id && c.status === 'satisfied'))) : [];
      result = incorrectlyRegenerated.length ? { ok: false, code: 'REPLAN_REGENERATES_VERIFIED', errors: ['replan must preserve satisfied scope'], tasks: [] }
        : planFromReport(normalized, { agents, routing, policy: activePolicy,
          ledger: replan ? ledgerForReplanValidation(ledger, replan.replanTargetAcceptance) : ledger,
          planningRef: attemptId, existingIds: replan ? store.list().map(t => t.id) : [] });
    }
    // A report cannot silently redefine an immutable acceptance identity.
    if (result.ok) for (const criterion of report.acceptance_criteria) {
      const previous = ledger.find(c => c.id === criterion.id);
      if (previous && (previous.description !== criterion.description || previous.source !== criterion.source)) {
        result = { ok: false, code: 'PLANNING_REPORT_INVALID', errors: [`criterion ${criterion.id} changed its description or source`], tasks: [] };
        break;
      }
    }
    if (result.ok && replan && report.acceptance_criteria.some(c => !ledger.some(x => x.id === c.id)))
      result = { ok: false, code: 'REPLAN_GOAL_MUTATION', errors: ['replan may not add or replace immutable acceptance identities'], tasks: [] };
    if (result.ok && !result.tasks.length) result = { ok: false, code: 'PLANNING_INCOMPLETE', errors: ['planning report produced no executable work items'], tasks: [] };
    if (result.ok) {
      try { requireModels(result.tasks.map(t => t.capability)); }
      catch (e) { result = { ok: false, code: 'PLANNING_FAILED', errors: [e.message], tasks: [] }; }
    }
    session.completePlanningAttempt(attemptId, { status: result.ok ? 'valid' : result.code === 'PLANNING_INCOMPLETE' ? 'incomplete' : 'invalid',
      rawReport: child?.raw ?? report ?? null, validation: { code: result.code ?? null, errors: result.errors, coverage: result.coverage ?? {}, child: child?.child ?? null } });
    event('planning-result', { attemptId, childTaskId: childId, status: result.ok ? 'valid' : result.code, errors: result.errors });
    if (!result.ok) return { error: result.code, errors: result.errors };
    for (const criterion of report.acceptance_criteria) if (!ledger.some(c => c.id === criterion.id)) session.addAcceptanceCriterion(runId, criterion);
    return { tasks: result.tasks, report, attemptId };
  }

  try {
  if (planning) {
    if (p.planner === 'adaptive') {
      const previous = runId ? session?.listPlanningAttempts(runId).at(-1) : null;
      if (previous) return finish(previous.validation?.code ?? 'PLANNING_FAILED', previous.validation?.errors ?? ['previous planning attempt did not produce an execution graph']);
      const adaptive = await designFirstPlan();
      if (adaptive.error) return finish(adaptive.error, adaptive.errors);
      p = { planner: 'adaptive' };
      event('plan', { planner: 'adaptive', planningRef: adaptive.attemptId, tasks: adaptive.tasks.map(t => ({ id: t.id, agent: t.assignedAgent, dependencies: t.dependencies })) });
      for (const t of adaptive.tasks) {
        const choices = routeCatalog({ routing, registry, capability: t.capability, role: t.assignedAgent, availability: routeAvailability });
        const explicit = [session.getRun(runId).canonicalGoal.originalRequest, ...session.getRun(runId).canonicalGoal.userDecisions];
        const lock = { ...routeLockFromUserDecisions(explicit, choices, Object.keys(routing.backends)), ...(routeLocks[t.id] ?? {}) };
        const first = choices.find(r => r.capability === t.capability && !routeDenied(r, lock, explicit));
        const initial = first ?? null;
        const task = newTask({ ...t, budget: createTaskBudget(t, activePolicy.agent_runtime), routeLock: lock,
          executionRoute: initial, routeHistory: initial ? [initial] : [] });
        if (!initial && (Object.keys(lock).length || /(?:no paid|有料.*禁止|only|だけ)/i.test(explicit.join(' ')))) {
          task.status = 'failed'; task.blockedReason = 'explicit user route lock leaves no permitted bound route';
        }
        store.add(task);
        seq = Math.max(seq, Number(/^t(\d+)$/.exec(t.id)?.[1] ?? 0));
      }
      persistMeta('running');
      syncActivity('running');
      await projectStore.onPlan(store.snapshot());
    } else {
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
    }
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
    store.add(newTask({ ...tasks[0], sourceFindingIds: spec.sourceFindingIds, sourceReviewTaskId: spec.sourceReviewTaskId,
      affectedAcceptanceIds: spec.affectedAcceptanceIds, affectedFiles: spec.affectedFiles, repairScope: spec.repairScope,
      repairIndex: spec.repairIndex, rootTaskId: spec.rootTaskId, sourceImplementationRole: spec.sourceImplementationRole,
      origin: sourceId ?? 'orchestrator' }));
    persistMeta();
    event('task-added', { taskId: id, source: sourceId, agent: tasks[0].assignedAgent });
    return id;
  }

  function retryOrFail(t, run, reasons) {
    const failureClass = classifyRun({ ...run, failureClass: run?.failureClass, evaluatorReasonCodes: t.evaluatorReasonCodes });
    // Models actually invoked this attempt (NOT health-skipped / already-tried /
    // unavailable candidates). invocationsStarted is the attempt-budget unit.
    const invoked = run?.invokedModels ?? (run?.modelId ? [run.modelId] : []);
    const counters = run?.counters ?? { candidatesConsidered: invoked.length, candidatesSkipped: 0, invocationsStarted: invoked.length };
    const record = { attempt: t.attempts, failureClass, evaluatorReasonCodes: t.evaluatorReasonCodes ?? [], evidenceReferences: t.evidenceReferences ?? [], reasons, summary: run?.result?.summary ?? run?.error ?? '', modelId: run?.modelId ?? invoked.at(-1), counters, filesChanged: run?.worktree?.agentChanges?.map(c => c.path) ?? run?.result?.filesChanged ?? [], commandsRun: run?.result?.commandsRun ?? [], verification: run?.result?.verification ?? [] };
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

  const reviewLimits = () => ({ maxRepairsPerFinding: limits.max_repairs_per_finding ?? REVIEW_LIMITS.maxRepairsPerFinding,
    maxRepairRoundsPerRootTask: limits.max_repair_rounds_per_root_task ?? REVIEW_LIMITS.maxRepairRoundsPerRootTask,
    maxReplansPerRun: limits.max_replans_per_run ?? REVIEW_LIMITS.maxReplansPerRun,
    maxReviewRoundsPerRun: limits.max_review_rounds_per_run ?? REVIEW_LIMITS.maxReviewRoundsPerRun });
  const findingById = id => reviewFindings.find(f => f.id === id);
  function setFinding(id, patch) {
    if (patch.status === 'resolved' && !patch.resolutionEvidence?.verification?.some(v => v.result === 'pass' && v.command))
      throw new Error(`finding ${id}: resolution requires passing verification evidence`);
    reviewFindings = reviewFindings.map(f => f.id === id ? { ...f, ...patch } : f);
    persistMeta();
  }
  function satisfyTask(t, evidence) {
    if (!session || t.kind === 'review' || !t.acceptanceIds?.length) return;
    for (const id of t.acceptanceIds) {
      const c = session.getAcceptanceLedger(runId).find(row => row.id === id);
      if (!c || reviewFindings.some(f => f.affected_acceptance_ids.includes(id) && !['resolved', 'rejected', 'superseded'].includes(f.status))) continue;
      if (c.status === 'satisfied') continue;
      session.addAcceptanceEvidence(runId, id, { taskId: t.id, detail: `parent-verified completion: ${String(evidence ?? '').slice(0, 300)}` });
      session.setAcceptanceStatus(runId, id, 'satisfied');
    }
  }
  function scheduleReverify(f, dependency, reviewer) {
    return addTask({ title: `Reverify ${f.id}: ${f.title}`, goal: `Verify ${f.title} for ${f.affected_acceptance_ids.join(', ')} in ${f.affected_files.join(', ')}; report concrete passing evidence`,
      agent: agents.some(a => a.meta.name === 'tester') ? 'tester' : reviewer.assignedAgent, kind: 'reverify', artifact_type: 'test_result', expected_outcome: 'evidence_only',
      dependencies: dependency ? [dependency] : [], acceptanceIds: f.affected_acceptance_ids,
      acceptance: f.affected_acceptance_ids.map(id => `Verify ${id}: ${f.title}`),
      sourceFindingIds: [f.id], sourceReviewTaskId: reviewer.id, planningRef: reviewer.planningRef, affectedAcceptanceIds: f.affected_acceptance_ids,
      affectedFiles: f.affected_files, rootTaskId: f.rootTaskId, sourceImplementationRole: 'coder' }, reviewer.id);
  }
  function consumeFindings(t, run) {
    if (!['review', 'verify', 'reverify', 'investigate'].includes(t.kind)) return;
    if (t.kind === 'review' && t.dependencies.some(id => store.get(id)?.kind === 'implement' && store.get(id)?.assignedAgent === t.assignedAgent)) {
      unresolved.push(`${t.id}: review role must be independent of the implementation role`);
      persistMeta(); return;
    }
    const priorRounds = reviewRounds;
    if (['review', 'verify', 'reverify'].includes(t.kind)) reviewRounds++;
    if (priorRounds >= reviewLimits().maxReviewRoundsPerRun) {
      unresolved.push(`${t.id}: REVIEW_ROUND_LIMIT_EXCEEDED`);
      persistMeta(); return;
    }
    const structured = run.result?.reviewFindings ?? [];
    const raw = structured.length ? structured : (run.result?.remainingIssues ?? [])
      .map(i => normalizeLegacyReviewIssue(i, t)).filter(Boolean);
    if (!raw.length) { persistMeta(); return; }
    for (const item of raw) {
      let f;
      try { f = parseReviewFinding(item, { sourceTaskId: t.id, acceptanceIds: session?.getAcceptanceLedger(runId).map(c => c.id) ?? [] }); }
      catch (e) { unresolved.push(`${t.id}: invalid review finding: ${e.message}`); continue; }
      f = { ...f, id: `${t.id}/${f.id}`, rootTaskId: t.rootTaskId ?? t.id, signature: findingSignature(f), status: 'open', sourceReviewTaskId: t.id };
      if (reviewFindings.some(x => x.id === f.id)) continue;
      const original = reviewFindings.find(x => x.signature === f.signature && !['rejected', 'superseded'].includes(x.status));
      const repairCount = reviewFindings.filter(x => x.rootTaskId === f.rootTaskId && x.repairTaskId).length;
      const decision = decideReviewFinding(f, { existing: reviewFindings, alternatePath: f.suggested_scope.alternate_path,
        repairsForFinding: original?.repairCount ?? 0, repairRoundsForRoot: repairCount, reviewRounds: priorRounds,
        replanCount, limits: reviewLimits(), failedRepairHistory: original?.failedRepairHistory ?? [] });
      findingDecisions.push({ ...decision, sourceReviewTaskId: t.id });
      if (decision.action === 'ignore_duplicate') {
        f.status = original?.status ?? 'open'; f.duplicateOf = original.id; f.repairTaskId = original.repairTaskId;
        f.resolutionEvidence = original.resolutionEvidence;
        if (original.repairTaskId && store.has(original.repairTaskId)) store.update(original.repairTaskId, {
          sourceFindingIds: [...new Set([...(store.get(original.repairTaskId).sourceFindingIds ?? []), f.id])] });
      } else if (decision.action === 'repair') {
        const spec = focusedRepairSpec(f, t, reworkCycles + 1, session?.getAcceptanceLedger(runId) ?? []);
        const fix = addTask({ ...spec, sourceFindingIds: [f.id], planningRef: t.planningRef }, t.id);
        if (fix) {
          reworkCycles++; f.status = 'repairing'; f.repairTaskId = fix; f.repairCount = 1;
          f.reverifyTaskId = scheduleReverify(f, fix, t);
        } else { f.status = 'blocked'; unresolved.push(`${f.id}: repair task could not be scheduled`); }
      } else if (decision.action === 'replan') {
        pendingReplans.push(f.id);
      } else if (decision.action === 'reverify' || decision.action === 'investigate') {
        const kind = decision.action === 'reverify' ? 'reverify' : 'investigate';
        const agent = kind === 'reverify' ? 'tester' : 'scout';
        const id = addTask({ title: `${kind} ${f.id}`, goal: f.suggested_scope.alternate_path || `Gather evidence for ${f.title} in ${f.affected_files.join(', ') || 'the reported environment'}; do not change project code`,
          kind, artifact_type: kind === 'reverify' ? 'test_result' : 'investigation', expected_outcome: 'evidence_only', agent,
          acceptance: [`Report evidence for ${f.id}`], acceptanceIds: f.affected_acceptance_ids,
          sourceFindingIds: [f.id], sourceReviewTaskId: t.id, planningRef: t.planningRef, affectedAcceptanceIds: f.affected_acceptance_ids,
          affectedFiles: f.affected_files, rootTaskId: f.rootTaskId }, t.id);
        f.reverifyTaskId = id; f.status = id ? 'awaiting_reverification' : 'blocked';
      } else if (decision.action === 'approval_required') {
        f.status = 'blocked';
        if (session) {
          const id = session.insertDecision({ runId, taskId: t.id, question: `Clarify requirement: ${f.title}`, options: [],
            reason: f.description, escalationType: 'requirement_ambiguity', key: `finding:${f.id}` });
          escalations.push({ id, taskId: t.id, question: `Clarify requirement: ${f.title}`, reason: f.description, options: [] });
        }
        store.update(t.id, { status: session ? 'waiting_for_user' : 'blocked', blockedReason: 'requirement ambiguity needs user decision' });
      } else { f.status = 'blocked'; unresolved.push(`${f.id}: ${decision.reason}`); }
      if (['repair', 'replan'].includes(decision.action)) for (const id of f.affected_acceptance_ids) {
        const c = session?.getAcceptanceLedger(runId).find(row => row.id === id);
        if (c?.status === 'satisfied') { session.addAcceptanceEvidence(runId, id, { taskId: t.id, detail: `reopened by finding ${f.id}: ${f.description}` }); session.setAcceptanceStatus(runId, id, 'in_progress'); }
      }
      reviewFindings.push(f);
      event('review-finding', { findingId: f.id, classification: f.classification, action: decision.action, repairTaskId: f.repairTaskId });
    }
    persistMeta();
  }

  function completeReviewLifecycle(t, run) {
    if (t.kind === 'reverify' && t.sourceFindingIds?.length) {
      const passed = (run.result?.verification ?? []).some(v => v.result === 'pass' && v.command);
      if (passed) for (const id of t.sourceFindingIds) {
        const f = findingById(id);
        if (!f || !['awaiting_reverification', 'open'].includes(f.status)) continue;
        const resolutionEvidence = { taskId: t.id, verification: run.result.verification.filter(v => v.result === 'pass') };
        setFinding(id, { status: 'resolved', resolutionEvidence });
        for (const duplicate of reviewFindings.filter(x => x.duplicateOf === id)) setFinding(duplicate.id, { status: 'resolved', resolutionEvidence });
      }
      else unresolved.push(`${t.id}: reverify completed without passing command evidence; finding stays open`);
    }
    if (t.kind === 'investigate' && t.sourceFindingIds?.length) for (const id of t.sourceFindingIds) {
      const f = findingById(id);
      const passing = (run.result?.verification ?? []).filter(v => v.result === 'pass' && v.command);
      if (f?.classification === 'environment_limitation' && f.status === 'awaiting_reverification' && passing.length)
        setFinding(id, { status: 'resolved', resolutionEvidence: { taskId: t.id, verification: passing, alternatePath: f.suggested_scope.alternate_path } });
    }
    if (t.kind === 'implement' && t.sourceFindingIds?.length) for (const id of t.sourceFindingIds) {
      const f = findingById(id);
      if (f?.status === 'repairing') setFinding(id, { status: 'awaiting_reverification' });
    }
    satisfyTask(t, run.result?.summary);
    consumeFindings(t, run);
  }

  function afterRepairFailure(t, reasons) {
    if (!t.sourceFindingIds?.length || !['failed', 'partial', 'blocked'].includes(store.get(t.id).status)
      || store.get(t.id).continuedBy || store.get(t.id).splitInto?.length) return;
    for (const id of t.sourceFindingIds) {
      const f = findingById(id);
      if (!f || !['repairing', 'awaiting_reverification'].includes(f.status)) continue;
      setFinding(id, { status: 'open', failedRepairHistory: [...(f.failedRepairHistory ?? []), { taskId: t.id, reasons }] });
      if (replanCount < reviewLimits().maxReplansPerRun) pendingReplans.push(id);
      else { setFinding(id, { status: 'blocked' }); unresolved.push(`${id}: REPLAN_LIMIT_EXCEEDED`); }
    }
  }

  // Only adaptive/provenance-bearing tasks use continuation. Legacy tasks retain their
  // existing evaluator and retry path when no progress contract is present.
  function handleProgress(t, run, ev) {
    if (!(t.planningRef || t.parentTaskId || t.sourceTaskId)) return false;
    const eventKey = `${t.id}:${t.attempts}`;
    if (session?.getExecutionDecision(runId, eventKey)) return true;
    const priorDecisions = session?.listExecutionDecisions(runId).filter(d => d.sourceTaskId === t.id) ?? [];
    let failureRecord = null;
    const commit = (candidate, targets, apply) => {
      const generated = targets.filter(id => id !== t.id).length;
      const exceeded = candidate.action !== 'stop' && (
        runBudget.execution_decisions >= effectiveRunBudgetCaps.maxExecutionDecisionsPerRun ||
        runBudget.generated_tasks + generated > effectiveRunBudgetCaps.maxGeneratedTasksPerRun ||
        runBudget.task_extensions + Number(candidate.action === 'extend') > effectiveRunBudgetCaps.maxExtensionsPerRun);
      const decision = exceeded ? { ...candidate, action: 'stop', policyRule: 'guard.RUN_BUDGET_EXCEEDED',
        reason: 'RUN_BUDGET_EXCEEDED: execution decision, generated task or extension run cap reached', split_plan: null, retry_policy: null } : candidate;
      const resultingTaskIds = exceeded ? [] : targets;
      const write = () => {
        if (failureRecord) store.update(t.id, { failureHistory: [...(t.failureHistory ?? []), failureRecord] });
        if (exceeded) store.update(t.id, { status: 'failed', blockedReason: decision.reason });
        else apply();
        session?.recordExecutionDecision(runId, eventKey, decision, resultingTaskIds);
        runBudget = { ...runBudget, execution_decisions: runBudget.execution_decisions + 1,
          generated_tasks: runBudget.generated_tasks + resultingTaskIds.filter(id => id !== t.id).length,
          task_extensions: runBudget.task_extensions + Number(decision.action === 'extend'),
          retries: runBudget.retries + Number(decision.action === 'retry'),
          continuations: runBudget.continuations + Number(decision.action === 'continue' || decision.action === 'extend'),
          reassignments: runBudget.reassignments + Number(decision.action === 'reassign'),
          escalations: runBudget.escalations + Number(decision.action === 'escalate'),
          rootEscalations: decision.action === 'escalate' ? { ...runBudget.rootEscalations,
            [t.rootTaskId ?? t.id]: (runBudget.rootEscalations?.[t.rootTaskId ?? t.id] ?? 0) + 1 } : runBudget.rootEscalations };
        persistMeta('running');
      };
      if (session) session.transaction(write); else write();
      if (exceeded || decision.reason.startsWith('RUN_BUDGET_EXCEEDED')) { limitsHit.add('RUN_BUDGET_EXCEEDED'); unresolved.push(decision.reason); }
      event('execution-decision', { taskId: t.id, decisionId: session?.getExecutionDecision(runId, eventKey)?.decisionId,
        action: decision.action, policyRule: decision.policyRule, resultingTaskIds });
    };
    const context = (report, metrics, terminationReason, observedRun = run) => ({
      task: t, run: observedRun, terminationReason, progressReport: report, progressMetrics: metrics,
      failureSignature: t.lastFailureSignature, ledger: session?.getAcceptanceLedger(runId) ?? [],
      acceptanceCoverage: Object.fromEntries((session?.getAcceptanceLedger(runId) ?? []).map(c => [c.id, { status: c.status, description: c.description }])),
      workspaceState: { paths: t.ownedPaths ?? [], dirty: !!t.ownedPaths?.length },
      canonicalGoal: session?.getRun(runId)?.canonicalGoal,
      explicitUserDecisions: [ ...(session?.getRun(runId)?.canonicalGoal.userDecisions ?? []),
        ...(session?.listDecisions(runId)?.filter(d => d.status === 'answered').map(d => String(d.answer ?? '')) ?? []) ],
      counters: { retries: t.retryCount ?? 0, reassignments: t.reassignmentCount ?? 0, splitDepth: t.splitDepth ?? 0 },
      history: priorDecisions, evaluatorVerdict: ev.verdict,
    });
    const raw = run?.result?.progressReport;
    if (raw == null) {
      // A progress-aware interruption must not restart its full goal without a handoff.
      const reason = classifyTermination(run);
      const metrics = reason === 'turn_limit' ? { progressMade: false, completedWorkCount: 0, remainingWorkCount: 0, repeatedFailureSignature: null } : null;
      const decision = decideExecution(context(null, metrics, reason));
      commit(decision, decision.action === 'retry' ? [t.id] : [], () => {
        if (decision.action === 'complete') { store.update(t.id, { status: 'completed', taskStatus: 'TASK_COMPLETED', terminationReason: reason, feedback: [] });
          completeReviewLifecycle(t, run); }
        else if (decision.action === 'retry') store.update(t.id, { status: 'pending', retryCount: (t.retryCount ?? 0) + 1,
          lastFailureSignature: decision.retry_policy.suppressIfSignature, terminationReason: reason, feedback: [decision.reason],
          budget: t.budget ? { ...t.budget, retry_count: (t.retryCount ?? 0) + 1 } : undefined });
        else store.update(t.id, { status: 'failed', taskStatus: 'TASK_UNKNOWN', terminationReason: reason,
          blockedReason: decision.reason });
      });
      return true;
    }
    let report;
    try {
      report = parseProgressReport(raw);
      if (report.task_id !== t.id) throw new Error(`report task_id ${report.task_id} does not match ${t.id}`);
      const known = new Set(t.acceptanceIds ?? []);
      for (const c of report.completed_acceptance) if (!known.has(c.acceptance_id)) throw new Error(`unknown acceptance id ${c.acceptance_id}`);
      for (const w of report.remaining_work) for (const id of w.acceptance_ids) if (!known.has(id)) throw new Error(`unknown acceptance id ${id}`);
    } catch (e) {
      const reason = 'validation_failure';
      const decision = decideExecution(context(null, null, reason, { ...run, failureClass: 'MALFORMED_RESULT' }));
      commit(decision, [], () => store.update(t.id, { status: 'failed', taskStatus: 'TASK_UNKNOWN', progressReportRaw: raw,
        terminationReason: reason, blockedReason: `invalid progress report: ${e.message}` }));
      return true;
    }
    const terminationReason = classifyTermination(run, report);
    const metrics = progressMetrics(report);
    const persisted = { progressReport: report, terminationReason, progressMetrics: metrics,
      taskStatus: `TASK_${report.status.toUpperCase()}` };
    // Evidence and execution decision are committed together; a child claim never
    // changes criterion status. A duplicate end event cannot duplicate either row.
    const recordEvidence = () => {
      if (session) for (const c of report.completed_acceptance) for (const evidence of c.evidence) {
        if (typeof evidence === 'string' ? !evidence.trim() : !evidence || typeof evidence !== 'object' || !Object.keys(evidence).length) continue;
        session.addAcceptanceEvidence(runId, c.acceptance_id, { taskId: t.id, detail: JSON.stringify(evidence) });
      }
    };
    const ledger = session?.getAcceptanceLedger(runId) ?? [];
    const sufficientlyEvidenced = (t.acceptanceIds ?? []).every(id => {
      if (ledger.some(c => c.id === id && c.status === 'satisfied')) return true;
      const entry = report.completed_acceptance.find(c => c.acceptance_id === id);
      return entry?.evidence?.some(e => {
        if (!e || typeof e !== 'object') return false;
        if (e.type === 'test_result') return report.tests_run.some(x => x.command === e.command && x.result === 'pass' && e.result === 'pass');
        if (e.type === 'produced_artifact') return report.artifacts.some(x => x.location === e.location);
        if (e.type === 'file_path') return report.files_touched.includes(e.location) || t.inheritedArtifacts?.some(x => x.location === e.location);
        if (e.type === 'command_result') return report.tests_run.some(x => x.command === e.command && x.result === e.result && e.result === 'pass');
        if (e.type === 'prior_task') return ledger.some(c => c.id === id && c.evidence.some(x => x.taskId === e.taskId));
        return false;
      });
    });
    const onlyMissingLegacyAcceptance = ev.reasons.every(reason => /^acceptance A\d+ not reported/.test(reason));
    const completionVerified = ev.verdict === 'success' || (sufficientlyEvidenced && onlyMissingLegacyAcceptance && (t.acceptanceIds ?? []).length > 0);
    let managed = decideExecution(context(report, metrics, terminationReason));
    let budgetDecision = null;
    if (t.budget && managed.action !== 'stop' && report.status === 'partial' && ['turn_limit', 'tool_limit'].includes(terminationReason)) {
      // Adapter markers are invocation-relative; budget usage is lineage-cumulative.
      const priorTurns = Math.max(0, t.budget.turns.used - (run.child?.turns ?? 0));
      const priorTools = Math.max(0, t.budget.tool_calls.used - (run.child?.toolCalls ?? 0));
      const turnMarker = run.child?.lastProgressTurn;
      const toolMarker = run.child?.lastProgressToolCall;
      const recency = { ...metrics,
        lastProgressTurn: Number.isFinite(turnMarker) ? priorTurns + turnMarker : null,
        lastProgressToolCall: Number.isFinite(toolMarker) ? priorTools + toolMarker : null };
      // Unknown recency is never grounds for extension; keep the Phase 3
      // continuation path rather than pretending a historic step was recent.
      if (recency.lastProgressTurn != null || recency.lastProgressToolCall != null) {
        budgetDecision = decideBudgetExtension({ task: t, budget: t.budget, terminationReason, progressMetrics: recency,
          progressReport: report, telemetry: { ...run.child, turns: t.budget.turns.used, toolCalls: t.budget.tool_calls.used },
          priorFailureSignature: t.lastFailureSignature,
          failureClassification: t.estimatedComplexity === 'large' || report.remaining_work.length > 2 ? 'task_too_large' : managed.failureClassification?.class === 'task_too_large' ? 'bounded_partial' : managed.failureClassification?.class,
          runBudget: { exhausted: runBudget.task_extensions >= effectiveRunBudgetCaps.maxExtensionsPerRun } });
        if (budgetDecision.action === 'extend') {
          managed = { ...managed, action: 'extend', reason: budgetDecision.reason, policyRule: budgetDecision.policyRule,
            previousBudget: budgetDecision.previousBudget, newBudget: budgetDecision.newBudget,
            progressSnapshot: budgetDecision.progressSnapshot, remainingWorkSnapshot: budgetDecision.remainingWorkSnapshot };
        } else if (budgetDecision.action === 'split') {
          const split = buildSplitTasks({ task: t, report, acceptanceCoverage: context(report, metrics, terminationReason).acceptanceCoverage,
            counters: { splitDepth: t.splitDepth ?? 0 } });
          managed = split.ok ? { ...managed, action: 'split', reason: budgetDecision.reason,
            policyRule: budgetDecision.policyRule, split_plan: split.tasks,
            previousBudget: budgetDecision.previousBudget, progressSnapshot: budgetDecision.progressSnapshot,
            remainingWorkSnapshot: budgetDecision.remainingWorkSnapshot }
            : { ...managed, action: 'stop', reason: `budget split unsafe: ${split.errors.join('; ')}`,
              policyRule: 'budget.stop.unsplittable', split_plan: null };
        } else if (budgetDecision.action === 'stop') {
          managed = { ...managed, action: 'stop', reason: budgetDecision.reason, policyRule: budgetDecision.policyRule,
            previousBudget: budgetDecision.previousBudget, progressSnapshot: budgetDecision.progressSnapshot,
            remainingWorkSnapshot: budgetDecision.remainingWorkSnapshot };
        }
      }
    }
    if (managed.action === 'stop' && t.budget) {
      const routes = routeCatalog({ routing, registry, capability: t.capability, role: t.assignedAgent, availability: routeAvailability });
      const liveAvailability = { ...routeAvailability };
      for (const candidate of routes) {
        const blocked = health?.skip?.(candidate);
        if (blocked) liveAvailability[candidate.modelId] = /quota|usage.?exhaust/i.test(String(blocked)) ? 'quota_exhausted' : 'temporarily_unavailable';
      }
      const currentRoute = routes.find(r => r.modelId === run.modelId && (!run.backend || r.backend === run.backend))
        ?? t.executionRoute ?? null;
      if (currentRoute && !t.executionRoute) store.update(t.id, { executionRoute: currentRoute,
        routeHistory: [...(t.routeHistory ?? []), currentRoute] });
      managed = decideExecutionEscalation(managed, { task: t, currentRoute, routes, run,
        progressMetrics: metrics, failureHistory: t.failureHistory ?? [], routeLock: t.routeLock,
        userDecisions: [session?.getRun(runId)?.canonicalGoal.originalRequest ?? '',
          ...(session?.getRun(runId)?.canonicalGoal.userDecisions ?? []),
          ...(session?.listDecisions(runId)?.filter(d => d.status === 'answered').map(d => String(d.answer ?? '')) ?? [])],
        availability: liveAvailability, limits: {
          maxEscalationsPerTask: limits.max_escalations_per_task ?? ESCALATION_LIMITS.maxEscalationsPerTask,
          maxEscalationsPerRootTask: limits.max_escalations_per_root_task ?? ESCALATION_LIMITS.maxEscalationsPerRootTask,
          maxEscalationsPerRun: limits.max_escalations_per_run ?? ESCALATION_LIMITS.maxEscalationsPerRun },
        runEscalations: runBudget.escalations, rootEscalations: runBudget.rootEscalations?.[t.rootTaskId ?? t.id] ?? 0 });
      failureRecord = { route: currentRoute, signature: managed.failureClassification?.signature,
        class: managed.failureClassification?.class, at: now() };
      if (['escalate', 'approval_required'].includes(managed.action))
        managed = { ...managed, failureHistory: [...(t.failureHistory ?? []), failureRecord].slice(-8) };
    }
    if (managed.action === 'complete' && (!run.ok || !completionVerified)) {
      managed = { ...managed, action: 'stop', reason: 'completion lacks parent-verified evidence or evaluator safety checks',
        policyRule: 'guard.parent-evidence' };
    }
    if (managed.action === 'complete') {
      commit(managed, [], () => { recordEvidence(); store.update(t.id, { ...persisted, status: 'completed', feedback: [] });
        if (ev.verdict === 'success') completeReviewLifecycle(t, run);
        else if (completionVerified) satisfyTask(t, run.result?.summary); });
      return true;
    }
    if (managed.action === 'escalate') {
      const route = managed.proposedRoute;
      commit(managed, [t.id], () => { recordEvidence(); store.update(t.id, { ...persisted, status: 'pending',
        capability: route.capability, executionRoute: route,
        routeHistory: [...(t.routeHistory ?? []), route], escalationCount: (t.escalationCount ?? 0) + 1,
        lastEscalationReason: managed.reason, attemptedModels: [], capabilityLocalTriedModels: [],
        budget: createTaskBudget(t, activePolicy.agent_runtime), feedback: [managed.reason] }); });
      return true;
    }
    if (managed.action === 'approval_required') {
      commit(managed, [], () => { recordEvidence(); store.update(t.id, { ...persisted, status: 'waiting_for_user',
        escalationRequest: managed.escalation_request, blockedReason: 'approval_required: additional model cost; no route change or invocation' }); });
      if (store.get(t.id).status === 'waiting_for_user') escalations.push({ taskId: t.id, question: '追加費用のあるモデルへの昇格には明示的な承認が必要です',
        reason: managed.reason, options: [] });
      return true;
    }
    if (managed.action === 'retry') {
      commit(managed, [t.id], () => { recordEvidence(); store.update(t.id, { ...persisted, status: 'pending',
        retryCount: (t.retryCount ?? 0) + 1, lastFailureSignature: managed.retry_policy.suppressIfSignature,
        budget: t.budget ? { ...t.budget, retry_count: (t.retryCount ?? 0) + 1 } : undefined,
        feedback: [managed.reason] }); });
      return true;
    }
    if (managed.action === 'reassign') {
      const agent = ROLE_AGENTS[managed.next_role];
      if (!agent || !agents.some(a => a.meta.name === agent)) managed = { ...managed, action: 'stop', policyRule: 'guard.unknown-role', reason: `unknown role ${managed.next_role}` };
      else if (t.executionRoute && !t.executionRoute.roles.includes(agent)) managed = { ...managed, action: 'stop', policyRule: 'guard.role-route-incompatible', reason: `current route does not allow role ${agent}; reassign cannot change model implicitly` };
      else {
        const artifact = { investigator: 'investigation', tester: 'test_result', auditor: 'audit_report', reviewer: 'audit_report', documentation: 'documentation', coder: 'code_change' }[managed.next_role];
        const kind = { investigator: 'investigate', tester: 'verify', auditor: 'review', reviewer: 'review', documentation: 'implement', coder: 'implement' }[managed.next_role];
        commit(managed, [t.id], () => { recordEvidence(); store.update(t.id, { ...persisted, status: 'pending',
          assignedAgent: agent, recommendedRole: managed.next_role, capability: t.capability,
          artifact_type: artifact ?? t.artifact_type, kind: kind ?? t.kind,
          goal: report.remaining_work.length ? report.remaining_work.map(w => w.description).join('\n') : `Diagnose: ${report.handoff_notes.join('; ') || run.result?.summary || t.title}`,
          originalGoal: t.originalGoal ?? t.goal,
          budget: t.budget ? createTaskBudget({ ...t, assignedAgent: agent }, activePolicy.agent_runtime) : undefined,
          reassignmentCount: (t.reassignmentCount ?? 0) + 1,
          assignmentHistory: [...(t.assignmentHistory ?? []), { from: t.assignedAgent, to: agent, role: managed.next_role, reason: managed.reason, at: now() }],
          feedback: [managed.reason] }); });
        return true;
      }
    }
    if (managed.action === 'split') {
      const specs = managed.split_plan ?? [];
      const checked = validatePlan(specs.map(s => ({ ...s, planningRef: t.planningRef, dependencies: s.dependencies ?? [] })),
        { agents, routing, policy: activePolicy, existingIds: store.list().map(x => x.id) });
      if (checked.errors.length || !specs.length || store.size() + specs.length > limits.max_tasks) {
        managed = { ...managed, action: 'stop', policyRule: 'guard.invalid-split',
          reason: `split rejected: ${checked.errors.join('; ') || 'task limit exceeded'}`, split_plan: null };
      } else {
        const ids = checked.tasks.map(s => s.id);
        commit(managed, ids, () => {
          recordEvidence(); store.update(t.id, { ...persisted, status: 'partial', splitInto: ids });
          for (const spec of checked.tasks) store.add(newTask({ ...spec, planningRef: t.planningRef,
            sourceTaskId: t.id, rootTaskId: t.rootTaskId ?? t.id, splitDepth: (t.splitDepth ?? 0) + 1,
            budget: createTaskBudget(spec, activePolicy.agent_runtime), routeLock: t.routeLock,
            routeHistory: t.routeHistory ?? [], escalationCount: t.escalationCount ?? 0,
            executionRoute: t.executionRoute?.roles?.includes(spec.assignedAgent) ? t.executionRoute : undefined,
            origin: t.id }));
          for (const dependent of store.list()) {
            if (ids.includes(dependent.id) || !dependent.dependencies.includes(t.id)) continue;
            store.update(dependent.id, { dependencies: [...new Set(dependent.dependencies.flatMap(id => id === t.id ? ids : [id]))] });
          }
        });
        return true;
      }
    }
    if (managed.action === 'stop') {
      commit(managed, [], () => { recordEvidence(); store.update(t.id, { ...persisted,
        status: report.status === 'partial' ? 'partial' : 'failed', blockedReason: managed.reason,
        lastFailureSignature: managed.failureClassification.signature }); });
      unresolved.push(`${t.id}: ${managed.reason}`);
      return true;
    }
    // 'continue' creates a fresh bounded residual; 'extend' creates a residual
    // carrying only the incremental unused allowance. Both are distinct decisions.
    const workspaceRef = { runId, parentTaskId: t.id, source: run.worktree?.after?.source ?? null,
      dirty: !!Object.keys(run.worktree?.after?.entries ?? {}).length,
      paths: [...new Set([...(t.ownedPaths ?? []), ...(run.worktree?.agentChanges ?? []).map(c => c.path), ...report.files_touched])].sort() };
    const residual = buildContinuationTask({ task: t, report, ledger: session?.getAcceptanceLedger(runId) ?? [],
      workspaceRef, progressRef: t.id, terminationReason });
    if (!residual.ok || store.size() >= limits.max_tasks) {
      const code = residual.errors.some(e => /depth .*exceeds/.test(e)) ? 'CONTINUATION_DEPTH_EXCEEDED'
        : store.size() >= limits.max_tasks ? 'CONTINUATION_TASK_LIMIT' : residual.code;
      const stopped = { ...managed, action: 'stop', policyRule: `guard.${code}`, reason: `${code}: ${residual.errors.join('; ')}` };
      commit(stopped, [], () => { recordEvidence(); store.update(t.id, { ...persisted, status: 'partial', blockedReason: stopped.reason }); });
      unresolved.push(`${t.id}: ${code}`);
      event('continuation-stopped', { taskId: t.id, code, terminationReason, metrics });
      return true;
    }
    const spec = residual.task;
    spec.expected_outcome = t.expected_outcome === 'code_change_required' && spec.inheritedArtifacts?.length
      ? 'evidence_or_change' : t.expected_outcome;
    spec.budget = managed.action === 'extend' ? { ...managed.newBudget, continuation_depth: spec.continuationIndex } : createTaskBudget(spec, activePolicy.agent_runtime);
    spec.lastFailureSignature = metrics.repeatedFailureSignature ?? t.lastFailureSignature;
    spec.executionRoute = t.executionRoute;
    spec.routeHistory = t.routeHistory ?? [];
    spec.escalationCount = t.escalationCount ?? 0;
    spec.lastEscalationReason = t.lastEscalationReason;
    spec.failureHistory = t.failureHistory ?? [];
    spec.routeLock = t.routeLock;
    if (managed.action === 'extend') { spec.extensionOf = t.id; spec.budgetExtensionIndex = spec.budget.extensions.count; }
    spec.continuationContext = { canonicalGoal: session?.getRun(runId)?.canonicalGoal,
      relevantAcceptance: (session?.getAcceptanceLedger(runId) ?? []).filter(c => spec.acceptanceIds.includes(c.id)),
      originalTaskPurpose: t.title, previousTaskSummary: run.result?.summary ?? run.error ?? '',
      previousProgressReport: report, remainingWork: report.remaining_work, workspaceState: workspaceRef };
    // Parent result, child and dependency rewiring are one SQLite transaction.
    // A restart cannot generate the same residual twice or lose its provenance.
    const persist = () => {
      recordEvidence();
      const existing = store.get(spec.id);
      store.update(t.id, { ...persisted, status: 'partial', continuedBy: spec.id });
      if (!existing) store.add(newTask(spec));
      for (const dependent of store.list()) {
        if (dependent.id === spec.id || !dependent.dependencies.includes(t.id)) continue;
        store.update(dependent.id, { dependencies: dependent.dependencies.map(id => id === t.id ? spec.id : id) });
      }
    };
    commit(managed, [spec.id], persist);
    event('continuation-created', { parentTaskId: t.id, rootTaskId: spec.rootTaskId, taskId: spec.id,
      remainingWorkIds: spec.remainingWorkIds, terminationReason, metrics });
    return true;
  }

  async function applyPendingReplans() {
    while (pendingReplans.length) {
      const id = pendingReplans.shift();
      const f = findingById(id);
      if (!f || f.status === 'superseded' || f.replanAttempted) continue;
      if (!session) { setFinding(id, { status: 'blocked' }); unresolved.push(`${id}: replan requires persistent design context`); continue; }
      if (replanCount >= reviewLimits().maxReplansPerRun) { setFinding(id, { status: 'blocked' }); unresolved.push(`${id}: REPLAN_LIMIT_EXCEEDED`); continue; }
      // The SAME Phase 2 design-planner reads the current, immutable goal and
      // graph; no repair agent or ad-hoc graph generator gets planning authority.
      const context = { canonicalGoal: session.getRun(runId).canonicalGoal,
        acceptanceLedger: session.getAcceptanceLedger(runId), existingTaskGraph: store.snapshot(),
        completedEvidence: session.getAcceptanceLedger(runId).flatMap(c => c.evidence), openFindings: reviewFindings.filter(x => x.status !== 'resolved'),
        failedRepairHistory: reviewFindings.flatMap(x => x.failedRepairHistory ?? []),
        workspaceState: repoRoot ? captureWorktree(repoRoot) : { source: null, entries: {} },
        existingUserDecisions: session.listDecisions(runId).filter(d => d.status === 'answered'),
        constraints: ['preserve verified completed work', 'do not regenerate satisfied scope unless reopened', 'emit residual work only'],
        replanTargetAcceptance: f.affected_acceptance_ids };
      const before = store.snapshot();
      const previous = session.listPlanningAttempts(runId).find(a => a.childTaskId === `design-planner-replan-${replanCount + 1}`);
      let result;
      const recoveredReport = typeof previous?.rawReport === 'string'
        ? parseJsonBlock(previous.rawReport)?.planningReport : previous?.rawReport;
      if (previous?.status === 'valid' && recoveredReport?.work_items) {
        const report = recoveredReport;
        const normalized = { ...report, work_items: report.work_items.map(item => ({ ...item,
          id: `rp${replanCount + 1}-${item.id}`, depends_on: item.depends_on.map(dep => `rp${replanCount + 1}-${dep}`) })) };
        const ledger = session.getAcceptanceLedger(runId);
        const invalid = normalized.work_items.some(item => item.acceptance_ids.some(a => ledger.some(c => c.id === a && c.status === 'satisfied')));
        result = invalid ? { error: 'REPLAN_REGENERATES_VERIFIED', errors: ['recovered plan includes satisfied scope'] }
          : planFromReport(normalized, { agents, routing, policy: activePolicy,
            ledger: ledgerForReplanValidation(ledger, context.replanTargetAcceptance),
            planningRef: previous.id, existingIds: store.list().map(t => t.id) });
        if (!result.ok) result = { error: result.code, errors: result.errors };
      } else if (previous) result = { error: previous.status, errors: previous.validation?.errors ?? ['prior replan attempt invalid'] };
      else result = await designFirstPlan(context);
      replanCount++;
      if (result.error) {
        setFinding(id, { status: 'blocked', replanAttempted: true });
        unresolved.push(`${id}: adaptive replanning failed: ${(result.errors ?? []).join('; ')}`);
        continue;
      }
      // Supersede only the scope invalidated by THIS finding. Other reopened
      // criteria may already have focused repairs or investigations in flight.
      const reopened = f.affected_acceptance_ids.filter(a => session.getAcceptanceLedger(runId)
        .some(c => c.id === a && c.status !== 'satisfied'));
      const obsolete = before.filter(t => (['pending', 'blocked'].includes(t.status) || t.id === f.repairTaskId && t.status === 'failed')
        && t.id !== f.source_task_id && (t.acceptanceIds ?? []).some(a => reopened.includes(a)));
      const newIds = result.tasks.map(t => t.id);
      const reverifyId = `rp${replanCount}-${id.replace(/[^A-Za-z0-9-]/g, '-')}-verify`;
      const diff = { reason: `finding ${id}: ${f.description}`, keptTasks: before.filter(t => !obsolete.some(x => x.id === t.id)).map(t => t.id),
        supersededTasks: obsolete.map(t => t.id), newTasks: [...newIds, reverifyId],
        dependencyChanges: result.tasks.map(t => ({ taskId: t.id, dependencies: t.dependencies })), reopenedAcceptanceCriteria: reopened };
      session.transaction(() => {
        for (const old of obsolete) store.update(old.id, { status: 'superseded', supersededBy: newIds, supersededReason: diff.reason });
        for (const spec of result.tasks) store.add(newTask({ ...spec, rootTaskId: f.rootTaskId, sourceFindingIds: [id],
          sourceReviewTaskId: f.sourceReviewTaskId, budget: createTaskBudget(spec, activePolicy.agent_runtime) }));
        const reviewer = store.get(f.sourceReviewTaskId);
        const verify = newTask({ id: reverifyId, title: `Reverify replan ${id}`, goal: `Verify ${f.title} using concrete evidence for ${f.affected_acceptance_ids.join(', ')}`,
          assignedAgent: 'tester', capability: agents.find(a => a.meta.name === 'tester')?.meta.capability ?? 'strong-code',
          kind: 'reverify', artifact_type: 'test_result', expected_outcome: 'evidence_only', dependencies: newIds, acceptanceIds: f.affected_acceptance_ids,
          acceptance: f.affected_acceptance_ids.map(a => `Verify ${a}: ${f.title}`), rootTaskId: f.rootTaskId,
          sourceFindingIds: [id], sourceReviewTaskId: reviewer?.id, affectedAcceptanceIds: f.affected_acceptance_ids,
          affectedFiles: f.affected_files, budget: createTaskBudget({ assignedAgent: 'tester' }, activePolicy.agent_runtime) });
        store.add(verify);
        for (const dependent of store.list()) {
          if (dependent.id === verify.id || !['pending', 'blocked'].includes(dependent.status) || !dependent.dependencies.some(dep => obsolete.some(x => x.id === dep))) continue;
          const dependencies = [...new Set(dependent.dependencies.flatMap(dep => obsolete.some(x => x.id === dep) ? [reverifyId] : [dep]))];
          diff.dependencyChanges.push({ taskId: dependent.id, before: dependent.dependencies, after: dependencies });
          store.update(dependent.id, { dependencies, ...(dependent.status === 'blocked' ? { status: 'pending', blockedReason: undefined } : {}) });
        }
        planDiffs.push(diff);
        setFinding(id, { status: 'awaiting_reverification', replanAttempted: true, reverifyTaskId: reverifyId });
        persistMeta();
      });
      event('replan-diff', diff);
    }
  }

  const depResults = t => t.dependencies.map(id => store.get(id)).map(d => ({ id: d.id, agent: d.assignedAgent, title: d.title, ...(d.result ?? {}) }));
  // Paths changed by ANY agent of this run so far (retry / rework must not treat them
  // as pre-existing dirty changes) and every answered decision in the run (a rework
  // task inherits the dirty-gate answer given for the original implementation).
  const ownedPaths = () => [...new Set(store.list().flatMap(x => x.ownedPaths ?? []))];
  const runDecisions = () => store.list().flatMap(x => x.decisions ?? []);

  await applyPendingReplans();
  while (true) {
    const ready = runnableTasks(store);
    if (!ready.length) break;
    if (round >= limits.max_rounds) { hitLimit('max_rounds', `${ready.length} runnable task(s) left`); break; }
    round++;
    const batch = ready.slice(0, dp.max_parallel_tasks);
    for (const t of batch) {
      const reviewContext = ['review', 'verify', 'reverify'].includes(t.kind) && session ? {
        implementationRoles: t.dependencies.map(id => ({ taskId: id, agent: store.get(id)?.assignedAgent })).filter(x => x.agent),
        reviewerRole: t.assignedAgent,
        pendingAcceptance: session.getAcceptanceLedger(runId).filter(c => c.status !== 'satisfied'),
        recentRepairFindings: reviewFindings.filter(f => f.status !== 'resolved').slice(-12),
        unverifiedEvidence: session.getAcceptanceLedger(runId).filter(c => c.status !== 'satisfied' && c.evidence.length),
      } : undefined;
      store.update(t.id, { status: 'running', attempts: t.attempts + 1, ...(reviewContext ? { reviewContext } : {}) });
    }
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
      run.evaluatorReasonCodes = ev.reasonCodes;
      store.update(t.id, { evaluatorReasonCodes: ev.reasonCodes, evidenceReferences: ev.evidenceReferences });
      if (run.child) event('child', run.child);
      // Trace only routing/verdict metadata, not model output or step telemetry
      // (which can contain text, commands, and tool arguments).
      const traceSteps = run.steps?.map(s => ({ modelId: s.modelId, capability: s.capability, ok: s.ok, skipped: s.skipped,
        failureClass: s.failureClass, protocolFailure: s.protocolFailure, durationMs: s.durationMs,
        ...(['task-global-failed', 'already-tried'].includes(s.reason) ? { reason: s.reason } : {}) }));
      event('result', { taskId: t.id, agent: t.assignedAgent, capability: t.capability, attempt: t.attempts, executor: run.executor, modelId: run.modelId, verdict: ev.verdict, reasons: ev.reasons, reasonCodes: ev.reasonCodes, failureClass: classifyRun(run), steps: traceSteps, counters: run.counters, invokedModels: run.invokedModels });
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
      const measuredBudget = t.budget ? {
        ...t.budget,
        turns: { ...t.budget.turns, used: t.budget.turns.used + (Number.isInteger(run.child?.turns) ? run.child.turns : 0) },
        tool_calls: { ...t.budget.tool_calls, used: t.budget.tool_calls.used + (Number.isInteger(run.child?.toolCalls) ? run.child.toolCalls : 0) },
      } : undefined;
      store.update(t.id, { result: run.result ?? { status: 'failed', summary: run.error }, modelId: run.modelId, totalModelAttempts, taskGlobalFailedModels, ownedPaths: ownedNow,
        ...(measuredBudget ? { budget: measuredBudget } : {}) });
      if (run.gate) event('gate', { taskId: t.id, gateType: run.gate.type, action: run.gate.action, key: run.gate.key, paths: run.gate.paths });
      if (handleProgress(t, run, ev)) {
        afterRepairFailure(t, ev.reasons);
        await projectStore.onTaskUpdate(structuredClone(store.get(t.id)));
        syncActivity();
        continue;
      }
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
        const complete = () => {
          store.update(t.id, { status: 'completed', feedback: [] });
          completeReviewLifecycle(t, run);
          if (!['review', 'reverify'].includes(t.kind)) for (const spec of ev.newTasks) addTask(spec, t.id);
        };
        if (session) session.transaction(complete); else complete();
      } else if (ev.verdict === 'blocked') {
        gate(t, ev.decisions);
      } else {
        retryOrFail(t, run, ev.reasons);
        afterRepairFailure(t, ev.reasons);
      }
      await projectStore.onTaskUpdate(structuredClone(store.get(t.id)));
      syncActivity();
      progress(`評価: [${t.id}] ${store.get(t.id).status} (${store.list().filter(x => x.status === 'completed').length}/${store.size()} 件完了)`);
    }
    await applyPendingReplans();
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
    throw abortRun(e);
  }
  const resolved = t => t.status === 'completed' || t.status === 'superseded' || (t.status === 'partial' && (
    (t.continuedBy && store.get(t.continuedBy) && resolved(store.get(t.continuedBy))) ||
    (t.splitInto?.length && t.splitInto.every(id => store.get(id) && resolved(store.get(id))))));
  const open = store.list().filter(t => !resolved(t));
  finalGate = completionGate({ tasks: store.list(), ledger: session?.getAcceptanceLedger(runId) ?? [], findings: reviewFindings, pendingApprovals: escalations });
  const status = escalations.length ? 'needs-user' : open.length || unresolved.length || !finalGate.allowed ? 'incomplete' : 'completed';
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
        const failedTasks = session.loadTasks(runId);
        const report = formatReport({ status: 'incomplete', runStatus: 'failed', runId, rounds: round, tasks: failedTasks,
          errors: [String(e.message)], autoDecisions, unresolved, limitsHit: [...limitsHit], escalations });
        session.appendTrace(runId, { at: now(), round, type: 'final-report', report });
        session.updateRun(runId, { status: 'failed', round, reworkCycles, seq, planner: p.planner, counters: { autoDecisions, unresolved: [...unresolved, `run aborted: ${e.message}`], limitsHit: [...limitsHit], decisionLog, runBudget, runBudgetCaps: effectiveRunBudgetCaps,
          reviewFindings, findingDecisions, planDiffs, reviewRounds, replanCount } });
      });
      syncActivity('failed');
      activity?.finishRun?.(runId);
      return { ok: true };
    } catch (e2) {
      return { ok: false, error: e2.message };
    }
  }

  function abortRun(e) {
    const persisted = terminateOnError(e);
    progress(`終了: エラー${runId ? ` (run ${runId})` : ''} — ${first(e.message)}`);
    const err = new Error(`orchestrate: ${e.message}${persisted.ok ? '' : ` (run state could not be persisted: ${persisted.error})`}`);
    err.cause = e; err.runId = runId; err.persisted = persisted.ok;
    return err;
  }

  async function finish(status, errors) {
    const tasks = store ? store.snapshot() : [];
    const runStatus = session ? runStatusOf(status, escalations, tasks) : undefined;
    if (session && runId) persistMeta(runStatus);
    syncActivity(runStatus ?? status);
    if (['completed', 'failed', 'cancelled'].includes(runStatus ?? status)) activity?.finishRun?.(runId);
    const result = { status, runStatus, runId, request, planner: p.planner, rounds: round, reworkCycles, errors, tasks, autoDecisions, escalations, unresolved: [...unresolved, ...(finalGate?.issues ?? [])], reviewFindings, findingDecisions, planDiffs, limitsHit: [...limitsHit], trace, recovered };
    const report = formatReport(result);
    event('final-report', { report });
    result.report = report;
    try {
      await projectStore.onFinal(result);
    } catch (e) {
      // finish() is returned from the async orchestration function; its rejection
      // bypasses the loop's catch. Correct the already-persisted terminal status/report.
      throw abortRun(e);
    }
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
