#!/usr/bin/env node
// Orchestrate one high-level request, or resume a persisted run.
// Usage:
//   node scripts/orchestrate.mjs [--dry-run] [--planner rules|model] [--repo <dir>] [--apply]
//                                [--policy <file>] [--store <db>] [--out <dir>] [--json] [--trace] "<request>"
//   node scripts/orchestrate.mjs --list [--status <run-status>] [--store <db>]
//   node scripts/orchestrate.mjs --decisions [--resume <run-id>] [--store <db>]
//   node scripts/orchestrate.mjs --show <run-id> [--store <db>]
//   node scripts/orchestrate.mjs --resume <run-id> [--answer <decision-id> "<text>"] [--store <db>] [--repo <dir>] [--apply]
//   node scripts/orchestrate.mjs --prune [--older-than 7d] [--store <db>]        # delete terminal run history
//   node scripts/orchestrate.mjs --delete <run-id> [--force] [--store <db>]     # preview, or delete with --force
//   node scripts/orchestrate.mjs --clear [--force] [--include-active] [--store <db>]  # preview, or delete with --force
// --dry-run plans and routes only. A real run is stored under .orchestration/state.db (or --store / LUDI_ORCHESTRATION_STORE).
// Cleanup touches terminal runs only (completed/failed/cancelled with no pending decisions); --include-active
// additionally removes running/waiting_for_user runs that have no pending decisions. Global decision memory,
// protocol stats and global backend health are never deleted.
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadRouting } from '../lib/routing.mjs';
import { loadPiRegistry, piUserModelsPath } from '../adapters/pi/lib/model-registry.mjs';
import { resolveCapability } from '../lib/resolve.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { loadPolicy } from '../lib/orchestrator/policy.mjs';
import { dryRun, formatPlan } from '../lib/orchestrator/orchestrator.mjs';
import {
  defaultStorePath, loadOrchestrationContext, listOrchestrationRuns, pendingDecisions, showRun,
  createRunHealth, createRunRunner, startOrchestration, resumeOrchestration, formatReport, formatRunList,
  parseOlderThan, previewRunCleanup, pruneOrchestrationRuns, deleteOrchestrationRun, clearOrchestrationRuns,
  formatCleanup,
} from '../lib/orchestrator/api.mjs';
import { createPiInvoker } from '../adapters/pi/lib/invoke.mjs';
import { createPiSubagentRunner } from '../adapters/pi/lib/subagent.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const VALUED = new Set(['planner', 'repo', 'policy', 'out', 'request', 'store', 'resume', 'status', 'show', 'delete', 'older-than']);
const opts = {}, positional = [];
opts.answers = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) { positional.push(a); continue; }
  const name = a.slice(2);
  if (name === 'answer') { opts.answers.push({ decisionId: args[++i], answer: args[++i] }); continue; }
  opts[name] = VALUED.has(name) ? args[++i] : true;
}
const cleanupMode = !!(opts.prune || opts.delete || opts.clear);
const request = opts.request ?? (opts.resume || opts.list || opts.decisions || opts.show || cleanupMode ? '' : positional.join(' '));
const storePath = resolve(opts.store ?? defaultStorePath(kit));
const usage = 'usage: orchestrate.mjs [--dry-run] [--planner rules|model] [--repo dir] [--apply] [--policy file] [--store db] [--out dir] [--json] [--trace] "<request>" | --list [--status] | --decisions [--resume id] | --show id | --resume id [--answer decision-id text] | --prune [--older-than 7d] | --delete id [--force] | --clear [--force] [--include-active]';
if (!request && !opts.resume && !opts.list && !opts.decisions && !opts.show && !cleanupMode) { console.error(usage); process.exit(2); }
// Cleanup flag validation.
const cleanupFlags = [opts.prune && '--prune', opts.delete && '--delete', opts.clear && '--clear'].filter(Boolean);
if (cleanupFlags.length > 1) { console.error(`cleanup modes are exclusive: ${cleanupFlags.join(' ')}`); process.exit(2); }
if (opts['older-than'] && !opts.prune) { console.error('--older-than requires --prune'); process.exit(2); }
if (opts['include-active'] && !opts.clear) { console.error('--include-active requires --clear'); process.exit(2); }
if (opts.force && !opts.delete && !opts.clear) { console.error('--force requires --delete or --clear'); process.exit(2); }
let olderThanMs = null;
if (opts['older-than']) {
  try { olderThanMs = parseOlderThan(opts['older-than']); }
  catch (e) { console.error(e.message); process.exit(2); }
}
const planner = opts.planner ?? 'rules';
if (!['rules', 'model'].includes(planner)) { console.error(`unknown planner "${planner}"`); process.exit(2); }

const routing = loadRouting(join(kit, 'routing/routing.json'));
const { registry } = loadPiRegistry(kit, routing);
const { agents, errors } = loadAgents(join(kit, 'agents'), routing);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
const { policy } = opts.policy
  ? loadPolicy(join(kit, 'orchestration/decision-policy.json'), resolve(opts.policy))
  : loadPolicy(join(kit, 'orchestration/decision-policy.json'), join(kit, 'orchestration/decision-policy.local.json'));
const repoRoot = opts.repo ? resolve(opts.repo) : null;
const outDir = resolve(opts.out ?? join(kit, 'adapters/pi/out/orchestrate'));

if (opts['dry-run'] && !cleanupMode) {
  const invoke = planner === 'model' ? createPiInvoker() : null;
  if (planner === 'model' && !resolveCapability(routing, registry, 'orchestration').candidates.length) throw new Error(`No bound model for orchestration; edit ${piUserModelsPath()}`);
  const dry = await dryRun(request, { planner, agents, routing, registry, policy, invoke, cwd: repoRoot ?? process.cwd() });
  console.log(opts.json ? JSON.stringify(dry, null, 2) : formatPlan(dry));
  process.exitCode = dry.errors.length ? 1 : 0;
} else {
  const ctx = loadOrchestrationContext({
    kit, storePath,
    policyPath: opts.policy ? resolve(opts.policy) : null,
    localPolicyPath: opts.policy ? null : join(kit, 'orchestration/decision-policy.local.json'),
  });
  if (ctx.errors.length) { console.error(ctx.errors.join('\n')); ctx.session.close(); process.exit(1); }
  try {
    if (opts.list) {
      const rows = listOrchestrationRuns(ctx, { status: opts.status ?? null });
      console.log(opts.json ? JSON.stringify(rows, null, 2) : formatRunList(rows));
    } else if (opts.decisions) {
      const rows = pendingDecisions(ctx, { runId: opts.resume ?? null });
      console.log(opts.json ? JSON.stringify(rows, null, 2) : (rows.length ? rows.map(d => `${d.runId}  ${d.id}  [${d.taskId}] ${d.question}`).join('\n') : 'decisions: none'));
    } else if (opts.show) {
      const shown = showRun(ctx, opts.show);
      console.log(opts.json ? JSON.stringify(shown, null, 2) : formatReport(shown));
    } else if (opts.prune) {
      try {
        const result = opts['dry-run']
          ? previewRunCleanup(ctx, { olderThan: new Date(Date.now() - (olderThanMs ?? 7 * 86_400_000)).toISOString() })
          : pruneOrchestrationRuns(ctx, { olderThanMs });
        console.log(opts.json ? JSON.stringify(result, null, 2) : formatCleanup(result, { verb: '削除', hint: '--prune' }));
      } catch (e) { console.error(`整理できません: ${e.message}`); process.exitCode = 1; }
    } else if (opts.delete) {
      const id = opts.delete === true ? positional[0] : opts.delete;
      if (!id || String(id).startsWith('--')) { console.error('--delete requires a run id'); process.exit(2); }
      try {
        const result = deleteOrchestrationRun(ctx, id, { force: !!opts.force });
        console.log(opts.json ? JSON.stringify(result, null, 2) : `削除しました: ${result.id} (tasks:${result.deleted.tasks} decisions:${result.deleted.decisions} trace:${result.deleted.trace} health:${result.deleted.health})`);
      } catch (e) { console.error(`削除できません: ${e.message}`); process.exitCode = 1; }
    } else if (opts.clear) {
      try {
        const result = clearOrchestrationRuns(ctx, { force: !!opts.force, includeActive: !!opts['include-active'] });
        console.log(opts.json ? JSON.stringify(result, null, 2) : formatCleanup(result, { verb: '削除' }));
      } catch (e) { console.error(`整理できません: ${e.message}`); process.exitCode = 1; }
    } else {
      const health = createRunHealth(ctx);
      const invoke = createPiInvoker();
      const runner = createRunRunner(ctx, { invoke, runSubagent: createPiSubagentRunner(), repoRoot, outDir, apply: !!opts.apply, health });
      const result = opts.resume
        ? await resumeOrchestration(ctx, { runId: opts.resume, answers: opts.answers, repoRoot, runner, invoke, health })
        : await startOrchestration(ctx, { request, repoRoot, planner, runner, invoke, health });
      mkdirSync(outDir, { recursive: true });
      const traceFile = join(outDir, 'orchestration-trace.json');
      writeFileSync(traceFile, JSON.stringify(result, null, 2));
      if (opts.json) console.log(JSON.stringify({ ...result, trace: opts.trace ? result.trace : undefined }, null, 2));
      else {
        console.log(formatReport(result));
        console.log(`\nrun: ${result.runId}`);
        if (opts.trace) console.log(`trace: ${traceFile}`);
      }
      process.exitCode = result.status === 'completed' ? 0 : 1;
    }
  } finally {
    ctx.session.close();
  }
}
