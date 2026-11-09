// Child-side bounds and quiescence evidence for one native leaf.
// Native terminal notifications alone do not prove that timed-out tools stopped.
// The parent additionally requires shutdown=true and pendingTools=0 from this
// required extension before releasing a writer lease. Prompts/arguments are never
// written. A separate bounded final-text snapshot is unaccepted handoff evidence.
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';

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
    let toolCalls = 0, currentTurn = null, stopped = null, shutdown = false, unknownId = 0;
    const pending = new Set();
    const clearSnapshot = () => { if (sidecarPath) try { unlinkSync(`${sidecarPath}.output`); } catch { /* absent */ } };
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
      // Track observed turns only; turn_start itself is not an advisory channel.
      currentTurn = Number.isSafeInteger(event?.turnIndex) && event.turnIndex >= 0 ? event.turnIndex + 1 : null;
      clearSnapshot();
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
      // Advisory only: either resource can run out first. Hard limits and
      // sticky safety blocks are unchanged; preserve the original tool result.
      const remainingTurns = currentTurn == null ? null : Math.max(0, config.maxTurns - currentTurn);
      const toolWarning = toolCalls >= Math.max(1, config.maxToolCalls - 5);
      const turnWarning = remainingTurns != null && remainingTurns <= 3;
      if (!stopped && !shutdown && (toolWarning || turnWarning)) {
        const turns = currentTurn == null ? 'turn usage unknown'
          : `${currentTurn}/${config.maxTurns} turns used; ${remainingTurns} turns remaining after the current turn`;
        return { content: [...(event.content ?? []), { type: 'text', text:
          `LUDI_HANDOFF: ${toolCalls}/${config.maxToolCalls} tool calls used; ${turns}. Reserve the final allowed turn for your final JSON result. Finalize now from collected evidence; do not start broad exploration. If work remains, return status partial with a valid progressReport separating verified work, failed/unverified checks and the next bounded remaining_work. Partial is not acceptance or permission to continue. Do not claim completed after a hard stop.` }] };
      }
    });
    pi.on('message_end', event => {
      const message = event?.message;
      if (message?.role !== 'assistant') return;
      clearSnapshot();
      if (!sidecarPath || shutdown || message?.role !== 'assistant' || !Array.isArray(message.content)
        || message.content.some(c => c.type === 'toolCall')) return;
      const text = message.content.filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
      if (!text.trim() || Buffer.byteLength(text, 'utf8') > 1024 * 1024) return;
      try {
        writeFileSync(`${sidecarPath}.output.tmp`, text, { mode: 0o600 });
        renameSync(`${sidecarPath}.output.tmp`, `${sidecarPath}.output`);
      } catch { /* missing snapshot is never completion or continuation proof */ }
    });
    pi.on('session_shutdown', () => { shutdown = true; persist(); });
    persist();
  };
}
