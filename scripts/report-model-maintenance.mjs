#!/usr/bin/env node
// Phase 6 — calibration report: aggregate telemetry -> human-readable report +
// deterministic warnings + counterfactuals + policy calibration proposal.
// Read-only w.r.t. policy/catalog/routing; writes only out/ artifacts.
//
// Usage:
//   node scripts/report-model-maintenance.mjs [--adapter pi] [--days 14] [--json]
//   node scripts/report-model-maintenance.mjs --compact --days 30   # retention compaction
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTelemetry, calibrationWarnings, counterfactuals, calibrationProposal, compactTelemetry } from '../lib/telemetry.mjs';
import { loadExecPolicy } from '../lib/maintenance-exec.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const has = name => args.includes(`--${name}`);
const adapter = opt('adapter', 'pi');
const adapterDir = join(kit, 'adapters', adapter);
const outDir = join(adapterDir, 'out');
const days = Number(opt('days', 14));
const policy = loadExecPolicy(opt('policy', join(adapterDir, 'maintenance-policy.json')));

if (has('compact')) {
  const r = compactTelemetry(outDir, { days });
  console.log(`retention: compacted ${r.compacted} old run(s), kept ${r.kept}`);
}

const t = loadTelemetry(outDir);
const warnings = calibrationWarnings(t, policy);
const cf = counterfactuals(t, 10);
const cal = calibrationProposal(t, policy);
mkdirSync(outDir, { recursive: true });
const calFile = join(outDir, 'maintenance-policy.calibration.proposal.json');
writeFileSync(calFile, JSON.stringify(cal, null, 2) + '\n');

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(0)}%` : 'n/a');
const avg = t.runs ? t.cost.totalUsd / t.runs : 0;
const avgMargin = t.qualityMargins.length ? t.qualityMargins.reduce((a, b) => a + b, 0) / t.qualityMargins.length : null;
const top = (obj, n = 5) => Object.entries(obj ?? {}).sort((a, b) => b[1] - a[1]).slice(0, n);

const report = {
  activity: { totalRuns: t.runs, quietRuns: t.quietRuns, quietRatio: pct(t.quietRuns, t.runs), meaningful: t.meaningfulRuns, notifications: t.notifications, deduped: t.dedupedNotifications, dedupeRate: pct(t.dedupedNotifications, t.notifications) },
  cost: { totalUsd: +t.cost.totalUsd.toFixed(4), apiUsd: +t.cost.apiUsd.toFixed(4), localElectricityUsd: +t.cost.localElectricityUsd.toFixed(4), avgPerRun: +avg.toFixed(4), premiumInvocations: t.premiumInvocations, budgetLimited: t.budgetLimited },
  routing: { invocations: t.invocations, fallbacks: t.fallbacks, localFallbacks: t.localFallbacks, topSelected: top(t.selectedModels), topRejected: top(t.rejectedReasons) },
  quality: { avgQualityMargin: avgMargin === null ? null : +avgMargin.toFixed(1), borderlineSelections: t.borderline.length, insufficientData: t.insufficientData, degradedToDeterministic: t.degradedToDeterministic },
  noise: { duplicateObservations: t.duplicateObservations, staleObservations: t.staleObservations, probeFailures: t.probeFailures, conflicts: t.conflicts, unchangedProposals: t.unchangedProposals },
  escalation: { count: t.escalations.length, rate: pct(t.escalations.length, t.runs), reasons: t.escalations.slice(-5).map(e => e.reasons) },
  warnings,
  counterfactuals: cf,
  calibration: { status: cal.status, file: calFile, proposals: cal.proposals?.length ?? 0 },
};

if (has('json')) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

console.log(`=== Model maintenance calibration (${days}d window, ${t.runs} runs) ===`);
console.log(`Activity : ${t.runs} runs, ${report.activity.quietRatio} quiet, ${t.meaningfulRuns} meaningful, ${t.notifications} notifications (${report.activity.dedupeRate} deduped)`);
console.log(`Cost     : $${report.cost.totalUsd} total (api $${report.cost.apiUsd}, local $${report.cost.localElectricityUsd}), avg $${report.cost.avgPerRun}/run, premium x${t.premiumInvocations}, budgetLimited x${t.budgetLimited}`);
console.log(`Routing  : invocations mon=${t.invocations.monitor} eval=${t.invocations.evaluate} rec=${t.invocations.reconfigure}; fallbacks ${t.fallbacks} (local ${t.localFallbacks})`);
if (report.routing.topSelected.length) console.log(`           top models: ${report.routing.topSelected.map(([m, c]) => `${m}x${c}`).join(', ')}`);
console.log(`Quality  : avg margin ${report.quality.avgQualityMargin ?? 'n/a'}, borderline ${t.borderline.length}, insufficient-data ${t.insufficientData}, degraded ${t.degradedToDeterministic}`);
console.log(`Noise    : dup ${t.duplicateObservations}, stale ${t.staleObservations}, probe-fail ${t.probeFailures}, conflicts ${t.conflicts}`);
console.log(`Escalation: ${t.escalations.length} (${report.escalation.rate} of runs)`);
console.log(`Warnings : ${warnings.length ? warnings.map(w => `${w.kind}(${w.evidence})`).join('; ') : 'none'}`);
console.log(`Calibration: ${cal.status}${cal.status === 'ok' ? ` -> ${cal.proposals.length} proposal(s) at ${calFile}` : ` (${cal.runs}/${cal.required.minRuns} runs, ${cal.meaningfulRuns}/${cal.required.minMeaningfulEvents} meaningful)`}`);
if (cf.length) {
  console.log('Counterfactual (latest):');
  for (const c of cf.slice(-3)) console.log(`  ${c.tier}: ${c.actual.model} $${c.actual.estimatedCostUsd} q${c.actual.quality} | vs ${c.counterfactual.map(a => `${a.model} $${a.estimatedCostUsd} q${a.quality} [${a.verdict}]`).join(', ')}`);
}
