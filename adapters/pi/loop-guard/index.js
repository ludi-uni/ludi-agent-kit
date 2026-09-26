import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep fingerprints, never tool output or commands, in bounded session memory.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export default function loopGuard(pi) {
  const policy = readFileSync(resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '../../../rules/loop-prevention.md'), 'utf8').trim();
  let history = [], halted = false;
  const reset = () => { history = []; halted = false; };
  pi.on('session_start', reset);
  pi.on('model_select', reset);
  pi.on('input', event => {
    // An automatic goal/follow-up must not silently bypass a tripped guard.
    if (event.source === 'interactive' || event.source === 'rpc') reset();
  });
  pi.on('before_agent_start', event => {
    return { systemPrompt: event.systemPrompt.includes(policy) ? event.systemPrompt : event.systemPrompt + '\n\n' + policy };
  });
  pi.on('tool_call', (_event, ctx) => {
    if (halted) return { block: true, terminate: true, reason: 'Loop guard: stopped after repeated identical tool results. Wait for new user input.' };
  });
  pi.on('tool_result', (event, ctx) => {
    if (halted) return;
    const key = fingerprint([event.toolName, event.input]);
    const output = fingerprint([event.content, Boolean(event.isError)]);
    history.push({ key, output });
    if (history.length > 12) history.shift();
    let repeats = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].key !== key) continue;
      if (history[i].output !== output) break;
      repeats++;
    }
    if (repeats < 3) return;
    halted = true;
    ctx.abort();
    pi.sendMessage({
      customType: 'loop-guard', display: true,
      content: `反復を停止しました。直近12件の結果中、同じ${event.toolName}入力から同じ結果が3回続きました。既存の結果を確認し、調査方針を変えて新しい指示を送ってください。自動再開は行いません。`,
    }, { triggerTurn: false });
  });
}
