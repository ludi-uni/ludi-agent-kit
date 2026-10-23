// Child-side bounds and quiescence evidence for one native leaf.
// Native terminal notifications alone do not prove that timed-out tools stopped.
// The parent additionally requires shutdown=true and pendingTools=0 from this
// required extension before releasing a writer lease. No prompts/arguments/output
// are written to the private per-attempt sidecar.
import { writeFileSync, renameSync } from 'node:fs';

export const GUARD_TOOL = 'ludi_guard';
const EMPTY_PARAMS = { type: 'object', properties: {}, additionalProperties: false };

export function createNativeGuard(config = {}) {
  if (!Number.isSafeInteger(config.maxTurns) || config.maxTurns <= 0
    || !Number.isSafeInteger(config.maxToolCalls) || config.maxToolCalls < 0) {
    throw new Error('native guard の実行予算が不正です');
  }
  const allowed = new Set(config.allowedTools ?? []);
  const sidecarPath = config.sidecarPath;
  return function nativeGuard(pi) {
    let toolCalls = 0, stopped = null, shutdown = false, unknownId = 0;
    const pending = new Set();
    const persist = () => {
      if (!sidecarPath) return;
      // A failed write is not proof: the parent will conservatively retain the lease.
      try {
        writeFileSync(`${sidecarPath}.tmp`, JSON.stringify({ version: 1, reason: stopped,
          toolCalls, pendingTools: pending.size, shutdown, observedAt: new Date().toISOString() }), { mode: 0o600 });
        renameSync(`${sidecarPath}.tmp`, sidecarPath);
      } catch { /* absence/stale state fails closed in the parent */ }
    };
    const stop = reason => { if (!stopped) stopped = reason; persist(); };
    const abort = ctx => { try { ctx?.abort?.(); } catch { /* sticky tool blocks remain */ } };
    pi.registerTool({
      name: GUARD_TOOL, label: 'Ludi native guard', exposure: 'hidden',
      description: 'Internal launch-guard sentinel. Never call this tool.',
      parameters: EMPTY_PARAMS,
      async execute() { return { content: [{ type: 'text', text: 'guard active' }], details: undefined }; },
    });
    pi.on('turn_start', (event, ctx) => {
      if (shutdown || stopped) { abort(ctx); return; }
      if ((event?.turnIndex ?? -1) >= config.maxTurns) { stop('turn-limit'); abort(ctx); }
    });
    pi.on('tool_call', (event, ctx) => {
      const refuse = reason => {
        stop(reason); abort(ctx);
        return { block: true, terminate: true, reason: `native guard: ${stopped ?? reason}` };
      };
      if (shutdown || stopped) return refuse(stopped ?? 'shutdown');
      if (!allowed.has(event?.toolName)) return refuse('tool-not-allowed');
      if (toolCalls >= config.maxToolCalls) return refuse('tool-call-limit');
      toolCalls++;
      // Unknown IDs cannot prove completion: retain until host death rather than
      // accidentally matching another parallel tool's result.
      pending.add(typeof event.toolCallId === 'string' ? event.toolCallId : `unknown-${++unknownId}`);
      persist();
    });
    pi.on('tool_result', event => {
      if (typeof event?.toolCallId === 'string') pending.delete(event.toolCallId);
      persist();
    });
    pi.on('session_shutdown', () => { shutdown = true; persist(); });
    persist();
  };
}
