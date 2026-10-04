// Minimal executable path: task -> scout -> Context Pack -> coder -> validation -> success | escalation.
// Adapter-agnostic: the caller supplies `invoke({ modelId, provider, model, thinking, systemPrompt, prompt, cwd })`
// returning { ok, text, error?, durationMs }. Nothing here knows provider names.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveCapability } from './resolve.mjs';
import { LANGUAGE_POLICY } from './language-policy.mjs';
import { normalizeContextPack } from './normalize.mjs';
import { toMarkdown, parseContextPackMarkdown } from './context-pack.mjs';
import { resolveRepoPath } from './repo-path.mjs';
import { decideShell } from './orchestrator/shell-policy.mjs';
import { DIRTY_GATE_TYPE, evaluateDirtyGate } from './orchestrator/dirty-gate.mjs';
import { captureWorktree } from './orchestrator/worktree.mjs';

export const DEFAULT_MAX_ATTEMPTS = 2;
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', '.pi']);

// ---------- repository survey (deterministic pre-pass; keeps the scout prompt small) ----------
export function surveyRepo(repoRoot, { maxFiles = 200, maxInlineBytes = 4000, maxTotalInline = 24000 } = {}) {
  const files = [];
  const walk = dir => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      const safe = resolveRepoPath(repoRoot, relative(repoRoot, p));
      if (!safe) continue;
      if (e.isDirectory()) walk(p); else if (statSync(safe).isFile()) files.push(p);
      if (files.length >= maxFiles) return;
    }
  };
  walk(repoRoot);
  const rel = files.map(f => ({ path: relative(repoRoot, f).replace(/\\/g, '/'), size: statSync(resolveRepoPath(repoRoot, relative(repoRoot, f))).size }));
  let budget = maxTotalInline;
  const inline = [];
  for (const f of rel) {
    if (f.size > maxInlineBytes || budget <= 0 || /\.(png|jpg|mp4|wav|lock)$/.test(f.path)) continue;
    const safe = resolveRepoPath(repoRoot, f.path);
    if (!safe) continue;
    const content = readFileSync(safe, 'utf8');
    inline.push({ path: f.path, content });
    budget -= f.size;
  }
  return { files: rel, inline };
}

export function detectTestCommand(repoRoot) {
  const pkg = join(repoRoot, 'package.json');
  if (existsSync(pkg)) {
    const json = JSON.parse(readFileSync(pkg, 'utf8'));
    if (json.scripts?.test) return 'npm test';
  }
  return null;
}

function executionRecord(command, execution_status, output = '') {
  return { ok: false, command: command ?? null, requested_command: command ?? null,
    actual_command: null, execution_status, started: false, status: null, exit_code: null,
    signal: null, error: null, launch_error: null, stdout: '', stderr: '', output };
}

function errorRecord(error) {
  return error ? { name: error.name, message: error.message, code: error.code, errno: error.errno, syscall: error.syscall } : null;
}

function verificationRecord(check) {
  return { ...check, result: check.skipped ? 'skipped' : check.ok ? 'pass' : 'fail' };
}

export function runTests(repoRoot, command, { requestedCommand = command } = {}) {
  const record = (execution_status, output = '') => ({ ...executionRecord(command, execution_status, output), requested_command: requestedCommand ?? null });
  if (!command) return { ...record('skipped', 'no test command'), skipped: true };
  const decision = decideShell(command, { shell: 'limited', network: false });
  if (!decision.allow) return { ...record('not_started', decision.reason), skipped: true, failureClass: 'POLICY_BLOCK' };
  const shell = process.platform === 'win32' ? ['pwsh', ['-NoProfile', '-Command', command]] : ['sh', ['-c', command]];
  // Strip node test-runner context so a nested `node --test` reports to us, not to an outer runner.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST_') && k !== 'NODE_OPTIONS'));
  const invocation = { executable: shell[0], argv: shell[1], cwd: repoRoot };
  let r;
  try { r = spawnSync(shell[0], shell[1], { cwd: repoRoot, encoding: 'utf8', timeout: 120000, windowsHide: true, env }); }
  catch (error) {
    const diagnostic = errorRecord(error);
    return { ...record('launch_failed', error.message), invocation, error: diagnostic, launch_error: diagnostic };
  }
  const started = r.pid > 0;
  const diagnostic = errorRecord(r.error);
  const ok = started && !r.error && r.status === 0;
  const execution_status = !started ? 'launch_failed' : r.error?.code === 'ETIMEDOUT' ? 'timeout' : ok ? 'completed_success' : 'completed_failure';
  const stdout = (r.stdout ?? '').slice(-6000), stderr = (r.stderr ?? '').slice(-6000);
  return { ...record(execution_status), invocation, started, pid: r.pid ?? null,
    actual_command: started ? shell[1].at(-1) : null, ok, status: r.status ?? null, exit_code: r.status ?? null,
    signal: r.signal ?? null, error: diagnostic, launch_error: started ? null : diagnostic,
    stdout, stderr, output: ((r.stdout ?? '') + (r.stderr ?? '')).slice(-6000) || diagnostic?.message || '' };
}

// ---------- prompts ----------
export function scoutPrompt({ task, survey, testOutput, testCommand }) {
  const tree = survey.files.map(f => `- ${f.path} (${f.size} B)`).join('\n');
  const contents = survey.inline.map(f => `### \`${f.path}\`\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n');
  return [
    `Task: ${task}`,
    '', '## Repository files', tree,
    '', '## File contents (bounded)', contents,
    testOutput ? `\n## Failing test output\n\`\`\`\n${testOutput}\n\`\`\`` : '',
    testCommand ? `\n## Test command\n- \`${testCommand}\`` : '',
    '', 'Produce the Context Pack now. Start with the line `# Context Pack`. If the task needs files that do not exist yet,',
    'list them in `## relevant_files` with the reason prefixed by `(new)`. If no existing file is relevant, add',
    '`## discovery` containing `none — <why>`. Use repository-relative paths only.',
    '', 'Write natural-language content (goal, reasons, constraints, notes) in Japanese unless the user requested another language.',
    'CRITICAL: `##` section headings must be the EXACT schema names — `## task`, `## goal`, `## constraints`, `## relevant_files`, `## relevant_snippets`, `## repo_rules`, `## observed_errors`, `## test_commands`, `## previous_attempts`, `## expected_output`. Never translate or annotate a heading (no "## 課題", no "## task Japanese"). Only the prose under each heading is Japanese.',
  ].join('\n');
}

export function coderPrompt({ pack, repoRoot }) {
  const files = pack.relevant_files.map(f => {
    const p = resolveRepoPath(repoRoot, f.path);
    if (!p) throw new Error(`relevant file ${f.path} is outside the repository or cannot be resolved safely`);
    return existsSync(p) ? `### \`${f.path}\`\n\`\`\`\n${readFileSync(p, 'utf8')}\n\`\`\`` : `### \`${f.path}\` (does not exist yet${f.create ? '; you may create it' : ''})`;
  }).join('\n\n');
  return [
    toMarkdown(pack),
    '', '## Current contents of relevant_files', files,
    '', 'Return the complete new contents of every file you change using exactly this format and nothing else:',
    '=== FILE: <repo-relative path> ===', '<full file content>', '=== END ===',
    'Only paths listed in relevant_files may be changed or created. Do not explain.',
    '', 'Any prose you must include (commit-style notes, comments) should be in Japanese unless the user requested another language; code and file contents stay as-is.',
  ].join('\n');
}

export function parseFileBlocks(text) {
  const blocks = [];
  const re = /=== FILE: (.+?) ===\r?\n([\s\S]*?)\r?\n=== END ===/g;
  let m;
  while ((m = re.exec(text))) blocks.push({ path: m[1].trim().replace(/\\/g, '/'), content: m[2] });
  return blocks;
}

export function applyFileBlocks(repoRoot, blocks, allowed) {
  const applied = [], rejected = [];
  const allow = new Set(allowed.map(f => f.path));
  for (const b of blocks) {
    if (!allow.has(b.path)) { rejected.push(b.path); continue; }
    const target = resolveRepoPath(repoRoot, b.path);
    if (!target) { rejected.push(b.path); continue; }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, b.content.endsWith('\n') ? b.content : b.content + '\n');
    applied.push(b.path);
  }
  return { applied, rejected };
}

// ---------- escalation core ----------
/**
 * Try `fn(candidate)` on the capability chain: primary, then fallback[0], ... bounded by maxAttempts.
 * The same modelId is never tried twice. Each failure is appended to pack.previous_attempts.
 * Optional hooks: `skip(candidate)` returns a reason to pass over a candidate without spending an attempt
 * (e.g. a backend known to be out of quota); `onFailure(candidate, reason)` observes each failed attempt.
 */
export async function withEscalation({ routing, registry, capability, agent, pack, maxAttempts = DEFAULT_MAX_ATTEMPTS, trace, fn, skip = null, onFailure = null, excludeModels = null, taskGlobalFailedModels = null, invocationsBudget = null }) {
  const resolved = resolveCapability(routing, registry, capability);
  if (!resolved.candidates.length) throw new Error(`no bound model for capability "${capability}" (unbound=${resolved.unbound.join(',')}, placeholder=${resolved.placeholder.join(',')})`);
  // Candidates already tried (and failed) on earlier attempts of this task are
  // passed in via excludeModels so a retried task advances to a NEW candidate
  // instead of restarting at candidate[0]. They are recorded as skipped, not run.
  //
  // Counter semantics (attempt budget applies to invocationsStarted only):
  //   candidatesConsidered = every candidate the loop looked at
  //   candidatesSkipped    = health/availability/already-tried skips (NO invocation)
  //   invocationsStarted   = candidates actually invoked (attempt budget unit)
  //   invokedModels        = modelIds actually invoked this call (NOT excludeModels)
  const alreadyTried = new Set(excludeModels ?? []);
  const globallyFailed = new Set(taskGlobalFailedModels ?? []);
  const invokedSet = new Set(); // dedup within this call: identical modelId on two backends runs once
  const invokedModels = [];
  const skipped = [];
  let last = null, attempts = 0, i = 0, considered = 0;
  // The capability is freshly resolved each call. Filter task-global failures
  // before the first invocation, including candidates after an early success.
  const eligible = resolved.candidates.filter(c => {
    if (!globallyFailed.has(c.modelId)) return true;
    considered++;
    skipped.push({ backend: c.backend, modelId: c.modelId, reason: 'task-global-failed' });
    trace.push({ step: agent, agent, capability, backend: c.backend, provider: c.provider, model: c.model, modelId: c.modelId, skipped: true, ok: false, reason: 'task-global-failed', startedAt: new Date().toISOString(), durationMs: 0 });
    return false;
  });
  // invocationsBudget caps ACTUAL invocations across the whole task (not just this
  // call), so a retried task cannot overspend max_total_attempts_per_task.
  const invocationsLeft = () => (invocationsBudget == null ? Infinity : invocationsBudget - invokedModels.length);
  for (; i < eligible.length && attempts < maxAttempts && invocationsLeft() > 0; i++) {
    const c = eligible[i];
    considered++;
    if (alreadyTried.has(c.modelId) || invokedSet.has(c.modelId)) { const reason = 'already-tried'; skipped.push({ backend: c.backend, modelId: c.modelId, reason }); trace.push({ step: agent, agent, capability, backend: c.backend, provider: c.provider, model: c.model, modelId: c.modelId, skipped: true, ok: false, reason, startedAt: new Date().toISOString(), durationMs: 0 }); continue; }
    const why = skip?.(c);
    if (why) {
      skipped.push({ backend: c.backend, modelId: c.modelId, reason: why });
      trace.push({ step: agent, agent, capability, backend: c.backend, provider: c.provider, model: c.model, modelId: c.modelId, skipped: true, ok: false, reason: why, startedAt: new Date().toISOString(), durationMs: 0 });
      continue;
    }
    invokedSet.add(c.modelId);
    invokedModels.push(c.modelId);
    const attempt = attempts++;
    const entry = { step: agent, attempt: attempt + 1, agent, capability, backend: c.backend, provider: c.provider, model: c.model, thinking: c.thinking, modelId: c.modelId, degraded: c.degraded, startedAt: new Date().toISOString() };
    const started = Date.now();
    try {
      const result = await fn(c, attempt);
      entry.durationMs = Date.now() - started;
      entry.ok = result.ok;
      entry.reason = result.reason;
      if (result.protocolFailure) entry.protocolFailure = result.protocolFailure; // model-quality failure for task-global marking
      if (result.failureClass) entry.failureClass = result.failureClass;
      // Per-candidate execution telemetry — preserved on the step so a later
      // candidate's record never overwrites an earlier one (e.g. Devin's run is
      // kept even when a subsequent candidate also runs).
      if (result.child) entry.child = result.child;
      if (result.telemetry) entry.telemetry = result.telemetry;
      if (result.verification) entry.verification = result.verification;
      trace.push(entry);
      if (result.ok) return { ok: true, candidate: c, result, attempts: attempt + 1, escalated: attempt > 0, skipped, invokedModels, counters: { candidatesConsidered: considered, candidatesSkipped: skipped.length, invocationsStarted: invokedModels.length } };
      last = result;
    } catch (e) {
      entry.durationMs = Date.now() - started; entry.ok = false; entry.reason = e.message; trace.push(entry);
      last = { ok: false, reason: e.message };
    }
    onFailure?.(c, String(last.reason ?? 'failed'));
    pack.previous_attempts = pack.previous_attempts ?? [];
    pack.previous_attempts.push({ summary: `${agent} on backend ${c.backend} (${c.modelId}) attempt ${attempt + 1}`, outcome: String(last.reason ?? 'failed').slice(0, 400) });
  }
  const counters = { candidatesConsidered: considered, candidatesSkipped: skipped.length, invocationsStarted: invokedModels.length };
  if (!attempts && skipped.length) {
    return { ok: false, attempts: 0, unavailable: true, exhausted: true, escalationCandidate: null, skipped, invokedModels, counters, last: { ok: false, reason: `all model candidates unavailable: ${skipped.map(s => `${s.modelId} (${s.reason})`).join('; ')}` } };
  }
  const next = eligible[i];
  return { ok: false, attempts, exhausted: !next, escalationCandidate: next ? { backend: next.backend, modelId: next.modelId } : null, last, skipped, invokedModels, counters };
}

// Preserve the parsed request BEFORE the existing normalizer rewrites in-repo
// absolute command arguments. The execution policy still checks only what runs.
function normalizePipelinePack(input, options) {
  const original = typeof input === 'string' ? parseContextPackMarkdown(input, { lenient: true }) : input;
  return { ...normalizeContextPack(original, options), requestedTestCommand: original.test_commands?.[0] };
}

// ---------- full pipeline ----------
// Shared pre-mutation gate, including the legacy CLI's validation-only path.
// Context carries the EXISTING path-keyed approval / agent-owned-path contract,
// not a blanket force flag. A direct call is safe without caller-side checks.
export function inspectPipelineGate(repoRoot, { ownedPaths = [], decisions = [] } = {}) {
  const g = evaluateDirtyGate({ before: captureWorktree(resolve(repoRoot)), ownedPaths, decisions });
  if (!g.gate || g.action === 'proceed') return null;
  return { outcome: 'worktree-dirty', failureClass: g.action === 'ask' ? 'USER_DECISION_REQUIRED' : 'POLICY_BLOCK',
    abort: g.action === 'abort', error: g.action === 'ask' ? 'workspace has pre-existing uncommitted changes; explicit approval is required' : 'implementation aborted by user decision',
    decision: g.decision, gate: { type: DIRTY_GATE_TYPE, key: g.key, action: g.action, paths: g.paths },
    steps: [], verification: [], executionAttempts: [] };
}

export async function runPipeline({ repoRoot, task, routing, registry, agents, invoke, outDir, maxAttempts = DEFAULT_MAX_ATTEMPTS, skipScout = false, packPath = null, health = null, dirtyContext = {} }) {
  const hooks = health ? { skip: health.skip, onFailure: health.report } : {};
  repoRoot = resolve(repoRoot);
  const refusal = inspectPipelineGate(repoRoot, dirtyContext);
  if (refusal) return { task, repoRoot, ...refusal }; // no directory, baseline, model or trace writes
  mkdirSync(outDir, { recursive: true });
  const trace = [];
  const byName = Object.fromEntries(agents.map(a => [a.meta.name, a]));
  const scoutAgent = byName.scout, coderAgent = byName.coder;
  if (!scoutAgent || !coderAgent) throw new Error('pipeline requires scout and coder agents');
  const testCommand = detectTestCommand(repoRoot);
  const baseline = runTests(repoRoot, testCommand);
  const baselineVerification = verificationRecord(baseline);
  const summary = { task, repoRoot, testCommand, baselineTestsPass: baseline.ok, baselineVerification, steps: trace,
    executionAttempts: [{ phase: 'baseline', ...baselineVerification }] };

  // ---- scout -> Context Pack ----
  let pack, requestedTestCommand;
  if (packPath) {
    const n = normalizePipelinePack(readFileSync(packPath, 'utf8'), { repoRoot, task, capability: coderAgent.meta.capability });
    if (n.errors.length) throw new Error(`supplied Context Pack invalid: ${n.errors.join('; ')}`);
    pack = n.pack;
    requestedTestCommand = n.requestedTestCommand;
    summary.scoutNormalizerReport = n.report;
    summary.packSource = packPath;
    if (testCommand && !(pack.test_commands ?? []).length) pack.test_commands = [testCommand];
  } else if (skipScout) {
    throw new Error('skipScout requires packPath');
  } else {
    const survey = surveyRepo(repoRoot);
    const prompt = scoutPrompt({ task, survey, testOutput: baseline.ok ? null : baseline.output, testCommand });
    const scout = await withEscalation({
      routing, registry, capability: scoutAgent.meta.capability, agent: 'scout', pack: { previous_attempts: [] }, maxAttempts, trace, ...hooks,
      fn: async c => {
        const r = await invoke({ ...c, systemPrompt: scoutAgent.body, prompt, cwd: repoRoot });
        if (!r.ok) return { ok: false, reason: r.error ?? 'invoke failed' };
        writeFileSync(join(outDir, `scout.output.${c.backend}.md`), r.text);
        let n;
        try { n = normalizePipelinePack(r.text, { repoRoot, task, capability: coderAgent.meta.capability, producedBy: `scout@${c.modelId}` }); }
        catch (e) { return { ok: false, reason: `scout output not a Context Pack: ${e.message}` }; }
        if (n.errors.length) return { ok: false, reason: `Context Pack invalid: ${n.errors.join('; ')}` };
        if (testCommand && !(n.pack.test_commands ?? []).length) n.pack.test_commands = [testCommand];
        return { ok: true, reason: 'context pack produced', pack: n.pack, requestedTestCommand: n.requestedTestCommand, report: n.report, raw: r.text };
      },
    });
    if (!scout.ok) { summary.outcome = 'scout-failed'; summary.escalationCandidate = scout.escalationCandidate; writeOut(outDir, summary); return summary; }
    pack = scout.result.pack;
    requestedTestCommand = scout.result.requestedTestCommand;
    summary.scoutNormalizerReport = scout.result.report;
    writeFileSync(join(outDir, 'scout.raw.md'), scout.result.raw);
  }
  // Model-supplied commands are untrusted. Refuse them before invoking the coder
  // or applying any files, and never let a supplemental command replace the
  // repository's detected test suite. Keep the existing first-command behavior.
  const testCommands = [...new Set([testCommand, pack.test_commands?.[0]].filter(Boolean))];
  const requestedFor = command => command === pack.test_commands?.[0] ? requestedTestCommand ?? command : command;
  const refused = testCommands.map(command => ({ command, ...decideShell(command, { shell: 'limited', network: false }) })).find(d => !d.allow);
  if (refused) {
    summary.outcome = 'policy-blocked'; summary.failureClass = 'POLICY_BLOCK';
    summary.error = `test command refused: ${refused.reason}`;
    summary.verification = [{ ...verificationRecord(runTests(repoRoot, refused.command, { requestedCommand: requestedFor(refused.command) })), reason: refused.reason }];
    summary.executionAttempts.push({ phase: 'prevalidation', ...summary.verification[0] });
    writeOut(outDir, summary); return summary;
  }
  summary.verification = [];
  const packFile = join(outDir, 'context-pack.md');
  writeFileSync(packFile, toMarkdown(pack));
  summary.contextPack = packFile;
  summary.contextPackFiles = pack.relevant_files.map(f => f.path);

  // ---- coder -> apply -> validate, with escalation ----
  const coder = await withEscalation({
    routing, registry, capability: coderAgent.meta.capability, agent: 'coder', pack, maxAttempts, trace, ...hooks,
    fn: async (c, attempt) => {
      summary.verification = []; // a later exception must not leave an earlier PASS current
      const prompt = coderPrompt({ pack, repoRoot });
      writeFileSync(join(outDir, `coder.input.${c.backend}.md`), `<!-- system -->\n${coderAgent.body}\n\n<!-- user -->\n${prompt}`);
      const r = await invoke({ ...c, systemPrompt: coderAgent.body, prompt, cwd: repoRoot });
      if (!r.ok) return { ok: false, reason: r.error ?? 'invoke failed' };
      writeFileSync(join(outDir, `coder.output.${c.backend}.md`), r.text);
      const blocks = parseFileBlocks(r.text);
      if (!blocks.length) return { ok: false, reason: 'coder returned no FILE blocks' };
      const { applied, rejected } = applyFileBlocks(repoRoot, blocks, pack.relevant_files);
      if (!applied.length) return { ok: false, reason: `all ${rejected.length} file blocks rejected (outside relevant_files)` };
      const checks = [];
      for (const command of testCommands.length ? testCommands : [null]) {
        const check = runTests(repoRoot, command, { requestedCommand: requestedFor(command) });
        checks.push(check);
        summary.executionAttempts.push({ phase: 'verification', attempt: attempt + 1, ...verificationRecord(check) });
        if (!check.ok) break;
      }
      summary.verification = checks.map(verificationRecord);
      const tests = checks.at(-1);
      if (!tests.ok) {
        pack.observed_errors = [tests.output.slice(-2000)];
        return { ok: false, reason: `tests failed after applying ${applied.join(', ')}`, applied, rejected, tests, verification: summary.verification };
      }
      return { ok: true, reason: 'tests pass', applied, rejected, tests, verification: summary.verification };
    },
  });
  summary.outcome = coder.ok ? 'success' : (coder.exhausted ? 'exhausted' : 'escalation-candidate');
  summary.escalated = coder.escalated ?? false;
  summary.attempts = coder.attempts;
  summary.escalationCandidate = coder.escalationCandidate ?? null;
  summary.applied = coder.result?.applied ?? coder.last?.applied ?? null;
  writeFileSync(packFile, toMarkdown(pack)); // includes previous_attempts / observed_errors updates
  writeOut(outDir, summary);
  return summary;
}

function writeOut(outDir, summary) {
  writeFileSync(join(outDir, 'trace.json'), JSON.stringify(summary, null, 2));
}
