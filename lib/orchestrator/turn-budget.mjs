// Subagent execution budget: complexity classification, per-role initial turn
// budgets, and deterministic progress evaluation for bounded extension.
// Provider-agnostic — nothing here names a model or backend.

export const COMPLEXITIES = ['simple', 'normal', 'heavy', 'repo-history-heavy'];

const HEAVY_RE = /\b(git log|commit history|commit(s)? histor|across (the )?(repo|codebase)|multiple (directories|files|modules)|whole (repo|codebase)|all files|every file)\b|コミット履歴|履歴|横断|全体/i;
const HISTORY_RE = /\b(git|commit|history|changelog|blame|past changes|previous commits)\b|コミット|変更履歴|過去/i;
const MULTI_RE = /\b(and|&|plus|also|then combine|integrate|merge|compare|across)\b|かつ|と同時に|統合|比較|組み合わせ/i;

/**
 * Classify a task's investigation complexity from its goal/kind. Deterministic —
 * no model call. repo-history-heavy needs git/commit-history analysis; heavy needs
 * multi-area discovery+analysis; normal is a focused investigate; simple is trivial.
 */
export function classifyTaskComplexity(task) {
  const text = `${task?.title ?? ''} ${task?.goal ?? ''}`.toLowerCase();
  const deps = task?.dependencies?.length ?? 0;
  const history = HISTORY_RE.test(text);
  const heavy = HEAVY_RE.test(text) || MULTI_RE.test(text);
  if (history && (heavy || /ux|preference|ui|implement|design|pattern/i.test(text))) return 'repo-history-heavy';
  if (history) return 'repo-history-heavy';
  if (heavy || deps >= 2) return 'heavy';
  if (task?.kind === 'investigate' || task?.kind === 'review') return 'normal';
  return 'simple';
}

/**
 * Initial turn budget for a task = turn_budgets[role][complexity]
 *   -> turn_budgets[role].normal -> turn_budgets.default[complexity] -> max_turns.
 */
export function initialTurnBudget(agentRuntime, role, complexity) {
  const budgets = agentRuntime?.turn_budgets ?? {};
  const roleB = budgets[role] ?? budgets.default ?? {};
  const defB = budgets.default ?? {};
  return roleB[complexity] ?? roleB.normal ?? defB[complexity] ?? defB.normal ?? agentRuntime?.max_turns ?? 12;
}

/**
 * Deterministic progress score from a subagent's execution telemetry.
 * Positive score = meaningful progress worth extending. No LLM judgement.
 *   +2 per tool call, +3 per unique file inspected, +1 per successful command,
 *   -2 per repeated identical command, -4 for zero tool calls.
 */
export function progressScore(telemetry) {
  const toolCalls = telemetry?.toolCalls ?? 0;
  const uniqueFiles = telemetry?.uniqueFiles?.size ?? telemetry?.uniqueFilesInspected ?? 0;
  const commands = telemetry?.commands ?? [];
  const successful = telemetry?.successfulToolCalls ?? commands.length;
  const repeats = commands.length - new Set(commands).size;
  const score = toolCalls * 2 + uniqueFiles * 3 + successful * 1 - repeats * 2 + (toolCalls === 0 ? -4 : 0);
  const reasons = [];
  if (toolCalls === 0) reasons.push('no tool calls');
  if (uniqueFiles > 0) reasons.push(`${uniqueFiles} files inspected`);
  if (repeats > 1) reasons.push(`${repeats} repeated commands`);
  if (successful > 0) reasons.push(`${successful} commands run`);
  return { score, reasons, meaningful: toolCalls > 0 && (uniqueFiles > 0 || successful > 0 || repeats <= 1) };
}

/** True when a turn-limit hit should be treated as no-progress (global model failure). */
export function isNoProgressTimeout(telemetry) {
  return !progressScore(telemetry).meaningful;
}
