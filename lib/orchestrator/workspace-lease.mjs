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
    const owner = db.prepare('SELECT pid FROM workspace_owners WHERE workspace = ?').get(workspace);
    if (owner) {
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
      if (alive) {
        const error = new Error(`workspace ${workspace} already has a writer (pid ${owner.pid}); retry after it finishes`);
        error.code = 'WORKSPACE_BUSY';
        throw error;
      }
    }
    db.prepare('INSERT INTO workspace_owners (workspace, pid, token) VALUES (?, ?, ?) ON CONFLICT(workspace) DO UPDATE SET pid = excluded.pid, token = excluded.token')
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
    release() {
      if (released) return;
      try { db.prepare('DELETE FROM workspace_owners WHERE workspace = ? AND token = ?').run(workspace, token); }
      finally { released = true; db.close(); }
    },
  };
}
