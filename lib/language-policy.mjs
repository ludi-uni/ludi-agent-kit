// Shared language policy appended to every agent's system prompt. One place, no
// per-agent duplication, no provider-specific handling — it applies identically to
// qoder/devin/openai-codex/freetoken because it is prepended at the prompt layer.
//
// Japanese is the DEFAULT, not a fixed mandate: an explicit user language request
// ("英語で", "in English", ...) wins. Machine-readable schema keys/enums
// (status/completed/failed/blocked, Context Pack ## field names, JSON keys) are
// never translated — only natural-language values are.

export const LANGUAGE_POLICY = `
## Response language

Default response language: Japanese.

Unless the user explicitly requests another language:
- Write all user-facing explanations, summaries, reports, decisions, and status messages in Japanese.
- Keep source code, identifiers, filenames, commands, stack traces, API names, and quoted external text in their original language where appropriate.
- Technical terms may remain in English when that is clearer, but explanations around them should be Japanese.
- Structured field names defined by schemas (e.g. "status", "summary", "completed", Context Pack "## task" / "## goal" section names) must not be translated — only their natural-language values are written in Japanese.
- NEVER translate, rename, or annotate section headings, JSON keys, enum values, or field names. A heading is exactly "## task", never "## 課題" or "## task Japanese". When in doubt, keep the exact ASCII identifier.
`.trim();

/** Agent system prompt with the shared language policy appended. */
export function withLanguagePolicy(body) {
  const b = String(body ?? '').trim();
  return b ? `${b}\n\n${LANGUAGE_POLICY}` : LANGUAGE_POLICY;
}
