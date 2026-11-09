// Hermetic tests for adapters/pi/lib/agent-profiles.mjs: derived pi-subagents
// profiles keep the strict allowlist contract without duplicating common agent
// definitions. No providers, no pi process, no user writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../lib/agents.mjs';
import { deriveProfile, renderAgentProfiles, renderProfileShellGate } from '../adapters/pi/lib/agent-profiles.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = join(kit, 'agents');

const profileOf = (name, profilesDir) =>
  parseFrontmatter(readFileSync(join(profilesDir, `${name}.md`), 'utf8'));

test('derived profiles keep the canonical names, bodies and frontmatter', () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-profiles-'));
  try {
    const profilesDir = join(root, 'agent-profiles');
    renderAgentProfiles({ agentsDir, outDir: profilesDir });
    for (const name of ['scout', 'coder', 'tester', 'reviewer', 'orchestrator', 'browser', 'visual', 'design-planner']) {
      const source = parseFrontmatter(readFileSync(join(agentsDir, `${name}.md`), 'utf8'));
      const derived = profileOf(name, profilesDir);
      assert.equal(derived.meta.name, name, name);
      assert.equal(derived.body, source.body, `${name} body must be copied verbatim`);
      for (const key of Object.keys(source.meta)) {
        if (key === 'tools') continue;
        assert.deepEqual(derived.meta[key], source.meta[key], `${name}.meta.${key}`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shell-capable roles gain ludi_exec plus an explicit provider; raw shell never granted', () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-profiles-'));
  try {
    const profilesDir = join(root, 'agent-profiles');
    const records = renderAgentProfiles({ agentsDir, outDir: profilesDir });
    for (const role of ['coder', 'tester']) {
      const derived = profileOf(role, profilesDir);
      const tools = String(derived.meta.tools).split(',').map(s => s.trim());
      assert.ok(tools.includes('ludi_exec'), `${role} tools: ${derived.meta.tools}`);
      assert.ok(!tools.includes('powershell') && !tools.includes('bash'), `${role} must not allowlist raw shell`);
      assert.equal(derived.meta.subagentOnlyExtensions, `./extensions/${role}-shell-gate.mjs`);
      const providerPath = join(profilesDir, 'extensions', `${role}-shell-gate.mjs`);
      assert.ok(existsSync(providerPath), `${role} provider missing`);
      const src = readFileSync(providerPath, 'utf8');
      assert.match(src, /createShellGate/);
      assert.match(src, new RegExp(`"agent":"${role}"`));
      assert.match(src, /"shell":"true"/);
      const rec = records.find(r => r.agent === role);
      assert.equal(rec.access.shell, 'true');
      assert.equal(rec.extension, `${role}-shell-gate.mjs`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('non-adapted roles keep their source tools verbatim and gain no provider', () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-profiles-'));
  try {
    const profilesDir = join(root, 'agent-profiles');
    renderAgentProfiles({ agentsDir, outDir: profilesDir });
    // Approved scope is coder/tester only. Every other role passes through
    // exactly as authored: no ludi_exec, no provider, and legacy tool names
    // (browser/visual powershell) are preserved — pi-subagents applies the
    // common contract directly for these roles.
    for (const role of ['scout', 'reviewer', 'design-planner', 'visual', 'browser', 'orchestrator']) {
      const source = parseFrontmatter(readFileSync(join(agentsDir, `${role}.md`), 'utf8'));
      const derived = profileOf(role, profilesDir);
      assert.equal(derived.meta.tools, source.meta.tools, `${role} tools must pass through verbatim`);
      const tools = String(derived.meta.tools).split(',').map(s => s.trim());
      assert.ok(!tools.includes('ludi_exec'), `${role} must not gain ludi_exec`);
      assert.equal(derived.meta.subagentOnlyExtensions, source.meta.subagentOnlyExtensions,
        `${role} must not gain or lose a provider reference`);
      assert.ok(!existsSync(join(profilesDir, 'extensions', `${role}-shell-gate.mjs`)), `${role} provider must not be generated`);
    }
    // Regression: browser's body requires powershell for the agent-browser
    // wrapper — the previous rewrite stripped it.
    const browserTools = String(profileOf('browser', profilesDir).meta.tools).split(',').map(s => s.trim());
    assert.ok(browserTools.includes('powershell'), 'browser keeps its authored powershell tool');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('non-adapted synthetic roles pass tools through verbatim regardless of access', () => {
  // A non-coder/tester role is never rewritten: legacy tool names survive
  // (even ones access inference would treat as shell), no provider is added,
  // and an authored subagentOnlyExtensions would pass through.
  const source = parseFrontmatter([
    '---',
    'name: fixture-shell',
    'description: fixture',
    'capability: cheap-code',
    'tools: read, powershell',
    'access:',
    '  filesystem: read',
    '  shell: true',
    '  git: none',
    '  network: false',
    '---',
    'body text',
  ].join('\n'));
  const p = deriveProfile(source);
  assert.equal(p.access.shell, 'true');
  assert.equal(p.extensionFileName, null);
  const derived = parseFrontmatter(p.text);
  assert.equal(derived.meta.tools, 'read, powershell');
  assert.equal(derived.meta.subagentOnlyExtensions, undefined);
  const withProvider = parseFrontmatter([
    '---', 'name: fixture-prov', 'description: fixture', 'capability: cheap-code',
    'tools: read', 'subagentOnlyExtensions: ./extensions/keep-me.mjs', '---', 'body',
  ].join('\n'));
  const kept = parseFrontmatter(deriveProfile(withProvider).text);
  assert.equal(kept.meta.subagentOnlyExtensions, './extensions/keep-me.mjs');
  // An adapted role (coder) with shell access is rewritten through access.
  const coder = parseFrontmatter([
    '---',
    'name: coder',
    'description: fixture',
    'capability: strong-code',
    'tools: read, powershell',
    'access:',
    '  filesystem: read-write',
    '  shell: true',
    '  git: read',
    '  network: false',
    '---',
    'body text',
  ].join('\n'));
  const pc = deriveProfile(coder);
  assert.equal(pc.extensionFileName, 'coder-shell-gate.mjs');
  const derivedCoder = parseFrontmatter(pc.text);
  const coderTools = String(derivedCoder.meta.tools).split(',').map(s => s.trim());
  assert.ok(coderTools.includes('ludi_exec'));
  assert.ok(!coderTools.includes('powershell'));
  assert.equal(derivedCoder.meta.subagentOnlyExtensions, './extensions/coder-shell-gate.mjs');
});

test('an adapted role with access.shell false is still rewritten but gains no provider', () => {
  // coder/tester always get the access-derived allowlist; with shell:false
  // that means no ludi_exec and no shell-gate provider — and powershell is
  // never re-added by access.
  const source = parseFrontmatter([
    '---', 'name: tester', 'description: fixture', 'capability: cheap-code',
    'tools: read, powershell',
    'access:', '  filesystem: read', '  shell: false', '  git: read', '  network: false',
    '---', 'body',
  ].join('\n'));
  const p = deriveProfile(source);
  const derived = parseFrontmatter(p.text);
  const tools = String(derived.meta.tools).split(',').map(s => s.trim());
  assert.ok(!tools.includes('ludi_exec'));
  assert.ok(!tools.includes('powershell'));
  assert.equal(derived.meta.subagentOnlyExtensions, undefined);
  assert.equal(p.extensionFileName, null);
});

test('renderProfileShellGate emits fixed JSON config importing createShellGate only', () => {
  const src = renderProfileShellGate({ agent: 'coder', shell: 'limited', network: false });
  assert.ok(src.includes('import { createShellGate } from "../../../shell-gate/index.js";'));
  assert.ok(!src.includes('file:///'));
  assert.match(src, /const CONFIG = \{"agent":"coder","shell":"limited","network":false\};/);
  assert.match(src, /createShellGate\(\{ shell: CONFIG\.shell, network: CONFIG\.network \}\)\(pi\)/);
  // The generated module never reads ambient environment state.
  assert.ok(!src.includes('process.env'));
  assert.ok(!src.includes('LUDI_SHELL'));
});

test('generated profiles dir contains only role files plus the extensions subdir', () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-profiles-'));
  try {
    const profilesDir = join(root, 'agent-profiles');
    renderAgentProfiles({ agentsDir, outDir: profilesDir });
    const entries = readdirSync(profilesDir).sort();
    assert.deepEqual(entries.filter(e => e !== 'extensions'), readdirSync(agentsDir).filter(f => f.endsWith('.md') && f !== 'README.md').sort());
    assert.deepEqual(readdirSync(join(profilesDir, 'extensions')).sort(),
      ['coder-shell-gate.mjs', 'tester-shell-gate.mjs']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an empty agentsDir produces no profiles and no stray files', () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-profiles-empty-'));
  try {
    const agents = join(root, 'empty-agents');
    mkdirSync(agents);
    const profilesDir = join(root, 'agent-profiles');
    const records = renderAgentProfiles({ agentsDir: agents, outDir: profilesDir });
    assert.deepEqual(records, []);
    assert.deepEqual(readdirSync(profilesDir), ['extensions']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('renderAgentProfiles preserves existing output on parse or derive failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-profiles-preserve-'));
  try {
    const agents = join(root, 'agents');
    mkdirSync(agents);
    // One valid profile plus one that fails scalar validation (description
    // contains # -> parse succeeds, then deriveProfile throws).
    writeFileSync(join(agents, 'coder.md'), [
      '---', 'name: coder', 'description: valid', 'capability: strong-code',
      'tools: read, write', 'access:', '  filesystem: read-write', '  shell: true',
      '  git: read', '  network: false', '---', 'body',
    ].join('\n'));
    writeFileSync(join(agents, 'bad.md'), [
      '---', 'name: bad', 'description: Implements issue #123',
      'capability: cheap-code', 'tools: read', '---', 'body',
    ].join('\n'));
    const profilesDir = join(root, 'agent-profiles');
    mkdirSync(profilesDir);
    const previous = '---\nname: legacy\ndescription: previous\n---\nold body\n';
    writeFileSync(join(profilesDir, 'legacy.md'), previous);
    assert.throws(() => renderAgentProfiles({ agentsDir: agents, outDir: profilesDir }), /flat scalar/);
    assert.equal(readFileSync(join(profilesDir, 'legacy.md'), 'utf8'), previous);
    assert.ok(!existsSync(join(profilesDir, 'coder.md')), 'new output must not be partially published');
    assert.ok(!existsSync(`${profilesDir}.lock`), 'derive failure must release the lock');
    writeFileSync(join(agents, 'bad.md'), 'invalid frontmatter');
    assert.throws(() => renderAgentProfiles({ agentsDir: agents, outDir: profilesDir }), /missing frontmatter/);
    assert.equal(readFileSync(join(profilesDir, 'legacy.md'), 'utf8'), previous);
    assert.ok(!existsSync(`${profilesDir}.lock`), 'parse failure must release the lock');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('renderAgentProfiles preserves existing output on stage/write failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-profiles-writefail-'));
  try {
    const agents = join(root, 'agents');
    mkdirSync(agents);
    writeFileSync(join(agents, 'coder.md'), [
      '---', 'name: coder', 'description: valid', 'capability: strong-code',
      'tools: read, write', 'access:', '  filesystem: read-write', '  shell: true',
      '  git: read', '  network: false', '---', 'body',
    ].join('\n'));
    const profilesDir = join(root, 'agent-profiles');
    mkdirSync(profilesDir);
    const previous = '---\nname: legacy\ndescription: previous\n---\nold body\n';
    writeFileSync(join(profilesDir, 'legacy.md'), previous);
    const writeImpl = (path, text) => {
      if (path.endsWith('coder-shell-gate.mjs')) throw new Error('injected write failure');
      writeFileSync(path, text);
    };
    assert.throws(
      () => renderAgentProfiles({ agentsDir: agents, outDir: profilesDir, writeImpl }),
      /injected write failure/,
    );
    assert.equal(readFileSync(join(profilesDir, 'legacy.md'), 'utf8'), previous);
    assert.ok(!existsSync(join(profilesDir, 'coder.md')));
    // Staging dir must be cleaned up.
    const leftovers = readdirSync(root).filter(f => f.startsWith('agent-profiles.staging-'));
    assert.deepEqual(leftovers, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('renderAgentProfiles rolls back on publish failure and preserves backup on rollback failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-profiles-pubfail-'));
  try {
    const agents = join(root, 'agents');
    mkdirSync(agents);
    writeFileSync(join(agents, 'coder.md'), [
      '---', 'name: coder', 'description: valid', 'capability: strong-code',
      'tools: read, write', 'access:', '  filesystem: read-write', '  shell: true',
      '  git: read', '  network: false', '---', 'body',
    ].join('\n'));
    const profilesDir = join(root, 'agent-profiles');
    mkdirSync(profilesDir);
    const previous = '---\nname: legacy\ndescription: previous\n---\nold body\n';
    writeFileSync(join(profilesDir, 'legacy.md'), previous);

    // 1) Second rename (staging -> outDir) fails; rollback (backup -> outDir) succeeds.
    let calls = 0;
    const renameImpl = (src, dest) => {
      calls += 1;
      if (calls === 2) throw new Error('injected publish failure');
      renameSync(src, dest);
    };
    assert.throws(
      () => renderAgentProfiles({ agentsDir: agents, outDir: profilesDir, renameImpl }),
      /injected publish failure/,
    );
    assert.equal(readFileSync(join(profilesDir, 'legacy.md'), 'utf8'), previous);
    assert.ok(!existsSync(join(profilesDir, 'coder.md')));

    // 2) Both publish and rollback fail: backup dir is preserved with old content.
    calls = 0;
    const renameImpl2 = (src, dest) => {
      calls += 1;
      if (calls === 1) { renameSync(src, dest); return; } // outDir -> backup
      throw new Error(`injected failure ${calls}`);
    };
    assert.throws(
      () => renderAgentProfiles({ agentsDir: agents, outDir: profilesDir, renameImpl: renameImpl2 }),
      /rollback also failed/,
    );
    const backups = readdirSync(root).filter(f => f.startsWith('agent-profiles.backup-'));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(root, backups[0], 'legacy.md'), 'utf8'), previous);
    // Staging dir must be cleaned up even after publish failure.
    const leftovers = readdirSync(root).filter(f => f.startsWith('agent-profiles.staging-'));
    assert.deepEqual(leftovers, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('renderAgentProfiles releases its lock after success and permits another render', () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-profiles-unlock-'));
  try {
    const profilesDir = join(root, 'nested', 'agent-profiles');
    const first = renderAgentProfiles({ agentsDir, outDir: profilesDir });
    assert.ok(!existsSync(`${profilesDir}.lock`), 'successful render must release the lock');
    const before = readFileSync(join(profilesDir, 'coder.md'), 'utf8');
    const second = renderAgentProfiles({ agentsDir, outDir: profilesDir });
    assert.deepEqual(second, first);
    assert.equal(readFileSync(join(profilesDir, 'coder.md'), 'utf8'), before);
    assert.ok(!existsSync(`${profilesDir}.lock`), 'repeated render must release the lock');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('renderAgentProfiles fails closed when the outDir lock is held', () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-profiles-lock-'));
  try {
    const agents = join(root, 'agents');
    mkdirSync(agents);
    writeFileSync(join(agents, 'coder.md'), [
      '---', 'name: coder', 'description: valid', 'capability: strong-code',
      'tools: read, write', 'access:', '  filesystem: read-write', '  shell: true',
      '  git: read', '  network: false', '---', 'body',
    ].join('\n'));
    const profilesDir = join(root, 'agent-profiles');
    mkdirSync(profilesDir);
    writeFileSync(join(profilesDir, 'legacy.md'), '---\nname: legacy\ndescription: previous\n---\nold\n');
    // Simulate a concurrent renderer holding the lock.
    mkdirSync(`${profilesDir}.lock`);
    assert.throws(
      () => renderAgentProfiles({ agentsDir: agents, outDir: profilesDir }),
      /locked by another renderer/,
    );
    // Existing output is untouched and no staging dirs are left behind.
    assert.equal(readFileSync(join(profilesDir, 'legacy.md'), 'utf8'), '---\nname: legacy\ndescription: previous\n---\nold\n');
    const leftovers = readdirSync(root).filter(f => f.startsWith('agent-profiles.staging-'));
    assert.deepEqual(leftovers, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a successful render deletes only the backup it created; repeated renders leave none', () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-profiles-backup-'));
  try {
    const profilesDir = join(root, 'agent-profiles');
    // Three consecutive renders: each replaces the previous output and must
    // remove only its own backup, so backup-* never accumulates.
    for (let i = 0; i < 3; i += 1) {
      renderAgentProfiles({ agentsDir, outDir: profilesDir });
      assert.deepEqual(
        readdirSync(root).filter(f => f.startsWith('agent-profiles.backup-')), [],
        `render ${i + 1} must leave no backup behind`,
      );
    }
    // An older backup that this render did not create is preserved untouched.
    const legacyBackup = join(root, 'agent-profiles.backup-legacy');
    mkdirSync(legacyBackup);
    writeFileSync(join(legacyBackup, 'keep.md'), 'keep\n');
    renderAgentProfiles({ agentsDir, outDir: profilesDir });
    assert.equal(readFileSync(join(legacyBackup, 'keep.md'), 'utf8'), 'keep\n');
    // Only the legacy backup remains — the render's own backup was removed.
    assert.deepEqual(
      readdirSync(root).filter(f => f.startsWith('agent-profiles.backup-')),
      ['agent-profiles.backup-legacy'],
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed backup cleanup is reported with the path but the new output stays live', () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-profiles-cleanupfail-'));
  try {
    const agents = join(root, 'agents');
    mkdirSync(agents);
    writeFileSync(join(agents, 'coder.md'), [
      '---', 'name: coder', 'description: valid', 'capability: strong-code',
      'tools: read, write', 'access:', '  filesystem: read-write', '  shell: true',
      '  git: read', '  network: false', '---', 'body',
    ].join('\n'));
    const profilesDir = join(root, 'agent-profiles');
    mkdirSync(profilesDir);
    writeFileSync(join(profilesDir, 'legacy.md'), '---\nname: legacy\ndescription: previous\n---\nold\n');
    const rmImpl = (path, opts) => {
      if (path.includes('.backup-')) throw new Error('injected cleanup failure');
      rmSync(path, opts);
    };
    let err;
    assert.throws(
      () => renderAgentProfiles({ agentsDir: agents, outDir: profilesDir, rmImpl }),
      error => {
        err = error;
        return /failed to remove the superseded backup/.test(error.message);
      },
    );
    // The diagnostic names the exact leftover path.
    const backup = readdirSync(root).find(f => f.startsWith('agent-profiles.backup-'));
    assert.ok(backup, 'failed cleanup must leave the backup for manual removal');
    assert.match(err.message, new RegExp(backup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    // The new publish is never rolled back or deleted on cleanup failure.
    assert.ok(existsSync(join(profilesDir, 'coder.md')));
    assert.ok(!existsSync(join(profilesDir, 'legacy.md')));
    // Lock is still released.
    assert.ok(!existsSync(`${profilesDir}.lock`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('outDir accepts a real directory or a missing path only', () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-profiles-outdir-'));
  try {
    const agents = join(root, 'agents');
    mkdirSync(agents);
    writeFileSync(join(agents, 'coder.md'), [
      '---', 'name: coder', 'description: valid', 'capability: strong-code',
      'tools: read, write', 'access:', '  filesystem: read-write', '  shell: true',
      '  git: read', '  network: false', '---', 'body',
    ].join('\n'));
    // Missing outDir is created and rendered.
    const missing = join(root, 'missing-out');
    renderAgentProfiles({ agentsDir: agents, outDir: missing });
    assert.ok(existsSync(join(missing, 'coder.md')));
    // A real directory renders again in place.
    renderAgentProfiles({ agentsDir: agents, outDir: missing });
    assert.ok(existsSync(join(missing, 'coder.md')));
    // A regular file at outDir is refused; the file is left untouched.
    const fileOut = join(root, 'file-out');
    writeFileSync(fileOut, 'not a dir');
    assert.throws(
      () => renderAgentProfiles({ agentsDir: agents, outDir: fileOut }),
      new RegExp(`must be absent or a real directory.*${fileOut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    assert.equal(readFileSync(fileOut, 'utf8'), 'not a dir');
    assert.ok(!existsSync(`${fileOut}.lock`), 'refusal before lock must not leave one');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('outDir that is a live or dangling link is refused without touching the target', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'ludi-profiles-link-'));
  try {
    const agents = join(root, 'agents');
    mkdirSync(agents);
    writeFileSync(join(agents, 'coder.md'), [
      '---', 'name: coder', 'description: valid', 'capability: strong-code',
      'tools: read, write', 'access:', '  filesystem: read-write', '  shell: true',
      '  git: read', '  network: false', '---', 'body',
    ].join('\n'));
    // Live junction to a real dir: refused before the target is touched.
    const target = join(root, 'link-target');
    mkdirSync(target);
    writeFileSync(join(target, 'sentinel.txt'), 'sentinel\n');
    const liveLink = join(root, 'live-link');
    symlinkSync(target, liveLink, 'junction');
    assert.throws(
      () => renderAgentProfiles({ agentsDir: agents, outDir: liveLink }),
      new RegExp(`junction/symlink.*${liveLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    assert.equal(readFileSync(join(target, 'sentinel.txt'), 'utf8'), 'sentinel\n');
    assert.equal(readdirSync(target).length, 1, 'nothing may be written through the link');
    assert.ok(lstatSync(liveLink).isSymbolicLink(), 'the link itself is preserved');
    assert.ok(!existsSync(`${liveLink}.lock`));
    // Dangling link: existsSync would return false but lstat still sees the
    // link — refused the same way. Junction to a real dir first, then remove
    // the target so the link dangles on every platform/tooling variant.
    const gone = join(root, 'gone-target');
    mkdirSync(gone);
    const deadLink = join(root, 'dead-link');
    symlinkSync(gone, deadLink, 'junction');
    rmSync(gone, { recursive: true, force: true });
    assert.throws(
      () => renderAgentProfiles({ agentsDir: agents, outDir: deadLink }),
      /junction\/symlink/,
    );
    assert.ok(lstatSync(deadLink).isSymbolicLink(), 'the dangling link is preserved');
    assert.ok(!existsSync(gone), 'a dangling link must not resurrect its target');
    assert.ok(!existsSync(`${deadLink}.lock`));
    // No staging/backup dirs or published output are left behind for either refusal.
    const leftovers = readdirSync(root).filter(f =>
      f.startsWith('live-link.') || f.startsWith('dead-link.') || f === 'gone-target');
    assert.deepEqual(leftovers, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('common agent files stay provider-neutral: no adapter paths in frontmatter', () => {
  // The common definitions never pin a concrete provider path; role bodies may
  // name the gated ludi_exec tool in prose (neutral contract name), while the
  // derived profiles add the strict tools entry and provider reference so
  // pi-subagents' allowlist actually resolves it.
  for (const file of readdirSync(agentsDir).filter(f => f.endsWith('.md') && f !== 'README.md')) {
    const { meta } = parseFrontmatter(readFileSync(join(agentsDir, file), 'utf8'));
    assert.equal(meta.subagentOnlyExtensions, undefined, `${file} must not pin a provider path`);
    assert.ok(!String(meta.tools ?? '').includes('ludi_exec'), `${file} tools stays provider-neutral`);
    assert.ok(!String(meta.extensions ?? '').includes('adapters/'), `${file} must not leak an adapter path`);
  }
});
