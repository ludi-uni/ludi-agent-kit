// Subagent execution budget: complexity classification, per-role initial turns,
// deterministic progress evaluation, bounded extension, and timeout classification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTaskComplexity, initialTurnBudget, progressScore, isNoProgressTimeout, COMPLEXITIES } from '../lib/orchestrator/turn-budget.mjs';
import { shouldMarkTaskGlobalFailure, isProtocolFailure, FAILURE_CLASSES } from '../lib/orchestrator/failures.mjs';
import { loadPolicy } from '../lib/orchestrator/policy.mjs';
import { inspectPiEvents } from '../adapters/pi/lib/subagent.mjs';
import { planRules } from '../lib/orchestrator/planner.mjs';
import { loadRouting } from '../lib/routing.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const RT = { max_turns: 12, extension_turns: 8, max_extensions: 2, absolute_max_turns: 32,
  turn_budgets: { default: { simple: 12, normal: 16, heavy: 20, 'repo-history-heavy': 24 }, scout: { simple: 12, normal: 16, heavy: 20, 'repo-history-heavy': 24 }, coder: { simple: 16, normal: 20, heavy: 24, 'repo-history-heavy': 24 } } };

test('default runtime leaves room for bounded tool and turn extensions', () => {
  const { agent_runtime: runtime } = loadPolicy(join(kit, 'orchestration/decision-policy.json')).policy;
  assert.equal(runtime.max_runtime_ms, 1200000);
  assert.equal(runtime.absolute_max_turns, 48);
  assert.equal(runtime.max_extensions, 3);
  assert.equal(runtime.absolute_max_tool_calls, 80);
});

// ---------- complexity classification ----------
test('complexity: simple/normal/heavy/repo-history-heavy', () => {
  assert.equal(classifyTaskComplexity({ title: 'x', goal: 'read one file', kind: 'investigate' }), 'normal');
  assert.equal(classifyTaskComplexity({ title: 'x', goal: 'analyze the commit history and git log for preferences', kind: 'investigate' }), 'repo-history-heavy');
  assert.equal(classifyTaskComplexity({ title: 'x', goal: 'survey across the whole repo and combine multiple modules', kind: 'investigate' }), 'heavy');
});

test('initial turn budget resolves role+complexity with fallbacks', () => {
  assert.equal(initialTurnBudget(RT, 'scout', 'simple'), 12);
  assert.equal(initialTurnBudget(RT, 'scout', 'repo-history-heavy'), 24);
  assert.equal(initialTurnBudget(RT, 'coder', 'heavy'), 24);
  assert.equal(initialTurnBudget(RT, 'unknown-role', 'normal'), 16);   // default
  assert.equal(initialTurnBudget({ max_turns: 12 }, 'scout', 'heavy'), 12); // no budgets -> max_turns
});

// ---------- progress evaluation ----------
test('progressScore: meaningful vs no-progress', () => {
  assert.equal(progressScore({ toolCalls: 0, commands: [] }).meaningful, false);
  assert.equal(progressScore({ toolCalls: 5, uniqueFiles: new Set(['a.js','b.js']), commands: ['git log','cat a'] }).meaningful, true);
  assert.ok(progressScore({ toolCalls: 0 }).score < 0);
});

test('isNoProgressTimeout distinguishes progress from spinning', () => {
  assert.equal(isNoProgressTimeout({ toolCalls: 0 }), true);
  assert.equal(isNoProgressTimeout({ toolCalls: 6, uniqueFiles: new Set(['x']), commands: ['git log'] }), false);
});

// ---------- timeout classification ----------
test('timeout classes exist and classify correctly', () => {
  assert.ok(FAILURE_CLASSES.includes('NO_PROGRESS_TIMEOUT'));
  assert.ok(FAILURE_CLASSES.includes('PROGRESS_TIMEOUT'));
  // protocol failure: no-progress advances candidate, progress is recoverable
  assert.equal(isProtocolFailure('NO_PROGRESS_TIMEOUT'), true);
  assert.equal(isProtocolFailure('PROGRESS_TIMEOUT'), false);
});

test('task-global marking: no-progress yes, progress no', () => {
  assert.equal(shouldMarkTaskGlobalFailure('NO_PROGRESS_TIMEOUT'), false, 'missing telemetry cannot establish no progress');
  assert.equal(shouldMarkTaskGlobalFailure('NO_PROGRESS_TIMEOUT', { toolCalls: 0, structuredProgress: false, hasFinalOutput: false }), true);
  assert.equal(shouldMarkTaskGlobalFailure('PROGRESS_TIMEOUT'), false);
});

// ---------- planner sizing ----------
test('planner splits a multi-concern investigation instead of one giant scout task', () => {
  const p = planRules('コミット履歴から僕の好みを推定して、UXを改善して', { agents });
  const scouts = p.tasks.filter(t => t.agent === 'scout');
  // history + ui concerns -> should produce >1 investigation task (split + synth)
  assert.ok(scouts.length >= 2, `expected split investigation, got ${scouts.length} scout task(s)`);
  // a simple single-concern request stays one scout task
  const simple = planRules('Fix the failing average() test', { agents });
  assert.equal(simple.tasks.filter(t => t.agent === 'scout').length, 1);
});

// ---------- inspectPiEvents telemetry ----------
test('inspectPiEvents captures tool names, unique files, commands', () => {
  const events = [
    { type: 'message_end', message: { role: 'assistant', content: [
      { type: 'toolCall', name: 'ludi_exec', arguments: { command: 'git log --oneline' } },
      { type: 'toolCall', name: 'read', arguments: { path: 'src/app.ts' } },
    ] } },
    { type: 'message_end', message: { role: 'assistant', content: [
      { type: 'toolCall', name: 'read', arguments: { path: 'src/ui.ts' } },
      { type: 'text', text: 'done' },
    ] } },
  ];
  const seen = inspectPiEvents(events);
  assert.equal(seen.turns, 2);
  assert.equal(seen.toolCalls, 3);
  assert.equal(seen.uniqueFilesInspected, 2);
  assert.equal(seen.toolNames.read, 2);
  assert.equal(seen.toolNames.ludi_exec, 1);
  assert.deepEqual(seen.commands, ['git log --oneline']);
});

// ---------- bounded extension semantics ----------
test('bounded extension: no-progress stops, progress extends within absolute max', () => {
  // Simulated: a no-progress agent at turn cap gets NO extension.
  const noProg = progressScore({ toolCalls: 0, commands: [] });
  assert.equal(noProg.meaningful, false); // -> would stop, NO_PROGRESS_TIMEOUT
  // A progressing agent gets extended but capped by absolute_max_turns.
  const cap = RT.absolute_max_turns;
  let turnCap = initialTurnBudget(RT, 'scout', 'repo-history-heavy'); // 24
  let ext = 0;
  while (ext < RT.max_extensions && turnCap < cap) { ext++; turnCap = Math.min(turnCap + RT.extension_turns, cap); }
  assert.equal(turnCap, Math.min(24 + 2 * 8, 32)); // 24 -> 32 (capped), extensions bounded
  assert.ok(turnCap <= RT.absolute_max_turns);
});
