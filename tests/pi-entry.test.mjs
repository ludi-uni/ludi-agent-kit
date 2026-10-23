// Hermetic pi CLI discovery fixtures. Uses only temporary trees; never the
// real user install, PATH, or LUDI_PI_ENTRY of the host environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { locatePiEntry } from '../adapters/pi/lib/invoke.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ludi-pi-entry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function npmLayout(root, { bin = { pi: 'dist/bundle/cli.js' }, createBin = true } = {}) {
  const binDir = join(root, 'npm-bin');
  const pkgDir = join(binDir, 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', bin }));
  if (createBin) {
    mkdirSync(join(pkgDir, 'dist', 'bundle'), { recursive: true });
    writeFileSync(join(pkgDir, 'dist', 'bundle', 'cli.js'), '// fixture pi cli\n');
  }
  writeFileSync(join(binDir, 'pi.cmd'), '@echo off\r\nfixture\r\n');
  writeFileSync(join(binDir, 'pi'), '#!/bin/sh\n# fixture\n');
  return { binDir, pkgDir };
}

function managedLayout(root, { version = '0.0.0-fixture', bin = { pi: 'dist/bundle/cli.js' }, createBin = true } = {}) {
  const agentDir = join(root, 'agent');
  const binDir = join(agentDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const pkgDir = join(agentDir, 'install', 'releases', version, 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(join(agentDir, 'install'), { recursive: true });
  writeFileSync(join(agentDir, 'install', 'current-version'), `${version}\n`);
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', bin }));
  if (createBin) {
    mkdirSync(join(pkgDir, 'dist', 'bundle'), { recursive: true });
    writeFileSync(join(pkgDir, 'dist', 'bundle', 'cli.js'), '// fixture pi cli\n');
  }
  writeFileSync(join(binDir, 'pi.cmd'), '@echo off\r\nnode "%~dp0pi-launcher.js" %*\r\n');
  writeFileSync(join(binDir, 'pi.ps1'), '# fixture\n');
  writeFileSync(join(binDir, 'pi'), '#!/bin/sh\n# fixture\n');
  writeFileSync(join(binDir, 'pi-launcher.js'), '// fixture launcher\n');
  return { agentDir, binDir, pkgDir };
}

test('LUDI_PI_ENTRY takes precedence when it points to an existing file', t => {
  const root = fixture(t);
  const { binDir, pkgDir } = npmLayout(root);
  const explicit = join(root, 'explicit-cli.js');
  writeFileSync(explicit, '// explicit\n');
  const found = locatePiEntry({ PATH: binDir, LUDI_PI_ENTRY: explicit });
  assert.equal(found, explicit);
});

test('missing LUDI_PI_ENTRY falls through to PATH discovery instead of failing', t => {
  const root = fixture(t);
  const { binDir, pkgDir } = npmLayout(root);
  const found = locatePiEntry({ PATH: binDir, LUDI_PI_ENTRY: join(root, 'does-not-exist.js') });
  assert.equal(found, join(pkgDir, 'dist', 'bundle', 'cli.js'));
});

test('npm layout resolves bin.pi through the package adjacent to pi on PATH', t => {
  const root = fixture(t);
  const { binDir, pkgDir } = npmLayout(root);
  assert.equal(locatePiEntry({ PATH: binDir }), join(pkgDir, 'dist', 'bundle', 'cli.js'));
  const root2 = fixture(t);
  const strBin = npmLayout(root2, { bin: 'lib/cli.js' });
  mkdirSync(join(strBin.pkgDir, 'lib'), { recursive: true });
  writeFileSync(join(strBin.pkgDir, 'lib', 'cli.js'), '// fixture\n');
  assert.equal(locatePiEntry({ PATH: strBin.binDir }), join(strBin.pkgDir, 'lib', 'cli.js'));
});

test('managed layout resolves through install/current-version and validates it', t => {
  const root = fixture(t);
  const { binDir, pkgDir } = managedLayout(root);
  assert.equal(locatePiEntry({ PATH: binDir }), join(pkgDir, 'dist', 'bundle', 'cli.js'));
  for (const version of ['..', '.', 'not/a-version', 'bad;version', ' ']) {
    writeFileSync(join(root, 'agent', 'install', 'current-version'), version);
    assert.equal(locatePiEntry({ PATH: binDir }), null, `version ${JSON.stringify(version)} must be rejected`);
  }
});

test('managed layout validates the resolved bin path stays a file inside the package', t => {
  const root = fixture(t);
  const { binDir, pkgDir } = managedLayout(root, { bin: { pi: '../../outside.js' } });
  assert.equal(locatePiEntry({ PATH: binDir }), null);
  const root2 = fixture(t);
  const missing = managedLayout(root2, { createBin: false });
  assert.equal(locatePiEntry({ PATH: missing.binDir }), null);
});

test('malformed or stale candidates do not prevent later valid discovery', t => {
  const root = fixture(t);
  // Candidate 1: pi present, package.json malformed JSON.
  const badJson = join(root, 'bad-json');
  mkdirSync(join(badJson, 'node_modules', '@earendil-works', 'pi-coding-agent'), { recursive: true });
  writeFileSync(join(badJson, 'pi.cmd'), 'x'); writeFileSync(join(badJson, 'pi'), 'x');
  writeFileSync(join(badJson, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), '{not json');
  // Candidate 2: pi present, package.json missing entirely.
  const noPkg = join(root, 'no-pkg'); mkdirSync(noPkg);
  writeFileSync(join(noPkg, 'pi.cmd'), 'x'); writeFileSync(join(noPkg, 'pi'), 'x');
  // Candidate 3: stale managed layout (current-version points at absent release).
  const stale = join(root, 'stale-agent', 'bin'); mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, 'pi.cmd'), 'x');
  mkdirSync(join(root, 'stale-agent', 'install'), { recursive: true });
  writeFileSync(join(root, 'stale-agent', 'install', 'current-version'), 'gone\n');
  // Candidate 4: valid npm layout.
  const { binDir, pkgDir } = npmLayout(join(root, 'valid'));
  const env = { PATH: [badJson, noPkg, stale, binDir].join(delimiter) };
  assert.equal(locatePiEntry(env), join(pkgDir, 'dist', 'bundle', 'cli.js'));
});

test('invalid package metadata is skipped in favor of a later valid candidate', t => {
  const root = fixture(t);
  const bad = npmLayout(join(root, 'bad'));
  const good = npmLayout(join(root, 'good'));
  for (const metadata of [null, [], 'invalid', 42, { bin: {} }, { bin: { pi: 42 } }]) {
    writeFileSync(join(bad.pkgDir, 'package.json'), JSON.stringify(metadata));
    assert.equal(locatePiEntry({ PATH: [bad.binDir, good.binDir].join(delimiter) }), join(good.pkgDir, 'dist', 'bundle', 'cli.js'));
  }
});

test('directories on PATH without any pi wrapper are skipped', t => {
  const root = fixture(t);
  const empty = join(root, 'empty'); mkdirSync(empty);
  const { binDir, pkgDir } = npmLayout(root);
  assert.equal(locatePiEntry({ PATH: [empty, binDir].join(delimiter) }), join(pkgDir, 'dist', 'bundle', 'cli.js'));
  assert.equal(locatePiEntry({ PATH: empty }), null);
  assert.equal(locatePiEntry({ PATH: '' }), null);
});
