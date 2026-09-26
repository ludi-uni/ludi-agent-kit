#!/usr/bin/env node
// Run the minimal executable path on a repository using the pi adapter.
// Usage:
//   node scripts/run-pipeline.mjs --repo <dir> --task "<text>" [--out <dir>] [--max-attempts 2]
//                                 [--pack <context-pack.md>] [--dry-run] [--agent scout|coder] [--capability <name>]
// --dry-run resolves models and writes the scout prompt / coder input without invoking any model.
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { loadRouting } from '../lib/routing.mjs';
import { loadRegistry } from '../lib/registry.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { resolveAgents, resolveCapability } from '../lib/resolve.mjs';
import { runPipeline, surveyRepo, scoutPrompt, detectTestCommand, runTests, coderPrompt } from '../lib/pipeline.mjs';
import { parseContextPackMarkdown } from '../lib/context-pack.mjs';
import { createPiInvoker } from '../adapters/pi/lib/invoke.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const flag = name => args.includes(`--${name}`);
const repo = opt('repo'); const task = opt('task');
if (!repo || !task) { console.error('usage: run-pipeline.mjs --repo <dir> --task "<text>" [--out <dir>] [--max-attempts N] [--pack file] [--dry-run] [--agent name] [--capability name]'); process.exit(2); }
const outDir = resolve(opt('out', join(kit, 'adapters/pi/out/pipeline')));
const maxAttempts = Number(opt('max-attempts', 2));

const routing = loadRouting(join(kit, 'routing/routing.json'));
const { registry, sources } = loadRegistry(join(kit, 'adapters/pi/models.json'), join(kit, 'adapters/pi/models.local.json'), routing);
const { agents, errors } = loadAgents(join(kit, 'agents'), routing);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
const resolved = resolveAgents(agents, routing, registry);

if (flag('dry-run')) {
  mkdirSync(outDir, { recursive: true });
  const repoRoot = resolve(repo);
  const testCommand = detectTestCommand(repoRoot);
  const baseline = runTests(repoRoot, testCommand);
  const survey = surveyRepo(repoRoot);
  const report = { mode: 'dry-run', registrySources: sources, task, repoRoot, testCommand, baselineTestsPass: baseline.ok, selection: {} };
  const agentName = opt('agent', null); const capability = opt('capability', null);
  const targets = agentName ? [agentName] : ['scout', 'coder'];
  for (const name of targets) {
    const cap = capability ?? agents.find(a => a.meta.name === name)?.meta.capability;
    report.selection[name] = { capability: cap, ...resolveCapability(routing, registry, cap) };
  }
  writeFileSync(join(outDir, 'scout.input.md'), scoutPrompt({ task, survey, testOutput: baseline.ok ? null : baseline.output, testCommand }));
  const packPath = opt('pack', null);
  if (packPath) writeFileSync(join(outDir, 'coder.input.dry-run.md'), coderPrompt({ pack: parseContextPackMarkdown(readFileSync(packPath, 'utf8')), repoRoot }));
  writeFileSync(join(outDir, 'dry-run.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const summary = await runPipeline({ repoRoot: repo, task, routing, registry, agents, invoke: createPiInvoker(), outDir, maxAttempts, packPath: opt('pack', null) });
console.log(JSON.stringify({ outcome: summary.outcome, attempts: summary.attempts, escalated: summary.escalated, escalationCandidate: summary.escalationCandidate, applied: summary.applied, contextPack: summary.contextPack, steps: summary.steps.map(s => ({ step: s.step, attempt: s.attempt, backend: s.backend, modelId: s.modelId, ok: s.ok, reason: s.reason, durationMs: s.durationMs })), trace: join(outDir, 'trace.json') }, null, 2));
process.exitCode = summary.outcome === 'success' ? 0 : 1;
