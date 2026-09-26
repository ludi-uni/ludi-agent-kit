// Planner request classification: history / UI concerns must not fire on everyday
// words (build, guide, linux, requires, pre-commit, から, from, instructions) and
// splitInvestigation must only run for genuinely multi-concern requests.
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
const scouts = req => planRules(req, { agents }).tasks.filter(t => t.agent === 'scout').length;
const isSplit = req => scouts(req) > 1;

const SPLIT = [
  'コミットから好みを推測してUXを改善',
  'コミット履歴を分析してUIの好みを反映して',
  'Analyze past commits to infer my UI preferences',
  'Look at the commit history and infer my UX preferences, then apply them to the settings screen',
  'Infer preferences from previous commits and improve the layout',
];
const NO_SPLIT = [
  'このコミットを修正して',
  'このコミットを戻して',
  'Add a pre-commit hook',
  'Add a pre-commit hook from the template and build the docs',
  'build the docs',
  'update the guide',
  'fix Linux support',
  'Run the tests',
  'The module requires a rebuild on linux',
  'Follow the instructions from the README and fix the build',
  'READMEを英語から日本語に翻訳して、コミットメッセージも直して',
  'SELECT文のパフォーマンスを調べて',
  'Fix the failing average() test',
];

test('split: multi-concern history + UI requests produce >1 scout plus synthesis', () => {
  for (const req of SPLIT) {
    const c = classifyRequest(req);
    assert.equal(c.history, true, `history: ${req}`);
    assert.equal(c.ui || c.visual, true, `ui: ${req}`);
    assert.ok(isSplit(req), `expected split: ${req}`);
    const p = planRules(req, { agents });
    assert.ok(p.tasks.some(t => /Synthesize/.test(t.title)), `synthesis: ${req}`);
    assert.ok(p.tasks.length <= 8, `task count ${p.tasks.length} for: ${req}`);
  }
});

test('no split: single-commit fixes, tooling and everyday words stay one scout', () => {
  for (const req of NO_SPLIT) {
    assert.equal(scouts(req), 1, `expected exactly one scout for: ${req} -> ${JSON.stringify(classifyRequest(req))}`);
  }
});

test('negative: UI is not detected inside build/guide/linux/requires', () => {
  for (const req of ['build the docs', 'update the guide', 'fix Linux support', 'The module requires a rebuild', 'Debug the linux build', 'quick guide']) {
    assert.equal(classifyRequest(req).ui, false, req);
  }
});

test('positive: UI/UX as whole tokens and Japanese 画面/好み are detected', () => {
  for (const req of ['Improve the UI', 'UX review', 'Redesign the settings screen', '画面を見直す', '私の好みに合わせて']) {
    assert.equal(classifyRequest(req).ui, true, req);
  }
});

test('negative: history is not detected from pre-commit / from / instructions / から', () => {
  for (const req of ['Add a pre-commit hook', 'configure post-commit hooks', 'Follow the instructions from the docs', 'Commit the change', 'このコミットを修正して', 'READMEを英語から日本語に翻訳して、コミットメッセージも直して', 'コミットメッセージのフォーマットを指示どおりに直して']) {
    assert.equal(classifyRequest(req).history, false, req);
  }
});

test('positive: history is detected with analysis context', () => {
  for (const req of ['Analyze past commits to infer my UI preferences', 'コミットから好みを推測して', 'コミットの傾向を分析して', 'Look at the git log for style patterns', 'infer conventions from previous commits', 'Review the commit history for regressions']) {
    assert.equal(classifyRequest(req).history, true, req);
  }
});
