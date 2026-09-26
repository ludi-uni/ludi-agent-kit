// Phase 6 — calibration telemetry: aggregate run records into metrics, emit
// deterministic warnings, counterfactual comparisons, and a policy calibration
// proposal. Read-only w.r.t. policy/catalog/routing — proposals only.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const sha = o => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
const SEV = ['none', 'info', 'action', 'urgent'];

export function emptyTelemetry() {
  return {
    version: 1, runs: 0, quietRuns: 0, meaningfulRuns: 0, notifications: 0, dedupedNotifications: 0,
    severity: { info: 0, action: 0, urgent: 0 },
    invocations: { monitor: 0, evaluate: 0, reconfigure: 0 },
    fallbacks: 0, localFallbacks: 0, premiumInvocations: 0, budgetLimited: 0, degradedToDeterministic: 0,
    observerFailures: 0, conflicts: 0, duplicateObservations: 0, staleObservations: 0, probeFailures: 0, unchangedProposals: 0,
    cost: { apiUsd: 0, localElectricityUsd: 0, totalUsd: 0 },
    decisions: [],        // per-tier selections (bounded)
    escalations: [],      // {reasons, at}
    borderline: [],       // selections with small quality margin
    qualityMargins: [],
    insufficientData: 0,
    lastRunAt: null, firstRunAt: null,
    selectedModels: {}, rejectedReasons: {},
  };
}

/** Fold one job run record into telemetry. `run` is the model-maintenance.lastrun.json shape. */
export function recordRun(tel, run) {
  const t = tel ?? emptyTelemetry();
  t.runs++;
  t.lastRunAt = run.completedAt ?? run.startedAt ?? t.lastRunAt;
  if (!t.firstRunAt) t.firstRunAt = run.startedAt ?? run.completedAt;
  if (run.quiet) t.quietRuns++; else t.meaningfulRuns++;
  if (run.ingest) {
    t.duplicateObservations += run.ingest.duplicates ?? 0;
    t.staleObservations += run.ingest.stale ?? 0;
    if (run.ingest.probeFailed) { t.probeFailures++; t.observerFailures++; }
  }
  if (run.budgetLimited) t.budgetLimited++;
  const n = run.notification;
  if (n) { t.notifications++; t.severity[n.severity] = (t.severity[n.severity] ?? 0) + 1; if (!n.sent) t.dedupedNotifications++; }
  if (run.verdict?.reasons?.some(r => /conflict/.test(r))) t.conflicts++;
  if (run.artifacts?.proposal && run.verdict && !run.verdict.meaningful) t.unchangedProposals++;

  for (const tier of run.tiers ?? []) {
    if (tier.role && t.invocations[tier.role] !== undefined) t.invocations[tier.role]++;
    if (tier.fallbackOccurred) t.fallbacks++;
    if (tier.selectionPath === 'local-fallback') t.localFallbacks++;
    if (tier.selected?.premium) t.premiumInvocations++;
    const est = tier.selected?.effectiveCostUsd ?? 0;
    t.cost.totalUsd += est;
    if (tier.selected?.location === 'local') t.cost.localElectricityUsd += tier.selected?.costDetail?.electricityUsd ?? est;
    else t.cost.apiUsd += tier.selected?.costDetail?.estimatedApiCostUsd ?? est;
    if (tier.selected) {
      const margin = tier.requiredQuality != null ? tier.selected.quality - tier.requiredQuality : null;
      t.decisions.push({
        at: run.completedAt, tier: tier.role, model: tier.selected.model,
        estimatedCostUsd: est, quality: tier.selected.quality, requiredQuality: tier.requiredQuality ?? null,
        qualityMargin: margin, path: tier.selectionPath, premium: tier.selected.premium === true,
        alternatives: (tier.ordered ?? []).slice(1, 4).map(a => ({ model: a.model, cost: a.effectiveCostUsd, quality: a.quality })),
        rejected: (tier.candidates ?? []).filter(c => !c.eligible).map(c => ({ model: c.model, reasons: c.rejectedReasons })),
      });
      t.selectedModels[tier.selected.model] = (t.selectedModels[tier.selected.model] ?? 0) + 1;
      if (margin !== null) { t.qualityMargins.push(margin); if (margin < 5) t.borderline.push({ model: tier.selected.model, tier: tier.role, margin, at: run.completedAt }); }
      for (const c of tier.candidates ?? []) for (const r of c.rejectedReasons ?? []) t.rejectedReasons[r] = (t.rejectedReasons[r] ?? 0) + 1;
    }
  }
  for (const inv of run.invocations ?? []) {
    if (inv.degradedToDeterministic) t.degradedToDeterministic++;
    if (inv.skippedByBudget) t.budgetLimited++;
  }
  if (run.escalation) t.escalations.push({ at: run.completedAt, reasons: run.escalation.escalationReason, target: run.escalation.targetTier });
  if (run.proposal?.decisions) t.insufficientData += run.proposal.decisions.filter(d => d.decision === 'insufficient-data').length;
  return t;
}

// ---------------------------------------------------------------------------
// Telemetry store — JSONL of compact run summaries + rolling aggregate.
// ---------------------------------------------------------------------------

export function telemetryPaths(outDir) {
  return { runs: join(outDir, 'telemetry-runs.jsonl'), aggregate: join(outDir, 'telemetry.json') };
}

export function loadTelemetry(outDir) {
  const { aggregate } = telemetryPaths(outDir);
  if (existsSync(aggregate)) { try { return JSON.parse(readFileSync(aggregate, 'utf8')); } catch { /* rebuild below */ } }
  const t = emptyTelemetry();
  const { runs } = telemetryPaths(outDir);
  if (existsSync(runs)) {
    for (const line of readFileSync(runs, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { recordRun(t, JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
  }
  return t;
}

export function persistRun(outDir, run) {
  const { runs, aggregate } = telemetryPaths(outDir);
  mkdirSync(outDir, { recursive: true });
  const t = loadTelemetry(outDir);
  recordRun(t, run);
  writeFileSync(runs, JSON.stringify(compactRun(run)) + '\n', { flag: 'a' });
  atomicJson(aggregate, t);
  return t;
}

function compactRun(run) {
  return {
    runId: run.runId, startedAt: run.startedAt, completedAt: run.completedAt, status: run.status, quiet: run.quiet,
    verdict: run.verdict ? { meaningful: run.verdict.meaningful, severity: run.verdict.severity, quietReason: run.verdict.quietReason } : null,
    ingest: run.ingest, budgetLimited: run.budgetLimited,
    notification: run.notification ? { severity: run.notification.severity, sent: run.notification.sent } : null,
    tiers: (run.tiers ?? []).map(t => ({ role: t.role, selectionPath: t.selectionPath, fallbackOccurred: t.fallbackOccurred, selected: t.selected ? { model: t.selected.model, location: t.selected.location, premium: t.selected.premium, quality: t.selected.quality, effectiveCostUsd: t.selected.effectiveCostUsd, costDetail: t.selected.costDetail } : null, requiredQuality: t.requiredQuality, ordered: t.ordered, candidates: t.candidates })),
    invocations: (run.invocations ?? []).map(i => ({ tier: i.tier, degradedToDeterministic: i.degradedToDeterministic, skippedByBudget: i.skippedByBudget })),
    escalation: run.escalation ? { escalationReason: run.escalation.escalationReason, targetTier: run.escalation.targetTier } : null,
    proposal: run.proposal ? { decisions: (run.proposal.decisions ?? []).map(d => ({ backend: d.backend, decision: d.decision, currentStatus: d.currentStatus })) } : null,
  };
}

function atomicJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Warnings — deterministic rules over the aggregate. Proposals, never applied.
// ---------------------------------------------------------------------------

export function calibrationWarnings(t, policy) {
  const w = [];
  const runs = t.runs || 1;
  const notifRatio = t.meaningfulRuns ? t.notifications / t.meaningfulRuns : 0;
  if (t.meaningfulRuns >= 3 && notifRatio > 0.8) w.push({ kind: 'too-noisy', evidence: `${t.notifications} notifications / ${t.meaningfulRuns} meaningful runs`, suggestion: 'raise notification threshold or dedupe window' });
  if (t.runs >= 10 && t.quietRuns / runs < 0.3 && t.notifications > 5) w.push({ kind: 'too-noisy', evidence: `quiet ratio ${(t.quietRuns / runs).toFixed(2)} with ${t.notifications} notifications`, suggestion: 'review severity rules' });
  const budget = policy?.budget?.maxEstimatedCostPerRunUsd;
  const avg = t.cost.totalUsd / runs;
  if (budget && avg > budget * 0.8) w.push({ kind: 'too-expensive', evidence: `avg $${avg.toFixed(4)}/run vs budget $${budget}`, suggestion: 'reduce polling frequency or taskProfiles' });
  const escRate = t.runs ? t.escalations.length / runs : 0;
  if (t.escalations.length >= 3 && escRate > 0.3) w.push({ kind: 'too-many-premium-escalations', evidence: `${t.escalations.length} escalations in ${t.runs} runs`, suggestion: 'raise escalation thresholds (minQualitySwing / minCapabilities)' });
  const fbRate = t.runs ? t.fallbacks / runs : 0;
  if (t.fallbacks >= 3 && fbRate > 0.3) w.push({ kind: 'too-many-fallbacks', evidence: `${t.fallbacks} fallbacks in ${t.runs} runs`, suggestion: 'review primary model availability/quality' });
  if (t.qualityMargins.length >= 5) {
    const avgMargin = t.qualityMargins.reduce((a, b) => a + b, 0) / t.qualityMargins.length;
    if (avgMargin < 5) w.push({ kind: 'quality-margin-too-small', evidence: `avg quality margin ${avgMargin.toFixed(1)} over ${t.qualityMargins.length} selections`, suggestion: 'review requiredQuality or candidate pool' });
  }
  return w;
}

// ---------------------------------------------------------------------------
// Counterfactual — compare the selected model against the runners-up it beat.
// ---------------------------------------------------------------------------

export function counterfactuals(t, limit = 10) {
  const out = [];
  for (const d of (t.decisions ?? []).slice(-limit)) {
    const alts = (d.alternatives ?? []).map(a => ({
      model: a.model, estimatedCostUsd: a.cost, quality: a.quality,
      costDelta: Math.round((a.cost - d.estimatedCostUsd) * 1e6) / 1e6,
      qualityDelta: Math.round((a.quality - d.quality) * 10) / 10,
      verdict: a.cost < d.estimatedCostUsd && a.quality >= d.quality ? 'dominates-actual' : a.cost < d.estimatedCostUsd ? 'cheaper-lower-quality' : a.quality > d.quality ? 'better-more-expensive' : 'dominated',
    }));
    if (alts.length) out.push({ tier: d.tier, at: d.at, actual: { model: d.model, estimatedCostUsd: d.estimatedCostUsd, quality: d.quality }, counterfactual: alts });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Policy calibration proposal — evidence-based, guarded by minimum data.
// ---------------------------------------------------------------------------

export function calibrationProposal(t, policy, { minRuns, minMeaningfulEvents } = {}) {
  const mr = minRuns ?? policy?.calibration?.minRuns ?? 20;
  const me = minMeaningfulEvents ?? policy?.calibration?.minMeaningfulEvents ?? 3;
  if (t.runs < mr || t.meaningfulRuns < me) {
    return { status: 'insufficient-observation-data', runs: t.runs, meaningfulRuns: t.meaningfulRuns, required: { minRuns: mr, minMeaningfulEvents: me }, proposals: [] };
  }
  const proposals = [];
  const warnings = calibrationWarnings(t, policy);
  for (const w of warnings) {
    if (w.kind === 'too-noisy') proposals.push({ field: 'notification.threshold', currentValue: 'all-meaningful', proposedValue: 'action-and-urgent-only', evidence: w.evidence, expectedEffect: 'fewer info notifications', confidence: 'medium' });
    if (w.kind === 'too-expensive') proposals.push({ field: 'budget.maxEstimatedCostPerRunUsd', currentValue: policy?.budget?.maxEstimatedCostPerRunUsd, proposedValue: Math.max(0.01, (policy?.budget?.maxEstimatedCostPerRunUsd ?? 0.05) / 2), evidence: w.evidence, expectedEffect: 'lower per-run spend', confidence: 'medium' });
    if (w.kind === 'too-many-premium-escalations') proposals.push({ field: 'escalation.minQualitySwing', currentValue: policy?.escalation?.minQualitySwing, proposedValue: (policy?.escalation?.minQualitySwing ?? 15) + 5, evidence: w.evidence, expectedEffect: 'fewer reconfigure escalations', confidence: 'medium' });
    if (w.kind === 'too-many-fallbacks') proposals.push({ field: 'routing.primary-review', currentValue: 'current bindings', proposedValue: 'review primary model availability/quality', evidence: w.evidence, expectedEffect: 'fewer fallbacks', confidence: 'low' });
    if (w.kind === 'quality-margin-too-small') proposals.push({ field: 'requiredQuality', currentValue: policy?.requiredQuality, proposedValue: 'raise evaluate/reconfigure bars or widen candidate pool', evidence: w.evidence, expectedEffect: 'larger selection margins', confidence: 'low' });
  }
  // scheduler recommendation from observed change frequency
  const interval = t.meaningfulRuns === 0 && t.runs >= 10 ? '12h' : t.meaningfulRuns / Math.max(1, t.runs) > 0.5 ? '6h' : '6h';
  proposals.push({ field: 'scheduler.interval', currentValue: '6h', proposedValue: interval, evidence: `${t.meaningfulRuns} meaningful / ${t.runs} runs`, expectedEffect: interval === '12h' ? 'halve polling cost' : 'keep responsiveness', confidence: 'medium' });
  return { status: 'ok', generatedAt: new Date().toISOString(), runs: t.runs, meaningfulRuns: t.meaningfulRuns, proposals, warnings };
}

// ---------------------------------------------------------------------------
// Retention — compact raw runs older than `days` into the aggregate, keep the
// summary; raw lines for the window are preserved. Failure keeps originals.
// ---------------------------------------------------------------------------

export function compactTelemetry(outDir, { days = 30, now = Date.now() } = {}) {
  const { runs } = telemetryPaths(outDir);
  if (!existsSync(runs)) return { compacted: 0, kept: 0 };
  const cutoff = now - days * 86400 * 1000;
  const lines = readFileSync(runs, 'utf8').split(/\r?\n/).filter(l => l.trim());
  const keep = [], old = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      (Date.parse(r.completedAt ?? r.startedAt ?? 0) < cutoff ? old : keep).push(line);
    } catch { keep.push(line); } // corrupt lines are kept, never silently dropped
  }
  if (!old.length) return { compacted: 0, kept: keep.length };
  // summary first, then rewrite — original data preserved on any failure
  const summary = { compactedAt: new Date(now).toISOString(), compactedRuns: old.length, firstKeptAt: null };
  const tmp = `${runs}.compact.tmp`;
  writeFileSync(tmp, [...keep, JSON.stringify({ _compactedSummary: summary })].join('\n') + '\n');
  renameSync(tmp, runs);
  return { compacted: old.length, kept: keep.length, summary };
}
