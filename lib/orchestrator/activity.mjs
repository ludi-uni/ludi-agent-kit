// Public run-activity snapshots for external clients (pi-web, future UIs). The tracker keeps a
// live in-memory view of one client's runs and writes an ATOMIC public JSON snapshot per client
// under <kit>/.orchestration/activity/clients/<kind>-<sessionId>.json. The store remains the
// source of truth; this file is a projection that other processes can tail without SQLite.
//
// Event policy: orchestration-level events (plan/round/result/retry/escalation/…), invocation
// lifecycle (start/end), tool calls, turn-cap extensions and fallbacks are SIGNIFICANT — they are
// also the events the orchestrator persists to the run trace. High-frequency per-turn progress
// updates only refresh the in-memory snapshot + written file, never the trace.
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const ACTIVITY_VERSION = 1;

/** Events that matter for history: persisted to the run trace by the orchestrator. */
export const SIGNIFICANT_EVENT_TYPES = new Set([
  'invocation-start', 'invocation-end', 'invocation-tool', 'invocation-extension', 'candidate-changed',
]);

/** High-frequency progress events: live snapshot only, never the trace. */
export const HIGH_FREQUENCY_EVENT_TYPES = new Set(['invocation-turn', 'invocation-tool-completed']);

const safeSegment = s => String(s ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
const invocationKey = (runId, taskId, invocationId) => JSON.stringify([runId, taskId, invocationId]);

/** clientContext -> canonical snapshot file name, e.g. pi-web-<canonicalPiUUID>.json */
export function activityFileName(clientContext) {
  return `${safeSegment(clientContext?.kind)}-${safeSegment(clientContext?.sessionId)}.json`;
}

export function clientKeyOf(clientContext) {
  return JSON.stringify([clientContext?.kind ?? '', clientContext?.sessionId ?? '']);
}

/** Publish a complete document without exposing partial JSON to readers. On Windows a
 * reader may briefly hold the destination without FILE_SHARE_DELETE, causing EPERM.
 * Retry only those sharing violations; never remove the old snapshot first. */
export function publishActivitySnapshot(file, doc, {
  rename = renameSync,
  wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  windows = process.platform === 'win32',
} = {}) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(doc, null, 2));
    for (let attempt = 0; ; attempt++) {
      try { rename(tmp, file); return; }
      catch (error) {
        if (!windows || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
        wait([10, 20, 40, 80, 160][attempt]);
      }
    }
  } finally {
    // A failed rename must not accumulate temporary files on every turn.
    try { rmSync(tmp, { force: true }); } catch { /* temporary file may itself be locked */ }
  }
}

/** Drop raw payloads: only bounded, non-secret fields may leave the process. */
export function sanitizeInvocationEvent(type, data = {}) {
  const out = { type };
  const copy = k => { if (data[k] != null) out[k] = typeof data[k] === 'string' ? data[k].slice(0, 500) : data[k]; };
  for (const k of ['runId', 'taskId', 'invocationId', 'agent', 'capability', 'modelId', 'backend', 'provider', 'turn', 'turnCap', 'turnsUsed', 'turnLimit', 'toolCalls', 'extensionsGranted', 'oldLimit', 'newLimit', 'fromModel', 'toModel', 'from', 'to', 'reason', 'status', 'at']) copy(k);
  if (data.tool) {
    const file = data.tool.file ? basename(String(data.tool.file).replace(/\\/g, '/')).slice(0, 100) : '';
    out.tool = { name: String(data.tool.name ?? 'tool').slice(0, 80), ...(file ? { file } : {}) };
  }
  if (data.childSessionId) out.childSessionId = String(data.childSessionId);
  return out;
}

/**
 * @param {object} o
 * @param {string} o.kit kit root; snapshots go to <kit>/.orchestration/activity/clients/
 * @param {object} [o.clientContext] { kind, sessionId } — generic; the extension injects the
 *   authoritative pi session id for kind 'pi-web'.
 */
export function createActivityTracker({ kit, clientContext = null, now = () => new Date().toISOString() } = {}) {
  const dir = kit ? join(kit, '.orchestration', 'activity', 'clients') : null;
  const file = dir && clientContext?.sessionId ? join(dir, activityFileName(clientContext)) : null;
  const runs = new Map();       // runId -> live activity object
  const bindings = new Map();   // clientKey -> runId (a client sees the runs it started)
  const listeners = new Map();  // runId -> Set<listener>
  const invocations = new Map();// invocationKey -> invocation record
  const startedAt = new Map();
  let snapshotWarningShown = false;

  const notify = runId => {
    const activity = runs.get(runId);
    for (const fn of listeners.get(runId) ?? []) {
      try { fn(structuredClone(activity)); } catch { /* listener must not break the run */ }
    }
  };

  const writeSnapshot = () => {
    if (!file) return;
    const runList = [...bindings.values()].map(id => runs.get(id)).filter(Boolean);
    const latest = runList.at(-1) ?? null;
    const doc = {
      version: ACTIVITY_VERSION,
      clientContext: clientContext ? { kind: clientContext.kind, sessionId: clientContext.sessionId } : null,
      runId: latest?.runId ?? null,
      repoRoot: latest?.repoRoot ?? null,
      startedAt: latest ? startedAt.get(latest.runId) : null,
      activity: latest ? { ...structuredClone(latest), updatedAt: now() } : null,
    };
    try {
      publishActivitySnapshot(file, doc);
      snapshotWarningShown = false;
    } catch (error) {
      // The public projection is optional: a sharing violation must not abort
      // the authoritative SQLite run or turn a successful task into a failure.
      if (!snapshotWarningShown) console.warn(`activity snapshot unavailable (${error.code ?? 'write error'}); the run remains persisted`);
      snapshotWarningShown = true;
    }
  };

  const ensureRun = runId => {
    if (!runs.has(runId)) {
      runs.set(runId, { runId, state: 'running', completedTasks: 0, totalTasks: 0, activeAgents: 0, tasks: [], activeInvocations: [], updatedAt: now() });
    }
    return runs.get(runId);
  };

  const tracker = {
    file,
    clientContext,

    /** Bind this client to a run the moment the run exists. */
    bindRun({ runId, repoRoot = null }) {
      if (!runId) return;
      const a = ensureRun(runId);
      if (!startedAt.has(runId)) startedAt.set(runId, now());
      a.repoRoot = repoRoot ?? a.repoRoot;
      if (clientContext?.sessionId) bindings.set(clientKeyOf(clientContext), runId);
      notify(runId);
      writeSnapshot();
    },

    /**
     * Feed one event. `persist` tells the orchestrator whether this type belongs in the
     * durable trace (significant) or only in the live snapshot (high-frequency turns).
     */
    emit(type, data = {}) {
      const runId = data.runId;
      const persist = SIGNIFICANT_EVENT_TYPES.has(type);
      if (!runId) return { persist };
      const a = ensureRun(runId);
      const e = sanitizeInvocationEvent(type, data);
      if (type === 'candidate-changed' || type === 'fallback') {
        const task = a.tasks.find(t => t.taskId === data.taskId);
        if (task) {
          task.fallbackFrom = e.fromModel ?? e.from;
          task.fallbackTo = e.toModel ?? e.to;
          if (e.toModel) task.modelId = e.toModel;
          if (e.to) task.capability = e.to;
        }
        a.recentEvent = type;
      }
      if (type === 'invocation-start') {
        invocations.set(invocationKey(runId, data.taskId, data.invocationId), e);
      } else if (type === 'invocation-end') {
        invocations.delete(invocationKey(runId, data.taskId, data.invocationId));
      } else if ((HIGH_FREQUENCY_EVENT_TYPES.has(type) || SIGNIFICANT_EVENT_TYPES.has(type)) && data.invocationId) {
        const key = invocationKey(runId, data.taskId, data.invocationId);
        const previous = invocations.get(key);
        if (previous) {
          const next = { ...previous, ...e };
          if (e.turn !== undefined) next.turnsUsed = e.turn;
          if (e.turnCap !== undefined) next.turnLimit = e.turnCap;
          if (e.newLimit !== undefined) next.turnLimit = e.newLimit;
          if (type === 'invocation-tool' && e.tool) next.recentTools = [...(previous.recentTools ?? []), { tool: e.tool.name, ...(e.tool.file ? { summary: e.tool.file } : {}) }].slice(-5);
          invocations.set(key, next);
        }
      }
      a.activeInvocations = [...invocations.values()].filter(i => i.runId === runId);
      a.activeAgents = a.activeInvocations.length || a.tasks.filter(t => t.state === 'running').length;
      a.updatedAt = now();
      notify(runId);
      writeSnapshot();
      return { persist };
    },

    /** Sync the task-level projection after a store update. */
    syncTasks({ runId, tasks = [], state = null }) {
      const a = ensureRun(runId);
      a.tasks = tasks.map(t => {
        const live = a.activeInvocations.find(i => i.taskId === t.id);
        return { taskId: t.id, title: t.title, agent: t.assignedAgent, capability: t.capability,
          modelId: live?.modelId ?? t.modelId, state: t.status, attempts: t.attempts ?? 0,
          ...(a.tasks.find(x => x.taskId === t.id)?.fallbackFrom ? {
            fallbackFrom: a.tasks.find(x => x.taskId === t.id).fallbackFrom,
            fallbackTo: a.tasks.find(x => x.taskId === t.id).fallbackTo,
          } : {}),
          ...(live?.turnsUsed != null ? { turnsUsed: live.turnsUsed } : {}),
          ...(live?.turnLimit != null ? { turnLimit: live.turnLimit } : {}),
          ...(live?.toolCalls != null ? { toolCalls: live.toolCalls } : {}),
          ...(live?.recentTools?.length ? { recentTools: live.recentTools } : {}) };
      });
      a.totalTasks = a.tasks.length;
      a.completedTasks = a.tasks.filter(t => t.state === 'completed').length;
      a.activeAgents = a.activeInvocations.length || a.tasks.filter(t => t.state === 'running').length;
      if (state) a.state = state;
      a.updatedAt = now();
      notify(runId);
      writeSnapshot();
    },

    getRunActivity(runId) {
      const a = runs.get(runId);
      if (a) return structuredClone(a);
      const snapshot = file ? readActivitySnapshot(file) : null;
      return snapshot?.runId === runId ? snapshot.activity ?? null : null;
    },

    getRunActivityByClient(kind, sessionId) {
      if (clientKeyOf({ kind, sessionId }) !== clientKeyOf(clientContext)) return null;
      const runId = bindings.get(clientKeyOf({ kind, sessionId }));
      if (runId) return tracker.getRunActivity(runId);
      const snapshot = file ? readActivitySnapshot(file) : null;
      return snapshot?.clientContext?.kind === kind && snapshot?.clientContext?.sessionId === sessionId ? snapshot.activity ?? null : null;
    },

    /** Stop live subscriptions when a run terminates; keep its final snapshot. */
    finishRun(runId) {
      for (const key of invocations.keys()) if (JSON.parse(key)[0] === runId) invocations.delete(key);
      const a = runs.get(runId);
      if (a) { a.activeInvocations = []; a.activeAgents = 0; a.updatedAt = now(); notify(runId); writeSnapshot(); }
      listeners.delete(runId);
    },

    /** listener(activity) on every significant change. Returns an unsubscribe fn. */
    subscribeRunActivity(runId, listener) {
      if (!listeners.has(runId)) listeners.set(runId, new Set());
      listeners.get(runId).add(listener);
      return () => listeners.get(runId)?.delete(listener);
    },
  };
  return tracker;
}

/** Read a published client snapshot (for tools / tests). Returns null when absent. */
export function readActivitySnapshot(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
