// Persistent orchestration state. SQLite (node:sqlite) is the only I/O here; the orchestrator never
// sees SQL. One file holds runs, tasks, pending decisions, decision memory, backend health and trace.
// Default location is repo-local (.orchestration/state.db). Callers pass the path; nothing writes to a user profile.
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMemoryTaskStore } from './task-store.mjs';

export const RUN_STATUSES = ['running', 'waiting_for_user', 'completed', 'failed', 'cancelled'];
/** Runs in these states are history; anything else is active or resumable. */
export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'];
const TERMINAL_RUN = new Set(TERMINAL_RUN_STATUSES);
export const BUSY_TIMEOUT_MS = 5000;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  request TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  rework_cycles INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  planner TEXT,
  policy_snapshot TEXT NOT NULL,
  counters TEXT NOT NULL,
  repo_root TEXT,
  scope_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_owners (
  run_id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  token TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  question TEXT NOT NULL,
  options_json TEXT,
  reason TEXT,
  escalation_type TEXT,
  flags_json TEXT,
  status TEXT NOT NULL,
  answer TEXT,
  decision_key TEXT,
  recommended TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE TABLE IF NOT EXISTS decision_memory (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_key TEXT,
  decision_key TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  rationale TEXT,
  confidence REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS decision_memory_lookup
  ON decision_memory(scope, ifnull(scope_key, ''), decision_key);
CREATE TABLE IF NOT EXISTS backend_health (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  run_id TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  detected_at TEXT NOT NULL,
  retry_after TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (provider, model, run_id)
);
CREATE TABLE IF NOT EXISTS trace (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  at TEXT NOT NULL,
  round INTEGER,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS protocol_stats (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  malformed INTEGER NOT NULL DEFAULT 0,
  empty INTEGER NOT NULL DEFAULT 0,
  turn_limit INTEGER NOT NULL DEFAULT 0,
  structured_ok INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, model)
);
`;

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id, request: row.request, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    round: row.round, reworkCycles: row.rework_cycles, seq: row.seq, planner: row.planner,
    policySnapshot: parse(row.policy_snapshot, {}), counters: parse(row.counters, {}),
    repoRoot: row.repo_root, scopeKey: row.scope_key,
  };
}

function mapDecision(row) {
  return {
    id: row.id, runId: row.run_id, taskId: row.task_id, question: row.question,
    options: parse(row.options_json, []), reason: row.reason, escalationType: row.escalation_type,
    flags: parse(row.flags_json, []), status: row.status, answer: row.answer == null ? undefined : parse(row.answer, row.answer),
    key: row.decision_key, recommended: row.recommended, createdAt: row.created_at, answeredAt: row.answered_at ?? undefined,
  };
}

function mapMemory(row) {
  return {
    id: row.id, scope: row.scope, scopeKey: row.scope_key ?? undefined, key: row.decision_key,
    decision: parse(row.decision_json, {}), rationale: row.rationale ?? undefined,
    confidence: row.confidence ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at,
    expiresAt: row.expires_at ?? undefined,
  };
}

function mapHealth(row) {
  return {
    provider: row.provider, model: row.model || undefined, state: row.state, reason: row.reason ?? undefined,
    detectedAt: row.detected_at, retryAfter: row.retry_after ?? undefined, expiresAt: row.expires_at, runId: row.run_id || undefined,
  };
}

export function openStore(storePath, { now = () => new Date().toISOString() } = {}) {
  mkdirSync(dirname(storePath), { recursive: true });
  const db = new DatabaseSync(storePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  // Bounded wait on SQLITE_BUSY so a second writer (another orchestrate process,
  // pi-web) does not make this one throw immediately and leave a zombie run.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec(SCHEMA);
  let depth = 0;
  const transaction = fn => {
    if (depth > 0) return fn();
    depth++;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      depth--;
      return result;
    } catch (e) {
      depth--;
      try { db.exec('ROLLBACK'); } catch { /* already closed */ }
      throw e;
    }
  };

  function saveTask(runId, task) {
    const updatedAt = task.updatedAt ?? now();
    transaction(() => {
      db.prepare(`INSERT INTO tasks (run_id, id, status, updated_at, payload) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id, id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, payload = excluded.payload`)
        .run(runId, task.id, task.status, updatedAt, JSON.stringify(task));
    });
  }

  function loadTasks(runId) {
    return db.prepare('SELECT payload FROM tasks WHERE run_id = ? ORDER BY rowid').all(runId).map(r => parse(r.payload, null)).filter(Boolean);
  }

  /**
   * Classification for history cleanup. A run is deletable only when it is terminal
   * (completed/failed/cancelled) AND has no pending decisions — pending decisions make
   * it resumable even if the status column was somehow forced to a terminal value.
   */
  function cleanupInfo(row) {
    const run = mapRun(row);
    const pending = db.prepare(`SELECT count(*) AS n FROM decisions WHERE run_id = ? AND status = 'pending'`).get(run.id).n;
    const runningTasks = db.prepare(`SELECT count(*) AS n FROM tasks WHERE run_id = ? AND status = 'running'`).get(run.id).n;
    const terminal = TERMINAL_RUN.has(run.status);
    const deletable = terminal && pending === 0 && runningTasks === 0;
    return {
      id: run.id, request: run.request, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt,
      counts: {
        tasks: db.prepare('SELECT count(*) AS n FROM tasks WHERE run_id = ?').get(run.id).n,
        decisions: db.prepare('SELECT count(*) AS n FROM decisions WHERE run_id = ?').get(run.id).n,
        trace: db.prepare('SELECT count(*) AS n FROM trace WHERE run_id = ?').get(run.id).n,
        health: db.prepare('SELECT count(*) AS n FROM backend_health WHERE run_id = ?').get(run.id).n,
        pendingDecisions: pending, runningTasks,
      },
      deletable,
      reason: deletable ? null : !terminal ? `active/resumable (${run.status})` : runningTasks ? `active (${runningTasks} running task${runningTasks === 1 ? '' : 's'})` : `resumable (${pending} pending decision${pending === 1 ? '' : 's'})`,
    };
  }

  /**
   * Every row owned by one run: tasks, decisions, trace and RUN-LOCAL backend health.
   * decision_memory and protocol_stats are global and are never touched; backend_health
   * rows with run_id = '' (e.g. usage_exhausted) are global too and survive.
   */
  function deleteRunRows(id) {
    db.prepare('DELETE FROM run_owners WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM trace WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM decisions WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM tasks WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM backend_health WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM runs WHERE id = ?').run(id);
  }

  const session = {
    path: storePath,
    now,
    close() { db.close(); },
    transaction,
    /** Current SQLite pragmas relevant to concurrency (for tests / diagnostics). */
    pragmas() {
      return {
        journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
        busyTimeoutMs: db.prepare('PRAGMA busy_timeout').get().timeout,
      };
    },

    createRun({ request, policy, repoRoot = null, planner = 'rules', scopeKey = null }) {
      const id = newId('run');
      const at = now();
      const key = scopeKey ?? repoRoot ?? 'default';
      db.prepare(`INSERT INTO runs (id, request, status, created_at, updated_at, round, rework_cycles, seq, planner, policy_snapshot, counters, repo_root, scope_key)
        VALUES (?, ?, 'running', ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)`)
        .run(id, request, at, at, planner, JSON.stringify(policy), JSON.stringify({}), repoRoot, key);
      return id;
    },

    getRun(id) { return mapRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(id)); },

    /** Claim an active run before recovery. A live process always wins; a dead owner is reclaimable. */
    claimRun(id) {
      const token = randomBytes(16).toString('hex');
      transaction(() => {
        if (!session.getRun(id)) throw new Error(`store: run not found: ${id}`);
        const owner = db.prepare('SELECT pid FROM run_owners WHERE run_id = ?').get(id);
        if (owner) {
          let alive = true;
          try { process.kill(owner.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
          if (alive) throw new Error(`store: run ${id} is already active (pid ${owner.pid})`);
        }
        db.prepare('INSERT INTO run_owners (run_id, pid, token) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET pid = excluded.pid, token = excluded.token')
          .run(id, process.pid, token);
      });
      return token;
    },

    releaseRun(id, token) {
      db.prepare('DELETE FROM run_owners WHERE run_id = ? AND token = ?').run(id, token);
    },

    updateRun(id, patch) {
      const cur = session.getRun(id);
      if (!cur) throw new Error(`store: run not found: ${id}`);
      if (patch.status && !RUN_STATUSES.includes(patch.status)) throw new Error(`store: invalid run status "${patch.status}"`);
      const next = {
        status: patch.status ?? cur.status,
        round: patch.round ?? cur.round,
        reworkCycles: patch.reworkCycles ?? cur.reworkCycles,
        seq: patch.seq ?? cur.seq,
        planner: patch.planner ?? cur.planner,
        counters: patch.counters ?? cur.counters,
        updatedAt: now(),
      };
      db.prepare(`UPDATE runs SET status = ?, updated_at = ?, round = ?, rework_cycles = ?, seq = ?, planner = ?, counters = ? WHERE id = ?`)
        .run(next.status, next.updatedAt, next.round, next.reworkCycles, next.seq, next.planner, JSON.stringify(next.counters), id);
      return session.getRun(id);
    },

    listRuns({ status = null } = {}) {
      const rows = status
        ? db.prepare('SELECT * FROM runs WHERE status = ? ORDER BY updated_at DESC').all(status)
        : db.prepare('SELECT * FROM runs ORDER BY updated_at DESC').all();
      return rows.map(row => {
        const run = mapRun(row);
        const tasks = loadTasks(run.id);
        const pending = db.prepare(`SELECT count(*) AS n FROM decisions WHERE run_id = ? AND status = 'pending'`).get(run.id).n;
        return {
          id: run.id, request: run.request, status: run.status, updatedAt: run.updatedAt, createdAt: run.createdAt,
          completed: tasks.filter(t => t.status === 'completed').length, total: tasks.length, pendingDecisions: pending,
        };
      });
    },

    loadTasks,
    saveTask,

    /** Memory facade that writes through on add/update. Completed tasks stay completed across restarts. */
    openTaskStore(runId) {
      const mem = createMemoryTaskStore();
      for (const t of loadTasks(runId)) mem.add(t);
      return {
        add(task) {
          const stamped = { ...task, runId, createdAt: task.createdAt ?? now(), updatedAt: now() };
          const t = mem.add(stamped);
          saveTask(runId, t);
          return t;
        },
        update(id, patch) {
          const t = mem.update(id, { ...patch, updatedAt: now() });
          saveTask(runId, t);
          return t;
        },
        get: mem.get, has: mem.has, list: mem.list, size: mem.size, snapshot: mem.snapshot,
      };
    },

    /** In-flight tasks go back to pending. Attempts are kept. Nothing is marked completed. */
    recoverStale(runId) {
      const recovered = [];
      transaction(() => {
        for (const t of loadTasks(runId)) {
          if (t.status !== 'running') continue;
          t.status = 'pending';
          t.blockedReason = 'recovered after interruption; the in-flight attempt did not finish';
          t.updatedAt = now();
          saveTask(runId, t);
          recovered.push(t.id);
        }
      });
      return recovered;
    },

    /**
     * Write pending decisions and the waiting task in one transaction so a crash cannot
     * leave a decision without its task, or a waiting task without its decision.
     */
    persistWaiting(runId, task, drafts) {
      return transaction(() => {
        const ids = drafts.map(d => session.insertDecision({ ...d, runId }));
        saveTask(runId, task);
        return ids;
      });
    },

    insertDecision(d) {
      const id = newId('dec');
      const at = now();
      db.prepare(`INSERT INTO decisions (id, run_id, task_id, question, options_json, reason, escalation_type, flags_json, status, decision_key, recommended, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(id, d.runId, d.taskId, d.question, JSON.stringify(d.options ?? []), d.reason ?? '', d.escalationType ?? '', JSON.stringify(d.flags ?? []), d.key ?? '', d.recommended ?? null, at);
      return id;
    },

    getDecision(id) {
      const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
      return row ? mapDecision(row) : null;
    },

    listDecisions(runId, status = null) {
      const rows = status
        ? db.prepare('SELECT * FROM decisions WHERE run_id = ? AND status = ? ORDER BY created_at').all(runId, status)
        : db.prepare('SELECT * FROM decisions WHERE run_id = ? ORDER BY created_at').all(runId);
      return rows.map(mapDecision);
    },

    /**
     * Record a user answer. The same answer twice is a no-op. A different answer keeps the first.
     * The blocked task becomes pending when it has no other pending decisions.
     */
    answerDecision({ runId, decisionId, answer, scopeKey }) {
      return transaction(() => {
        const d = session.getDecision(decisionId);
        if (!d || d.runId !== runId) throw new Error(`store: decision not found: ${decisionId}`);
        const text = String(answer ?? '').trim();
        if (d.status === 'answered') {
          const same = String(d.answer ?? '').trim() === text;
          return { idempotent: true, same, decision: d };
        }
        if (d.status !== 'pending') return { idempotent: true, same: false, decision: d };
        const optionId = matchOption(d.options, text);
        if (d.options.length && !optionId) throw new Error(`store: answer must select an option id (${d.options.map(o => o.id).join(', ')})`);
        if (!text) throw new Error('store: answer cannot be empty');
        const at = now();
        db.prepare(`UPDATE decisions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?`)
          .run(JSON.stringify(text), at, decisionId);
        const run = session.getRun(runId);
        session.saveMemory({
          scope: 'repository', scopeKey: scopeKey ?? run.scopeKey, key: d.key || d.question.trim().toLowerCase(),
          decision: { optionId, answer: text }, rationale: text, confidence: 1,
        });
        const tasks = loadTasks(runId);
        const task = tasks.find(t => t.id === d.taskId);
        if (task) {
          const choice = optionId ? `${optionId}: ${text}` : text;
          // key + optionId let a runner-level gate (e.g. worktree-dirty) recognise
          // its own answered decision without parsing the question text.
          task.decisions = [...(task.decisions ?? []), { key: d.key || undefined, optionId: optionId ?? undefined, question: d.question, choice, reason: `user answer (${decisionId})`, decisionId }];
          const still = session.listDecisions(runId, 'pending').some(x => x.taskId === task.id);
          if (!still && (task.status === 'waiting_for_user' || task.status === 'blocked')) {
            task.status = 'pending';
            task.blockedReason = undefined;
          }
          task.updatedAt = at;
          saveTask(runId, task);
        }
        return { idempotent: false, same: true, decision: session.getDecision(decisionId), optionId };
      });
    },

    saveMemory({ scope, scopeKey = null, key, decision, rationale = null, confidence = null, expiresAt = null }) {
      if (!['global', 'project', 'repository'].includes(scope)) throw new Error(`store: invalid memory scope "${scope}"`);
      const at = now();
      const existing = db.prepare(`SELECT id, created_at FROM decision_memory WHERE scope = ? AND ifnull(scope_key, '') = ? AND decision_key = ?`)
        .get(scope, scopeKey ?? '', key);
      if (existing) {
        db.prepare(`UPDATE decision_memory SET decision_json = ?, rationale = ?, confidence = ?, updated_at = ?, expires_at = ? WHERE id = ?`)
          .run(JSON.stringify(decision), rationale, confidence, at, expiresAt, existing.id);
        return existing.id;
      }
      const id = newId('mem');
      db.prepare(`INSERT INTO decision_memory (id, scope, scope_key, decision_key, decision_json, rationale, confidence, created_at, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, scope, scopeKey, key, JSON.stringify(decision), rationale, confidence, at, at, expiresAt);
      return id;
    },

    lookupMemory({ key, scopeKey, now: at = now() }) {
      const rows = db.prepare(`SELECT * FROM decision_memory WHERE decision_key = ? AND (expires_at IS NULL OR expires_at > ?)`).all(key, at);
      const rank = m => {
        if (m.scope === 'repository' && m.scopeKey === scopeKey) return 0;
        if (m.scope === 'project' && m.scopeKey === scopeKey) return 1;
        if (m.scope === 'global') return 2;
        return 9;
      };
      return rows.map(mapMemory).filter(m => rank(m) < 9).sort((a, b) => rank(a) - rank(b) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },

    listMemory() { return db.prepare('SELECT * FROM decision_memory ORDER BY updated_at').all().map(mapMemory); },

    recordHealth({ provider, model = '', state, reason, runId, ttlMs, now: at = now() }) {
      const detectedAt = at;
      const expiresAt = new Date(Date.parse(detectedAt) + ttlMs).toISOString();
      const rowRun = state === 'usage_exhausted' ? '' : (runId ?? '');
      db.prepare(`INSERT INTO backend_health (provider, model, run_id, state, reason, detected_at, retry_after, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, model, run_id) DO UPDATE SET
          state = excluded.state, reason = excluded.reason, detected_at = excluded.detected_at,
          retry_after = excluded.retry_after, expires_at = excluded.expires_at`)
        .run(provider, model ?? '', rowRun, state, String(reason ?? '').slice(0, 500), detectedAt, expiresAt, expiresAt);
      return { provider, model: model || undefined, state, reason, detectedAt, retryAfter: expiresAt, expiresAt, runId: rowRun || undefined };
    },

    /**
     * Protocol-reliability telemetry per provider/model. Audit only — NOT fed back
     * into routing scores. kind: 'malformed'|'empty'|'turn_limit'|'structured_ok'.
     */
    recordProtocol({ provider, model = '', kind, now: at = now() }) {
      const col = { malformed: 'malformed', empty: 'empty', turn_limit: 'turn_limit', structured_ok: 'structured_ok' }[kind];
      if (!col) return null;
      db.prepare(`INSERT INTO protocol_stats (provider, model, ${col}, updated_at) VALUES (?, ?, 1, ?)
        ON CONFLICT(provider, model) DO UPDATE SET ${col} = ${col} + 1, updated_at = excluded.updated_at`)
        .run(provider, model ?? '', at);
    },

    protocolStats() {
      return db.prepare('SELECT provider, model, malformed, empty, turn_limit, structured_ok, updated_at FROM protocol_stats ORDER BY provider, model').all();
    },

    activeHealth({ provider, model = '', runId, now: at = now() }) {
      const row = db.prepare(`SELECT * FROM backend_health
        WHERE provider = ? AND model = ? AND expires_at > ? AND (run_id = ? OR run_id = '')
        ORDER BY CASE WHEN run_id = '' THEN 1 ELSE 0 END, detected_at DESC LIMIT 1`)
        .get(provider, model ?? '', at, runId ?? '');
      return row ? mapHealth(row) : null;
    },

    appendTrace(runId, event) {
      db.prepare('INSERT INTO trace (run_id, at, round, type, payload) VALUES (?, ?, ?, ?, ?)')
        .run(runId, event.at, event.round ?? null, event.type, JSON.stringify(event));
    },

    loadTrace(runId) {
      return db.prepare('SELECT payload FROM trace WHERE run_id = ? ORDER BY id').all(runId).map(r => parse(r.payload, null)).filter(Boolean);
    },

    /**
     * Read-only history-cleanup preview. `olderThan` is an ISO timestamp cutoff on
     * runs.updated_at; `includeActive` reports non-terminal runs too (they are still
     * never deletable while pending decisions exist). Nothing is written.
     */
    previewRuns({ olderThan = null, includeActive = false } = {}) {
      const rows = db.prepare('SELECT * FROM runs ORDER BY updated_at DESC').all();
      const runs = rows.map(row => {
        const info = cleanupInfo(row);
        const ageMatches = !olderThan || String(row.updated_at) < olderThan;
        return { ...info, deletable: ageMatches && (includeActive || info.deletable),
          reason: ageMatches ? (includeActive ? null : info.reason) : 'newer than cutoff' };
      });
      const deletable = runs.filter(r => r.deletable);
      const totals = deletable.reduce((acc, r) => {
        for (const k of ['tasks', 'decisions', 'trace', 'health']) acc[k] += r.counts[k];
        return acc;
      }, { runs: deletable.length, tasks: 0, decisions: 0, trace: 0, health: 0 });
      return {
        scope: { olderThan, includeActive }, executed: false, runs,
        deletable: deletable.map(r => r.id),
        skipped: runs.filter(r => !r.deletable).map(r => ({ id: r.id, reason: r.reason })),
        totals: { ...totals, matched: runs.length, terminal: runs.filter(r => TERMINAL_RUN.has(r.status)).length,
          active: runs.filter(r => !TERMINAL_RUN.has(r.status) || r.counts.pendingDecisions > 0 || r.counts.runningTasks > 0).length,
          oldest: runs.at(-1)?.updatedAt ?? null, newest: runs[0]?.updatedAt ?? null },
      };
    },

    /** Explicit force is required for an active/resumable run. */
    deleteRun(id, { force = false } = {}) {
      return transaction(() => {
        const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
        if (!row) throw new Error(`store: run not found: ${id}`);
        const info = cleanupInfo(row);
        if (!info.deletable && !force) throw new Error(`store: run is active/resumable; use --force (${id})`);
        deleteRunRows(id);
        return { id, status: info.status, deleted: info.counts };
      });
    },

    /**
     * Delete every deletable run matching the preview scope in ONE transaction.
     * If any delete fails the whole batch rolls back — no partial cleanup.
     */
    pruneRuns({ olderThan = null } = {}) {
      return transaction(() => {
        const preview = session.previewRuns({ olderThan });
        for (const id of preview.deletable) deleteRunRows(id);
        return { ...preview, executed: true };
      });
    },

    /** Preview (force=false) or delete (force=true) all run history. Terminal-only unless includeActive. */
    clearRuns({ force = false, includeActive = false } = {}) {
      if (!force) return { ...session.previewRuns({ includeActive }), executed: false };
      // Preview INSIDE the transaction: a run that gained a pending decision or went
      // active since the caller looked is reclassified and skipped, never deleted.
      return transaction(() => {
        const preview = session.previewRuns({ includeActive });
        for (const id of preview.deletable) deleteRunRows(id);
        return { ...preview, executed: true };
      });
    },
  };
  return session;
}

export function matchOption(options, answer) {
  const a = String(answer ?? '').trim().toLowerCase();
  if (!a) return null;
  for (const o of options ?? []) {
    if (String(o.id).toLowerCase() === a) return o.id;
    if (o.summary && (a === String(o.summary).toLowerCase() || a.includes(String(o.summary).toLowerCase()))) return o.id;
  }
  // Permit an unambiguous explicit option reference or a whole-word id (not a
  // substring such as `no` inside `know`). Ambiguous prose must be clarified.
  const matches = (options ?? []).filter(o => {
    const id = String(o.id).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b(?:option\\s+)?${id}\\b`, 'i').test(a) && (id.length > 1 || new RegExp(`\\boption\\s+${id}\\b`, 'i').test(a));
  });
  return matches.length === 1 ? matches[0].id : null;
}

/** Task store bound to one run. Exported for tests that open a store directly. */
export function createPersistentTaskStore(session, runId) {
  return session.openTaskStore(runId);
}
