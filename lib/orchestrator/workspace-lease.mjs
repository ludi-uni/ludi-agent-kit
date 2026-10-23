// Cross-run/process writer ownership, independent of each orchestration store.
// SQLite serializes claim/reclaim; no TTL may evict a living writer. Only the
// matching token can release ownership. Registry state stays in the OS temp dir.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

export function canonicalWorkspace(path) {
  let root = realpathSync.native(resolve(path));
  // A repository and its subdirectories share ownership; junction aliases also
  // resolve to the same physical path. Standalone non-git workspaces keep theirs.
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) { root = dir; break; }
    if (dirname(dir) === dir) break;
  }
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

export function acquireWorkspaceLease(path, { lockDir = join(tmpdir(), 'ludi-workspace-leases') } = {}) {
  const workspace = canonicalWorkspace(path);
  mkdirSync(lockDir, { recursive: true });
  const db = new DatabaseSync(join(lockDir, 'owners.db'));
  const token = randomBytes(16).toString('hex');
  let transaction = false;
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    db.exec('CREATE TABLE IF NOT EXISTS workspace_owners (workspace TEXT PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL)');
    db.exec('BEGIN IMMEDIATE'); transaction = true;
    if (!db.prepare('PRAGMA table_info(workspace_owners)').all().some(c => c.name === 'manual_recovery')) {
      db.exec('ALTER TABLE workspace_owners ADD COLUMN manual_recovery INTEGER NOT NULL DEFAULT 0');
    }
    const owner = db.prepare('SELECT pid, manual_recovery FROM workspace_owners WHERE workspace = ?').get(workspace);
    if (owner) {
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
      if (alive || owner.manual_recovery) {
        const error = new Error(owner.manual_recovery && !alive
          ? `workspace ${workspace} has an unconfirmed protected writer from dead pid ${owner.pid}; automatic recovery is disabled. An operator must verify orphan processes are stopped before manually recovering this registry entry.`
          : `workspace ${workspace} already has a writer (pid ${owner.pid}); retry after it finishes`);
        error.code = 'WORKSPACE_BUSY';
        throw error;
      }
    }
    db.prepare('INSERT INTO workspace_owners (workspace, pid, token, manual_recovery) VALUES (?, ?, ?, 0) ON CONFLICT(workspace) DO UPDATE SET pid = excluded.pid, token = excluded.token, manual_recovery = 0')
      .run(workspace, process.pid, token);
    db.exec('COMMIT'); transaction = false;
  } catch (error) {
    if (transaction) db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  let released = false;
  return {
    workspace,
    // Protect before dispatching work that can outlive this process. A host
    // crash cannot prove descendants stopped; dead-PID recovery stays closed.
    quarantine() {
      if (released) throw new Error('cannot protect a released workspace lease');
      const result = db.prepare('UPDATE workspace_owners SET manual_recovery = 1 WHERE workspace = ? AND token = ?').run(workspace, token);
      if (result.changes !== 1) throw new Error('workspace lease ownership changed before protected dispatch');
    },
    release() {
      if (released) return;
      try { db.prepare('DELETE FROM workspace_owners WHERE workspace = ? AND token = ?').run(workspace, token); }
      finally { released = true; db.close(); }
    },
  };
}
