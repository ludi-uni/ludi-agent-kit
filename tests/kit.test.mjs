// Whole-kit structural checks: validate.mjs passes, agents are capability-bound, no hardcoded
// user paths, no secrets, adapter boundary respected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateKit } from '../scripts/validate.mjs';
import { loadAgents, parseFrontmatter, validateAgent } from '../lib/agents.mjs';
import { loadRouting } from '../lib/routing.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', '.orchestration', 'node_modules', 'out']);
const TEXT = /\.(md|mjs|js|json|ps1|py|yaml|yml|txt|gitignore|gitattributes)$/;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}
const files = [...walk(kit)].filter(f => TEXT.test(f) || !f.includes('.'));

test('validate.mjs passes for the shipped kit', () => {
  const report = validateKit(kit);
  assert.deepEqual(report.errors, []);
  assert.equal(report.result, 'PASS');
  assert.deepEqual(report.summary.agents.sort(), ['browser->browser', 'coder->strong-code', 'orchestrator->orchestration', 'reviewer->deep-review', 'scout->cheap-code', 'tester->cheap-code', 'visual->vision-reasoning']);
});

test('exactly the seven thin agents exist and none pins a model/provider', () => {
  const routing = loadRouting(join(kit, 'routing/routing.json'));
  const { agents, errors } = loadAgents(join(kit, 'agents'), routing);
  assert.deepEqual(errors, []);
  assert.deepEqual(agents.map(a => a.meta.name).sort(), ['browser', 'coder', 'orchestrator', 'reviewer', 'scout', 'tester', 'visual']);
  const bad = parseFrontmatter('---\nname: x\ndescription: d\ncapability: strong-code\nmodel: gpt-something\n---\nbody');
  assert.ok(validateAgent(bad, routing).some(e => e.includes('must not pin a model')));
});

test('no fixed Windows user-profile paths are hardcoded', () => {
  const offenders = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (/[A-Za-z]:\\Users\\(?!someone\\)[A-Za-z0-9_.-]+/.test(text) || /\/Users\/(?!someone\/)[A-Za-z0-9_.-]+\//.test(text)) offenders.push(relative(kit, f));
  }
  assert.deepEqual(offenders, []);
});

test('no API keys / tokens / private keys in tracked-shape files', () => {
  const pattern = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)/;
  const offenders = files.filter(f => pattern.test(readFileSync(f, 'utf8'))).map(f => relative(kit, f));
  assert.deepEqual(offenders, []);
});

test('.gitignore excludes secrets, generated output and media', () => {
  const ignore = readFileSync(join(kit, '.gitignore'), 'utf8');
  for (const needle of ['auth.json', '.env', '*.key', 'adapters/pi/out/', 'models.local.json', '*.png', '*.mp4']) assert.ok(ignore.includes(needle), needle);
});

test('provider/model names live only in adapters (common layer stays neutral)', () => {
  const pi = JSON.parse(readFileSync(join(kit, 'adapters/pi/models.json'), 'utf8'));
  const concrete = Object.values(pi.backends).flatMap(b => [b.provider, b.model]).filter(v => v && !v.startsWith('TODO'));
  const common = files.filter(f => /[\\/](lib|routing|agents|rules|context-pack|orchestration)[\\/]/.test(f));
  for (const f of common) {
    const text = readFileSync(f, 'utf8');
    for (const name of concrete) assert.ok(!text.includes(name), `${relative(kit, f)} mentions concrete "${name}"`);
  }
});

test('copied skills keep valid frontmatter and visual-verification has no Codex home dependency', () => {
  const skill = readFileSync(join(kit, 'skills/visual-verification/SKILL.md'), 'utf8');
  assert.ok(!/CODEX_HOME/.test(skill));
  assert.match(skill, /^---\r?\nname: visual-verification/);
  for (const name of ['scripts/common.ps1', 'scripts/screenshot.ps1', 'scripts/desktop-screenshot.ps1', 'scripts/winapp-common.ps1']) {
    assert.ok(statSync(join(kit, 'skills/visual-verification', name)).isFile(), name);
  }
});
