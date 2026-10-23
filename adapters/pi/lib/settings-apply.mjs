// Two-phase, opt-in apply of the pi-subagents model proposal into settings.json.
// Imported by adapters/pi/sync-pi.ps1 -ApplySettings and unit-tested directly.
//
// Scope (verified against pi-subagents docs/models.md + agents.md):
//   merge ONLY subagents.agentOverrides.{scout,coder,visual,reviewer}.{model,thinking}.
//   All other settings keys, other override fields (tools, disabled, defaultProvider,
//   systemPrompt, ...), other roles and unknown keys are preserved semantically.
//   JSON formatting may change on a real update; a no-op preserves the original bytes.
//
// Concurrency guarantee (documented honestly): the apply captures a SHA256 digest of the
// settings bytes before proposal resolution, then acquires a cooperating-exclusive
// sidecar lock (created with 'wx' — it never evicts another owner) for the apply phase.
// In-process captureAndApply can hold the lock across resolution as well.
// The apply re-verifies the digest immediately before an atomic
// rename-into-place. This detects and refuses concurrent modification between phases and
// serialized merges between cooperating kit applies. It is NOT a kernel compare-and-swap:
// a non-cooperating external editor that writes between the final digest check and the
// rename can still lose its edit. That window is a few instructions, not the resolution
// phase. Backups are byte-for-byte; diagnostics never contain raw settings content.
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SETTINGS_APPLY_ROLES = ['scout', 'coder', 'visual', 'reviewer'];
const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const STAGING_MODE = 0o600;

export class SettingsApplyError extends Error {
  constructor(code, message) { super(message); this.name = 'SettingsApplyError'; this.code = code; }
}
const fail = (code, message) => { throw new SettingsApplyError(code, message); };
const sha256 = buf => createHash('sha256').update(buf).digest('hex');

/** Reject a symlinked/junctioned settings file (write through regular files only). */
function assertRegularFilePath(settingsPath) {
  let st;
  try { st = lstatSync(settingsPath); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; } // settings may be absent
  if (st.isSymbolicLink()) fail('symlink', `refusing to write through a symlink: ${settingsPath}`);
  if (!st.isFile()) fail('not-regular', `settings path is not a regular file: ${settingsPath}`);
}

function readSnapshot(settingsPath) {
  assertRegularFilePath(settingsPath);
  let bytes = null;
  try { bytes = readFileSync(settingsPath); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { path: settingsPath, exists: bytes !== null, sha256: bytes === null ? null : sha256(bytes) };
}

export const settingsLockPath = settingsPath => `${resolve(settingsPath)}.ludi-apply.lock`;

/** Acquire the cooperating-apply lock (deterministic name, wx = never evicts an owner).
 *  A stale lock from a crashed apply refuses future applies; remove the .lock file
 *  manually to recover — the kit never deletes a lock it did not create this run. */
function acquireLock(settingsPath) {
  const lockPath = settingsLockPath(settingsPath);
  let fd;
  try {
    fd = openSync(lockPath, 'wx', STAGING_MODE);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, created: new Date().toISOString() }) + '\n');
  } catch (e) {
    if (fd !== undefined) { closeSync(fd); fd = undefined; rmSync(lockPath, { force: true }); }
    if (e.code === 'EEXIST') fail('lock-busy', `another apply holds ${lockPath}; refusing to proceed (delete it manually only if no apply is running)`);
    throw e;
  } finally { if (fd !== undefined) closeSync(fd); }
  return lockPath;
}

/**
 * Phase 1 — capture settings existence + digest and take the cooperating lock.
 * Call BEFORE proposal resolution so any concurrent change during resolution is detected.
 * Returns { path, exists, sha256, lockPath, lockHeld, release }. Only the digest/presence
 * may leave this process (plan/diff output); raw bytes stay private. Call release() on abort.
 */
export function captureSettingsSnapshot(settingsPath, { lock = true } = {}) {
  settingsPath = resolve(settingsPath);
  const snap = readSnapshot(settingsPath);
  let lockPath = null;
  if (lock) lockPath = acquireLock(settingsPath);
  return {
    path: snap.path, exists: snap.exists, sha256: snap.sha256, lockPath, lockHeld: lockPath !== null,
    release() {
      if (this.lockPath) { try { rmSync(this.lockPath, { force: true }); } catch { /* best effort */ } this.lockPath = null; this.lockHeld = false; }
    },
  };
}

function validateOverride(role, o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) fail('bad-proposal', `proposal override for "${role}" must be an object`);
  for (const k of Object.keys(o)) if (k !== 'model' && k !== 'thinking') fail('bad-proposal', `proposal override for "${role}" has unsupported field "${k}" (only model/thinking are applied)`);
  if (typeof o.model !== 'string' || !/^[^\s/]+\/\S+$/.test(o.model)) fail('bad-proposal', `proposal override for "${role}".model must be a fully qualified "provider/model" string`);
  if (o.thinking !== undefined && !THINKING.has(o.thinking)) fail('bad-proposal', `proposal override for "${role}".thinking must be one of ${[...THINKING].join('|')}`);
}

/**
 * Extract the four allowed role overrides from a settings.proposal.json-shaped object.
 * Proposals for other roles are ignored entirely; proposal defaults/extra fields are
 * never adopted. Throws SettingsApplyError on malformed input.
 */
export function extractRoleOverrides(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) fail('bad-proposal', 'proposal root must be an object');
  if (proposal.subagents === undefined) return {};
  if (!isPlainObject(proposal.subagents)) fail('bad-proposal', 'proposal.subagents must be an object');
  const overrides = proposal.subagents.agentOverrides;
  if (overrides === undefined) return {};
  if (!isPlainObject(overrides)) fail('bad-proposal', 'proposal.subagents.agentOverrides must be an object');
  const out = {};
  for (const role of SETTINGS_APPLY_ROLES) {
    const o = overrides[role];
    if (o === undefined) continue;
    validateOverride(role, o);
    out[role] = o.thinking === undefined ? { model: o.model } : { model: o.model, thinking: o.thinking };
  }
  return out;
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Pure merge: apply model (+ optional thinking) for each proposed role onto a live
 * settings object. `live === null` means a missing settings file — only the minimal
 * {subagents:{agentOverrides:{...}}} object is created on explicit opt-in.
 * Returns null when the merge is a semantic no-op.
 */
export function mergeRoleOverrides(live, roleOverrides) {
  if (!isPlainObject(roleOverrides)) fail('bad-proposal', 'role overrides must be an object');
  for (const [role, value] of Object.entries(roleOverrides)) {
    if (!SETTINGS_APPLY_ROLES.includes(role)) fail('bad-proposal', 'role is outside the four-role apply scope');
    validateOverride(role, value);
  }
  const root = live === null ? {} : live;
  if (!isPlainObject(root)) fail('bad-settings', 'settings.json root must be a JSON object');
  let changed = false;
  const merged = { ...root };
  const sub = live === null ? {} : root.subagents;
  if (sub !== undefined && !isPlainObject(sub)) fail('bad-settings', 'settings.json "subagents" must be an object');
  const mergedSub = { ...(sub ?? {}) };
  const ao = mergedSub.agentOverrides;
  if (ao !== undefined && !isPlainObject(ao)) fail('bad-settings', 'settings.json "subagents.agentOverrides" must be an object');
  const mergedAo = { ...(ao ?? {}) };
  for (const [role, o] of Object.entries(roleOverrides)) {
    const cur = mergedAo[role];
    if (cur !== undefined && !isPlainObject(cur)) fail('bad-settings', `settings.json "subagents.agentOverrides.${role}" must be an object`);
    const next = { ...(cur ?? {}) };
    // Merge ONLY model and optional thinking; preserve every other field the user has
    // (tools, disabled, defaultProvider, systemPrompt, ...). A proposal without
    // `thinking` never clears a user-set value.
    next.model = o.model;
    if (o.thinking !== undefined) next.thinking = o.thinking;
    if (!changed && JSON.stringify(next) !== JSON.stringify(cur ?? null)) changed = true;
    mergedAo[role] = next;
  }
  if (!changed) return null;
  mergedSub.agentOverrides = mergedAo;
  merged.subagents = mergedSub;
  return merged;
}

/** Serialize + parse twice and require deep equality (guards non-JSON-safe values). */
function roundTripCheck(obj) {
  const text = JSON.stringify(obj, null, 2) + '\n';
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { fail('round-trip', `serialized settings failed to parse: ${e.message}`); }
  if (JSON.stringify(parsed) !== JSON.stringify(obj)) fail('round-trip', 'settings JSON round-trip mismatch; refusing to write');
  return text;
}

/**
 * Phase 2 — apply captured role overrides to the settings file.
 * `snap` must come from captureSettingsSnapshot (or be a plain
 * {path, exists, sha256, lockPath} digest record — contents are never re-read from it).
 *
 * Returns { changed: false } on a semantic no-op: original bytes untouched, no backup,
 * no staging or lock files left. On success: { changed: true, backupPath|null, roles }.
 * On refusal/failure the original file is preserved; owned staging/lock files are
 * cleaned. The backup is never used to overwrite a concurrently changed file.
 */
export function applySettingsOverrides(snap, roleOverrides, { backupDir = null } = {}) {
  const settingsPath = resolve(snap.path);
  const cleanup = [];
  // If the caller did not already hold the cooperating lock (e.g. a snapshot passed
  // process-boundary as digest only), take it now so the compare->replace window is
  // serialized against other kit applies. Never evicts an existing owner.
  let ownedLock = null;
  try {
    if (!snap.lockHeld) ownedLock = acquireLock(settingsPath);
    // Re-verify against the pre-resolution snapshot: created / deleted / modified all refuse.
    const now = readSnapshot(settingsPath);
    if (now.exists !== snap.exists || now.sha256 !== snap.sha256) {
      fail('concurrent-change', `settings.json changed since the plan was captured (${snap.exists ? 'modified-or-removed' : 'created'}); re-run to re-resolve. Original preserved.`);
    }

    let live = null;
    const originalBytes = now.exists ? readFileSync(settingsPath) : null;
    if (now.exists) {
      if (sha256(originalBytes) !== snap.sha256) fail('concurrent-change', 'settings.json changed while reading; refusing to overwrite');
      try { live = JSON.parse(originalBytes.toString('utf8')); } catch { fail('bad-settings', 'settings.json is not valid JSON; refusing to overwrite'); }
      if (!isPlainObject(live)) fail('bad-settings', 'settings.json root must be a JSON object');
    }
    const merged = mergeRoleOverrides(live, roleOverrides);
    if (merged === null) return { changed: false };
    const text = roundTripCheck(merged);

    // Backup the exact original bytes before replacing (missing file: no invented backup).
    let backupPath = null;
    if (now.exists) {
      if (!backupDir) backupDir = join(dirname(settingsPath), 'ludi-agent-kit', `backup-${new Date().toISOString().replace(/[:.]/g, '').replace('T', '-')}-${randomUUID().slice(0, 8)}`);
      // Never follow a junction/symlink in any existing backup ancestor.
      for (let bp = resolve(backupDir); ; bp = dirname(bp)) {
        const bst = lstatSync(bp, { throwIfNoEntry: false });
        if (bst?.isSymbolicLink()) fail('symlink', `refusing symlinked backup path: ${bp}`);
        if (bst && !bst.isDirectory()) fail('not-directory', 'backup ancestor is not a directory');
        if (dirname(bp) === bp) break;
      }
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      backupPath = join(backupDir, 'settings.json');
      // wx refuses any existing backup entry, including a symlink or hardlink.
      writeFileSync(backupPath, originalBytes, { mode: STAGING_MODE, flag: 'wx' });
    }

    // Stage the merged document in the same directory (same volume -> atomic rename),
    // restrictive mode, then re-check the digest once more immediately before replacing.
    const staging = join(dirname(settingsPath), `.settings.json.ludi-staging-${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
    const stagingFd = openSync(staging, 'wx', STAGING_MODE);
    cleanup.push(staging); // remove only a file this invocation actually created
    try { writeFileSync(stagingFd, text); } finally { closeSync(stagingFd); }
    // Verify the staged bytes round-trip too (write-path corruption check).
    if (JSON.stringify(JSON.parse(readFileSync(staging, 'utf8'))) !== JSON.stringify(merged)) fail('round-trip', 'staged settings failed verification; original preserved');
    const last = readSnapshot(settingsPath);
    if (last.exists !== snap.exists || last.sha256 !== snap.sha256) fail('concurrent-change', 'settings.json changed while staging; refusing to replace. Original preserved.');
    renameSync(staging, settingsPath); // atomic same-directory replace (creates when missing)
    cleanup.length = 0;
    return { changed: true, backupPath, roles: Object.keys(roleOverrides) };
  } finally {
    for (const p of cleanup) { try { rmSync(p, { force: true }); } catch { /* best effort */ } }
    if (ownedLock) { try { rmSync(ownedLock, { force: true }); } catch { /* best effort */ } }
    snap.release?.();
  }
}

/**
 * Convenience: resolve-then-apply in one call (used by the sync CLI wrapper).
 * `resolveOverrides` is invoked while the cooperating lock is held so any concurrent
 * settings change during resolution is caught at apply time.
 */
export function captureAndApply(settingsPath, resolveOverrides, opts = {}) {
  const snap = captureSettingsSnapshot(settingsPath, { lock: true });
  try {
    const overrides = typeof resolveOverrides === 'function' ? resolveOverrides() : resolveOverrides;
    return applySettingsOverrides(snap, extractRoleOverrides(overrides), opts);
  } catch (e) { snap.release(); throw e; }
}

// ---- optional CLI wrapper (adapter-local; importing this module never runs it) ----
// node adapters/pi/lib/settings-apply.mjs --settings <path> --proposal <file|--json <json>> [--backup-dir <dir>]
const isMain = (() => { try { return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const args = process.argv.slice(2);
  const opt = n => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
  try {
    const settings = opt('settings');
    if (!settings) fail('usage', 'required: --settings <path>');
    let proposal;
    if (opt('proposal')) proposal = JSON.parse(readFileSync(opt('proposal'), 'utf8'));
    else if (opt('json')) proposal = JSON.parse(opt('json'));
    else fail('usage', 'required: --proposal <file> or --json <object>');
    const r = captureAndApply(settings, proposal, { backupDir: opt('backup-dir') });
    process.stdout.write(JSON.stringify({ ok: true, ...r }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, code: e.code ?? 'error', error: e.message }) + '\n');
    process.exitCode = 1;
  }
}
