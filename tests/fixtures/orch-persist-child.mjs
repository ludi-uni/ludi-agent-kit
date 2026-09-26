// Separate process for the persistent-orchestration restart test. Not part of node --test.
//   node tests/fixtures/orch-persist-child.mjs start <db>
//   node tests/fixtures/orch-persist-child.mjs resume <db> <runId> [decisionId]
//   node tests/fixtures/orch-persist-child.mjs crash <db> <marker>
import { writeFileSync } from 'node:fs';
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
  astra: { provider: 'pa', model: 'ma', thinking: 'medium', vision: true },
  codex: { provider: 'px', model: 'mx', thinking: 'high' },
} };
const phase = process.argv[2];
const storePath = process.argv[3];
const spec = (id, agent, dependencies = []) => ({ id, title: `task ${id}`, goal: `goal ${id}`, agent, dependencies, acceptance: ['done'] });
const completed = task => ({ ok: true, structured: true, result: { status: 'completed', summary: `did ${task.id}`, artifacts: [], verification: [], acceptance: [{ id: 'A1', met: true, evidence: 'observed' }], remainingIssues: [], decisions: [], newTasks: [] } });
const ask = { key: 'keep', question: 'Keep the existing approach?', flags: ['user_value_judgement'], options: [{ id: 'yes', summary: 'existing approach' }, { id: 'no', summary: 'new approach' }] };
const blocked = () => ({ ok: true, structured: true, result: { status: 'blocked', summary: 'need a choice', artifacts: [], verification: [], acceptance: [], remainingIssues: [], decisions: [ask], newTasks: [] } });

const session = openStore(storePath);
try {
  if (phase === 'start') {
    const result = await orchestrate({
      request: 'continue the work', plan: [spec('t1', 'scout'), spec('t2', 'coder', ['t1']), spec('t3', 'reviewer', ['t2'])],
      agents, routing, registry: REG, policy: DEFAULT_POLICY, session,
      runner: { async run(task) { return task.id === 't2' && !(task.decisions ?? []).length ? blocked() : completed(task); } },
    });
    console.log(JSON.stringify({ runId: result.runId, decisionId: result.escalations[0]?.id, runStatus: result.runStatus, tasks: result.tasks.map(t => ({ id: t.id, status: t.status, attempts: t.attempts })) }));
  } else if (phase === 'resume') {
    const calls = [];
    const decisionId = process.argv[5];
    const answers = decisionId && decisionId !== '-' ? [{ decisionId, answer: 'yes' }] : [];
    const result = await orchestrate({
      request: '', resumeRunId: process.argv[4], answers, agents, routing, registry: REG, policy: DEFAULT_POLICY, session,
      runner: { async run(task) { calls.push({ id: task.id, attempt: task.attempts }); return completed(task); } },
    });
    console.log(JSON.stringify({ status: result.status, runStatus: result.runStatus, calls, tasks: result.tasks.map(t => ({ id: t.id, status: t.status, attempts: t.attempts })) }));
  } else if (phase === 'crash') {
    const marker = process.argv[4];
    await orchestrate({
      request: 'crash me', plan: [spec('t1', 'scout')], agents, routing, registry: REG, policy: DEFAULT_POLICY, session,
      runner: { async run(task) { writeFileSync(marker, JSON.stringify({ id: task.id, attempts: task.attempts, status: task.status })); process.exit(99); } },
    });
  } else {
    console.error(`unknown phase ${phase}`);
    process.exit(2);
  }
} finally {
  try { session.close(); } catch { /* process.exit skips this */ }
}
