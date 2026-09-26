// AgentRunner: oneshot (pi -p --no-tools), pipeline (existing scout->coder path), or an injected
// tool-capable subagent. pi process details stay in the adapter behind `runSubagent`.
import { join, relative, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { withEscalation, runPipeline, surveyRepo } from '../pipeline.mjs';
import { parseJsonBlock } from './planner.mjs';
import { buildTaskContract, RESULT_STATUSES } from './contract.mjs';
import { accessOf, piToolsForAccess, resolveExecutionMode, workspaceOf } from './permissions.mjs';
import { captureWorktree, diffWorktree } from './worktree.mjs';
import { classifyRun, REASSIGN_CLASSES, isProtocolFailure, shouldMarkTaskGlobalFailure } from './failures.mjs';
import { dangerousCommands } from './shell-policy.mjs';
import { classifyTaskComplexity, initialTurnBudget } from './turn-budget.mjs';

const arr = v => (Array.isArray(v) ? v : []);

/** Structured result from agent text. Unstructured replies are kept as summary and flagged. */
export function parseStructuredResult(text) {
  const json = parseJsonBlock(text);
  if (!json || typeof json !== 'object' || !RESULT_STATUSES.includes(json.status)) {
    return { structured: false, failureClass: 'MALFORMED_RESULT', result: { status: 'unknown', summary: String(text ?? '').trim().slice(0, 2000), artifacts: [], filesChanged: [], commandsRun: [], verification: [], acceptance: [], remainingIssues: [], decisions: [], newTasks: [] } };
  }
  const status = json.status === 'needs_decision' ? 'blocked' : json.status;
  const verification = arr(json.verification).map(v => (typeof v === 'string' ? { result: v } : v));
  return { structured: true, result: {
    status, summary: String(json.summary ?? ''),
    artifacts: arr(json.artifacts ?? json.filesChanged).map(String),
    filesChanged: arr(json.filesChanged).map(String),
    commandsRun: arr(json.commandsRun).map(String),
    verification, acceptance: arr(json.acceptance),
    remainingIssues: arr(json.remainingIssues).map(i => (typeof i === 'string' ? { summary: i, blocking: false } : i)),
    decisions: arr(json.decisions), newTasks: arr(json.newTasks ?? json.discoveredTasks),
  } };
}

export const DIRTY_GATE_TYPE = 'worktree-dirty';

/**
 * Dirty-worktree safety gate. Only PRE-EXISTING, UNRELATED changes gate an
 * implementation: paths this run's agents already changed (`ownedPaths`) are
 * excluded, and a non-git workspace (file inventory) is never treated as dirty.
 * The decision key is derived from the set of unrelated paths so an answered
 * decision for the same condition is recognised across retries / rework tasks.
 * @returns {{ gate: false } | { gate: true, action: 'ask'|'proceed'|'abort', paths: string[], key: string, decision?: object }}
 */
export function evaluateDirtyGate({ before, ownedPaths = [], decisions = [] }) {
  if (before?.source !== 'git') return { gate: false, reason: 'not a git workspace' };
  const owned = new Set(ownedPaths);
  const paths = Object.keys(before.entries ?? {}).filter(p => !owned.has(p)).sort();
  if (!paths.length) return { gate: false, reason: owned.size ? 'only agent-owned changes' : 'clean' };
  const digest = createHash('sha1').update(paths.join('\n')).digest('hex').slice(0, 12);
  const key = `${DIRTY_GATE_TYPE}:${digest}`;
  const answered = decisions.filter(d => d && (d.key === key || d.decisionType === DIRTY_GATE_TYPE && d.key === key));
  const optionOf = d => d.optionId ?? (/^proceed/i.test(String(d.choice ?? '')) ? 'proceed' : /^abort/i.test(String(d.choice ?? '')) ? 'abort' : null);
  const last = answered.map(optionOf).filter(Boolean).at(-1);
  if (last === 'proceed') return { gate: true, action: 'proceed', paths, key };
  if (last === 'abort') return { gate: true, action: 'abort', paths, key };
  return {
    gate: true, action: 'ask', paths, key,
    decision: {
      key, decisionType: DIRTY_GATE_TYPE,
      question: `Workspace has ${paths.length} pre-existing uncommitted change(s) not made by this run (${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ', …' : ''}). Proceed with implementation anyway?`,
      flags: ['destructive_action'],
      options: [
        { id: 'proceed', summary: 'proceed; existing changes are unrelated or acceptable', reversible: false, flags: ['destructive_action'] },
        { id: 'abort', summary: 'do not implement; keep the dirty tree untouched', reversible: true },
      ],
    },
  };
}

export function guardWorkspace(workspace, repoRoot) {
  if (!workspace?.path) return null;
  const root = resolve(repoRoot ?? workspace.path);
  const target = resolve(workspace.path);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) return `workspace ${target} is outside ${root}`;
  return null;
}

function childRecord(task, ctx, extra) {
  return {
    taskId: task.id, runId: ctx.runId ?? null, agent: task.assignedAgent, capability: task.capability,
    startedAt: extra.startedAt, finishedAt: extra.finishedAt, durationMs: extra.durationMs ?? null, status: extra.status,
    childSessionId: extra.childSessionId ?? null, modelId: extra.modelId ?? null, backend: extra.backend ?? null, provider: extra.provider ?? null, failureClass: extra.failureClass ?? null,
    toolCalls: extra.toolCalls ?? null, turns: extra.turns ?? null,
    uniqueFilesInspected: extra.uniqueFilesInspected ?? 0, toolNames: extra.toolNames ?? {},
    commandsExecuted: extra.commandsExecuted ?? 0, extensionsGranted: extra.extensionsGranted ?? 0,
    initialTurns: extra.initialTurns, finalTurnLimit: extra.finalTurnLimit, stopReason: extra.stopReason ?? null,
  };
}

/**
 * @param {object} o
 * @param {Function} o.invoke adapter invoker ({ modelId, systemPrompt, prompt, cwd }) -> { ok, text, error }
 * @param {Function} [o.runSubagent] tool-capable child ({ modelId, systemPrompt, prompt, cwd, toolNames, shell, limits })
 * @param {string[]} [o.pipelineAgents] agents executed through runPipeline (writes files; opt-in)
 */
export function createAgentRunner({ invoke, runSubagent = null, agents, routing, registry, repoRoot = null, outDir = null, maxModelAttempts = 2, pipelineAgents = [], surveyKinds = ['investigate', 'review', 'verify'], health = null, policy = null, session = null }) {
  const byName = Object.fromEntries(agents.map(a => [a.meta.name, a]));
  const runtime = policy?.agent_runtime ?? { max_runtime_ms: 600000, max_tool_calls: 40, max_turns: 12 };
  // Resolved per-task execution limits: role+complexity initial turn budget plus
  // the bounded-extension knobs. The subagent runner enforces progress-aware
  // extension inside a single invocation (never consumes the attempt budget).
  const limitsFor = (task, agent) => {
    const complexity = classifyTaskComplexity(task);
    const turns = initialTurnBudget(runtime, agent?.meta?.name ?? 'default', complexity);
    return { ...runtime, max_turns: turns, complexity, extension_turns: runtime.extension_turns ?? 0, max_extensions: runtime.max_extensions ?? 0, absolute_max_turns: runtime.absolute_max_turns ?? turns };
  };
  // Remaining real-invocation budget for this task across retries.
  const invocationsBudget = task => {
    const cap = policy?.limits?.max_total_attempts_per_task;
    return cap == null ? null : Math.max(0, cap - (task?.totalModelAttempts ?? 0));
  };
  // Candidates to skip entirely: capability-local tried + task-global failed models.
  const excludeModels = task => task?.attemptedModels ?? [];
  const telemetryFor = out => ({
    toolCalls: out?.child?.toolCalls ?? out?.telemetry?.toolCalls ?? out?.toolCalls,
    turnLimit: ['no-progress-turn-limit', 'absolute-turn-limit'].includes(out?.child?.stopReason) || /turn limit/i.test(out?.error ?? ''),
    structuredProgress: out?.structuredProgress ?? ((out?.text ?? out?.telemetry?.text) != null ? parseStructuredResult(out.text ?? out.telemetry.text).structured : undefined),
    hasFinalOutput: (out?.text ?? out?.telemetry?.text) != null ? parseStructuredResult(out.text ?? out.telemetry.text).structured : undefined,
  });

  // Protocol-reliability telemetry (audit only; not fed back into routing).
  const recordProtocol = (candidate, kind) => {
    try { session?.recordProtocol?.({ provider: candidate?.provider, model: candidate?.model ?? candidate?.modelId, kind }); } catch { /* never block a run on telemetry */ }
  };

  async function viaPipeline(task, ctx) {
    const context = ctx.dependencyResults.map(d => `- ${d.id}: ${String(d.summary ?? '').slice(0, 600)}`).join('\n');
    const summary = await runPipeline({ repoRoot, task: `${task.goal}${context ? `\n\nContext from earlier steps:\n${context}` : ''}`, routing, registry, agents, invoke, outDir: join(outDir ?? join(repoRoot, '.orchestrate-out'), task.id), maxAttempts: maxModelAttempts, health });
    const ok = summary.outcome === 'success';
    const evidence = ok ? `pipeline outcome success; \`${summary.testCommand ?? 'tests'}\` passed after applying ${summary.applied?.join(', ')}` : `pipeline outcome ${summary.outcome}`;
    const n = Math.max(task.acceptance.length, 1);
    return { ok: true, structured: true, executor: 'pipeline', steps: summary.steps, modelId: summary.steps.at(-1)?.modelId, result: {
      status: ok ? 'completed' : 'failed', summary: evidence, artifacts: summary.applied ?? [], filesChanged: summary.applied ?? [], commandsRun: [], verification: ok ? [{ command: summary.testCommand, result: 'pass' }] : [{ command: summary.testCommand, result: evidence }],
      acceptance: Array.from({ length: n }, (_, i) => ({ id: `A${i + 1}`, met: ok, evidence })), remainingIssues: ok ? [] : [{ summary: evidence, blocking: true }], decisions: [], newTasks: [],
    }, failureClass: ok ? undefined : 'TEST_FAILURE' };
  }

  async function viaSubagent(task, agent, ctx) {
    const workspace = workspaceOf(task, repoRoot);
    const outside = guardWorkspace(workspace, repoRoot);
    if (outside) return { ok: false, error: outside, failureClass: 'POLICY_BLOCK', steps: [], executor: 'subagent' };
    const access = accessOf(agent);
    const before = workspace.path ? captureWorktree(workspace.path) : { available: false, entries: {} };
    // Working-tree safety: a write-capable implementation on a dirty tree may
    // collide with PRE-EXISTING user changes. Read-only tasks proceed; changes
    // made by this run's agents (retry / rework) are not "dirty"; a non-git
    // workspace is never gated; an already-answered decision is honoured.
    if (access.filesystem === 'read-write') {
      const g = evaluateDirtyGate({ before, ownedPaths: ctx.ownedPaths ?? [], decisions: [...(ctx.runDecisions ?? []), ...(task.decisions ?? [])] });
      if (g.gate && g.action === 'ask') {
        return { ok: false, error: `workspace has ${g.paths.length} pre-existing uncommitted change(s); implementation may collide with existing work`, failureClass: 'USER_DECISION_REQUIRED', steps: [], executor: 'subagent', decision: g.decision, gate: { type: DIRTY_GATE_TYPE, key: g.key, action: 'ask', paths: g.paths } };
      }
      if (g.gate && g.action === 'abort') {
        return { ok: false, error: 'implementation aborted by user decision: workspace has pre-existing uncommitted changes', failureClass: 'POLICY_BLOCK', abort: true, steps: [], executor: 'subagent', gate: { type: DIRTY_GATE_TYPE, key: g.key, action: 'abort', paths: g.paths } };
      }
      if (g.gate) ctx = { ...ctx, gate: { type: DIRTY_GATE_TYPE, key: g.key, action: 'proceed', paths: g.paths } };
    }
    const survey = workspace.path && surveyKinds.includes(task.kind) ? surveyRepo(workspace.path, { maxTotalInline: 8000 }) : null;
    const prompt = buildTaskContract(task, { ...ctx, survey, access, workspace });
    const steps = [];
    const startedAt = new Date().toISOString();
    let invocationSeq = 0;
    let previousModel = null;
    const emit = (type, data) => ctx.onEvent?.(type, { taskId: task.id, ...data });
    let r;
    try {
      r = await withEscalation({ routing, registry, capability: task.capability, agent: agent.meta.name, pack: { previous_attempts: [] }, maxAttempts: maxModelAttempts, trace: steps, skip: health?.skip, onFailure: health?.report, excludeModels: excludeModels(task), taskGlobalFailedModels: task.taskGlobalFailedModels, invocationsBudget: invocationsBudget(task),
        fn: async (c, attempt) => {
          const invocationId = `${task.id}-i${++invocationSeq}`;
          if (attempt > 0) {
            const prior = [...steps].reverse().find(s => !s.skipped);
            const reason = prior?.protocolFailure ?? prior?.failureClass ?? 'candidate failed';
            emit('candidate-changed', { invocationId, agent: agent.meta.name, capability: task.capability, fromModel: previousModel, toModel: c.modelId, reason });
          }
          previousModel = c.modelId;
          emit('invocation-start', { invocationId, agent: agent.meta.name, capability: task.capability, modelId: c.modelId, backend: c.backend, provider: c.provider });
          const forward = (type, data) => emit(type, { invocationId, ...data });
          let out;
          try {
            out = await runSubagent({ ...c, capability: task.capability, systemPrompt: agent.body, prompt, cwd: workspace.path ?? repoRoot ?? process.cwd(), toolNames: piToolsForAccess(access), access, limits: limitsFor(task, agent), taskId: task.id, runId: ctx.runId, onEvent: forward });
          } catch (error) {
            emit('invocation-end', { invocationId, agent: agent.meta.name, modelId: c.modelId, status: 'failed', reason: 'MODEL_FAILURE' });
            throw error;
          }
          const klass = out.failureClass || classifyRun(out);
          const probe = out.ok ? parseStructuredResult(out.text) : null;
          const endFailure = !out.ok ? klass : !probe.structured ? 'MALFORMED_RESULT' : null;
          emit('invocation-end', { invocationId, agent: agent.meta.name, modelId: c.modelId, status: endFailure ? 'failed' : 'finished', reason: endFailure ?? undefined,
            ...(out.child?.turns != null ? { turnsUsed: out.child.turns } : {}), ...(out.child?.toolCalls != null ? { toolCalls: out.child.toolCalls } : {}) });
          if (!out.ok && REASSIGN_CLASSES.has(klass)) return { ok: false, reason: out.error ?? klass, failureClass: klass, protocolFailure: klass === 'MODEL_FAILURE' ? klass : undefined, child: out.child, telemetry: out.telemetry };
          if (!out.ok) {
            // Protocol-quality failure -> return ok:false so withEscalation advances
            // to the NEXT candidate within this same attempt instead of retrying
            // this model. A turn-limit timeout WITH tool progress stays retryable.
            if (isProtocolFailure(klass, out.child ?? out)) {
              recordProtocol(c, klass === 'EMPTY_RESPONSE' ? 'empty' : (klass === 'TIMEOUT' || klass === 'NO_PROGRESS_TIMEOUT') ? 'turn_limit' : 'malformed');
              return { ok: false, reason: out.error ?? klass, protocolFailure: shouldMarkTaskGlobalFailure(klass, telemetryFor(out)) ? klass : undefined, failureClass: klass, child: out.child, telemetry: out.telemetry ?? out.child };
            }
            return { ok: true, reason: 'child stopped', terminalFailure: klass, error: out.error, child: out.child, text: out.text ?? '', telemetry: out.child };
          }
          // Got text back — but if it isn't a structured result, that is a
          // MALFORMED_RESULT protocol failure: advance to the next candidate too.
          if (!probe.structured) { recordProtocol(c, 'malformed'); return { ok: false, reason: 'no structured result block', protocolFailure: 'MALFORMED_RESULT', child: out.child, text: out.text, telemetry: out.child }; }
          recordProtocol(c, 'structured_ok');
          return { ok: true, reason: 'response received', text: out.text, child: out.child, telemetry: out.child };
        } });
    } catch (e) {
      return { ok: false, error: e.message, failureClass: classifyRun({ error: e.message }), steps, executor: 'subagent' };
    }
    const after = workspace.path ? captureWorktree(workspace.path) : before;
    const agentChanges = diffWorktree(before, after);
    const finishedAt = new Date().toISOString();
    const payload = r.result ?? {};
    // On protocol failure r.result is empty, so payload.child is missing. Recover
    // the last invoked candidate's child (it holds real toolCalls/turns/modelId)
    // from r.last so telemetry isn't lost. Never invent values — only reuse what
    // the runner actually recorded.
    const lastStep = [...steps].reverse().find(s => !s.skipped);
    const lastChild = r.last?.child ?? payload.child ?? {};
    const lastModelId = r.candidate?.modelId ?? lastStep?.modelId ?? lastChild.modelId ?? r.invokedModels?.at(-1);
    const child = childRecord(task, ctx, { ...lastChild,
      toolCalls: lastChild.toolCalls ?? lastStep?.telemetry?.toolCalls,
      turns: lastChild.turns ?? lastStep?.telemetry?.turns,
      startedAt: lastStep?.startedAt ?? startedAt, finishedAt,
      durationMs: lastStep?.durationMs,
      status: r.ok && !payload.terminalFailure ? 'finished' : 'failed', modelId: lastModelId,
      backend: r.candidate?.backend ?? lastStep?.backend ?? lastChild.backend,
      provider: r.candidate?.provider ?? lastStep?.provider ?? lastChild.provider,
      failureClass: r.ok ? payload.terminalFailure : (lastStep?.failureClass ?? lastStep?.protocolFailure ?? null),
    });
    if (!r.ok) return { ok: false, error: r.last?.reason ?? 'no model candidate succeeded', failureClass: r.last?.protocolFailure ?? classifyRun({ error: r.last?.reason }), steps, executor: 'subagent', child, worktree: { before, after, agentChanges }, invokedModels: r.invokedModels, counters: r.counters, modelId: r.invokedModels?.at(-1) };
    if (payload.terminalFailure) return { ok: false, error: payload.error ?? payload.terminalFailure, failureClass: payload.terminalFailure, steps, executor: 'subagent', child, worktree: { before, after, agentChanges }, invokedModels: r.invokedModels, counters: r.counters, modelId: r.candidate?.modelId };
    const parsed = parseStructuredResult(payload.text);
    if (agentChanges.length) {
      const seen = new Set(parsed.result.filesChanged);
      for (const change of agentChanges) if (!seen.has(change.path)) parsed.result.filesChanged.push(change.path);
    }
    return { ok: true, executor: 'subagent', raw: payload.text, structured: parsed.structured, result: parsed.result, failureClass: parsed.failureClass, modelId: r.candidate.modelId, backend: r.candidate.backend, steps, child, worktree: { before, after, agentChanges }, invokedModels: r.invokedModels, counters: r.counters, gate: ctx.gate };
  }

  return {
    async run(task, ctx = { dependencyResults: [] }) {
      const agent = byName[task.assignedAgent];
      if (!agent) return { ok: false, error: `unknown agent "${task.assignedAgent}"`, failureClass: 'UNKNOWN', steps: [] };
      const mode = resolveExecutionMode(agent, task, { pipelineAgents, hasSubagent: typeof runSubagent === 'function' });
      if (mode === 'pipeline') {
        try { return await viaPipeline(task, ctx); } catch (e) { return { ok: false, error: `pipeline: ${e.message}`, failureClass: 'TOOL_FAILURE', steps: [], executor: 'pipeline' }; }
      }
      if (mode === 'subagent') return viaSubagent(task, agent, ctx);
      const survey = repoRoot && surveyKinds.includes(task.kind) ? surveyRepo(repoRoot, { maxTotalInline: 12000 }) : null;
      const prompt = buildTaskContract(task, { ...ctx, survey, access: accessOf(agent), workspace: workspaceOf(task, repoRoot) });
      const steps = [];
      let r;
      try {
        r = await withEscalation({ routing, registry, capability: task.capability, agent: agent.meta.name, pack: { previous_attempts: [] }, maxAttempts: maxModelAttempts, trace: steps, skip: health?.skip, onFailure: health?.report, excludeModels: excludeModels(task), taskGlobalFailedModels: task.taskGlobalFailedModels, invocationsBudget: invocationsBudget(task),
          fn: async c => {
            const x = await invoke({ ...c, systemPrompt: agent.body, prompt, cwd: repoRoot ?? process.cwd() });
            if (!x.ok) {
              const klass = x.failureClass || classifyRun({ error: x.error });
              if (isProtocolFailure(klass, x)) { recordProtocol(c, klass === 'EMPTY_RESPONSE' ? 'empty' : klass === 'TIMEOUT' ? 'turn_limit' : 'malformed'); return { ok: false, reason: x.error ?? klass, protocolFailure: shouldMarkTaskGlobalFailure(klass, telemetryFor(x)) ? klass : undefined, failureClass: klass }; }
              return { ok: false, reason: x.error ?? 'invoke failed', failureClass: klass, protocolFailure: klass === 'MODEL_FAILURE' ? klass : undefined };
            }
            const probe = parseStructuredResult(x.text);
            if (!probe.structured) { recordProtocol(c, 'malformed'); return { ok: false, reason: 'no structured result block', protocolFailure: 'MALFORMED_RESULT', text: x.text }; }
            recordProtocol(c, 'structured_ok');
            return { ok: true, reason: 'response received', text: x.text };
          } });
      } catch (e) { return { ok: false, error: e.message, failureClass: classifyRun({ error: e.message }), steps, executor: 'oneshot' }; }
      if (!r.ok) return { ok: false, error: r.last?.reason ?? 'no model candidate succeeded', failureClass: r.last?.protocolFailure ?? classifyRun({ error: r.last?.reason }), steps, executor: 'oneshot', invokedModels: r.invokedModels, counters: r.counters, modelId: r.invokedModels?.at(-1) };
      const parsed = parseStructuredResult(r.result.text);
      return { ok: true, executor: 'oneshot', raw: r.result.text, structured: parsed.structured, result: parsed.result, failureClass: parsed.failureClass, modelId: r.candidate.modelId, backend: r.candidate.backend, steps, invokedModels: r.invokedModels, counters: r.counters };
    },
  };
}

export { dangerousCommands };
