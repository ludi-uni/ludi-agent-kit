// Planner: high-level request -> task specs. Two strategies, same output shape:
//   rules - deterministic keyword template (no model call; default, used by dry-run)
//   model - the orchestrator agent returns a JSON plan; invalid output falls back to rules
import { withEscalation } from '../pipeline.mjs';
import { routeTask, workerAgents, ORCHESTRATOR_AGENT } from './router.mjs';
import { findCycle } from './task-store.mjs';

const RE = {
  implement: /\b(implement|fix|add|create|build|refactor|update|change|migrate|write|support)\b|進め|実装|修正|追加|作成|対応|改善|変更|移行|作る/i,
  review: /\b(review|audit)\b|レビュー|監査/i,
  investigate: /\b(investigate|explain|analy[sz]e|research|survey|find out)\b|調査|説明|分析|調べ/i,
  visual: /\b(screenshot|visual|ui|image|animation|video|render(ing)?)\b|画面|見た目|画像|アニメ|動画|描画/i,
  browser: /\b(browser|web ?page|localhost|url)\b|ブラウザ|webページ|ウェブ/i,
  history: /\b(commit history|git log|past commits|previous commits|commit(s)? histor\w*|changelog|previous changes)\b|コミット履歴|変更履歴|過去のコミット/i,
  // ASCII words need \b on both sides ("build", "guide", "linux", "requires" must
  // not match); Japanese has no word boundary, so 画面/好み stand alone.
  ui: /\b(ui|ux|interface|screen|design|layout|preference)\b|画面|好み/i,
};

// Context-aware history detection: bare "コミット"/"commit" alone is not a history
// investigation ("このコミットを修正して", "add a pre-commit hook" are single-commit
// or tooling work). It is one only when combined with ANALYSIS context (infer
// preferences / style / patterns / trends). Everyday words ("from", "instructions",
// "から") are deliberately NOT context.
const HISTORY_CONTEXT = {
  ja: /コミット(?!を(修正|直し|適用|打ち|作|追加|戻|取り消))/i,
  jaContext: /好み|推測|推定|傾向|履歴|分析|スタイル|方針|パターン/i,
  en: /(?<![\w-])commits?\b/i, // excludes "pre-commit", "post-commit"
  enContext: /\b(infer|guess|preferences?|style|patterns?|history|past|previous|trends?|analy[sz]e|author'?s?)\b/i,
};

function detectHistory(request) {
  if (RE.history.test(request)) return true;
  // Japanese: コミット + analysis/preference context, but not コミットを修正/fix.
  if (HISTORY_CONTEXT.ja.test(request) && HISTORY_CONTEXT.jaContext.test(request)) return true;
  // English: commit(s) + analysis/preference context.
  if (HISTORY_CONTEXT.en.test(request) && HISTORY_CONTEXT.enContext.test(request)) return true;
  return false;
}

// Explicit stage gating: "まずPhase 0だけを開始", "Phase 0の調査が終わるまでは実装を
// 始めない", "start only phase 0", "don't implement until the investigation is
// done". The user authorized ONE stage now, so keywords belonging to later phases
// (実装, fix, browser check, review) must not spawn implement/verify/review tasks.
const STAGED = {
  // A numbered phase explicitly narrowed with だけ/のみ/only.
  phaseOnly: /(phase|stage|step|フェーズ|段階)\s*\d+\s*(だけ|のみ|only)|\bonly\b[^.\n]{0,15}\b(phase|stage|step)\s*\d+/i,
  // Investigation/research only.
  invOnly: /(調査|分析|investigat\w*|research|analysis)\s*(だけ|のみ)|\b(?:investigat\w*|research|analysis)\b[^.\n]{0,20}\bonly\b|\bonly\b[^.\n]{0,20}\b(?:investigat\w*|research|analysis)\b/i,
  // "まず〜だけ/のみ" or "〜だけ/のみを開始・着手" — one stage authorized now. On its
  // own this is ambiguous ("まずこれだけ直して" is a scoped fix), so it counts only
  // when a phase/investigation marker is present too (see isStagedScope).
  firstOnly: /まず[^。\n]{0,60}?(だけ|のみ)|(だけ|のみ)(?:を|の)(?:開始|着手|実行|進め)/i,
  phaseOrInv: /phase|stage|step|フェーズ|段階|調査|分析|investigat|research/i,
  // An explicit hold on implementation: "〜までは実装を始めない", "実装はまだ",
  // "do not implement until ...", "hold off on implementation".
  hold: /までは?[^。\n]{0,60}?(始めない|しない|やめ|待)|実装(を|は|への)?(始めない|しない|着手しない|入らない|まだ|後で|待って)|\b(?:do not|don'?t|not yet|hold off)\b[^.\n]{0,60}\b(?:implement\w*|cod\w*|build|chang\w*|develop\w*|modif\w*)\b|\bwait\b[^.\n]{0,40}\buntil\b[^.\n]{0,40}\b(?:implement\w*|chang\w*|build)\b|\b(?:implement\w*|development|coding)\b[^.\n]{0,40}\buntil\b/i,
};

function isStagedScope(request) {
  if (STAGED.hold.test(request) || STAGED.phaseOnly.test(request) || STAGED.invOnly.test(request)) return true;
  return STAGED.firstOnly.test(request) && STAGED.phaseOrInv.test(request);
}

export function classifyRequest(request) {
  const has = k => RE[k].test(request);
  const staged = isStagedScope(request);
  const implement = !staged && (has('implement') || (!has('review') && !has('investigate')));
  return { implement, review: !staged && (has('review') || implement), visual: !staged && has('visual'), browser: !staged && has('browser'), history: detectHistory(request), ui: has('ui'), staged };
}

/**
 * A request that mixes several independent investigation concerns (e.g. commit
 * history AND current-implementation analysis AND preference extraction) is too
 * big for one scout pass — it blows the turn budget. Split it into focused
 * sub-investigations plus a synthesis step so each subagent stays small.
 */
function splitInvestigation(request, c, add) {
  const concerns = [];
  if (c.history) concerns.push({ key: 'history', title: 'Analyze commit history for preferences', goal: `From the repository's commit history, extract the author's preferences and working style relevant to: ${request}` });
  if (c.ui || c.visual) concerns.push({ key: 'ui', title: 'Inspect current UI/UX implementation', goal: `Investigate the current UI/UX implementation relevant to: ${request}. Identify concrete files and patterns.` });
  // Only split when there are genuinely independent concerns; otherwise one scout.
  if (concerns.length < 2) return null;
  const ids = [];
  for (const con of concerns) {
    const id = add('scout', { kind: 'investigate', title: con.title, goal: con.goal, dependencies: [],
      acceptance: ['concrete evidence (files, commits, or patterns) is reported', 'findings are specific, not generic'] });
    if (id) ids.push(id);
  }
  const synth = add('scout', { kind: 'investigate', title: 'Synthesize implementation context', goal: `Combine the investigation results into a single implementation context for: ${request}`, dependencies: ids,
    acceptance: ['relevant files, constraints and test commands are identified', 'open questions are listed, or explicitly none'] });
  return synth ? [synth] : ids;
}

export function planRules(request, { agents, policy = null }) {
  const names = new Set(workerAgents(agents).map(a => a.meta.name));
  const c = classifyRequest(request);
  const tasks = [];
  const add = (agent, spec) => { if (!names.has(agent)) return null; const id = `t${tasks.length + 1}`; tasks.push({ id, agent, ...spec }); return id; };
  // Split a multi-concern investigation into focused sub-tasks + a synthesis step
  // so no single scout is overloaded (prevents turn-limit stalls on big repos).
  // Runs whenever the request mixes independent concerns, not only when the
  // 'investigate' keyword fired — an implement+history+ui request still needs it.
  const split = splitInvestigation(request, c, add);
  const base = split ?? (() => {
    const scout = add('scout', { kind: 'investigate', title: 'Investigate scope and context', goal: `Identify the files, constraints, open questions and test commands needed for: ${request}`, dependencies: [],
      acceptance: ['relevant files, constraints and test commands are identified', 'open questions are listed, or explicitly none'] });
    return scout ? [scout] : [];
  })();
  const impl = c.implement ? add('coder', { kind: 'implement', title: 'Implement the change', goal: `Implement the smallest sufficient change for: ${request}`, dependencies: base,
    acceptance: ['the requested change is implemented within the investigated constraints', 'the relevant tests were run and pass, or the failure is reported'] }) : null;
  const verify = policy?.verification?.require_tester !== false;
  const tested = impl && verify ? add('tester', { kind: 'verify', title: 'Run tests', goal: `Run the repository tests for: ${request}. Do not implement further changes unless a test command itself is misconfigured.`, dependencies: [impl],
    acceptance: ['the relevant tests were executed', 'pass or fail is reported with the command and output'] }) : null;
  const after = tested ? [tested] : impl ? [impl] : base;
  const checks = [];
  if (c.visual) checks.push(add('visual', { kind: 'verify', title: 'Verify visual result', goal: `Verify the visual outcome of: ${request}`, dependencies: after,
    acceptance: ['the visual result was inspected with concrete evidence'] }));
  if (c.browser) checks.push(add('browser', { kind: 'verify', title: 'Verify in browser', goal: `Verify the browser behavior of: ${request}`, dependencies: after,
    acceptance: ['the page behavior was exercised and observed'] }));
  if (c.review) add('reviewer', { kind: 'review', title: 'Review result and risks', goal: `Review the outcome of "${request}" for correctness, regressions and risk`, dependencies: [...after, ...checks.filter(Boolean)],
    acceptance: ['findings are listed by severity, or explicitly none', 'verified checks are separated from read-only observations'] });
  return { planner: 'rules', classification: c, tasks };
}

/** Validate task specs (from any planner or from agent-discovered work) and route them. */
export function validatePlan(specs, { agents, routing, policy, existingIds = [] }) {
  const errors = [];
  if (!Array.isArray(specs) || !specs.length) return { errors: ['plan: at least one task is required'], tasks: [] };
  const max = policy.limits.max_tasks;
  if (specs.length + existingIds.length > max) errors.push(`plan: ${specs.length + existingIds.length} tasks exceed limits.max_tasks=${max}`);
  const ids = new Set(existingIds);
  const tasks = [];
  for (const s of specs) {
    if (!s || typeof s.id !== 'string' || !s.id) { errors.push('plan: every task needs a string id'); continue; }
    if (ids.has(s.id)) errors.push(`plan: duplicate task id "${s.id}"`);
    ids.add(s.id);
    if (typeof s.title !== 'string' || typeof s.goal !== 'string' || !s.goal.trim()) errors.push(`plan: task "${s.id}" needs title and goal`);
    const r = routeTask(s, { agents, routing });
    if (r.error) { errors.push(`plan: ${r.error}`); continue; }
    tasks.push({ id: s.id, title: s.title, goal: s.goal, kind: s.kind, assignedAgent: r.agent, capability: r.capability,
      dependencies: Array.isArray(s.dependencies) ? s.dependencies : [], acceptance: Array.isArray(s.acceptance) ? s.acceptance.map(String) : [], outputs: Array.isArray(s.outputs) ? s.outputs.map(String) : [] });
  }
  for (const t of tasks) for (const d of t.dependencies) if (!ids.has(d)) errors.push(`plan: task "${t.id}" depends on unknown task "${d}"`);
  const cycle = findCycle(tasks);
  if (cycle) errors.push(`plan: dependency cycle ${cycle.join(' -> ')}`);
  return { errors, tasks };
}

/** Fenced blocks paired line by line, so an earlier ```bash block cannot swallow a later ```json fence. */
export function fencedBlocks(text) {
  const blocks = [];
  let open = null;
  for (const line of String(text).split(/\r?\n/)) {
    const fence = /^\s*```\s*([\w-]*)\s*$/.exec(line);
    if (open) { if (fence && !fence[1]) { blocks.push(open); open = null; } else open.body.push(line); }
    else if (fence) open = { lang: fence[1].toLowerCase(), body: [] };
  }
  return blocks.map(b => ({ lang: b.lang, content: b.body.join('\n') }));
}

export function parseJsonBlock(text) {
  const blocks = fencedBlocks(text).reverse();
  for (const b of [...blocks.filter(b => b.lang === 'json'), ...blocks.filter(b => !b.lang)]) { try { return JSON.parse(b.content); } catch { /* try next */ } }
  try { return JSON.parse(String(text).trim()); } catch { return null; }
}

export function plannerPrompt(request, { agents, routing, policy }) {
  const roster = workerAgents(agents).map(a => `- ${a.meta.name} (capability ${a.meta.capability}): ${a.meta.description}`).join('\n');
  const caps = Object.entries(routing.capabilities).map(([k, v]) => `- ${k}: ${v.description ?? ''}`).join('\n');
  return [
    `Request: ${request}`, '', '## Agents', roster, '', '## Capabilities', caps, '',
    `Decompose the request into at most ${policy.limits.max_tasks} tasks. Reply with one fenced json block:`,
    '{"tasks":[{"id":"t1","title":"...","goal":"...","agent":"<agent>","kind":"investigate|implement|verify|review","dependencies":[],"acceptance":["..."]}]}',
    'Use only the agents listed. Every task needs verifiable acceptance criteria. Do not ask the user anything.',
  ].join('\n');
}

export async function planWithModel(request, { agents, routing, registry, policy, invoke, cwd, trace = [], health = null }) {
  const orch = agents.find(a => a.meta.name === ORCHESTRATOR_AGENT);
  const fallback = reason => ({ ...planRules(request, { agents, policy }), fallbackFrom: 'model', fallbackReason: reason });
  if (!orch) return fallback('orchestrator agent not found');
  let r;
  try {
    r = await withEscalation({ routing, registry, capability: orch.meta.capability, agent: ORCHESTRATOR_AGENT, pack: { previous_attempts: [] }, maxAttempts: policy.limits.model_attempts_per_task, trace, skip: health?.skip, onFailure: health?.report,
      fn: async c => { const x = await invoke({ ...c, systemPrompt: orch.body, prompt: plannerPrompt(request, { agents, routing, policy }), cwd }); return x.ok ? { ok: true, reason: 'plan received', text: x.text } : { ok: false, reason: x.error ?? 'invoke failed' }; } });
  } catch (e) { return fallback(e.message); }
  if (!r.ok) return fallback(r.last?.reason ?? 'planner model failed');
  const json = parseJsonBlock(r.result.text);
  if (!json?.tasks) return fallback('planner output had no JSON tasks');
  const { errors } = validatePlan(json.tasks, { agents, routing, policy });
  if (errors.length) return fallback(errors.join('; '));
  return { planner: 'model', modelId: r.candidate.modelId, tasks: json.tasks };
}
