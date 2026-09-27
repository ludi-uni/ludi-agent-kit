// Tool-capable child: `pi --mode json -p` with an explicit tool allowlist and the shell gate extension.
// Sessions stay out of ~/.pi (`--no-session`). The child id is ours and is recorded on the task trace.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { locatePiEntry } from './invoke.mjs';
import { classifyRun } from '../../../lib/orchestrator/failures.mjs';
import { progressScore } from '../../../lib/orchestrator/turn-budget.mjs';

const shellGate = join(dirname(fileURLToPath(import.meta.url)), '..', 'shell-gate', 'index.js');

const commandKey = command => createHash('sha256').update(String(command)).digest('hex');

function createPiEventTracker({ compactCommands = false } = {}) {
  const state = { text: '', error: '', toolCalls: 0, turns: 0, commands: [], toolNames: {},
    uniqueFilesInspected: 0, uniqueFiles: new Set(), successfulToolCalls: 0 };
  return {
    state,
    accept(event) {
      const message = event?.message;
      if (event?.type !== 'message_end' || message?.role !== 'assistant') return state;
      state.turns++;
      if (message.errorMessage) state.error = String(message.errorMessage);
      for (const part of message.content ?? []) {
        if (part.type === 'text' && part.text) state.text = part.text;
        if (part.type !== 'toolCall') continue;
        state.toolCalls++;
        const name = part.name ?? part.toolName ?? 'tool';
        state.toolNames[name] = (state.toolNames[name] ?? 0) + 1;
        const command = part.arguments?.command ?? part.args?.command;
        if (command) state.commands.push(compactCommands ? commandKey(command) : String(command));
        const fileArg = part.arguments?.path ?? part.arguments?.file ?? part.args?.path ?? part.args?.file;
        if (fileArg) state.uniqueFiles.add(String(fileArg));
      }
      state.uniqueFilesInspected = state.uniqueFiles.size;
      state.successfulToolCalls = state.toolCalls; // legacy telemetry; actual successes use tool_execution_end
      return state;
    },
  };
}

export function inspectPiEvents(events) {
  const tracker = createPiEventTracker();
  for (const event of events) tracker.accept(event);
  return tracker.state;
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
  let toolCap = limits.max_tool_calls ?? 40;
  const toolExtension = limits.extension_tool_calls ?? 0;
  const maxToolExtensions = limits.max_tool_extensions ?? 0;
  const absoluteToolMax = limits.absolute_max_tool_calls ?? toolCap;
  let toolExtensionsGranted = 0;
  let toolCheckpoint = { files: new Set(), successCount: 0 };
  let turnCheckpoint = { files: new Set(), successCount: 0 };
  // Live progress for the orchestrator's public activity snapshot. Events are
  // sanitized (tool name / file only — never arguments, output, or prompt text).
  const emit = (type, data = {}) => { try { req.onEvent?.(type, data); } catch { /* never break a child on telemetry */ } };
  let lastTurn = 0;
  const seenTools = new Set();
  const startedTools = new Map();
  const successfulTools = [];
  const progressSince = checkpoint => {
    const completed = successfulTools.slice(checkpoint.successCount);
    const files = completed.map(t => t.path).filter(Boolean);
    const commands = completed.map(t => t.command).filter(Boolean);
    const prog = progressScore({ toolCalls: completed.length,
      uniqueFilesInspected: files.filter(f => !checkpoint.files.has(f)).length, commands });
    const freshWrites = completed.some(t => ['edit', 'write'].includes(t.name));
    const productive = freshWrites || files.some(f => !checkpoint.files.has(f)) ||
      (commands.length > 0 && new Set(commands).size === commands.length);
    return { prog, productive, files };
  };
  const checkpointAfter = (checkpoint, files) => ({ successCount: successfulTools.length, files: new Set([...checkpoint.files, ...files]) });
  const child = {
    taskId: req.taskId ?? null, runId: req.runId ?? null, childSessionId, agent: req.agent ?? null,
    modelId: req.modelId, backend: req.backend ?? null, startedAt, finishedAt: null, status: 'running',
    toolCalls: 0, turns: 0, uniqueFilesInspected: 0, toolNames: {}, extensionsGranted: 0, toolExtensionsGranted: 0, initialTurns, finalTurnLimit: initialTurns, finalToolLimit: toolCap, stopReason: null,
  };
  // Runtime telemetry keeps command fingerprints, not full shell payloads.
  const tracker = createPiEventTracker({ compactCommands: true });
  let unkeyedTools = 0;
  let stdout = '';
  let stderr = '';
  try {
    const result = await new Promise(resolvePromise => {
      const proc = spawnImpl(process.execPath, args, {
        cwd: req.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PI_SKIP_VERSION_CHECK: '1', LUDI_SHELL_MODE: req.access?.shell ?? 'false', LUDI_SHELL_NETWORK: req.access?.network ? '1' : '0' },
      });
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (value.telemetry) value.telemetry = { ...value.telemetry, commands: [...value.telemetry.commands],
          toolNames: { ...value.telemetry.toolNames }, uniqueFiles: new Set(value.telemetry.uniqueFiles) };
        resolvePromise(value);
      };
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
            tracker.accept(parsedLine);
            if (parsedLine?.type === 'tool_execution_start') {
              const key = parsedLine.toolCallId ?? `tool-${++unkeyedTools}`;
              if (parsedLine.toolCallId) startedTools.set(key, {
                name: parsedLine.toolName,
                path: parsedLine.args?.path ?? parsedLine.args?.file,
                command: parsedLine.args?.command ? commandKey(parsedLine.args.command) : undefined,
              });
              if (!seenTools.has(key)) {
                seenTools.add(key);
                emit('invocation-tool', { tool: { name: parsedLine.toolName ?? 'tool', file: parsedLine.args?.path ?? parsedLine.args?.file } });
              }
            }
            if (parsedLine?.type === 'tool_execution_end') {
              const started = startedTools.get(parsedLine.toolCallId);
              if (parsedLine.toolCallId) startedTools.delete(parsedLine.toolCallId);
              if (parsedLine.isError === false && parsedLine.result?.isError !== true && started) successfulTools.push(started);
              emit('invocation-tool-completed', { tool: { name: parsedLine.toolName ?? 'tool' } });
            }
          } catch { /* non-json diagnostic */ }
          const seen = tracker.state;
          if (seen.turns > lastTurn) { lastTurn = seen.turns; emit('invocation-turn', { turn: seen.turns, turnCap, toolCalls: seen.toolCalls }); }
          if (!settled && seen.toolCalls > toolCap) {
            // Only confirmed successful completions count; editing the same file remains progress.
            const { prog, productive, files } = progressSince(toolCheckpoint);
            if (prog.meaningful && productive && toolExtensionsGranted < maxToolExtensions && toolExtension > 0 && toolCap < absoluteToolMax) {
              const oldLimit = toolCap;
              toolCap = Math.min(toolCap + toolExtension, absoluteToolMax);
              toolExtensionsGranted++;
              child.toolExtensionsGranted = toolExtensionsGranted;
              child.finalToolLimit = toolCap;
              toolCheckpoint = checkpointAfter(toolCheckpoint, files);
              emit('invocation-tool-extension', { oldLimit, newLimit: toolCap, toolCalls: seen.toolCalls, toolExtensionsGranted, reason: prog.reasons.join('; ') || 'fresh progress' });
            } else {
              child.stopReason = 'tool-call-limit'; proc.kill(); finish({ ok: false, error: `tool call limit ${toolCap}`, failureClass: 'TIMEOUT', telemetry: seen });
            }
          }
          if (!settled && seen.turns > turnCap) {
            // Evaluate only successful work since the previous turn extension.
            const { prog, productive, files } = progressSince(turnCheckpoint);
            if (prog.meaningful && productive && extensionsGranted < maxExtensions && extensionTurns > 0 && turnCap < absoluteMax) {
              extensionsGranted++;
              child.extensionsGranted = extensionsGranted;
              const oldLimit = turnCap;
              turnCap = Math.min(turnCap + extensionTurns, absoluteMax);
              child.finalTurnLimit = turnCap;
              child.lastProgressReasons = prog.reasons;
              turnCheckpoint = checkpointAfter(turnCheckpoint, files);
              emit('invocation-extension', { turn: seen.turns, turnCap, oldLimit, newLimit: turnCap, extensionsGranted, reason: 'fresh successful progress' });
            } else {
              child.stopReason = prog.meaningful && productive ? 'absolute-turn-limit' : 'no-progress-turn-limit';
              proc.kill();
              finish({ ok: false, error: `turn limit ${turnCap}`, failureClass: prog.meaningful && productive ? 'PROGRESS_TIMEOUT' : 'NO_PROGRESS_TIMEOUT', telemetry: seen, progress: prog });
            }
          }
        }
      });
      proc.stderr?.on?.('data', chunk => { stderr += chunk; });
      proc.on?.('error', error => finish({ ok: false, error: error.message, failureClass: 'MODEL_FAILURE' }));
      proc.on?.('close', code => {
        if (stdout.trim()) { try { tracker.accept(JSON.parse(stdout)); } catch { /* remainder */ } }
        const seen = tracker.state;
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
