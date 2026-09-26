// Separate process for the concurrent-writer E2E. Not part of node --test.
//   node tests/fixtures/orch-concurrent-child.mjs <db> <label> <tasks> <delayMs> [throwAt]
// Runs `tasks` sequential scout tasks against the shared store, each taking `delayMs`
// so two processes overlap their writes. With `throwAt` the project-store hook throws
// after that task (an exception the main loop does NOT swallow) to exercise
// exception-safe termination.
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRouting } from '../../lib/routing.mjs';
import { loadAgents } from '../../lib/agents.mjs';
import { DEFAULT_POLICY } from '../../lib/orchestrator/policy.mjs';
import { openStore } from '../../lib/orchestrator/store.mjs';
import { orchestrate } from '../../lib/orchestrator/orchestrator.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const REG = { version: 1, backends: {
  local: { provider: 'pl', model: 'ml', thinking: 'off' },
  cheap: { provider: 'pc', model: 'mc', thinking: 'low' },
  sol: { provider: 'ps', model: 'ms', thinking: 'high' },
  codex: { provider: 'px', model: 'mx', thinking: 'high' },
} };
const [storePath, label, tasksArg, delayArg, throwAt] = process.argv.slice(2);
const n = Number(tasksArg ?? 3), delayMs = Number(delayArg ?? 50);
const plan = Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, title: `${label} ${i + 1}`, goal: `g${i + 1}`, agent: 'scout', dependencies: i ? [`t${i}`] : [], acceptance: ['done'] }));
const completed = task => ({ ok: true, structured: true, result: { status: 'completed', summary: `${label} did ${task.id}`, artifacts: [], verification: [], acceptance: [{ id: 'A1', met: true, evidence: 'observed' }], remainingIssues: [], decisions: [], newTasks: [] } });

const session = openStore(storePath);
let exitCode = 0;
try {
  const result = await orchestrate({
    request: `${label} request`, plan, agents, routing, registry: REG, policy: DEFAULT_POLICY, session,
    runner: { async run(task) { await new Promise(r => setTimeout(r, delayMs)); return completed(task); } },
    projectStore: { name: 'inject', async onPlan() {}, async onFinal() {}, async onTaskUpdate(task) { if (throwAt && task.id === throwAt) throw new Error(`${label} injected failure at ${task.id}`); } },
  });
  console.log(JSON.stringify({ label, runId: result.runId, runStatus: result.runStatus, status: result.status, tasks: result.tasks.map(t => t.status) }));
} catch (e) {
  console.log(JSON.stringify({ label, error: e.message, runId: e.runId ?? null, persisted: e.persisted ?? null }));
  exitCode = 3;
} finally {
  try { session.close(); } catch { /* ignore */ }
}
process.exit(exitCode);
