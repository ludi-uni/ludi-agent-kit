// Backend health for one run, and a short-lived cross-run mark when usage is exhausted.
// There is no permanent blacklist: every record has expiresAt. Unknown durations use the policy TTL.
import { DEFAULT_POLICY } from './policy.mjs';

export function classifyBackendFailure(reason) {
  const t = String(reason ?? '').toLowerCase();
  if (t.includes('usage limit has been reached') || t.includes('usage limit') || t.includes('insufficient_quota')) return 'usage_exhausted';
  if (t.includes('rate limit') || t.includes('too many requests')) return 'rate_limited';
  if (t.includes('temporarily unavailable') || t.includes('service unavailable') || t.includes('overloaded')) return 'temporarily_unavailable';
  return null;
}

export function healthTtlMs(policy, state) {
  const h = policy?.backend_health ?? DEFAULT_POLICY.backend_health;
  if (state === 'usage_exhausted') return h.usage_exhausted_ttl_hours * 3600 * 1000;
  if (state === 'rate_limited') return h.rate_limited_ttl_minutes * 60 * 1000;
  return h.unavailable_ttl_minutes * 60 * 1000;
}

/**
 * skip/report hooks for withEscalation. bindRun(id) before the first model call.
 * Without a session, health lives in this object for the current process only.
 */
export function createHealthMonitor({ session = null, policy, now = () => new Date().toISOString() } = {}) {
  let runId = null;
  const local = [];
  return {
    bindRun(id) { runId = id; },
    skip(candidate) {
      if (!runId) return null;
      const at = now();
      if (session) {
        const row = session.activeHealth({ provider: candidate.provider, model: candidate.model, runId, now: at });
        return row ? `${row.state} until ${row.expiresAt}` : null;
      }
      const row = local.find(r => r.provider === candidate.provider && r.model === candidate.model && r.expiresAt > at && (r.runId === runId || r.runId === ''));
      return row ? `${row.state} until ${row.expiresAt}` : null;
    },
    report(candidate, reason) {
      const state = classifyBackendFailure(reason);
      if (!state || !runId) return null;
      const ttlMs = healthTtlMs(policy, state);
      const at = now();
      if (session) return session.recordHealth({ provider: candidate.provider, model: candidate.model, state, reason, runId, ttlMs, now: at });
      const expiresAt = new Date(Date.parse(at) + ttlMs).toISOString();
      const rowRun = state === 'usage_exhausted' ? '' : runId;
      const row = { provider: candidate.provider, model: candidate.model, state, reason: String(reason).slice(0, 500), detectedAt: at, retryAfter: expiresAt, expiresAt, runId: rowRun };
      const i = local.findIndex(r => r.provider === row.provider && r.model === row.model && r.runId === rowRun);
      if (i >= 0) local[i] = row; else local.push(row);
      return row;
    },
  };
}
