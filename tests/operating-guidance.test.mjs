// Operating-guidance contract: the generated AGENTS.md stays in sync with
// rules/, the delegation/test-enumeration guidance is documented, and every
// real tests/*.test.mjs file name expanded into one literal `node --test`
// command passes decideShell for gated coder/tester workers. Static checks
// only — no shell is spawned and nothing under the user profile is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideShell } from '../lib/orchestrator/shell-policy.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agents = readFileSync(join(kit, 'AGENTS.md'), 'utf8');
const common = readFileSync(join(kit, 'rules', 'common.md'), 'utf8');
const repoLocal = readFileSync(join(kit, 'rules', 'repo-local.md'), 'utf8');

test('generated AGENTS.md matches the current rules composition', () => {
  const loop = readFileSync(join(kit, 'rules', 'loop-prevention.md'), 'utf8');
  const header = '<!-- ludi-agent-kit repository instructions. Composed from rules/common.md, rules/loop-prevention.md and rules/repo-local.md by scripts/sync-agents-md.ps1; do not edit directly. -->';
  assert.equal(agents, `${header}\n${common.trim()}\n\n${loop.trim()}\n\n${repoLocal.trim()}\n`,
    'AGENTS.md is stale — run scripts/sync-agents-md.ps1');
});

test('delegation guidance: parent owns delegation, bounded children, no implicit re-delegation', () => {
  assert.match(common, /owns scope, integration, decisions, final\s+acceptance, the delegation decision itself/);
  assert.match(common, /When delegation is authorized and useful/);
  assert.match(common, /Trivial work, or work better done directly, may be\s+performed by the parent without delegation/);
  assert.match(common, /never re-delegate\s+unless the parent's context pack explicitly authorizes a fanout/);
});

test('gated-worker test guidance: literal enumeration, no pipelines/globs/directory args', () => {
  assert.match(repoLocal, /Gated `ludi_exec` workers/);
  assert.match(repoLocal, /single literal command/);
  assert.match(repoLocal, /not a substitute for the full enumerated suite/);
  // The raw-PowerShell form remains for parent/native sessions.
  assert.match(repoLocal, /Get-ChildItem tests -Filter '\*\.test\.mjs'/);
});

test('the real test listing expands to one literal node --test allowed by decideShell', () => {
  const files = readdirSync(join(kit, 'tests'))
    .filter(f => f.endsWith('.test.mjs'))
    .map(f => `tests/${f}`)
    .sort();
  assert.ok(files.length > 20, 'expected the real suite, got ' + files.length);
  const command = `node --test ${files.join(' ')}`;
  for (const shell of ['limited', 'true']) {
    const d = decideShell(command, { shell });
    assert.equal(d.allow, true, `${shell}: ${d.reason}`);
  }
  // Shell expressions are refused; directory/glob handling belongs to the runner,
  // not this gate. The documented literal enumeration avoids both dependencies.
  const expression = "node --test (Get-ChildItem tests -Filter '*.test.mjs' | ForEach-Object FullName)";
  assert.equal(decideShell(expression, { shell: 'limited' }).allow, false);
  assert.match(repoLocal, /Do not rely on glob expansion or directory arguments/);
});

test('browser and image-inspection guidance is backend-agnostic', () => {
  const skill = readFileSync(join(kit, 'skills', 'visual-verification', 'SKILL.md'), 'utf8');
  assert.match(skill, /browser-level automation/);
  assert.match(skill, /image-capable inspection tool/);
  assert.ok(!skill.includes('`view_image`'), 'a fixed tool name must not be mandated');
  assert.match(skill, /Do not silently fall back/, 'the no-silent-fallback contract survives');
});
