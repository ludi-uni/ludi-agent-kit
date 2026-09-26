// Registry merge, capability resolution, settings proposal, normalizer, escalation, loop prevention,
// and a fixture-repo E2E with a scripted invoker (no model calls).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { validateRegistry, mergeRegistries, loadRegistry } from '../lib/registry.mjs';
import { resolveCapability, resolveAgents, formatModelId } from '../lib/resolve.mjs';
import { normalizeContextPack, classifyPath, relativizeText } from '../lib/normalize.mjs';
import { withEscalation, runPipeline, parseFileBlocks, runTests } from '../lib/pipeline.mjs';
import { buildSettingsProposal } from '../adapters/pi/lib/settings-proposal.mjs';
import { createScriptedInvoker } from '../adapters/pi/lib/invoke.mjs';
import { loadPiRegistry, piUserModelsPath } from '../adapters/pi/lib/model-registry.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);

// Test registry with neutral names: no real provider ids in tests.
const REG = { version: 1, backends: {
  local: { provider: 'pl', model: 'ml', thinking: 'off' },
  cheap: { provider: 'pc', model: 'mc', thinking: 'low' },
  sol:   { provider: 'ps', model: 'ms', thinking: 'high' },
  astra: { provider: 'pa', model: 'ma', thinking: 'medium', vision: true },
  codex: { provider: 'px', model: 'mx', thinking: 'high' },
  qoder: { provider: 'pq', model: 'mq', thinking: 'low' },
  devin: { provider: 'pd', model: 'md', thinking: 'high' },
} };

// ---------- registry ----------
test('registry: valid, unknown key, unknown backend, credential and thinking errors', () => {
  assert.deepEqual(validateRegistry(REG, routing), []);
  const bad = structuredClone(REG); bad.extra = 1; bad.backends.ghost = { provider: 'p', model: 'm' }; bad.backends.sol.apiKey = 'x'; bad.backends.cheap.thinking = 'ultra'; bad.backends.local.color = 'red';
  const errs = validateRegistry(bad, routing);
  for (const needle of ['unknown top-level key "extra"', 'backend "ghost" is not defined', 'must not store credentials', 'thinking must be one of', 'unknown key "color"']) assert.ok(errs.some(e => e.includes(needle)), needle);
});

test('registry: models.local.json overrides models.json per backend and can add backends', () => {
  const base = { version: 1, backends: { cheap: { provider: 'TODO-provider', model: 'TODO', thinking: 'low' }, sol: { provider: 'ps', model: 'ms' } } };
  const local = { version: 1, backends: { cheap: { provider: 'pc', model: 'mc' }, local: { provider: 'pl', model: 'ml' } } };
  const m = mergeRegistries(base, local);
  assert.deepEqual(m.backends.cheap, { provider: 'pc', model: 'mc', thinking: 'low' });
  assert.deepEqual(m.backends.sol, { provider: 'ps', model: 'ms' });
  assert.ok(m.backends.local);
});

test('registry: loadRegistry merges files and rejects invalid local file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ludi-reg-'));
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ version: 1, backends: { sol: { provider: 'TODO-provider', model: 'TODO-m' } } }));
  writeFileSync(join(dir, 'models.local.json'), JSON.stringify({ version: 1, backends: { sol: { provider: 'ps', model: 'ms' } } }));
  const { registry, sources } = loadRegistry(join(dir, 'models.json'), join(dir, 'models.local.json'), routing);
  assert.equal(registry.backends.sol.provider, 'ps');
  assert.ok(sources.local);
  writeFileSync(join(dir, 'models.local.json'), JSON.stringify({ version: 1, backends: { nope: { provider: 'p', model: 'm' } } }));
  assert.throws(() => loadRegistry(join(dir, 'models.json'), join(dir, 'models.local.json'), routing), /models.local.json: backend "nope"/);
  const shipped = loadRegistry(join(kit, 'adapters/pi/models.json'), null, routing);
  assert.equal(shipped.sources.local, null);
});

test('pi user bindings override package-local bindings without writing to the agent directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ludi-pi-reg-'));
  const adapter = join(dir, 'adapters', 'pi');
  const home = join(dir, 'home');
  mkdirSync(adapter, { recursive: true });
  const userPath = piUserModelsPath({}, home);
  mkdirSync(dirname(userPath), { recursive: true });
  const file = (path, backends) => writeFileSync(path, JSON.stringify({ version: 1, backends }));
  file(join(adapter, 'models.json'), { devin: { provider: 'TODO-provider', model: 'TODO-model', thinking: 'low' } });
  file(join(adapter, 'models.local.json'), { devin: { provider: 'package', model: 'old' }, sol: { provider: 'package', model: 'fallback' } });
  file(userPath, { devin: { provider: 'user', model: 'new' } });
  const merged = loadPiRegistry(dir, routing, { env: {}, home });
  assert.equal(merged.registry.backends.devin.model, 'new');
  assert.equal(merged.registry.backends.devin.thinking, 'low');
  assert.equal(merged.registry.backends.sol.model, 'fallback');
  assert.equal(merged.sources.user, userPath);
  rmSync(join(adapter, 'models.local.json'));
  assert.equal(loadPiRegistry(dir, routing, { env: {}, home }).registry.backends.devin.model, 'new');
  file(join(adapter, 'models.local.json'), { devin: { provider: 'package', model: 'old' } });
  assert.equal(loadPiRegistry(dir, routing, { env: { PI_CODING_AGENT_DIR: join(dir, 'empty') }, home }).sources.user, null);
  assert.equal(piUserModelsPath({ PI_CODING_AGENT_DIR: join(dir, 'custom') }, home), join(dir, 'custom', 'ludi-agent-kit', 'models.local.json'));
  file(userPath, { devin: { apiKey: 'bad' } });
  assert.throws(() => loadPiRegistry(dir, routing, { env: {}, home }), /must not store credentials/);
});

// ---------- resolution ----------
test('resolve: agent -> capability -> backend chain -> concrete model; placeholders skipped', () => {
  const r = resolveAgents(agents, routing, REG);
  assert.equal(r.scout.capability, 'cheap-code');
  assert.deepEqual(r.scout.candidates.map(c => c.modelId), ['pq/mq:low', 'pc/mc:low', 'pl/ml:off', 'ps/ms:high']);
  assert.deepEqual(r.coder.candidates.map(c => c.backend), ['devin', 'qoder', 'sol', 'codex', 'local']);
  assert.equal(r.visual.candidates[1].degraded, true);
  const partial = { version: 1, backends: { sol: { provider: 'TODO-provider', model: 'TODO' }, codex: REG.backends.codex } };
  const c = resolveCapability(routing, partial, 'strong-code');
  assert.deepEqual(c.placeholder, ['sol']);
  assert.deepEqual(c.unbound, ['devin', 'qoder', 'local']);
  assert.deepEqual(c.candidates.map(x => x.backend), ['codex']);
  assert.equal(formatModelId({ provider: 'a', model: 'b' }), 'a/b');
});

// ---------- settings proposal ----------
test('proposal: pi-subagents agentOverrides shape (model + thinking only) and diff against live settings', () => {
  const r = resolveAgents(agents, routing, REG);
  const live = { subagents: { agentOverrides: { coder: { model: 'ps/ms', thinking: 'high' }, scout: { model: 'old/x' } } } };
  const p = buildSettingsProposal(r, { liveSettings: live });
  assert.deepEqual(Object.keys(p.proposal), ['subagents']);
  assert.deepEqual(Object.keys(p.proposal.subagents), ['agentOverrides']);
  for (const o of Object.values(p.proposal.subagents.agentOverrides)) assert.deepEqual(Object.keys(o).sort(), ['model', 'thinking']);
  assert.deepEqual(p.proposal.subagents.agentOverrides.coder, { model: 'pd/md', thinking: 'high' });
  assert.equal(p.diff.find(d => d.agent === 'coder').change, 'update');
  assert.equal(p.diff.find(d => d.agent === 'scout').change, 'update');
  assert.equal(p.diff.find(d => d.agent === 'visual').change, 'add');
  const none = buildSettingsProposal(resolveAgents(agents, routing, { version: 1, backends: {} }));
  assert.deepEqual(none.proposal.subagents.agentOverrides, {});
  assert.equal(none.notes.length, agents.length);
});

// ---------- normalizer ----------
test('normalize: repo-relative kept, in-repo absolute rewritten, outside absolute dropped explicitly', () => {
  const repo = 'D:\\work\\repo';
  assert.deepEqual(classifyPath('src\\a.js', repo), { kind: 'relative', path: 'src/a.js' });
  assert.deepEqual(classifyPath('D:\\work\\repo\\src\\a.js', repo), { kind: 'inside', path: 'src/a.js' });
  assert.equal(classifyPath('C:\\Users\\someone\\x.log', repo).kind, 'outside');
  const md = '# Context Pack\n## task\nt\n## goal\ng\n## constraints\n## relevant_files\n- `D:\\work\\repo\\src\\a.js` (lines 1-2) — x\n- `src/a.js`\n- `C:\\Users\\someone\\x.log`\n## observed_errors\n```\nError at D:\\work\\repo\\src\\a.js:3 and C:\\Users\\someone\\node.exe\n```\n## expected_output\ne\n';
  const n = normalizeContextPack(md, { repoRoot: repo, capability: 'strong-code', producedBy: 'scout@test' });
  assert.deepEqual(n.errors, []);
  assert.deepEqual(n.pack.relevant_files, [{ path: 'src/a.js', lines: '1-2', reason: 'x' }]);
  assert.deepEqual(n.report.dropped, [{ field: 'relevant_files', path: 'C:/Users/someone/x.log' }]);
  assert.ok(n.report.external.includes('C:/Users/someone/node.exe'));
  assert.match(n.pack.observed_errors[0], /Error at src\/a\.js:3 and C:\\Users\\someone\\node\.exe/);
  assert.ok(n.pack.constraints.some(c => c.startsWith('unknown: 1 path')));
  assert.match(n.markdown, /^# Context Pack/);
  assert.equal(relativizeText('see D:\\work\\repo\\x\\y.js', repo).text, 'see x/y.js');
});

test('normalize: fills goal/expected_output defaults and reports validation errors instead of throwing', () => {
  const n = normalizeContextPack({ task: 't', relevant_files: [{ path: 'a.js' }] }, { repoRoot: 'D:\\r', task: 't' });
  assert.deepEqual(n.errors, []);
  assert.equal(n.pack.goal, 't');
  const empty = normalizeContextPack({ task: 't', relevant_files: [] }, { repoRoot: 'D:\\r' });
  assert.ok(empty.errors.some(e => e.includes('at least one')));
  assert.equal(empty.markdown, null);
});

// ---------- escalation ----------
test('escalation: primary failure -> fallback[0]; previous_attempts appended; bounded by maxAttempts', async () => {
  const pack = { previous_attempts: [] }; const trace = [];
  const seen = [];
  const r = await withEscalation({ routing, registry: REG, capability: 'strong-code', agent: 'coder', pack, trace, maxAttempts: 2,
    fn: async c => { seen.push(c.backend); return c.backend === 'devin' ? { ok: false, reason: 'provider 500' } : { ok: true, reason: 'fine' }; } });
  assert.equal(r.ok, true); assert.equal(r.escalated, true); assert.equal(r.attempts, 2);
  assert.deepEqual(seen, ['devin', 'qoder']);
  assert.equal(pack.previous_attempts.length, 1);
  assert.match(pack.previous_attempts[0].summary, /backend devin \(pd\/md:high\) attempt 1/);
  assert.equal(pack.previous_attempts[0].outcome, 'provider 500');
  assert.deepEqual(trace.map(t => [t.backend, t.ok]), [['devin', false], ['qoder', true]]);
});

test('escalation: exhausted after maxAttempts; escalation candidate reported; thrown errors are attempts too', async () => {
  const pack = {}; const trace = []; let calls = 0;
  const r = await withEscalation({ routing, registry: REG, capability: 'cheap-code', agent: 'scout', pack, trace, maxAttempts: 2,
    fn: async () => { calls++; throw new Error('boom'); } });
  assert.equal(r.ok, false); assert.equal(calls, 2); assert.equal(r.exhausted, false);
  assert.deepEqual(r.escalationCandidate, { backend: 'local', modelId: 'pl/ml:off' });
  assert.equal(pack.previous_attempts.length, 2);
  const single = await withEscalation({ routing, registry: { version: 1, backends: { devin: REG.backends.devin } }, capability: 'deep-review', agent: 'reviewer', pack: {}, trace: [], maxAttempts: 5, fn: async () => ({ ok: false, reason: 'no' }) });
  assert.equal(single.attempts, 1); assert.equal(single.exhausted, true); assert.equal(single.escalationCandidate, null);
});

test('loop prevention: identical modelId on two backends is invoked once; no attempt exceeds the chain', async () => {
  const dup = { version: 1, backends: { sol: { provider: 'p', model: 'm' }, codex: { provider: 'p', model: 'm' } } };
  let calls = 0;
  const r = await withEscalation({ routing, registry: dup, capability: 'strong-code', agent: 'coder', pack: {}, trace: [], maxAttempts: 10, fn: async () => { calls++; return { ok: false, reason: 'x' }; } });
  assert.equal(calls, 1); assert.equal(r.ok, false);
  await assert.rejects(() => withEscalation({ routing, registry: { version: 1, backends: {} }, capability: 'strong-code', agent: 'coder', pack: {}, trace: [], fn: async () => ({ ok: true }) }), /no bound model/);
});

// ---------- fixture E2E (scripted invoker) ----------
function freshFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ludi-e2e-'));
  cpSync(join(kit, 'tests/fixtures/math-repo'), dir, { recursive: true });
  return dir;
}
const SCOUT_OUT = repo => `# Context Pack\n\n## task\nFix average()\n\n## goal\nAll tests in test/math.test.js pass.\n\n## constraints\n- Only touch src/math.js\n\n## relevant_files\n- \`${repo}\\src\\math.js\` (lines 8-11) — average divides by length + 1\n- \`test/math.test.js\` — failing expectation\n\n## observed_errors\n\`\`\`\nactual: 2, expected: 3\n\`\`\`\n\n## test_commands\n- \`npm test\`\n\n## expected_output\nDiff limited to src/math.js; npm test passes.\n`;
const GOOD_FIX = `=== FILE: src/math.js ===\nexport function sum(values) {\n  let total = 0;\n  for (const v of values) total += v;\n  return total;\n}\n\nexport function average(values) {\n  if (values.length === 0) return 0;\n  return sum(values) / values.length;\n}\n=== END ===`;
const BAD_FIX = `=== FILE: src/math.js ===\nexport function sum(values) { return values.reduce((a, b) => a + b, 0); }\nexport function average(values) { return values.length === 0 ? 0 : sum(values) / (values.length + 2); }\n=== END ===`;

test('E2E: task -> scout -> Context Pack (normalized) -> coder -> tests pass; selection observable', async () => {
  const repo = freshFixture();
  assert.equal(runTests(repo, 'npm test').ok, false, 'fixture must start red');
  const calls = [];
  const invoke = createScriptedInvoker({ 'pq/mq:low': SCOUT_OUT(repo), 'pd/md:high': GOOD_FIX }, calls);
  const s = await runPipeline({ repoRoot: repo, task: 'Fix the failing average test', routing, registry: REG, agents, invoke, outDir: join(repo, '.pipeline-out') });
  assert.equal(s.outcome, 'success');
  assert.equal(s.escalated, false);
  assert.deepEqual(s.applied, ['src/math.js']);
  assert.deepEqual(s.contextPackFiles, ['src/math.js', 'test/math.test.js']); // absolute in-repo path normalized
  assert.deepEqual(s.steps.map(x => [x.step, x.agent, x.capability, x.backend, x.modelId, x.ok]), [
    ['scout', 'scout', 'cheap-code', 'qoder', 'pq/mq:low', true],
    ['coder', 'coder', 'strong-code', 'devin', 'pd/md:high', true],
  ]);
  assert.deepEqual(calls.map(c => c.modelId), ['pq/mq:low', 'pd/md:high']);
  assert.ok(existsSync(join(repo, '.pipeline-out/context-pack.md')));
  assert.ok(existsSync(join(repo, '.pipeline-out/coder.input.devin.md')));
  assert.ok(existsSync(join(repo, '.pipeline-out/trace.json')));
  assert.equal(runTests(repo, 'npm test').ok, true);
  assert.match(readFileSync(join(repo, '.pipeline-out/context-pack.md'), 'utf8'), /produced_by|## task/);
});

test('E2E: coder primary produces a failing patch -> escalates to fallback -> success; attempts recorded in pack', async () => {
  const repo = freshFixture();
  const calls = [];
  const invoke = createScriptedInvoker({ 'pq/mq:low': [SCOUT_OUT(repo), GOOD_FIX], 'pd/md:high': BAD_FIX }, calls);
  const s = await runPipeline({ repoRoot: repo, task: 'Fix average', routing, registry: REG, agents, invoke, outDir: join(repo, '.pipeline-out') });
  assert.equal(s.outcome, 'success'); assert.equal(s.escalated, true); assert.equal(s.attempts, 2);
  assert.deepEqual(calls.map(c => c.modelId), ['pq/mq:low', 'pd/md:high', 'pq/mq:low']);
  const pack = readFileSync(join(repo, '.pipeline-out/context-pack.md'), 'utf8');
  assert.match(pack, /## previous_attempts\n- coder on backend devin \(pd\/md:high\) attempt 1 — outcome: tests failed/);
  // the coder input for the fallback attempt carried the failure forward
  assert.match(readFileSync(join(repo, '.pipeline-out/coder.input.qoder.md'), 'utf8'), /previous_attempts/);
});

test('E2E: all coder attempts fail -> outcome exhausted (2 candidates, maxAttempts 2), repo edits confined to relevant_files', async () => {
  const repo = freshFixture();
  const invoke = createScriptedInvoker({ 'pq/mq:low': SCOUT_OUT(repo), '*': BAD_FIX + `\n=== FILE: package.json ===\n{}\n=== END ===` });
  const s = await runPipeline({ repoRoot: repo, task: 'Fix average', routing, registry: REG, agents, invoke, outDir: join(repo, '.pipeline-out') });
  assert.equal(s.outcome, 'escalation-candidate'); assert.equal(s.attempts, 2);
  assert.deepEqual(s.escalationCandidate, { backend: 'sol', modelId: 'ps/ms:high' });
  assert.equal(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).name, 'fixture-math-repo', 'package.json must not be overwritten');
});

test('E2E: scout returns garbage -> scout escalates; --pack path bypasses scout', async () => {
  const repo = freshFixture();
  const calls = [];
  const invoke = createScriptedInvoker({ 'pq/mq:low': 'I could not find anything.', 'pc/mc:low': SCOUT_OUT(repo), 'pd/md:high': GOOD_FIX }, calls);
  const s = await runPipeline({ repoRoot: repo, task: 'Fix average', routing, registry: REG, agents, invoke, outDir: join(repo, '.pipeline-out') });
  assert.equal(s.outcome, 'success');
  assert.deepEqual(s.steps.filter(x => x.step === 'scout').map(x => [x.backend, x.ok]), [['qoder', false], ['cheap', true]]);
  const repo2 = freshFixture();
  const packPath = join(repo2, 'pack.md'); writeFileSync(packPath, SCOUT_OUT(repo2));
  const s2 = await runPipeline({ repoRoot: repo2, task: 'x', routing, registry: REG, agents, invoke: createScriptedInvoker({ 'pd/md:high': GOOD_FIX }), outDir: join(repo2, '.out'), packPath });
  assert.equal(s2.outcome, 'success'); assert.equal(s2.steps.length, 1);
});

test('E2E greenfield: scout marks (new) files; coder may create only those; nested test dir created', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ludi-green-'));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'g', private: true, type: 'module', scripts: { test: 'node --test test/greet.test.js' } }));
  const scoutOut = '## task\nAdd greet\n## goal\ngreet works\n## constraints\n## discovery\npartial — only package.json exists\n## relevant_files\n- `package.json` — test script\n- `src/greet.js` — (new) module\n- `test/greet.test.js` — (new) tests\n## expected_output\nnew files + passing tests\n';
  const coderOut = '=== FILE: src/greet.js ===\nexport const greet = n => `Hello, ${n}!`;\n=== END ===\n=== FILE: test/greet.test.js ===\nimport test from "node:test"; import assert from "node:assert/strict"; import { greet } from "../src/greet.js";\ntest("greet", () => assert.equal(greet("A"), "Hello, A!"));\n=== END ===\n=== FILE: docs/evil.md ===\nnope\n=== END ===';
  const s = await runPipeline({ repoRoot: repo, task: 'Add greet', routing, registry: REG, agents, invoke: createScriptedInvoker({ 'pq/mq:low': scoutOut, 'pd/md:high': coderOut }), outDir: join(repo, '.out') });
  assert.equal(s.outcome, 'success');
  assert.deepEqual(s.applied, ['src/greet.js', 'test/greet.test.js']);
  assert.ok(!existsSync(join(repo, 'docs/evil.md')));
  const pack = readFileSync(join(repo, '.out/context-pack.md'), 'utf8');
  assert.match(pack, /## discovery\npartial/);
  assert.match(pack, /`src\/greet.js` — \(new\) module/);
});

test('parseFileBlocks handles CRLF and multiple blocks', () => {
  const b = parseFileBlocks('=== FILE: a.js ===\r\nx\r\n=== END ===\r\n=== FILE: b/c.js ===\ny\n=== END ===');
  assert.deepEqual(b, [{ path: 'a.js', content: 'x' }, { path: 'b/c.js', content: 'y' }]);
});
