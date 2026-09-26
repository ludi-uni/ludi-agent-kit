// Opt-in real E2E through the installed pi CLI and the machine-local model registry.
// Not part of `node --test`; it spends real model quota. Run:
//   node tests/e2e-real-pi.mjs
// Requires user-level (or legacy package-local) models.local.json with ready providers (`pi auth check --provider <p>`).
import { mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadRouting } from '../lib/routing.mjs';
import { loadPiRegistry } from '../adapters/pi/lib/model-registry.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { runPipeline, runTests } from '../lib/pipeline.mjs';
import { createPiInvoker } from '../adapters/pi/lib/invoke.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { registry } = loadPiRegistry(kit, routing);
const { agents } = loadAgents(join(kit, 'agents'), routing);
const repo = mkdtempSync(join(tmpdir(), 'ludi-real-e2e-'));
cpSync(join(kit, 'tests/fixtures/math-repo'), repo, { recursive: true });
assert.equal(runTests(repo, 'npm test').ok, false, 'fixture must start red');
const summary = await runPipeline({ repoRoot: repo, task: 'Fix the failing average() test in this repository', routing, registry, agents, invoke: createPiInvoker(), outDir: join(repo, '.pipeline-out') });
console.log(JSON.stringify({ outcome: summary.outcome, steps: summary.steps.map(s => ({ step: s.step, backend: s.backend, modelId: s.modelId, ok: s.ok, durationMs: s.durationMs })), applied: summary.applied, out: join(repo, '.pipeline-out') }, null, 2));
assert.equal(summary.outcome, 'success');
assert.equal(runTests(repo, 'npm test').ok, true);
console.log('PASS: real pi E2E');
