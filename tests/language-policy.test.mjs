// Language policy: Japanese is the default for user-facing output across all agents,
// applied once at the shared prompt layer — never per-provider, never per-agent-file.
// Schema keys/enums stay English; explicit user language requests override.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGE_POLICY, withLanguagePolicy } from '../lib/language-policy.mjs';
import { loadAgents } from '../lib/agents.mjs';
import { loadRouting } from '../lib/routing.mjs';
import { buildTaskContract } from '../lib/orchestrator/contract.mjs';
import { scoutPrompt, coderPrompt } from '../lib/pipeline.mjs';
import { formatReport } from '../lib/orchestrator/orchestrator.mjs';
import { parseStructuredResult } from '../lib/orchestrator/runner.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routing = loadRouting(join(kit, 'routing/routing.json'));
const { agents } = loadAgents(join(kit, 'agents'), routing);
const names = agents.map(a => a.meta.name);

// --- policy presence ----------------------------------------------------------
test('every agent system prompt carries the shared Japanese-default language policy', () => {
  for (const a of agents) {
    assert.ok(a.body.includes('Default response language: Japanese'), `${a.meta.name} missing language policy`);
    assert.ok(a.body.includes('Japanese'), a.meta.name);
  }
  // the seven required agents are all covered
  for (const n of ['scout', 'coder', 'tester', 'reviewer', 'browser', 'orchestrator', 'visual']) {
    assert.ok(names.includes(n), `agent ${n} loaded`);
  }
});

test('policy is applied once at the shared layer, not duplicated per agent file', () => {
  // the raw agent .md files do NOT contain the policy — it is injected by loadAgents
  for (const a of agents) {
    const raw = readFileSync(join(kit, 'agents', a.file), 'utf8');
    assert.ok(!raw.includes('Default response language'), `${a.file} hardcodes the policy`);
  }
});

// --- structured output: keys/enums stay English, values Japanese ----------------
test('structured result: schema keys/enums stay English, natural-language value is Japanese', () => {
  const text = '```json\n{"status":"completed","summary":"主要なエントリーポイントは src/main.ts です。","acceptance":[{"id":"A1","met":true,"evidence":"testを実行して確認"}]}\n```';
  const p = parseStructuredResult(text);
  assert.equal(p.structured, true);
  assert.equal(p.result.status, 'completed'); // enum not translated
  assert.match(p.result.summary, /エントリーポイント/); // value is Japanese
});

test('result contract instructs Japanese values with English keys/enums', () => {
  const c = buildTaskContract({ id: 't', title: 'x', goal: 'y', acceptance: ['done'] }, {});
  assert.match(c, /LANGUAGE/);
  assert.match(c, /Japanese/);
  assert.match(c, /never translate/i);
});

// --- prompts --------------------------------------------------------------------
test('scout and coder prompts carry the Japanese instruction', () => {
  const survey = { files: [], inline: [] };
  assert.match(scoutPrompt({ task: 'x', survey }), /Japanese/);
  const pack = { task: 't', goal: 'g', constraints: [], relevant_files: [], expected_output: 'x' };
  assert.match(coderPrompt({ pack, repoRoot: kit }), /Japanese/);
});

// --- orchestrator report --------------------------------------------------------
test('orchestrator final report is Japanese', () => {
  const report = formatReport({ status: 'completed', runId: 'r1', runStatus: 'completed', rounds: 1, tasks: [{ id: 't1', title: 'task', status: 'completed', result: { summary: 'done' } }], autoDecisions: [], unresolved: [], escalations: [], errors: [], limitsHit: [] });
  assert.match(report, /状態:/);
  assert.match(report, /完了:/);
  assert.match(report, /未解決:/);
  assert.match(report, /ユーザー判断が必要:/);
});

// --- explicit language override -------------------------------------------------
test('explicit user language request overrides the Japanese default', () => {
  // the policy itself states the override — it is a default, not a mandate
  assert.match(LANGUAGE_POLICY, /Unless the user explicitly requests another language/);
  assert.match(LANGUAGE_POLICY, /explicitly requests/);
});

// --- provider independence ------------------------------------------------------
test('language policy is provider-agnostic (single shared layer)', () => {
  // withLanguagePolicy wraps any body the same way regardless of which provider
  // the resolved model belongs to — no provider branching anywhere.
  const wrapped = withLanguagePolicy('# Agent\nDo work.');
  assert.ok(wrapped.endsWith(LANGUAGE_POLICY));
  assert.ok(wrapped.startsWith('# Agent'));
  // no provider names anywhere in the policy
  for (const p of ['qoder', 'devin', 'openai', 'freetoken', 'codex']) {
    assert.ok(!LANGUAGE_POLICY.toLowerCase().includes(p), `policy mentions provider ${p}`);
  }
});
