// Browser capability: routing resolution, agent binding, wrapper command construction,
// action classification, failure normalization, and argv integrity (no shell mangling).
// These tests never launch a real browser; the opt-in real E2E is tests/e2e-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { resolveCapability, resolveAgents } from '../lib/resolve.mjs';
import { COMMANDS, ACTION_KINDS, classify, buildArgs, runBrowser, locateAgentBrowser } from '../adapters/pi/browser/agent-browser.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents, errors } = loadAgents(join(kit, 'agents'), routing);

const REG = { version: 1, backends: {
  sol:   { provider: 'ps', model: 'ms', thinking: 'high' },
  codex: { provider: 'px', model: 'mx', thinking: 'high' },
} };

// ---------- capability resolution ----------
test('browser capability resolves through routing like any other', () => {
  const r = resolveCapability(routing, REG, 'browser');
  assert.equal(r.capability, 'browser');
  assert.deepEqual(r.chain, ['sol', 'codex']);
  assert.deepEqual(r.candidates.map(c => c.modelId), ['ps/ms:high', 'px/mx:high']);
  assert.deepEqual(r.unbound, []);
});

test('browser agent binds to the browser capability and never names a model', () => {
  assert.deepEqual(errors, []);
  const browser = agents.find(a => a.meta.name === 'browser');
  assert.ok(browser, 'agents/browser.md must exist');
  assert.equal(browser.meta.capability, 'browser');
  assert.equal(browser.meta.model, undefined);
  assert.equal(browser.meta.provider, undefined);
  const resolved = resolveAgents(agents, routing, REG);
  assert.equal(resolved.browser.capability, 'browser');
  assert.equal(resolved.browser.candidates[0].backend, 'sol');
});

// ---------- command construction ----------
test('buildArgs produces the documented agent-browser argv', () => {
  assert.deepEqual(buildArgs('open', { url: 'https://example.com' }), ['open', 'https://example.com']);
  assert.deepEqual(buildArgs('navigate', { url: 'https://example.com' }), ['open', 'https://example.com']);
  assert.deepEqual(buildArgs('snapshot'), ['snapshot', '-i']);
  assert.deepEqual(buildArgs('snapshot', { interactive: false, compact: true, depth: 3 }), ['snapshot', '-c', '-d', '3']);
  assert.deepEqual(buildArgs('click', { ref: '@e2' }), ['click', '@e2']);
  assert.deepEqual(buildArgs('fill', { ref: '@e3', text: 'hello' }), ['fill', '@e3', 'hello']);
  assert.deepEqual(buildArgs('press', { key: 'Enter' }), ['press', 'Enter']);
  assert.deepEqual(buildArgs('getText', { ref: '@e1' }), ['get', 'text', '@e1']);
  assert.deepEqual(buildArgs('getValue', { ref: '@e3' }), ['get', 'value', '@e3']);
  assert.deepEqual(buildArgs('getUrl'), ['get', 'url']);
  assert.deepEqual(buildArgs('isVisible', { ref: '@e4' }), ['is', 'visible', '@e4']);
  assert.deepEqual(buildArgs('wait', { ms: 500 }), ['wait', '500']);
  assert.deepEqual(buildArgs('wait', { ref: '#done' }), ['wait', '#done']);
  assert.deepEqual(buildArgs('screenshot', { path: 'p.png', annotate: true }), ['screenshot', 'p.png', '--annotate']);
  assert.deepEqual(buildArgs('close'), ['close']);
});

test('unknown commands are rejected before spawn', () => {
  assert.throws(() => buildArgs('deleteEverything'), /unknown command/);
  assert.equal(classify('deleteEverything'), null);
});

// ---------- action classification (metadata for a future approval policy) ----------
test('every command has a safety kind and the kinds match the agreed tiers', () => {
  for (const [name, spec] of Object.entries(COMMANDS)) {
    assert.ok(ACTION_KINDS.includes(spec.kind), `${name} kind ${spec.kind}`);
  }
  for (const c of ['open', 'snapshot', 'getText', 'getValue', 'getUrl', 'getTitle', 'isVisible', 'isChecked', 'wait', 'screenshot']) {
    // open navigates (state change) but is trivially reversible -> low-risk, not read-only
    if (c === 'open') assert.equal(classify(c), 'low-risk');
    else assert.equal(classify(c), 'read-only', c);
  }
  for (const c of ['click', 'navigate', 'hover', 'scroll', 'close']) assert.equal(classify(c), 'low-risk', c);
  for (const c of ['fill', 'type', 'press', 'select', 'check', 'uncheck']) assert.equal(classify(c), 'write', c);
  for (const c of ['eval', 'submit']) assert.equal(classify(c), 'high-impact', c);
});

// ---------- argv integrity: no shell, values with spaces/quotes stay one arg ----------
test('argv round-trip: spaces, quotes and Windows paths survive without a shell', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ludi-ab-argv-'));
  const echo = join(dir, 'echo.mjs');
  writeFileSync(echo, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const env = { ...process.env, LUDI_AGENT_BROWSER_ENTRY: echo };
  const url = 'file:///D:/my folder/page "one".html';
  const r = await runBrowser('open', { url }, { env, session: 's1' });
  assert.equal(r.ok, true, r.error ?? r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), ['--session', 's1', 'open', url]);
});

// ---------- failure normalization ----------
test('nonzero exit becomes {ok:false,error} without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ludi-ab-fail-'));
  const fail = join(dir, 'fail.mjs');
  writeFileSync(fail, 'console.error("boom: no such ref"); process.exit(3)');
  const env = { ...process.env, LUDI_AGENT_BROWSER_ENTRY: fail };
  const r = await runBrowser('click', { ref: '@e99' }, { env });
  assert.equal(r.ok, false);
  assert.equal(r.status, 3);
  assert.match(r.error, /exit 3/);
  assert.match(r.stderr, /boom: no such ref/);
  assert.equal(r.kind, 'low-risk'); // classification survives failures
});

test('missing binary throws a clear install error', () => {
  const env = { ...process.env, PATH: '', Path: '', LUDI_AGENT_BROWSER_ENTRY: '', LUDI_AGENT_BROWSER_BIN: '' };
  assert.equal(locateAgentBrowser(env), null);
  assert.throws(() => runBrowser('snapshot', {}, { env }), /agent-browser not found/);
});

// ---------- real binary presence (informational; not a browser launch) ----------
test('installed agent-browser binary is locatable on this machine', () => {
  const located = locateAgentBrowser();
  assert.ok(located, 'agent-browser should be installed for the browser capability');
  assert.ok(['js', 'bin'].includes(located.kind));
});
