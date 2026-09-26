// Planner staged-scope gating: an explicit "Phase 0 だけを開始" / "調査が終わる
// までは実装を始めない" request authorizes ONE stage only. Keywords belonging to
// later phases (実装, fix, UI, browser check) must not spawn coder/tester/
// browser/visual/reviewer tasks. Ordinary implementation requests are unaffected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { classifyRequest, planRules } from '../lib/orchestrator/planner.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const agentsOf = req => planRules(req, { agents }).tasks.map(t => t.agent);

const STAGED = [
  // The pi-console style request: explicit staged start + an implementation hold,
  // while later-phase keywords (改善/実装/ブラウザ/UI) appear in the same request.
  'pi-consoleを改善してほしい。まずPhase 0だけを開始して。Phase 0の調査が終わるまでは、実装を始めないでください。Phase 1以降のUI修正やブラウザ確認はその後です',
  'まずPhase 0だけを開始して。調査が終わるまでは実装を始めないで',
  'Phase 0の調査だけをお願いします。実装はまだです',
  '調査だけして。実装はまだ',
  'まずフェーズ0のみを開始して',
  'Do not implement until the investigation is done',
  'Start only phase 0: investigate the planner. The fix, browser check and review come later',
];
const NOT_STAGED = [
  'Fix the failing average() test',
  'DOLL v2 Phase 2を進める',
  'このコミットを修正して',
  'まずこのコミットを修正して',
  'Update the settings screen UI and check it in the browser',
  'コミットや指示から僕の好みを推測して、このリポジトリを改善できますか',
];

test('staged: explicit phase/investigation-only requests produce investigation-only tasks', () => {
  for (const req of STAGED) {
    const c = classifyRequest(req);
    assert.equal(c.staged, true, `staged flag: ${req}`);
    assert.equal(c.implement, false, `implement suppressed: ${req}`);
    assert.equal(c.review, false, `review suppressed: ${req}`);
    assert.equal(c.visual, false, `visual suppressed: ${req}`);
    assert.equal(c.browser, false, `browser suppressed: ${req}`);
    const got = agentsOf(req);
    assert.ok(got.length >= 1, `at least one task: ${req}`);
    assert.ok(got.every(a => a === 'scout'), `investigation-only agents, got ${JSON.stringify(got)} for: ${req}`);
  }
});

test('staged: a single-scope request keeps one scout, no coder/tester/reviewer', () => {
  const p = planRules(STAGED[0], { agents });
  assert.deepEqual(p.tasks.map(t => t.agent), ['scout']);
  assert.match(p.tasks[0].goal, /pi-console/);
});

test('not staged: ordinary implementation and phase-progress requests unchanged', () => {
  for (const req of NOT_STAGED) {
    const c = classifyRequest(req);
    assert.equal(c.staged, false, `not staged: ${req}`);
    assert.equal(c.implement, true, `implement kept: ${req}`);
  }
  assert.deepEqual(agentsOf('Fix the failing average() test'), ['scout', 'coder', 'tester', 'reviewer']);
  assert.deepEqual(agentsOf('DOLL v2 Phase 2を進める'), ['scout', 'coder', 'tester', 'reviewer']);
  assert.deepEqual(agentsOf('Update the settings screen UI and check it in the browser'), ['scout', 'coder', 'tester', 'visual', 'browser', 'reviewer']);
});
