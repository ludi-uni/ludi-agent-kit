import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createPiInvoker } from '../adapters/pi/lib/invoke.mjs';

/** Minimal async ChildProcess double: streams are real push sources. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4321;
  child.kill = () => true;
  return child;
}

test('one-shot invoker sends long prompts through a temporary file and removes it', async () => {
  const prompt = 'Long task brief and repository survey.\n'.repeat(2000);
  let path;
  const invoke = createPiInvoker({ piEntry: 'pi-entry', spawnImpl(_command, args) {
    const arg = args.at(-1);
    assert.ok(arg.startsWith('@'));
    assert.ok(args.join('').length < 2000);
    path = arg.slice(1);
    assert.equal(readFileSync(path, 'utf8'), prompt);
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.emit('data', 'response');
      child.emit('close', 0, null);
    });
    return child;
  } });
  assert.deepEqual((await invoke({ modelId: 'p/m', systemPrompt: 'system', prompt })).ok, true);
  assert.equal(existsSync(path), false);
});

test('one-shot invoker removes the prompt after a spawn error', async () => {
  let path;
  const invoke = createPiInvoker({ piEntry: 'pi-entry', spawnImpl(_command, args) {
    path = args.at(-1).slice(1);
    const child = fakeChild();
    child.pid = undefined; // never spawned: resolve without waiting for close
    queueMicrotask(() => child.emit('error', new Error('spawn failed')));
    return child;
  } });
  assert.match((await invoke({ modelId: 'p/m', prompt: 'test' })).error, /spawn failed/);
  assert.equal(existsSync(path), false);
});

test('one-shot invoker removes the prompt when spawnImpl throws synchronously', async () => {
  let path;
  const invoke = createPiInvoker({ piEntry: 'pi-entry', spawnImpl(_command, args) {
    path = args.at(-1).slice(1);
    throw new Error('spawn exploded');
  } });
  assert.match((await invoke({ modelId: 'p/m', prompt: 'test' })).error, /spawn exploded/);
  assert.equal(existsSync(path), false);
});
