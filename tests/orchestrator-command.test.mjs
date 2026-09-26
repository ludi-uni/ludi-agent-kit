import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOrchestrateCommand } from '../adapters/pi/orchestrator-ext/command.mjs';

test('read-only slash commands route without starting a new run', () => {
  for (const action of ['status', 'children', 'result']) {
    assert.deepEqual(parseOrchestrateCommand(`${action} run-123`), { action, params: { runId: 'run-123' } });
  }
  assert.deepEqual(parseOrchestrateCommand(''), { action: 'list', params: { runId: undefined } });
});

test('a natural-language request remains a new start', () => {
  assert.deepEqual(parseOrchestrateCommand('Fix the test'), { action: 'start', params: { request: 'Fix the test' } });
});
