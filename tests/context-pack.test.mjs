import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContextPackMarkdown, validateContextPack, loadContextPack, toMarkdown, REQUIRED_FIELDS } from '../lib/context-pack.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const example = resolve(kit, 'context-pack/examples/example-fix.md');
const schema = JSON.parse(readFileSync(resolve(kit, 'context-pack/context-pack.schema.json'), 'utf8'));

test('schema file parses and lists the same required fields as the validator', () => {
  assert.deepEqual([...schema.required].sort(), [...REQUIRED_FIELDS].sort());
  for (const f of ['task', 'goal', 'constraints', 'relevant_files', 'relevant_snippets', 'repo_rules', 'observed_errors', 'test_commands', 'previous_attempts', 'expected_output']) {
    assert.ok(schema.properties[f], `schema missing ${f}`);
  }
});

test('example markdown parses, validates and round-trips', () => {
  const pack = loadContextPack(example);
  assert.equal(pack.task, 'Fix crash when saving an empty project');
  assert.deepEqual(pack.relevant_files[0], { path: 'src/save.ts', lines: '40-88', reason: 'serialization entry point' });
  assert.equal(pack.relevant_snippets[0].language, 'ts');
  assert.match(pack.relevant_snippets[0].content, /export function save/);
  assert.match(pack.observed_errors[0], /TypeError/);
  assert.deepEqual(pack.test_commands, ['npm test -- save']);
  assert.deepEqual(pack.previous_attempts[0], { summary: 'Added a null check in `save()`', outcome: 'tests pass but empty file is still invalid.' });
  const again = parseContextPackMarkdown(toMarkdown(pack));
  assert.deepEqual(again, pack);
});

test('missing required sections are reported', () => {
  const errs = validateContextPack(parseContextPackMarkdown('# Context Pack\n\n## task\nx\n'));
  for (const f of ['goal', 'constraints', 'relevant_files', 'expected_output']) assert.ok(errs.some(e => e.includes(`"${f}"`)), f);
});

test('unknown and duplicate sections are rejected', () => {
  assert.throws(() => parseContextPackMarkdown('# Context Pack\n## task\na\n## bogus\nb\n'), /unknown section/);
  assert.throws(() => parseContextPackMarkdown('# Context Pack\n## task\na\n## task\nb\n'), /duplicate section/);
  assert.throws(() => parseContextPackMarkdown('## task\na\n'), /missing "# Context Pack"/);
});

test('relevant_files must be non-empty, relative, with valid line ranges', () => {
  const ok = { task: 't', goal: 'g', constraints: [], relevant_files: [{ path: 'a.ts' }], expected_output: 'e' };
  assert.deepEqual(validateContextPack(ok), []);
  assert.ok(validateContextPack({ ...ok, relevant_files: [] }).some(e => e.includes('at least one')));
  assert.ok(validateContextPack({ ...ok, relevant_files: [{ path: 'C:\\Users\\someone\\a.ts' }] }).some(e => e.includes('repository-relative')));
  assert.ok(validateContextPack({ ...ok, relevant_files: [{ path: 'a.ts', lines: '10' }] }).some(e => e.includes('start-end')));
});

test('unknown fields and bad metadata are rejected', () => {
  const ok = { task: 't', goal: 'g', constraints: [], relevant_files: [{ path: 'a' }], expected_output: 'e' };
  assert.ok(validateContextPack({ ...ok, extra: 1 }).some(e => e.includes('unknown field')));
  assert.ok(validateContextPack({ ...ok, version: 2 }).some(e => e.includes('version')));
  assert.ok(validateContextPack({ ...ok, capability: 'Bad' }).some(e => e.includes('capability')));
  assert.ok(validateContextPack({ ...ok, budget: { max_tokens: 0 } }).some(e => e.includes('max_tokens')));
  assert.deepEqual(validateContextPack({ ...ok, version: 1, capability: 'strong-code', budget: { max_tokens: 8000 } }), []);
});

test('v1.1: discovery.status=none permits empty relevant_files; create flag round-trips; v1.0 packs unchanged', () => {
  const base = { task: 't', goal: 'g', constraints: [], relevant_files: [], expected_output: 'e' };
  assert.ok(validateContextPack(base).some(e => e.includes('at least one')));
  assert.deepEqual(validateContextPack({ ...base, discovery: { status: 'none', note: 'greenfield' } }), []);
  assert.ok(validateContextPack({ ...base, discovery: { status: 'partial' } }).some(e => e.includes('at least one')));
  assert.ok(validateContextPack({ ...base, discovery: { status: 'maybe' } }).some(e => e.includes('discovery.status')));
  const withCreate = { ...base, relevant_files: [{ path: 'src/new.js', create: true, reason: 'new module' }, { path: 'a.js' }] };
  assert.deepEqual(validateContextPack(withCreate), []);
  const md = toMarkdown({ ...withCreate, discovery: { status: 'partial', note: 'only tests exist' } });
  assert.match(md, /## discovery\npartial — only tests exist/);
  assert.match(md, /- `src\/new.js` — \(new\) new module/);
  const back = parseContextPackMarkdown(md);
  assert.deepEqual(back.discovery, { status: 'partial', note: 'only tests exist' });
  assert.deepEqual(back.relevant_files[0], { path: 'src/new.js', reason: 'new module', create: true });
  assert.deepEqual(validateContextPack(loadContextPack(example)), []); // v1.0 example still valid
  assert.equal(schema.properties.relevant_files.minItems, undefined);
  assert.equal(schema.else.properties.relevant_files.minItems, 1);
});

test('lenient parsing accepts real scout output shapes; strict parsing does not', () => {
  const loose = 'Preamble text.\n\n## task\nt\n## goal\ng\n## constraints\n- a\n  - nested detail\n## relevant_files\n- `src/math.js:1-12` — impl\n- `test/x.js:6`\n## relevant_snippets\n- `src/math.js:9-12`\n  ```js\n  code\n  ```\n## expected_output\ne\n';
  assert.throws(() => parseContextPackMarkdown(loose), /missing "# Context Pack"/);
  const p = parseContextPackMarkdown(loose, { lenient: true });
  assert.deepEqual(p.constraints, ['a nested detail']);
  assert.deepEqual(p.relevant_files, [{ path: 'src/math.js', lines: '1-12', reason: 'impl' }, { path: 'test/x.js', lines: '6-6' }]);
  assert.equal(p.relevant_snippets[0].path, 'src/math.js');
  assert.equal(p.relevant_snippets[0].lines, '9-12');
  assert.equal(p.relevant_snippets[0].language, 'js');
  assert.deepEqual(validateContextPack(p), []);
  // Windows drive letters are not line refs
  assert.equal(parseContextPackMarkdown('# Context Pack\n## relevant_files\n- `C:\\r\\a.js`\n', { lenient: true }).relevant_files[0].path, 'C:\\r\\a.js');
});

test('headings inside fenced code blocks do not start sections', () => {
  const md = '# Context Pack\n## task\nt\n## goal\ng\n## constraints\n## relevant_files\n- `a.md`\n## observed_errors\n```\n## not a heading\n```\n## expected_output\ne\n';
  const pack = parseContextPackMarkdown(md);
  assert.deepEqual(pack.observed_errors, ['## not a heading']);
  assert.deepEqual(validateContextPack(pack), []);
});
