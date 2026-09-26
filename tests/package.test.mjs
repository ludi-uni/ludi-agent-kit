import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('npm manifest exposes existing Pi resources without installation hooks', () => {
  assert.equal(pkg.name, '@ludi-uni/ludi-agent-kit');
  assert.equal(pkg.license, 'MIT');
  assert.ok(pkg.keywords.includes('pi-package'));
  assert.deepEqual(pkg.pi.extensions, [
    './adapters/pi/loop-guard/index.js',
    './adapters/pi/orchestrator-ext/index.js',
  ]);
  assert.deepEqual(pkg.pi.skills, [
    './skills/pi-workflow', './skills/project-management', './skills/visual-verification',
  ]);
  for (const path of pkg.pi.extensions) assert.ok(existsSync(join(root, path)), path);
  for (const path of pkg.pi.skills) assert.ok(existsSync(join(root, path, 'SKILL.md')), path);
  for (const field of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublishOnly']) {
    assert.equal(pkg.scripts?.[field], undefined, `${field} must not run on install/publish`);
  }
});

test('npm file allowlist excludes local state and includes extension runtime paths', () => {
  assert.ok(pkg.files.includes('rules/'));
  assert.ok(pkg.files.includes('lib/'));
  assert.ok(pkg.files.includes('adapters/pi/lib/'));
  assert.ok(pkg.files.includes('adapters/pi/models.json'));
  assert.ok(pkg.files.includes('adapters/pi/orchestrator-ext/'));
  for (const path of pkg.files) {
    assert.ok(!/(^|\/)(\.pi|\.orchestration|out|node_modules)(\/|$)|models\.local\.json$/.test(path), path);
  }
});
