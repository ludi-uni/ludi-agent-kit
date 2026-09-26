// Tool-capable child: `pi --mode json -p` with an explicit tool allowlist and the shell gate extension.
// Sessions stay out of ~/.pi (`--no-session`). The child id is ours and is recorded on the task trace.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { locatePiEntry } from './invoke.mjs';
import { classifyRun } from '../../../lib/orchestrator/failures.mjs';
import { progressScore } from '../../../lib/orchestrator/turn-budget.mjs';

const shellGate = join(dirname(fileURLToPath(import.meta.url)), '..', 'shell-gate', 'index.js');

export function inspectPiEvents(events) {
  let text = '';
  let error = '';
  let toolCalls = 0;
  let turns = 0;
  const commands = [];
  const toolNames = {};
  const uniqueFiles = new Set();
  for (const event of events) {
    const message = event?.message;
    if (event?.type === 'message_end' && message?.role === 'assistant') {
      turns++;
      if (message.errorMessage) error = String(message.errorMessage);
      for (const part of message.content ?? []) {
        if (part.type === 'text' && part.text) text = part.text;
        if (part.type === 'toolCall') {
          toolCalls++;
          const name = part.name ?? part.toolName ?? 'tool';
          toolNames[name] = (toolNames[name] ?? 0) + 1;
          const command = part.arguments?.command ?? part.args?.command;
          if (command) commands.push(String(command));
          // Track files the tool touched (read/edit/write/grep path args) for progress scoring.
          const fileArg = part.arguments?.path ?? part.arguments?.file ?? part.args?.path ?? part.args?.file;
          if (fileArg) uniqueFiles.add(String(fileArg));
        }
      }
    }
  }
  return { text, error, toolCalls, turns, commands, toolNames, uniqueFilesInspected: uniqueFiles.size, uniqueFiles, successfulToolCalls: toolCalls };
}

export function createPiSubagentRunner(options = {}) {
  return req => runPiSubagent(req, options);
}

export async function runPiSubagent(req, { piEntry = locatePiEntry(), spawnImpl = spawn, timeoutMs = null } = {}) {
  if (!piEntry) return { ok: false, error: 'pi CLI entry not found on PATH', failureClass: 'MODEL_FAILURE' };
  const limits = req.limits ?? {};
  const runtimeMs = timeoutMs ?? limits.max_runtime_ms ?? 600000;
  const childSessionId = `child-${randomBytes(4).toString('hex')}`;
  const startedAt = new Date().toISOString();
  const dir = mkdtempSync(join(tmpdir(), 'ludi-sub-'));
  const promptPath = join(dir, 'task.md');
  writeFileSync(promptPath, req.prompt ?? '');
  const tools = req.toolNames ?? [];
  // Extension discovery stays ON: providers that are registered by pi extensions
  // (e.g. qoder, devin — absent from the static model store) only resolve when their
  // extension has loaded; `--no-extensions` makes `--model` fail with "not found".
  // Kit extensions the child needs are passed explicitly with `-e`.
  const args = [piEntry, '--mode', 'json', '-p', '--no-session', '--no-approve', '--no-skills', '--model', req.modelId];
  if (tools.length) args.push('--tools', tools.join(','));
  else args.push('--no-tools');
  if (tools.includes('ludi_exec')) args.push('-e', shellGate);
  args.push('--system-prompt', req.systemPrompt ?? '', '--', `@${promptPath}`);
  // Execution budget: req.limits carries the RESOLVED initial turn budget for this
  // task's role+complexity (runner computes it). Extension is bounded and only
  // granted while the subagent keeps making meaningful progress — an extension is
  // inside the same model invocation and does NOT consume the attempt budget.
  const initialTurns = limits.max_turns ?? 12;
  const extensionTurns = limits.extension_turns ?? 0;
  const maxExtensions = limits.max_extensions ?? 0;
  const absoluteMax = limits.absolute_max_turns ?? initialTurns;
  let turnCap = initialTurns;
  let extensionsGranted = 0;
  // Live progress for the orchestrator's public activity snapshot. Events are
  // sanitized (tool name / file only — never arguments, output, or prompt text).
  const emit = (type, data = {}) => { try { req.onEvent?.(type, data); } catch { /* never break a child on telemetry */ } };
  let lastTurn = 0;
  const seenTools = new Set();
  const child = {
    taskId: req.taskId ?? null, runId: req.runId ?? null, childSessionId, agent: req.agent ?? null,
    modelId: req.modelId, backend: req.backend ?? null, startedAt, finishedAt: null, status: 'running',
    toolCalls: 0, turns: 0, uniqueFilesInspected: 0, toolNames: {}, extensionsGranted: 0, initialTurns, finalTurnLimit: initialTurns, stopReason: null,
  };
  const events = [];
  let stdout = '';
  let stderr = '';
  try {
    const result = await new Promise(resolvePromise => {
      const proc = spawnImpl(process.execPath, args, {
        cwd: req.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PI_SKIP_VERSION_CHECK: '1', LUDI_SHELL_MODE: req.access?.shell ?? 'false', LUDI_SHELL_NETWORK: req.access?.network ? '1' : '0' },
      });
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(value); } };
      const timer = setTimeout(() => { proc.kill(); finish({ ok: false, error: `child timed out after ${runtimeMs}ms`, failureClass: 'TIMEOUT' }); }, runtimeMs);
      proc.stdout?.setEncoding?.('utf8');
      proc.stderr?.setEncoding?.('utf8');
      proc.stdout?.on?.('data', chunk => {
        stdout += chunk;
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsedLine = JSON.parse(line);
            events.push(parsedLine);
            if (parsedLine?.type === 'tool_execution_start') {
              const key = parsedLine.toolCallId ?? `tool-${events.length}`;
              if (!seenTools.has(key)) {
                seenTools.add(key);
                emit('invocation-tool', { tool: { name: parsedLine.toolName ?? 'tool', file: parsedLine.args?.path ?? parsedLine.args?.file } });
              }
            }
            if (parsedLine?.type === 'tool_execution_end') {
              emit('invocation-tool-completed', { tool: { name: parsedLine.toolName ?? 'tool' } });
            }
          } catch { /* non-json diagnostic */ }
          const seen = inspectPiEvents(events);
          if (seen.turns > lastTurn) { lastTurn = seen.turns; emit('invocation-turn', { turn: seen.turns, turnCap, toolCalls: seen.toolCalls }); }
          if (limits.max_tool_calls && seen.toolCalls > limits.max_tool_calls) { child.stopReason = 'tool-call-limit'; proc.kill(); finish({ ok: false, error: `tool call limit ${limits.max_tool_calls}`, failureClass: 'TIMEOUT', telemetry: seen }); }
          if (seen.turns > turnCap) {
            // Turn cap reached. Evaluate progress deterministically: if the agent is
            // still doing useful work, grant a bounded extension; otherwise stop now.
            const prog = progressScore(seen);
            if (prog.meaningful && extensionsGranted < maxExtensions && turnCap < absoluteMax) {
              extensionsGranted++;
              child.extensionsGranted = extensionsGranted;
              const oldLimit = turnCap;
              turnCap = Math.min(turnCap + extensionTurns, absoluteMax);
              child.finalTurnLimit = turnCap;
              child.lastProgressReasons = prog.reasons;
              emit('invocation-extension', { turn: seen.turns, turnCap, oldLimit, newLimit: turnCap, extensionsGranted, reason: 'meaningful progress' });
            } else {
              child.stopReason = prog.meaningful ? 'absolute-turn-limit' : 'no-progress-turn-limit';
              proc.kill();
              finish({ ok: false, error: `turn limit ${turnCap}`, failureClass: prog.meaningful ? 'PROGRESS_TIMEOUT' : 'NO_PROGRESS_TIMEOUT', telemetry: seen, progress: prog });
            }
          }
        }
      });
      proc.stderr?.on?.('data', chunk => { stderr += chunk; });
      proc.on?.('error', error => finish({ ok: false, error: error.message, failureClass: 'MODEL_FAILURE' }));
      proc.on?.('close', code => {
        if (stdout.trim()) { try { events.push(JSON.parse(stdout)); } catch { /* remainder */ } }
        const seen = inspectPiEvents(events);
        child.toolCalls = seen.toolCalls;
        child.turns = seen.turns;
        child.uniqueFilesInspected = seen.uniqueFilesInspected;
        child.toolNames = seen.toolNames;
        child.commandsExecuted = seen.commands.length;
        const reason = seen.error || stderr.trim();
        if (code !== 0) finish({ ok: false, error: `pi exited ${code}: ${(reason || seen.text || '').slice(-800)}`, failureClass: classifyRun({ error: reason || seen.text }), text: seen.text, telemetry: seen });
        else if (!seen.text.trim()) finish({ ok: false, error: (reason || 'empty model response').slice(-800), failureClass: classifyRun({ error: reason || 'empty model response' }), text: '', telemetry: seen });
        else finish({ ok: true, text: seen.text, toolCalls: seen.toolCalls, turns: seen.turns, commands: seen.commands, telemetry: seen });
      });
    });
    child.finishedAt = new Date().toISOString();
    child.status = result.ok ? 'finished' : 'failed';
    const tel = result.telemetry ?? {};
    child.toolCalls = result.toolCalls ?? tel.toolCalls ?? child.toolCalls;
    child.turns = result.turns ?? tel.turns ?? child.turns;
    child.uniqueFilesInspected = tel.uniqueFilesInspected ?? child.uniqueFilesInspected;
    child.toolNames = tel.toolNames ?? child.toolNames;
    child.commandsExecuted = tel.commands?.length ?? child.commandsExecuted;
    if (!child.stopReason) child.stopReason = result.ok ? 'completed' : (result.failureClass ?? 'failed');
    return { ...result, child };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
