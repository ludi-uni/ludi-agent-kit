// Unit tests for adapters/pi/lib/settings-apply.mjs — the opt-in settings merger used by
// sync-pi.ps1 -ApplySettings. Everything runs against OS temp dirs with synthetic
// proposal/settings fixtures; no real ~/.pi, auth or machine-local model is touched.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureSettingsSnapshot, applySettingsOverrides, extractRoleOverrides, mergeRoleOverrides,
  settingsLockPath, SettingsApplyError,
} from '../adapters/pi/lib/settings-apply.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROPOSAL = {
  subagents: { agentOverrides: {
    scout: { model: 'pq/mq', thinking: 'low' },
    coder: { model: 'pd/md', thinking: 'high' },
    visual: { model: 'pa/ma', thinking: 'medium' },
    reviewer: { model: 'pd/md', thinking: 'high' },
    // Roles outside the allowed four must be ignored entirely.
    orchestrator: { model: 'px/mx' },
  } },
};
const overrides = () => extractRoleOverrides(PROPOSAL);
const temporaryDirs = [];
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'ludi-settings-apply-')); temporaryDirs.push(dir); return dir; };
after(() => { for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true }); });
const writeSettings = (dir, objOrText) => {
  const p = join(dir, 'settings.json');
  writeFileSync(p, typeof objOrText === 'string' ? objOrText : JSON.stringify(objOrText, null, 2));
  return p;
};

// ---------- pure helpers ----------
test('extractRoleOverrides keeps only the four roles and only model/thinking', () => {
  const o = overrides();
  assert.deepEqual(Object.keys(o).sort(), ['coder', 'reviewer', 'scout', 'visual']);
  assert.deepEqual(o.scout, { model: 'pq/mq', thinking: 'low' });
  assert.equal(o.orchestrator, undefined);
  // missing thinking stays absent (never invents a default)
  const o2 = extractRoleOverrides({ subagents: { agentOverrides: { scout: { model: 'a/b' } } } });
  assert.deepEqual(o2.scout, { model: 'a/b' });
});

test('extractRoleOverrides rejects malformed proposals', () => {
  for (const bad of [
    null, [], 'x', { subagents: null }, { subagents: [] },
    { subagents: { agentOverrides: null } }, { subagents: { agentOverrides: [] } },
    { subagents: { agentOverrides: { coder: null } } },
    { subagents: { agentOverrides: { coder: { model: 'no-slash' } } } },
    { subagents: { agentOverrides: { coder: { model: '' } } } },
    { subagents: { agentOverrides: { coder: { model: 'a/b', thinking: 'ultra' } } } },
    { subagents: { agentOverrides: { coder: { model: 'a/b', tools: ['x'] } } } },
  ]) assert.throws(() => extractRoleOverrides(bad), SettingsApplyError);
  assert.deepEqual(extractRoleOverrides({}), {});
  assert.deepEqual(extractRoleOverrides({ subagents: {} }), {});
  assert.equal(extractRoleOverrides({ subagents: { agentOverrides: { coder: { model: 'fixture/owner/model' } } } }).coder.model, 'fixture/owner/model');
  assert.throws(() => mergeRoleOverrides({}, { custom: { model: 'a/b' } }), SettingsApplyError);
});

test('mergeRoleOverrides: scoped merge preserves other fields, roles, keys, arrays, false/null', () => {
  const live = {
    defaultProvider: 'pfix', defaultTools: ['read', 'edit'], telemetry: false, note: null,
    subagents: {
      defaultProvider: 'sp',
      agentOverrides: {
        scout: { model: 'old/x', tools: ['read'], disabled: false, nested: { a: null } },
        coder: { model: 'ps/ms', thinking: 'low', systemPrompt: 'keep me' },
        customAgent: { model: 'keep/this', thinking: 'max' },
      },
      otherKey: [1, 2, 3],
    },
    unknownTop: { deep: [false, null] },
  };
  const merged = mergeRoleOverrides(structuredClone(live), overrides());
  assert.equal(merged.defaultProvider, 'pfix');
  assert.equal(merged.telemetry, false);
  assert.equal(merged.note, null);
  assert.deepEqual(merged.defaultTools, ['read', 'edit']);
  assert.equal(merged.subagents.defaultProvider, 'sp');
  assert.deepEqual(merged.subagents.otherKey, [1, 2, 3]);
  assert.deepEqual(merged.unknownTop, { deep: [false, null] });
  // preserved fields on merged roles
  assert.deepEqual(merged.subagents.agentOverrides.scout, { model: 'pq/mq', thinking: 'low', tools: ['read'], disabled: false, nested: { a: null } });
  assert.deepEqual(merged.subagents.agentOverrides.coder, { model: 'pd/md', thinking: 'high', systemPrompt: 'keep me' });
  // untouched role + added roles
  assert.deepEqual(merged.subagents.agentOverrides.customAgent, { model: 'keep/this', thinking: 'max' });
  assert.deepEqual(merged.subagents.agentOverrides.visual, { model: 'pa/ma', thinking: 'medium' });
  assert.deepEqual(merged.subagents.agentOverrides.reviewer, { model: 'pd/md', thinking: 'high' });
});

test('mergeRoleOverrides: proposal without thinking never clears an existing value; empty proposal is a no-op', () => {
  const live = { subagents: { agentOverrides: { scout: { model: 'x/y', thinking: 'max' } } } };
  const merged = mergeRoleOverrides(structuredClone(live), { scout: { model: 'a/b' } });
  assert.equal(merged.subagents.agentOverrides.scout.thinking, 'max');
  assert.equal(mergeRoleOverrides(live, {}), null);
  assert.equal(mergeRoleOverrides({ subagents: { agentOverrides: { scout: { model: 'pq/mq', thinking: 'low' } } } }, { scout: { model: 'pq/mq', thinking: 'low' } }), null);
});

// ---------- snapshot + apply ----------
test('apply: byte-for-byte backup, staged replace, four roles only', () => {
  const dir = tmp();
  const live = { defaultProvider: 'pfix', subagents: { agentOverrides: { scout: { model: 'old/x', tools: ['read'] }, customAgent: { model: 'k/k' } } } };
  const p = writeSettings(dir, live);
  const originalBytes = readFileSync(p);
  const snap = captureSettingsSnapshot(p);
  const r = applySettingsOverrides(snap, overrides(), { backupDir: join(dir, 'bk') });
  assert.equal(r.changed, true);
  assert.deepEqual(r.roles.sort(), ['coder', 'reviewer', 'scout', 'visual']);
  assert.equal(readFileSync(r.backupPath).toString(), originalBytes.toString());
  const merged = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(merged.defaultProvider, 'pfix');
  assert.deepEqual(merged.subagents.agentOverrides.scout, { model: 'pq/mq', thinking: 'low', tools: ['read'] });
  assert.deepEqual(merged.subagents.agentOverrides.customAgent, { model: 'k/k' });
  assert.equal(merged.subagents.agentOverrides.reviewer.model, 'pd/md');
  // no lock or staging leftovers
  assert.equal(existsSync(settingsLockPath(p)), false);
  assert.equal(readdirSync(dir).filter(f => f.includes('.ludi-staging-')).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('apply: semantic no-op leaves original bytes and writes no backup/lock/staging', () => {
  const dir = tmp();
  const live = { subagents: { agentOverrides: { scout: { model: 'pq/mq', thinking: 'low' }, coder: { model: 'pd/md', thinking: 'high' }, visual: { model: 'pa/ma', thinking: 'medium' }, reviewer: { model: 'pd/md', thinking: 'high' } } } };
  const p = writeSettings(dir, live);
  const bytes = readFileSync(p);
  const snap = captureSettingsSnapshot(p);
  const r = applySettingsOverrides(snap, overrides(), { backupDir: join(dir, 'bk') });
  assert.equal(r.changed, false);
  assert.equal(readFileSync(p).toString(), bytes.toString());
  assert.equal(existsSync(join(dir, 'bk')), false);
  assert.equal(existsSync(settingsLockPath(p)), false);
  rmSync(dir, { recursive: true, force: true });
});

test('apply: missing settings file creates only the minimal subagents object (explicit opt-in), no invented backup', () => {
  const dir = tmp();
  const p = join(dir, 'settings.json');
  const snap = captureSettingsSnapshot(p);
  assert.equal(snap.exists, false);
  const r = applySettingsOverrides(snap, overrides(), { backupDir: join(dir, 'bk') });
  assert.equal(r.changed, true);
  assert.equal(r.backupPath, null);
  const merged = JSON.parse(readFileSync(p, 'utf8'));
  assert.deepEqual(Object.keys(merged), ['subagents']);
  assert.deepEqual(Object.keys(merged.subagents), ['agentOverrides']);
  assert.equal(merged.subagents.agentOverrides.coder.model, 'pd/md');
  rmSync(dir, { recursive: true, force: true });
});

test('apply refuses invalid JSON and non-object/array roots or intermediates', () => {
  for (const [label, content] of [
    ['invalid JSON', '{not json'],
    ['null root', 'null'],
    ['array root', '[]'],
    ['string root', '"s"'],
    ['subagents array', { subagents: [] }],
    ['agentOverrides array', { subagents: { agentOverrides: [] } }],
    ['role entry string', { subagents: { agentOverrides: { coder: 'x' } } }],
  ]) {
    const dir = tmp();
    const p = writeSettings(dir, content);
    const bytes = readFileSync(p);
    const snap = captureSettingsSnapshot(p);
    assert.throws(() => applySettingsOverrides(snap, overrides(), { backupDir: join(dir, 'bk') }), SettingsApplyError, label);
    snap.release();
    assert.equal(readFileSync(p).toString(), bytes.toString(), `${label}: original must be preserved`);
    assert.equal(existsSync(join(dir, 'bk')), false, `${label}: no backup on refusal`);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent change between capture and apply is refused: modify, create, delete', () => {
  // modify
  let dir = tmp();
  let p = writeSettings(dir, { a: 1 });
  let bytes = readFileSync(p);
  let snap = captureSettingsSnapshot(p);
  writeFileSync(p, JSON.stringify({ a: 2 }));
  assert.throws(() => applySettingsOverrides(snap, overrides(), { backupDir: join(dir, 'bk') }), /changed since the plan was captured/);
  snap.release();
  assert.equal(readFileSync(p).toString(), JSON.stringify({ a: 2 }));
  rmSync(dir, { recursive: true, force: true });
  // create
  dir = tmp(); p = join(dir, 'settings.json');
  snap = captureSettingsSnapshot(p);
  writeFileSync(p, JSON.stringify({ a: 1 }));
  assert.throws(() => applySettingsOverrides(snap, overrides(), { backupDir: join(dir, 'bk') }), /changed since the plan was captured/);
  snap.release();
  rmSync(dir, { recursive: true, force: true });
  // delete
  dir = tmp(); p = writeSettings(dir, { a: 1 });
  snap = captureSettingsSnapshot(p);
  rmSync(p);
  assert.throws(() => applySettingsOverrides(snap, overrides(), { backupDir: join(dir, 'bk') }), /changed since the plan was captured/);
  snap.release();
  assert.equal(existsSync(p), false);
  rmSync(dir, { recursive: true, force: true });
});

test('a held lock makes concurrent cooperating applies refuse; released lock frees it', () => {
  const dir = tmp();
  const p = writeSettings(dir, { a: 1 });
  const original = readFileSync(p);
  const snap1 = captureSettingsSnapshot(p);
  const snap2 = captureSettingsSnapshot(p, { lock: false });
  const lockBytes = readFileSync(settingsLockPath(p));
  assert.throws(() => applySettingsOverrides(snap2, overrides(), { backupDir: join(dir, 'bk') }), /lock/);
  assert.deepEqual(readFileSync(p), original);
  assert.deepEqual(readFileSync(settingsLockPath(p)), lockBytes, 'failed contender must not remove another owner lock');
  snap1.release();
  const r = applySettingsOverrides(snap2, overrides(), { backupDir: join(dir, 'bk') });
  assert.equal(r.changed, true);
  rmSync(dir, { recursive: true, force: true });
});

test('failed apply cleans owned staging/lock and never restores backup over concurrent change', () => {
  const dir = tmp();
  const p = writeSettings(dir, { a: 1 });
  const snap = captureSettingsSnapshot(p);
  // emulate a crash mid-apply: concurrent modification + owned leftovers
  writeFileSync(p, JSON.stringify({ a: 2 }));
  assert.throws(() => applySettingsOverrides(snap, overrides(), { backupDir: join(dir, 'bk') }));
  snap.release();
  assert.equal(readFileSync(p).toString(), JSON.stringify({ a: 2 }), 'concurrent change preserved, not clobbered');
  assert.equal(existsSync(join(dir, 'bk')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('existing backup entries are never overwritten', () => {
  const dir = tmp();
  const p = writeSettings(dir, { preserved: true });
  const bytes = readFileSync(p);
  const backupDir = join(dir, 'backup');
  mkdirSync(backupDir);
  writeFileSync(join(backupDir, 'settings.json'), 'previous backup');
  const snap = captureSettingsSnapshot(p);
  assert.throws(() => applySettingsOverrides(snap, overrides(), { backupDir }), /EEXIST/);
  assert.deepEqual(readFileSync(p), bytes);
  assert.equal(readFileSync(join(backupDir, 'settings.json'), 'utf8'), 'previous backup');
  assert.equal(existsSync(settingsLockPath(p)), false);
});

test('rename failure preserves original and backup and cleans owned staging and lock', () => {
  const dir = tmp();
  const p = writeSettings(dir, { preserved: true });
  const bytes = readFileSync(p);
  const backupDir = join(dir, 'backup');
  const snap = captureSettingsSnapshot(p);
  const originalRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('injected rename failure'); };
  syncBuiltinESMExports();
  try { assert.throws(() => applySettingsOverrides(snap, overrides(), { backupDir }), /injected rename failure/); }
  finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
  assert.deepEqual(readFileSync(p), bytes);
  assert.deepEqual(readFileSync(join(backupDir, 'settings.json')), bytes);
  assert.equal(existsSync(settingsLockPath(p)), false);
  assert.equal(readdirSync(dir).some(name => name.includes('.ludi-staging-')), false);
});

test('concurrent edit during staging is refused; backup retains captured bytes', () => {
  const dir = tmp();
  const p = writeSettings(dir, { preserved: true });
  const bytes = readFileSync(p);
  const concurrent = '{"concurrent":"must survive"}';
  const backupDir = join(dir, 'backup');
  const snap = captureSettingsSnapshot(p);
  const originalWrite = fs.writeFileSync;
  let edited = false;
  fs.writeFileSync = (file, data, ...args) => {
    const result = originalWrite(file, data, ...args);
    if (!edited && typeof file === 'number' && String(data).includes('"agentOverrides"')) {
      edited = true;
      originalWrite(p, concurrent);
    }
    return result;
  };
  syncBuiltinESMExports();
  try { assert.throws(() => applySettingsOverrides(snap, overrides(), { backupDir }), /changed while staging/); }
  finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
  assert.equal(edited, true);
  assert.equal(readFileSync(p, 'utf8'), concurrent);
  assert.deepEqual(readFileSync(join(backupDir, 'settings.json')), bytes);
  assert.equal(existsSync(settingsLockPath(p)), false);
  assert.equal(readdirSync(dir).some(name => name.includes('.ludi-staging-')), false);
});

test('junction or symlink in backup ancestors is refused without writing outside', () => {
  const dir = tmp();
  const p = writeSettings(dir, { preserved: true });
  const outside = join(dir, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const snap = captureSettingsSnapshot(p);
  assert.throws(() => applySettingsOverrides(snap, overrides(), { backupDir: join(dir, 'linked', 'nested', 'backup') }), /symlink/);
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(existsSync(settingsLockPath(p)), false);
});

test('symlinked settings file is refused', (t) => {
  const dir = tmp();
  const real = join(dir, 'real.json');
  writeFileSync(real, JSON.stringify({ a: 1 }));
  const link = join(dir, 'settings.json');
  try { symlinkSync(real, link); } catch { t.skip('symlink not permitted on this platform'); return; }
  const snap = { path: link, exists: true, sha256: null };
  assert.throws(() => applySettingsOverrides(snap, overrides(), { backupDir: join(dir, 'bk') }), SettingsApplyError);
  rmSync(dir, { recursive: true, force: true });
});

// ---------- CLI wrapper ----------
test('CLI wrapper: merges via --proposal file, reports changed, exits 0; refuses with --json bad proposal', () => {
  const dir = tmp();
  const proposalPath = join(dir, 'proposal.json');
  writeFileSync(proposalPath, JSON.stringify(PROPOSAL));
  const p = writeSettings(dir, { subagents: { agentOverrides: { custom: { model: 'k/k' } } } });
  const out = JSON.parse(execFileSync(process.execPath, [join(kit, 'adapters/pi/lib/settings-apply.mjs'), '--settings', p, '--proposal', proposalPath, '--backup-dir', join(dir, 'bk')], { encoding: 'utf8' }));
  assert.equal(out.ok, true);
  assert.equal(out.changed, true);
  const merged = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(merged.subagents.agentOverrides.custom.model, 'k/k');
  assert.equal(merged.subagents.agentOverrides.coder.model, 'pd/md');
  assert.throws(() => execFileSync(process.execPath, [join(kit, 'adapters/pi/lib/settings-apply.mjs'), '--settings', p, '--json', '{"subagents":{"agentOverrides":{"coder":{"model":"bad"}}}}'], { encoding: 'utf8' }));
  rmSync(dir, { recursive: true, force: true });
});
