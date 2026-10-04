// Shared dirty-worktree approval policy for every implementation boundary.
import { createHash } from 'node:crypto';

export const DIRTY_GATE_TYPE = 'worktree-dirty';

/**
 * Dirty-worktree safety gate. Only PRE-EXISTING, UNRELATED changes gate an
 * implementation: paths this run's agents already changed (`ownedPaths`) are
 * excluded, and a non-git workspace (file inventory) is never treated as dirty.
 * The decision key is derived from the set of unrelated paths so an answered
 * decision for the same condition is recognised across retries / rework tasks.
 * @returns {{ gate: false } | { gate: true, action: 'ask'|'proceed'|'abort', paths: string[], key: string, decision?: object }}
 */
export function evaluateDirtyGate({ before, ownedPaths = [], decisions = [] }) {
  if (before?.source !== 'git') return { gate: false, reason: 'not a git workspace' };
  const owned = new Set(ownedPaths);
  const paths = Object.keys(before.entries ?? {}).filter(p => !owned.has(p)).sort();
  if (!paths.length) return { gate: false, reason: owned.size ? 'only agent-owned changes' : 'clean' };
  const digest = createHash('sha1').update(paths.join('\n')).digest('hex').slice(0, 12);
  const key = `${DIRTY_GATE_TYPE}:${digest}`;
  const answered = decisions.filter(d => d && (d.key === key || d.decisionType === DIRTY_GATE_TYPE && d.key === key));
  const optionOf = d => d.optionId ?? (/^proceed/i.test(String(d.choice ?? '')) ? 'proceed' : /^abort/i.test(String(d.choice ?? '')) ? 'abort' : null);
  const last = answered.map(optionOf).filter(Boolean).at(-1);
  if (last === 'proceed') return { gate: true, action: 'proceed', paths, key };
  if (last === 'abort') return { gate: true, action: 'abort', paths, key };
  return {
    gate: true, action: 'ask', paths, key,
    decision: {
      key, decisionType: DIRTY_GATE_TYPE,
      question: `Workspace has ${paths.length} pre-existing uncommitted change(s) not made by this run (${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ', …' : ''}). Proceed with implementation anyway?`,
      flags: ['destructive_action'],
      options: [
        { id: 'proceed', summary: 'proceed; existing changes are unrelated or acceptable', reversible: false, flags: ['destructive_action'] },
        { id: 'abort', summary: 'do not implement; keep the dirty tree untouched', reversible: true },
      ],
    },
  };
}
