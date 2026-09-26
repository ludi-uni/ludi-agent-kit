import test from 'node:test';
import assert from 'node:assert/strict';
import guard from '../adapters/pi/loop-guard/index.js';

function harness(model = { provider: 'example', id: 'example-model' }) {
  const handlers = {}, messages = [];
  let aborts = 0;
  const ctx = { model, hasUI: false, abort: () => { aborts++; } };
  guard({ on: (event, fn) => { handlers[event] = fn; }, sendMessage: message => messages.push(message) });
  const result = (command, text = 'no matches', isError = false) => handlers.tool_result({
    toolName: 'bash', input: { command }, content: [{ type: 'text', text }], isError,
  }, ctx);
  return { handlers, ctx, messages, result, aborts: () => aborts };
}

test('stops the observed A/B/C search cycle after third identical result', () => {
  const h = harness();
  for (let i = 0; i < 2; i++) for (const cmd of ['search A', 'search B', 'search C']) h.result(cmd);
  assert.equal(h.aborts(), 0);
  h.result('search A');
  assert.equal(h.aborts(), 1);
  assert.equal(h.messages.length, 1);
  assert.equal(h.handlers.tool_call({ toolName: 'bash', input: { command: 'search D' } }, h.ctx).terminate, true);
});
test('changed results and different inputs are progress', () => {
  const h = harness();
  for (let i = 0; i < 15; i++) { h.result('status', String(i)); h.result(`query ${i}`); }
  assert.equal(h.aborts(), 0);
});
test('an old repeated result outside the twelve-result window does not stop', () => {
  const h = harness();
  h.result('query'); h.result('query');
  for (let i = 0; i < 12; i++) h.result(`other ${i}`);
  h.result('query');
  assert.equal(h.aborts(), 0);
});
test('manual input resets; automatic extension followup does not', () => {
  const h = harness();
  for (let i = 0; i < 3; i++) h.result('query');
  h.handlers.input({ source: 'extension' }, h.ctx);
  assert.equal(h.handlers.tool_call({}, h.ctx).block, true);
  h.handlers.input({ source: 'rpc' }, h.ctx);
  assert.equal(h.handlers.tool_call({}, h.ctx), undefined);
  h.result('query');
  assert.equal(h.aborts(), 1);
});
test('all providers/models receive instructions and loop protection', () => {
  for (const model of [{provider:'p1',id:'m1'}, {provider:'p2',id:'m2'}]) {
    const h = harness(model);
    for (let i = 0; i < 5; i++) h.result('query');
    assert.equal(h.aborts(), 1);
    assert.match(h.handlers.before_agent_start({systemPrompt:'original'}, h.ctx).systemPrompt, /Progress rule/);
  }
});
test('repeated errors also stop; existing system prompt is preserved', () => {
  const h = harness();
  assert.match(h.handlers.before_agent_start({systemPrompt:'original'}, h.ctx).systemPrompt, /^original/);
  for (let i = 0; i < 3; i++) h.result('query', 'failure', true);
  assert.equal(h.aborts(), 1);
});
