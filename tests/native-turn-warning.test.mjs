// Deterministic guard probes only. No provider, child process or live run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeGuard } from '../adapters/pi/lib/native-guard.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ludi-turn-warning-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const handlers = {};
  const path = join(dir, 'stop.json');
  let aborts = 0;
  createNativeGuard({ maxTurns: 24, maxToolCalls: 40, allowedTools: ['read'], sidecarPath: path })({
    on: (name, fn) => { handlers[name] = fn; }, registerTool() {},
  });
  return { handlers, ctx: { abort() { aborts++; } }, aborts: () => aborts,
    state: () => JSON.parse(readFileSync(path, 'utf8')) };
}
function tool(f, id) {
  assert.equal(f.handlers.tool_call({ toolName: 'read', toolCallId: id }, f.ctx), undefined);
  return f.handlers.tool_result({ toolCallId: id, content: [{ type: 'text', text: 'observed evidence' }] });
}

test('sparse tools warn with 3 turns left, preserve evidence, and still stop before the 25th turn', t => {
  const f = fixture(t);
  let warnings = 0;
  for (let i = 0; i < 24; i++) {
    assert.equal(f.handlers.turn_start({ turnIndex: i }, f.ctx), undefined);
    const result = tool(f, `read-${i}`);
    if (i < 20) assert.equal(result, undefined);
    else {
      warnings++;
      assert.equal(result.content[0].text, 'observed evidence');
      assert.match(result.content[1].text, new RegExp(`${i + 1}/24 turns used; ${23 - i} turns remaining`));
      assert.match(result.content[1].text, /Reserve the final allowed turn/);
      assert.match(result.content[1].text, /verified work, failed\/unverified checks/);
    }
  }
  assert.equal(warnings, 4);
  assert.equal(f.aborts(), 0);
  assert.equal(f.state().toolCalls, 24);
  assert.equal(f.handlers.turn_start({ turnIndex: 24 }, f.ctx), undefined);
  assert.equal(f.aborts(), 1);
  assert.equal(f.state().reason, 'turn-limit');
  f.handlers.session_shutdown();
  assert.equal(f.state().pendingTools, 0);
  assert.equal(f.state().shutdown, true);
  // No advisory after a sticky stop or shutdown.
  assert.equal(f.handlers.tool_result({ toolCallId: 'foreign', content: [] }), undefined);
});

test('dense tools warn independently of turns and the 41st tool remains blocked', t => {
  const f = fixture(t);
  let warnings = 0;
  for (let i = 0; i < 40; i++) {
    assert.equal(f.handlers.turn_start({ turnIndex: Math.floor(i / 3) }, f.ctx), undefined);
    const result = tool(f, `read-${i}`);
    if (i < 34) assert.equal(result, undefined);
    else { warnings++; assert.match(result.content[1].text, /LUDI_HANDOFF/); }
  }
  assert.equal(warnings, 6);
  assert.equal(f.aborts(), 0);
  const blocked = f.handlers.tool_call({ toolName: 'read', toolCallId: 'over-limit' }, f.ctx);
  assert.equal(blocked.block, true);
  assert.equal(blocked.terminate, true);
  assert.equal(f.state().toolCalls, 40);
  assert.equal(f.state().reason, 'tool-call-limit');
  f.handlers.session_shutdown();
  assert.equal(f.state().pendingTools, 0);
  assert.equal(f.state().shutdown, true);
});

test('missing turn indices do not fabricate turn usage or suppress tool-based warnings', t => {
  const f = fixture(t);
  f.handlers.turn_start({ turnIndex: 20 }, f.ctx);
  assert.match(tool(f, 'known').content[1].text, /21\/24 turns used/);
  f.handlers.turn_start({}, f.ctx);
  assert.equal(tool(f, 'unknown'), undefined);
  for (let i = 2; i < 35; i++) {
    const result = tool(f, `rest-${i}`);
    if (i === 34) assert.match(result.content[1].text, /turn usage unknown/);
  }
  assert.equal(f.aborts(), 0);
});
