// Baseline the worktree before a task and report only what changed. Never reset, checkout, or stash.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP = new Set(['.git', 'node_modules', 'out', 'dist', '.orchestration']);

function hashFile(path) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
  catch { return null; }
}

function parsePorcelain(stdout) {
  const parts = String(stdout ?? '').split('\0').filter(Boolean);
  const entries = {};
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    const code = rec.slice(0, 2);
    let file = rec.slice(3);
    if ((code.startsWith('R') || code.startsWith('C')) && parts[i + 1]) file = parts[++i];
    entries[file.replace(/\\/g, '/')] = code;
  }
  return entries;
}

function inventory(root, dir = root, out = {}, budget = { n: 0 }) {
  if (budget.n > 400) return out;
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (SKIP.has(name)) continue;
    const abs = join(dir, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) inventory(root, abs, out, budget);
    else if (st.isFile()) {
      budget.n++;
      out[relative(root, abs).replace(/\\/g, '/')] = hashFile(abs);
    }
  }
  return out;
}

export function captureWorktree(root) {
  if (!root || !existsSync(root)) return { available: false, entries: {} };
  const status = spawnSync('git', ['status', '--porcelain', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (status.error || status.status !== 0) return { available: false, entries: inventory(root), source: 'files' };
  const codes = parsePorcelain(status.stdout);
  const entries = {};
  for (const [file, code] of Object.entries(codes)) entries[file] = { code, hash: hashFile(join(root, file)) };
  return { available: true, entries, source: 'git' };
}

export function diffWorktree(before, after) {
  if (!before?.source || before.source !== after?.source) return [];
  const changed = [];
  const keys = new Set([...Object.keys(before.entries ?? {}), ...Object.keys(after.entries ?? {})]);
  for (const path of keys) {
    const b = before.entries[path];
    const a = after.entries[path];
    if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) continue;
    const code = String(a?.code ?? '');
    let kind = 'modified';
    if (!a) kind = 'deleted';
    else if (after.source === 'git' && code.includes('?')) kind = 'untracked';
    else if (!b || (after.source === 'git' && code.includes('A'))) kind = 'added';
    else if (after.source === 'git' && code.includes('D')) kind = 'deleted';
    changed.push({ path, kind, before: b?.code ?? null, after: a?.code ?? null });
  }
  return changed;
}
