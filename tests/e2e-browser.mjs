// Opt-in real E2E for the browser capability: drives the *installed* agent-browser
// CLI against the local fixture page, snapshot -> ref action -> snapshot.
// Not part of `node --test`; it launches a real browser. Run:
//   node tests/e2e-browser.mjs
// Requires `agent-browser` on PATH (npm i -g agent-browser) and a local Chrome/Brave.
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { runBrowser, locateAgentBrowser } from '../adapters/pi/browser/agent-browser.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = pathToFileURL(join(kit, 'tests/fixtures/browser-page/index.html')).href;
const session = `ludi-e2e-${Date.now()}`;
const env = { ...process.env };

assert.ok(locateAgentBrowser(env), 'agent-browser binary not found; npm i -g agent-browser');

const steps = [];
const step = async (name, promise) => {
  const res = await promise;
  steps.push({ name, ok: res.ok, kind: res.kind, status: res.status, durationMs: res.durationMs });
  if (!res.ok) { console.log(JSON.stringify({ steps, failed: name, stderr: res.stderr, stdout: res.stdout, error: res.error }, null, 2)); process.exit(1); }
  return res;
};
const opt = { env, session, timeoutMs: 90000 };

try {
  // 1. open the local page
  await step('open', runBrowser('open', { url: fixture }, opt));

  // 2. snapshot -> interactive refs
  const snap1 = await step('snapshot', runBrowser('snapshot', {}, opt));
  const refs = [...snap1.stdout.matchAll(/@?e\d+/g)].map(m => m[0]);
  assert.ok(refs.length >= 2, `expected >=2 interactive refs, got: ${snap1.stdout.slice(0, 500)}`);

  // find the input ref (textbox) and the button ref from the snapshot text
  const refOf = re => { const m = snap1.stdout.match(re); return m ? '@' + m[1] : null; };
  const inputRef = refOf(/textbox[^\n]*ref=(e\d+)/i) ?? refOf(/input[^\n]*ref=(e\d+)/i);
  const buttonRef = refOf(/button[^\n]*ref=(e\d+)/i);
  assert.ok(inputRef, `no textbox ref in snapshot:\n${snap1.stdout.slice(0, 800)}`);
  assert.ok(buttonRef, `no button ref in snapshot:\n${snap1.stdout.slice(0, 800)}`);

  // 3. fill the input via its ref
  await step('fill', runBrowser('fill', { ref: inputRef, text: 'hello' }, opt));

  // 4. click the button via its ref
  await step('click', runBrowser('click', { ref: buttonRef }, opt));

  // 5. re-snapshot and read the result text
  const snap2 = await step('snapshot-after', runBrowser('snapshot', {}, opt));
  const resultRef = (snap2.stdout.match(/result[^\n]*ref=(e\d+)/i))?.[1];
  // result <p> is not interactive, so read it by selector if no ref; use get text on the id
  const textRes = resultRef
    ? await step('getText', runBrowser('getText', { ref: resultRef }, opt))
    : await step('getText-sel', runBrowser('getText', { ref: '#result' }, opt));
  assert.match(textRes.stdout, /hello hello|hello\s+hello/i, `expected greeting, got: ${textRes.stdout.slice(0, 300)}`);

  // 6. confirm the input kept the filled value
  const val = await step('getValue', runBrowser('getValue', { ref: inputRef }, opt));
  assert.match(val.stdout, /hello/);

  console.log(JSON.stringify({ outcome: 'success', fixture, session, steps }, null, 2));
} finally {
  await runBrowser('close', {}, opt);
}
console.log('PASS: real browser E2E');
