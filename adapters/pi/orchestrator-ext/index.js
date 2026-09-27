// pi extension: slash commands and one tool over the persistent orchestration API.
// Loaded from adapters/pi/orchestrator-ext (junction extensions/ludi-orchestrator). No pi core changes.
// When accessed via a junction/symlink (e.g. ~/.pi/agent/extensions/…/index.js) the file URL
// points at the junction, so relative imports would resolve wrong.  Resolve via realpathSync
// to the physical location and use dynamic imports built from kitRoot.
import { Type } from 'typebox';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { parseOrchestrateCommand } from './command.mjs';

// Resolve junctions so that __dir is the physical location under the kit tree.
const __file = realpathSync(fileURLToPath(import.meta.url));
const __dir = dirname(__file);
const kitRoot = resolve(__dir, '../../../');

// Lazy-import cache – resolved once via file:// URL built from kitRoot.
let _imports = null;
async function _importsFn() {
  if (!_imports) {
    _imports = {
      invoke: await import(pathToFileURL(resolve(kitRoot, 'adapters/pi/lib/invoke.mjs')).href),
      subagent: await import(pathToFileURL(resolve(kitRoot, 'adapters/pi/lib/subagent.mjs')).href),
      api: await import(pathToFileURL(resolve(kitRoot, 'lib/orchestrator/api.mjs')).href),
    };
  }
  return _imports;
}

function kitPath() {
  return decodeURIComponent(resolve(kitRoot).replace(/^\/[A-Za-z]:/, '$1'));
}

function text(body) {
  return { content: [{ type: 'text', text: body }], details: undefined };
}

export default function orchestratorExtension(pi) {
  // The pi session id is AUTHORITATIVE for clientContext kind 'pi-web'. A caller
  // may not claim a different session — mismatch is rejected before any run starts.
  const run = async (action, params, executionCtx = null, onProgress = null) => {
    const root = kitPath();
    const im = await _importsFn();
    const { loadOrchestrationContext, listOrchestrationRuns, showRun, formatReport, formatRunList, defaultStorePath, pendingDecisions, createRunHealth, createRunRunner, startOrchestration, resumeOrchestration, answerOrchestration, parseOlderThan, pruneOrchestrationRuns, deleteOrchestrationRun, clearOrchestrationRuns, previewRunCleanup, formatCleanup } = im.api;
    const createPiInvoker = im.invoke.createPiInvoker;
    const createPiSubagentRunner = im.subagent.createPiSubagentRunner;
    const requestedClient = params.clientContext;
    const sessionId = executionCtx?.sessionManager?.getSessionId?.() ?? null;
    if (requestedClient && requestedClient.kind !== 'pi-web') return 'unsupported clientContext.kind';
    if (requestedClient && !sessionId) return 'pi session id unavailable; cannot bind run';
    if (requestedClient?.sessionId && requestedClient.sessionId !== sessionId) return 'clientContext sessionId mismatch';
    const cc = requestedClient ? { kind: 'pi-web', sessionId } : null;
    const ctx = loadOrchestrationContext({ kit: root, storePath: params.store || defaultStorePath(root), clientContext: cc });
    try {
      if (ctx.errors.length) return ctx.errors.join('\n');
      if (action === 'list') return formatRunList(listOrchestrationRuns(ctx, { status: params.status || null }));
      if (action === 'status' && !params.runId) return formatRunList(listOrchestrationRuns(ctx, { status: params.status || null }));
      if (['status', 'children', 'result'].includes(action) && !params.runId) return `${action} requires runId`;
      if (params.runId && ['status', 'children', 'result'].includes(action)) {
        const shown = showRun(ctx, params.runId);
        const children = (shown.trace ?? []).filter(e => e.type === 'child');
        const active = shown.tasks.filter(t => t.status === 'running');
        if (action === 'children') return active.length ? active.map(t => `${t.id} ${t.assignedAgent} running`).join('\n') : 'active children: none';
        if (action === 'result') return shown.tasks.map(t => `${t.id} ${t.status} ${String(t.result?.summary ?? '').split('\n')[0]}`).join('\n');
        return `${shown.report ?? formatReport(shown)}\n\nactive children: ${active.length ? active.map(t => t.id).join(', ') : 'none'}\nchild sessions: ${children.length}`;
      }
      if (action === 'decisions') {
        const rows = pendingDecisions(ctx, { runId: params.runId || null });
        return rows.length ? rows.map(d => `${d.runId}  ${d.id}  [${d.taskId}] ${d.question}`).join('\n') : 'decisions: none';
      }
      if (action === 'prune') {
        // Destructive: deletes terminal run history. Always previews in the reply.
        const ms = params.olderThan ? parseOlderThan(params.olderThan) : undefined;
        return formatCleanup(pruneOrchestrationRuns(ctx, { olderThanMs: ms }), { verb: '削除' });
      }
      if (action === 'delete') {
        // Destructive only with force=true; otherwise a preview of that one run.
        if (!params.runId) return 'delete requires runId';
        if (params.force) {
          const r = deleteOrchestrationRun(ctx, params.runId, { force: true });
          return `削除しました: ${r.id} (tasks:${r.deleted.tasks} decisions:${r.deleted.decisions} trace:${r.deleted.trace} health:${r.deleted.health})`;
        }
        const target = previewRunCleanup(ctx, { includeActive: true }).runs.find(r => r.id === params.runId);
        if (!target) return `run not found: ${params.runId}`;
        if (!target.deletable) return `削除できません: ${target.id} — ${target.reason}`;
        return `削除対象（プレビュー）: ${target.id} ${target.status} tasks:${target.counts.tasks} decisions:${target.counts.decisions} trace:${target.counts.trace}\n実行するには force=true`;
      }
      if (action === 'clear') {
        // force=false previews; force=true deletes all terminal runs; includeActive adds active ones.
        return formatCleanup(clearOrchestrationRuns(ctx, { force: !!params.force, includeActive: !!params.includeActive }), { verb: '削除' });
      }
      const health = createRunHealth(ctx);
      const invoke = createPiInvoker();
      const runner = createRunRunner(ctx, { invoke, runSubagent: createPiSubagentRunner(), repoRoot: params.repo || null, apply: false, health,
        runId: ['resume', 'answer'].includes(action) ? params.runId : null });
      if (action === 'answer') {
        answerOrchestration(ctx, { runId: params.runId, decisionId: params.decisionId, answer: params.answer });
        const result = await resumeOrchestration(ctx, { runId: params.runId, repoRoot: params.repo || null, runner, invoke, health, onProgress });
        return formatReport(result);
      }
      if (action === 'resume') {
        const result = await resumeOrchestration(ctx, { runId: params.runId, repoRoot: params.repo || null, runner, invoke, health, onProgress });
        return formatReport(result);
      }
      const result = await startOrchestration(ctx, { request: params.request, repoRoot: params.repo || null, runner, invoke, health, onProgress });
      return formatReport(result);
    } catch (error) {
      if (!error.runId) throw error;
      const shown = showRun(ctx, error.runId);
      return `${shown.report ?? formatReport(shown)}\n\n実行エラー: ${error.message}`;
    } finally {
      ctx.session.close();
    }
  };

  pi.registerCommand('orchestrate', {
    description: 'Start, list, resume, or answer a persistent ludi orchestration run',
    handler: async (args, ctx) => {
      const { action, params } = parseOrchestrateCommand(args);
      try {
        const body = await run(action, params, ctx, message => ctx.ui.notify(message, 'info'));
        ctx.ui.notify(body, 'info');
      } catch (e) { ctx.ui.notify(`orchestration error: ${e.message}`, 'error'); }
    },
  });

  pi.registerTool({
    name: 'ludi_orchestrate',
    label: 'Ludi orchestrate',
    description: 'Persistent ludi orchestrator: start, list, status, children, result, decisions, resume, answer, or clean up run history (prune/delete/clear).',
    promptSnippet: 'ludi_orchestrate: start, list, resume, answer, or clean up history of a persistent orchestration run.',
    promptGuidelines: [
      'Use ludi_orchestrate to continue a high-level request across sessions. Do not re-ask a decision that is already pending; answer it or list it.',
      'prune, delete and clear are destructive. delete and clear preview unless force=true; delete active requires force=true; clear active requires both force=true and includeActive=true.',
    ],
    parameters: Type.Object({
      action: Type.String({ description: 'start | list | status | children | result | decisions | resume | answer | prune | delete | clear' }),
      request: Type.Optional(Type.String({ description: 'High-level request for action=start' })),
      runId: Type.Optional(Type.String({ description: 'Run id for status, children, result, decisions, resume, answer, or delete' })),
      decisionId: Type.Optional(Type.String({ description: 'Pending decision id for action=answer' })),
      answer: Type.Optional(Type.String({ description: 'User answer text for action=answer' })),
      status: Type.Optional(Type.String({ description: 'Filter for action=list' })),
      olderThan: Type.Optional(Type.String({ description: 'Duration for action=prune, e.g. "7d", "12h", "30m", "2w"' })),
      force: Type.Optional(Type.Boolean({ description: 'Actually delete for action=delete/clear (otherwise preview only)' })),
      includeActive: Type.Optional(Type.Boolean({ description: 'For action=clear with force=true: also delete active and resumable runs' })),
      repo: Type.Optional(Type.String({ description: 'Repository root the agents should read' })),
      store: Type.Optional(Type.String({ description: 'Override path to the orchestration sqlite file' })),
      clientContext: Type.Optional(Type.Object({ kind: Type.String(), sessionId: Type.Optional(Type.String()) }, { description: 'Client binding request; pi-web session UUID is obtained from the current pi session' })),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const updates = [];
      try { return text(await run(params.action || 'list', params, ctx, message => {
        updates.push(message);
        onUpdate?.(text(updates.slice(-12).join('\n')));
      })); }
      catch (e) { return text(`orchestration error: ${e.message}`); }
    },
  });
}
