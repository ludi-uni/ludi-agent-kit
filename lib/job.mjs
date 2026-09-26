// Phase 5 — maintenance job orchestrator: observe -> dedupe -> catalog diff ->
// meaningful-change gate -> proposal -> maintenance preview -> (optional live tiers)
// -> notification decision -> sinks. Quiet by default: only human-worthy changes
// produce a notification. Reuses Phase 1-4 modules; nothing is duplicated, and
// nothing outside out/ is ever written.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadObservationStore, ingestObservations, productionObservations } from './observe/observation.mjs';
import { SOURCES } from './observe/sources.mjs';
import { resolveRequestedObservers, runObservers } from './observe/observers.mjs';
import { diffCatalog, buildCatalogProposal, applyProposalToCatalog, proposalToEvents } from './observe/differ.mjs';
import { runMaintenancePlan, loadExecPolicy, DEFAULT_POLICY } from './maintenance-exec.mjs';
import { runMaintenanceLive } from './maintenance-runner.mjs';
import { persistRun } from './telemetry.mjs';

const sha = obj => createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
const SEVERITY_RANK = { none: 0, info: 1, action: 2, urgent: 3 };

// ---------------------------------------------------------------------------
// Lock — exclusive lock file, stale after TTL. Atomic artifacts via tmp+rename.
// ---------------------------------------------------------------------------

export function acquireLock(lockPath, { staleMs = 30 * 60 * 1000, now = Date.now() } = {}) {
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }));
    closeSync(fd);
    return { acquired: true, path: lockPath };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      const stat = statSync(lockPath);
      if (now - stat.mtimeMs > staleMs) { unlinkSync(lockPath); return acquireLock(lockPath, { staleMs, now }); }
    } catch { /* raced: treat as held */ }
    return { acquired: false, path: lockPath };
  }
}
export function releaseLock(lock) { if (lock?.acquired) try { unlinkSync(lock.path); } catch { /* already gone */ } }

export function atomicWriteJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Run state — notification dedupe across runs. Same payload hash is never resent;
// a severity increase re-notifies.
// ---------------------------------------------------------------------------

export function loadRunState(path) {
  if (!existsSync(path)) return { version: 1 };
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { version: 1, _corrupt: true }; }
}

export function shouldNotify(state, notification) {
  if (!notification) return { notify: false, reason: 'no notification' };
  const hash = notificationHash(notification);
  if (state.lastNotificationHash === hash) {
    if (SEVERITY_RANK[notification.severity] > SEVERITY_RANK[state.lastSeverity ?? 'none']) {
      return { notify: true, reason: `severity rose ${state.lastSeverity} -> ${notification.severity}`, hash };
    }
    return { notify: false, reason: 'identical notification already sent', hash };
  }
  return { notify: true, reason: 'new notification content', hash };
}

// Content identity excludes severity so a severity rise on the same facts re-notifies.
export function notificationHash(n) {
  return sha({ title: n.title, changes: n.changes, routingImpact: n.routingImpact });
}

// ---------------------------------------------------------------------------
// Meaningful-change gate + severity classification (deterministic authority)
// ---------------------------------------------------------------------------

const QUIET_REASONS = [
  'no observations', 'duplicates only', 'stale only', 'catalog unchanged',
  'no routing impact', 'availability probe failed only', 'unknown observations only',
];

export function classifyRun({ ingest, diff = { diffs: [] }, proposal = {}, preview, probeFailed }) {
  const proposed = (diff.diffs ?? []).filter(d => d.status === 'proposed');
  const conflicts = (diff.diffs ?? []).filter(d => d.status === 'conflict');
  const boundModels = new Set(); // filled by caller via preview decisions
  const changes = preview?.proposal?.changes ?? [];
  const routingImpact = changes.map(c => ({ backend: c.affected.backend, capabilities: c.affected.capabilities, agents: c.affected.agents, currentModel: `${c.currentModel.provider}/${c.currentModel.model}`, proposedModel: `${c.proposedModel.provider}/${c.proposedModel.model}` }));

  // --- urgency signals -----------------------------------------------------
  const currentRemoved = (proposal.deprecations ?? []).filter(d => d.observedValue === 'removed' || d.observedValue === 'deprecated');
  // insufficient-data is urgent only when the CURRENT model is unusable (removed/
  // deprecated/missing) — a healthy backend with no better candidate is not an emergency.
  const insufficient = (preview?.proposal?.decisions ?? []).filter(d =>
    d.decision === 'insufficient-data' && (d.currentStatus === 'removed' || d.currentStatus === 'deprecated' || d.currentStatus === 'unknown'));
  const localFallback = (preview?.tiers ?? []).some(t => t.selectionPath === 'local-fallback');
  const multiCap = new Set(changes.flatMap(c => c.affected?.capabilities ?? [])).size >= 2;
  const allFailed = (preview?.invocations ?? []).some(i => i.degradedToDeterministic && i.invocations.length > 0 && i.invocations.every(x => !x.ok));

  // --- decision ------------------------------------------------------------
  // Quiet gate: fresh ingest matters, but the accumulated store still drives the diff.
  // 'no observations'/'duplicates only'/'stale only' apply only when the diff itself is empty.
  const stored = ingest?.stored?.length ?? 0, dups = ingest?.duplicates?.length ?? 0, staleN = ingest?.stale?.length ?? 0;
  const diffEmpty = proposed.length === 0 && conflicts.length === 0 && !(proposal.additions?.length) && !(proposal.deprecations?.length);
  const onlyQuietSignals = diffEmpty
    ? (stored === 0 && dups > 0 ? 'duplicates only' : stored === 0 && staleN > 0 ? 'stale only' : stored === 0 && !probeFailed ? 'no observations' : 'catalog unchanged')
    : null;

  if (onlyQuietSignals && !probeFailed) return { meaningful: false, quietReason: onlyQuietSignals, severity: 'none' };
  if (probeFailed && proposed.length === 0) return { meaningful: false, quietReason: 'availability probe failed only', severity: 'none' };

  let severity = 'info';
  const reasons = [];
  if (proposal.additions?.length) reasons.push(`${proposal.additions.length} new model(s) observed`);
  if (proposed.length) reasons.push(`${proposed.length} catalog field change(s) proposed`);
  if (conflicts.length) reasons.push(`${conflicts.length} unresolved conflict(s)`);
  if (routingImpact.length) { severity = 'action'; reasons.push(`${routingImpact.length} backend binding change(s) in preview`); }
  if (currentRemoved.length) { severity = 'urgent'; reasons.push(`current model ${currentRemoved.map(d => `${d.model} -> ${d.observedValue}`).join(', ')}`); }
  if (insufficient.length) { severity = 'urgent'; reasons.push(`no eligible candidate for ${insufficient.map(d => d.backend).join(', ')}`); }
  if (localFallback) { severity = 'urgent'; reasons.push('selection fell back to a local model'); }
  if (allFailed) { severity = SEVERITY_RANK[severity] < 2 ? 'action' : severity; reasons.push('all candidates for a tier failed'); }
  if (multiCap) { severity = 'urgent'; reasons.push('changes span multiple capabilities'); }

  if (!proposed.length && !conflicts.length && !routingImpact.length && !(proposal.additions?.length) && !(proposal.deprecations?.length)) {
    return { meaningful: false, quietReason: 'no routing impact', severity: 'none' };
  }
  return { meaningful: true, severity, reasons, routingImpact };
}

// ---------------------------------------------------------------------------
// Notification payload + sinks
// ---------------------------------------------------------------------------

export function buildNotification({ severity, reasons, proposal, preview, runId, proposalPath, previewPath, budgetLimited }) {
  const changes = [
    ...(proposal.updates ?? []).map(u => `${u.model}: ${u.field} ${JSON.stringify(u.currentValue)} -> ${JSON.stringify(u.observedValue)}`),
    ...(proposal.additions ?? []).map(a => `${a.model}: new model observed`),
    ...(proposal.deprecations ?? []).map(d => `${d.model}: ${d.currentValue} -> ${d.observedValue}`),
    ...(proposal.conflicts ?? []).map(c => `${c.model}: conflict on ${c.field}`),
  ];
  const routingImpact = (preview?.proposal?.changes ?? []).map(c => `${c.affected.backend}: ${c.currentModel.provider}/${c.currentModel.model} -> ${c.proposedModel.provider}/${c.proposedModel.model} (${c.affected.agents.join(',')})`);
  const title = severity === 'urgent' ? 'Model maintenance: urgent action needed'
    : severity === 'action' ? 'Model maintenance: action recommended' : 'Model maintenance: info';
  const recommendedNextStep = routingImpact.length
    ? `Review ${proposalPath} and preview; if accepted, edit models.local.json per proposedModel and re-run resolve-capabilities.mjs`
    : proposal.deprecations?.length || proposal.updates?.length
      ? `Review ${proposalPath}; apply catalog edits manually if accepted`
      : `Review ${proposalPath}; no routing impact expected`;
  return {
    severity, title,
    summary: reasons.join('; ') || 'no significant change',
    changes, routingImpact, recommendedNextStep,
    requiresApproval: true,
    budgetLimited: budgetLimited === true,
    proposalPath, previewPath, runId, observedAt: new Date().toISOString(),
  };
}

export const sinks = {
  stdout: n => { console.log(`[${n.severity}] ${n.title}: ${n.summary}`); return { sink: 'stdout', ok: true }; },
  file: (n, { path }) => { atomicWriteJson(path, n); return { sink: 'file', ok: true, path }; },
  command: (n, { command }) => {
    const r = spawnSync(command, { input: JSON.stringify(n), encoding: 'utf8', shell: true, timeout: 30000, windowsHide: true });
    return { sink: 'command', ok: r.status === 0, exitCode: r.status, error: r.error?.message ?? (r.status !== 0 ? (r.stderr || '').slice(-300) : null) };
  },
};

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

/**
 * One scheduled maintenance run. Options mirror the CLI. `invoke` (optional) makes
 * the run live; `tierAllowed` is the budget gate. Returns the run record; writes
 * only under outDir (gitignored). Never touches catalog/routing/settings/~/.pi.
 */
export async function runMaintenanceJob({
  outDir, adapterDir, kit, catalog,
  source = null, input = null, checkPi = false, listing = null,
  checkQoder = false, qoderCachePath = null, qoderListing = undefined,
  check = null, observers = null,
  preview = true, live = false, invoke = null, notifyCommand = null,
  policy = DEFAULT_POLICY, routing, registry, agents,
  now = () => new Date().toISOString(), lockStaleMs,
  shadow = false, shadowNotify = false,
} = {}) {
  const runId = `run-${Date.now()}-${process.pid}`;
  const lockPath = join(outDir, 'model-maintenance.lock');
  mkdirSync(outDir, { recursive: true });
  const lock = acquireLock(lockPath, { staleMs: lockStaleMs });
  if (!lock.acquired) return { runId, status: 'skipped-locked', quiet: true };

  const statePath = join(outDir, 'model-maintenance.state.json');
  const state = loadRunState(statePath);
  const run = { runId, startedAt: now(), status: 'running', quiet: true, artifacts: {} };
  const log = [];
  try {
    // 1. observe — an explicit --input file, plus any requested live observers.
    // Observer selection/execution is registry-driven (lib/observe/observers.mjs):
    // --check-pi/--check-qoder/--check <list> resolve to observer ids and run once
    // each, in order. One observer's failure is isolated — it sets probeFailed and
    // records per-source metadata, never stops the others.
    let fresh = [], probeFailed = false;
    if (input) {
      const fn = SOURCES[source ?? 'manual'];
      if (!fn) throw new Error(`unknown source "${source}"`);
      fresh = fn(resolve(input));
    }
    const requested = resolveRequestedObservers({ checkPi, checkQoder, check, observers });
    if (requested.unknown.length) {
      run.status = 'error';
      run.error = `unknown observer id(s): ${requested.unknown.join(', ')}`;
      throw new Error(run.error);
    }
    if (requested.ids.length) {
      const r = await runObservers(requested.ids, { catalog, outDir, observedAt: now(), listing, qoderListing, qoderCachePath });
      fresh.push(...r.observations);
      if (r.probeFailed) probeFailed = true;
      run.observers = r.results; // per-source audit: which observer ran/failed/produced what
      for (const res of r.results) if (res.probeFailed) log.push(`${res.id}: ${res.metadata?.reason ?? 'probe failed'} -> unknown, not absent`);
    }
    const storePath = join(outDir, 'model-observations.jsonl');
    const ingest = fresh.length ? ingestObservations(storePath, fresh, { now }) : { stored: [], duplicates: [], stale: [], invalid: [] };
    run.ingest = { fresh: fresh.length, stored: ingest.stored.length, duplicates: ingest.duplicates.length, stale: ingest.stale.length, invalid: ingest.invalid.length, probeFailed };

    // 2. diff + proposal — production observations only; test/fixture records are
    // stored for audit but never drive a real catalog/routing proposal.
    const store = loadObservationStore(storePath);
    const prodObs = productionObservations(store.observations);
    run.excludedTestObservations = store.observations.length - prodObs.length;
    const diff = diffCatalog(catalog, prodObs);
    const proposal = buildCatalogProposal(catalog, diff, prodObs);
    const diffPath = join(outDir, 'catalog-diff.json');
    const proposalPath = join(outDir, 'model-catalog.proposal.json');
    atomicWriteJson(diffPath, diff);
    atomicWriteJson(proposalPath, proposal);
    run.artifacts.diff = diffPath; run.artifacts.proposal = proposalPath;

    // 3. preview on hypothetical catalog
    let previewResult = null, previewPath = null;
    if (preview) {
      const hypothetical = applyProposalToCatalog(catalog, proposal);
      const planOpts = { routing, registry, agents, catalog: hypothetical, events: proposalToEvents(proposal), policy };
      if (live && invoke) {
        const budget = policy.budget ?? DEFAULT_POLICY.budget;
        let invocations = 0, premium = 0, spent = 0;
        const tierAllowed = tier => {
          const sel = previewResult?.tiers?.find(t => t.role === tier);
          const est = sel?.selected?.effectiveCostUsd ?? 0;
          if (invocations >= budget.maxTotalInvocationsPerRun) return false;
          if (tier === 'reconfigure' && premium >= budget.maxPremiumInvocationsPerRun) return false;
          if (spent + est > budget.maxEstimatedCostPerRunUsd) return false;
          return true;
        };
        previewResult = await runMaintenanceLive({ ...planOpts, invoke, tierAllowed });
        run.budgetLimited = previewResult.invocations?.some(i => i.skippedByBudget) === true;
      } else {
        previewResult = runMaintenancePlan(planOpts);
      }
      previewPath = join(outDir, 'maintenance-preview.json');
      atomicWriteJson(previewPath, { ...previewResult, hypothetical: true, note: 'proposal applied in memory only' });
      run.artifacts.preview = previewPath;
      // Embed the preview's decision layer so telemetry/reporting can aggregate it.
      run.tiers = previewResult.tiers;
      run.invocations = previewResult.invocations;
      run.escalation = previewResult.escalation;
      run.proposal = previewResult.proposal ? { changes: previewResult.proposal.changes, decisions: previewResult.proposal.decisions } : null;
    }

    // 4. meaningful-change gate + severity
    const verdict = classifyRun({ ingest, diff, proposal, preview: previewResult, probeFailed });
    run.verdict = verdict;
    run.quiet = !verdict.meaningful;

    // 5. notification (dedupe via state)
    if (verdict.meaningful) {
      const notification = buildNotification({
        severity: verdict.severity, reasons: verdict.reasons, proposal, preview: previewResult,
        runId, proposalPath, previewPath, budgetLimited: run.budgetLimited,
      });
      const decision = shouldNotify(state, notification);
      run.notification = { ...notification, sent: decision.notify, dedupeReason: decision.reason };
      if (decision.notify) {
        run.notification.sinks = [sinks.stdout(notification), sinks.file(notification, { path: join(outDir, 'model-maintenance.notification.json') })];
        run.artifacts.notification = join(outDir, 'model-maintenance.notification.json');
        // Shadow mode: external sinks are opt-in via shadowNotify only.
        if (notifyCommand && (!shadow || shadowNotify)) run.notification.sinks.push(sinks.command(notification, { command: notifyCommand }));
        else if (notifyCommand && shadow) run.notification.shadowSuppressed = true;
      }
      state.lastNotificationHash = decision.hash;
      state.lastSeverity = notification.severity;
    }

    state.lastSuccessfulRunAt = now();
    state.lastProposalHash = sha(proposal);
    state.lastKnownRoutingImpact = verdict.routingImpact ?? [];
    atomicWriteJson(statePath, state);
    run.status = 'ok';
  } catch (e) {
    run.status = 'error';
    run.error = e.message;
  } finally {
    run.completedAt = now();
    run.shadow = shadow === true;
    atomicWriteJson(join(outDir, 'model-maintenance.lastrun.json'), run);
    try { persistRun(outDir, run); } catch { /* telemetry must never break the job */ }
    releaseLock(lock);
  }
  return run;
}
