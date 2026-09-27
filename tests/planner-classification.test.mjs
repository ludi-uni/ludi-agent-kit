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
  'Design an evolution engine: produce generation → evaluate → commit generation → checkpoint; monitor the trend of failures with a Fast Screen.',
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

test('long architecture briefs do not turn transaction commits or screening into unrelated scouts', () => {
  const req = `Design and implement a new evolution system.
Persist state: commit generation → checkpoint.
Mutation: trend strategies.
Progressive evaluation: Fast Screen → Full Backtest.
Do not introduce a distributed system yet. Do not implement live trading.
First design a task plan, then implement it.`;
  const c = classifyRequest(req);
  assert.equal(c.history, false);
  assert.equal(c.ui, false);
  assert.equal(c.staged, false);
  assert.equal(c.implement, true);
  assert.deepEqual(planRules(req, { agents }).tasks.map(t => t.agent), ['scout', 'coder', 'tester', 'reviewer']);
});

test('out-of-scope Web UI does not create a visual check or gate the review', () => {
  const req = `Implement a CLI and test it.
# 17. 実装しないもの
以下はスコープ外です。
* Web UI
* browser web page
先回りして作らないでください。
# 18. Acceptance Criteria
CLI runs and tests pass.`;
  const p = planRules(req, { agents });
  assert.equal(classifyRequest(req).visual, false);
  assert.equal(classifyRequest(req).browser, false);
  assert.equal(classifyRequest(req).ui, false);
  assert.deepEqual(p.tasks.map(t => t.agent), ['scout', 'coder', 'tester', 'reviewer']);
  assert.deepEqual(p.tasks.at(-1).dependencies, ['t3']);
  assert.equal(classifyRequest(req + '\n# 19. Visual verification\nInspect the UI screenshot').visual, true);
});

test('日本語の設計ブリーフでも対象外機能の否定は実装全体の保留と扱わない', () => {
  const req = `まず設計とTask decompositionを行い、その計画に基づいて実装へ進む。
最後にcommitされた世代から再開する。戦略の傾向を分析する。
初期段階では分散化まで導入しない。実売買は先回りして実装しない。`;
  const c = classifyRequest(req);
  assert.equal(c.history, false);
  assert.equal(c.staged, false);
  assert.equal(c.implement, true);
  assert.equal(scouts(req), 1);
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

test('staged: bare EN/JA implementation prohibitions gate the plan to investigation-only', () => {
  for (const req of [
    'Do not implement the OAuth flow, just investigate',
    'Do not implement the OAuth flow.',
    'この件は実装しない',
    '承認されるまでは実装しないでください',
    'レビューが完了するまでは実装しないで',
    "Don't implement the sync engine for now; just research the options",
  ]) {
    const c = classifyRequest(req);
    assert.equal(c.staged, true, `staged: ${req}`);
    assert.equal(c.implement, false, `implement suppressed: ${req}`);
    const plannedAgents = planRules(req, { agents }).tasks.map(t => t.agent);
    assert.ok(plannedAgents.length >= 1 && plannedAgents.every(a => a === 'scout'), `scout-only, got ${JSON.stringify(plannedAgents)} for: ${req}`);
  }
});

test('not staged: a feature-level deferral inside an implement brief is not a stage hold', () => {
  for (const req of ['実売買は先回りして実装しない', '実装を進めてください。ただし実売買は先回りして実装しないでください', 'Do not implement live trading. Implement the CLI instead.']) {
    const c = classifyRequest(req);
    assert.equal(c.staged, false, `not staged: ${req}`);
    assert.equal(c.implement, true, `implement kept: ${req}`);
  }
});

test('out-of-scope section content does not drive staged, implement or history classification', () => {
  const req = 'Implement the CLI.\n# Out of scope\n- Do not implement live trading until v2.\n- See the commit history for the old trading engine.';
  const c = classifyRequest(req);
  assert.equal(c.staged, false);
  assert.equal(c.implement, true);
  assert.equal(c.history, false);
  assert.deepEqual(planRules(req, { agents }).tasks.map(t => t.agent), ['scout', 'coder', 'tester', 'reviewer']);
});
