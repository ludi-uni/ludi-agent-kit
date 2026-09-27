// Programmatic boundary for the CLI and the pi extension. No SQL and no provider-specific imports:
// the caller supplies `invoke` / `runner`. Natural-language UI can call these functions later.
import { join } from 'node:path';
import { loadRouting } from '../routing.mjs';
import { loadPiRegistry, piUserModelsPath } from '../../adapters/pi/lib/model-registry.mjs';
import { loadAgents } from '../agents.mjs';
import { loadPolicy } from './policy.mjs';
import { openStore } from './store.mjs';
import { createHealthMonitor } from './health.mjs';
import { createAgentRunner } from './runner.mjs';
import { orchestrate, formatReport, formatRunList, toEscalation } from './orchestrator.mjs';
import { createActivityTracker } from './activity.mjs';

export function defaultStorePath(kit, env = process.env) {
  return env.LUDI_ORCHESTRATION_STORE || join(kit, '.orchestration', 'state.db');
}

export function loadOrchestrationContext({ kit, storePath, policyPath = null, localPolicyPath = null, clientContext = null, modelOptions = {} }) {
  const routing = loadRouting(join(kit, 'routing/routing.json'));
  const { registry } = loadPiRegistry(kit, routing, modelOptions);
  const { agents, errors } = loadAgents(join(kit, 'agents'), routing);
  const base = join(kit, 'orchestration/decision-policy.json');
  const { policy } = loadPolicy(base, policyPath ?? localPolicyPath ?? join(kit, 'orchestration/decision-policy.local.json'));
  const session = openStore(storePath);
  const activity = createActivityTracker({ kit, clientContext });
  return { kit, routing, registry, agents, errors, policy, session, storePath, clientContext, activity, bindingPath: piUserModelsPath(modelOptions.env, modelOptions.home) };
}

/** Public live activity for one run (in-memory projection; null when unknown). */
export function getRunActivity(ctx, runId) {
  return ctx.activity?.getRunActivity(runId) ?? null;
}

/** Public live activity addressed by owning client ({ kind, sessionId }). */
export function getRunActivityByClient(ctx, kind, sessionId) {
  return ctx.activity?.getRunActivityByClient(kind, sessionId) ?? null;
}

/** Subscribe to activity updates for one run. Returns an unsubscribe function. */
export function subscribeRunActivity(ctx, runId, listener) {
  return ctx.activity?.subscribeRunActivity(runId, listener) ?? (() => {});
}

export function listOrchestrationRuns(ctx, { status = null } = {}) {
  return ctx.session.listRuns(status ? { status } : {});
}

export function pendingDecisions(ctx, { runId = null } = {}) {
  const runs = runId ? [ctx.session.getRun(runId)].filter(Boolean) : ctx.session.listRuns({ status: 'waiting_for_user' });
  const out = [];
  for (const run of runs) {
    const id = run.id;
    for (const d of ctx.session.listDecisions(id, 'pending')) out.push(d);
  }
  return out;
}

export function showRun(ctx, runId) {
  const run = ctx.session.getRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  const tasks = ctx.session.loadTasks(runId);
  const pending = ctx.session.listDecisions(runId, 'pending');
  const trace = ctx.session.loadTrace(runId);
  // A prior final report is historical while a run is resumed; never show it as live status.
  const report = run.status === 'running' ? null : (trace.findLast(e => e.type === 'final-report')?.report ?? null);
  const status = run.status === 'waiting_for_user' ? 'needs-user' : run.status === 'completed' ? 'completed' : 'incomplete';
  return {
    status, runStatus: run.status, runId, request: run.request, planner: run.planner, rounds: run.round,
    errors: [], tasks, autoDecisions: run.counters.autoDecisions ?? [], escalations: pending.map(toEscalation),
    unresolved: run.counters.unresolved ?? [], limitsHit: run.counters.limitsHit ?? [], trace, report,
  };
}

export function answerOrchestration(ctx, { runId, decisionId, answer }) {
  return ctx.session.answerDecision({ runId, decisionId, answer, scopeKey: ctx.session.getRun(runId)?.scopeKey });
}

const DURATION_UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Parse a duration like "30m", "12h", "7d", "2w" into milliseconds. Throws on bad input. */
export function parseOlderThan(text) {
  const m = /^(\d+)\s*([mhdw])$/i.exec(String(text ?? '').trim());
  if (!m) throw new Error(`invalid --older-than "${text}" (examples: 30m, 12h, 7d, 2w)`);
  const ms = Number(m[1]) * DURATION_UNITS[m[2].toLowerCase()];
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error(`invalid --older-than "${text}"`);
  return ms;
}

/** Read-only preview of what a cleanup would delete. Never writes. */
export function previewRunCleanup(ctx, { olderThan = null, includeActive = false } = {}) {
  return ctx.session.previewRuns({ olderThan, includeActive });
}

/** Delete terminal runs older than `olderThanMs` (null = all terminal). One transaction. */
export function pruneOrchestrationRuns(ctx, { olderThanMs = 7 * 86_400_000 } = {}) {
  const cutoff = new Date(Date.now() - (olderThanMs ?? 7 * 86_400_000)).toISOString();
  return ctx.session.pruneRuns({ olderThan: cutoff });
}

/** Delete one run's history. The store refuses active/resumable runs. */
export function deleteOrchestrationRun(ctx, runId, { force = false } = {}) {
  return ctx.session.deleteRun(runId, { force });
}

/** force=false previews; force=true deletes all terminal runs (includeActive additionally removes active ones). */
export function clearOrchestrationRuns(ctx, { force = false, includeActive = false } = {}) {
  return ctx.session.clearRuns({ force, includeActive });
}

const cleanupLine = r => `${r.id}  ${r.status}  tasks:${r.counts.tasks} decisions:${r.counts.decisions} trace:${r.counts.trace}  ${r.updatedAt}  ${String(r.request).replace(/\s+/g, ' ').slice(0, 60)}`;

/** Concise Japanese summary of a cleanup preview or executed cleanup. */
export function formatCleanup(result, { verb = '削除', hint = '--force' } = {}) {
  const lines = [];
  if (!result.runs.length || (result.totals.runs === 0 && !result.skipped.length)) return '削除対象のランはありません';
  const head = result.executed ? `${verb}しました` : `削除対象（プレビュー）`;
  lines.push(`${head}: ${result.totals.runs} ラン (terminal:${result.totals.terminal} active/resumable:${result.totals.active}; tasks:${result.totals.tasks} decisions:${result.totals.decisions} trace:${result.totals.trace} health:${result.totals.health})`);
  lines.push(`内訳: completed ${result.runs.filter(r => r.deletable && r.status === 'completed').length}, failed ${result.runs.filter(r => r.deletable && r.status === 'failed').length}, cancelled ${result.runs.filter(r => r.deletable && r.status === 'cancelled').length}, active保持 ${result.skipped.filter(s => /active|resumable/.test(s.reason)).length}`);
  lines.push(`更新日時: ${result.totals.oldest ?? 'なし'} ～ ${result.totals.newest ?? 'なし'}`);
  for (const r of result.runs.filter(x => x.deletable)) lines.push(`  ${cleanupLine(r)}`);
  if (result.skipped.length) {
    lines.push(`スキップ: ${result.skipped.length} ラン`);
    for (const s of result.skipped) lines.push(`  ${s.id}  ${s.reason}`);
  }
  if (!result.executed) lines.push(`実行するには ${hint} を指定してください`);
  return lines.join('\n');
}

export function createRunHealth(ctx) {
  return createHealthMonitor({ session: ctx.session, policy: ctx.policy });
}

export function createRunRunner(ctx, { invoke, runSubagent = null, repoRoot, outDir, apply = false, health, runId = null }) {
  const snapshot = runId ? ctx.session.getRun(runId)?.policySnapshot : null;
  const policy = snapshot?.limits ? snapshot : ctx.policy;
  return createAgentRunner({
    invoke, runSubagent, agents: ctx.agents, routing: ctx.routing, registry: ctx.registry, repoRoot, outDir, health, policy, session: ctx.session,
    maxModelAttempts: policy.limits.model_attempts_per_task, pipelineAgents: apply ? ['coder'] : [],
  });
}

export async function startOrchestration(ctx, { request, repoRoot = null, planner = 'rules', plan = null, runner, invoke = null, health = null, projectStore, onProgress = null }) {
  return orchestrate({
    request, planner, plan, agents: ctx.agents, routing: ctx.routing, registry: ctx.registry, policy: ctx.policy,
    runner, invoke, repoRoot, session: ctx.session, health, projectStore, activity: ctx.activity, bindingPath: ctx.bindingPath, onProgress,
  });
}

export async function resumeOrchestration(ctx, { runId, answers = [], repoRoot = null, runner, invoke = null, health = null, projectStore, onProgress = null }) {
  return orchestrate({
    request: '', resumeRunId: runId, answers, agents: ctx.agents, routing: ctx.routing, registry: ctx.registry,
    policy: ctx.policy, runner, invoke, repoRoot, session: ctx.session, health, projectStore, activity: ctx.activity, bindingPath: ctx.bindingPath, onProgress,
  });
}

export { formatReport, formatRunList };
