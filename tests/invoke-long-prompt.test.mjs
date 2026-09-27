import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createPiInvoker } from '../adapters/pi/lib/invoke.mjs';

test('one-shot invoker sends long prompts through a temporary file and removes it', async () => {
  const prompt = 'Long task brief and repository survey.\n'.repeat(2000);
  let path;
  const invoke = createPiInvoker({ piEntry: 'pi-entry', spawnImpl(_command, args) {
    const arg = args.at(-1);
    assert.ok(arg.startsWith('@'));
    assert.ok(args.join('').length < 2000);
    path = arg.slice(1);
    assert.equal(readFileSync(path, 'utf8'), prompt);
    return { status: 0, stdout: 'response', stderr: '' };
  } });
  assert.deepEqual((await invoke({ modelId: 'p/m', systemPrompt: 'system', prompt })).ok, true);
  assert.equal(existsSync(path), false);
});

test('one-shot invoker removes the prompt after a spawn error', async () => {
  let path;
  const invoke = createPiInvoker({ piEntry: 'pi-entry', spawnImpl(_command, args) {
    path = args.at(-1).slice(1);
    return { error: new Error('spawn failed') };
  } });
  assert.match((await invoke({ modelId: 'p/m', prompt: 'test' })).error, /spawn failed/);
  assert.equal(existsSync(path), false);
});
