import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskContract } from '../lib/orchestrator/contract.mjs';
import {
  parseProgressReport, PROGRESS_STATUSES, TERMINATION_REASONS, BLOCKED_CLASSES,
} from '../lib/orchestrator/progress-contract.mjs';
import { COMPLEXITIES } from '../lib/orchestrator/planning-contract.mjs';
import { ARTIFACT_TYPES } from '../lib/orchestrator/task-store.mjs';

const task = { id: 'scout-1', title: 'Investigate', goal: 'Collect evidence', kind: 'investigate' };
const prefix = 'Allowed progressReport enum values (use exact values only): ';
const promptEnums = extra => {
  const prompt = buildTaskContract({ ...task, ...extra });
  const line = prompt.split('\n').find(line => line.startsWith(prefix));
  assert.ok(line, 'progress contract must disclose its enum values');
  return JSON.parse(line.slice(prefix.length));
};
const report = (extra = {}) => ({
  task_id: task.id, status: 'partial', completed_acceptance: [],
  completed_steps: ['Inspected contract'], remaining_work: [], blocked_work: [],
  files_touched: [], tests_run: [], artifacts: [], environment_constraints: [], handoff_notes: [],
  ...extra,
});

test('investigation, planned and continuation prompts disclose the exact validation enums', () => {
  for (const extra of [{}, { kind: 'implement', planningRef: 'plan-1' }, { kind: 'implement', parentTaskId: 'parent-1' }]) {
    assert.deepEqual(promptEnums(extra), {
      status: PROGRESS_STATUSES,
      termination_reason: TERMINATION_REASONS,
      'remaining_work[].estimated_complexity': COMPLEXITIES,
      'blocked_work[].classification': BLOCKED_CLASSES,
      'artifacts[].type': ARTIFACT_TYPES,
    });
  }
});

test('every advertised enum value is accepted by the progress parser', () => {
  const enums = promptEnums();
  for (const status of enums.status) assert.equal(parseProgressReport(report({ status })).status, status);
  for (const termination_reason of enums.termination_reason) {
    assert.equal(parseProgressReport(report({ termination_reason })).termination_reason, termination_reason);
  }
  for (const estimated_complexity of enums['remaining_work[].estimated_complexity']) {
    const remaining_work = [{ id: 'remaining-1', description: 'Follow up', acceptance_ids: [], estimated_complexity }];
    assert.deepEqual(parseProgressReport(report({ remaining_work })).remaining_work, remaining_work);
  }
  for (const classification of enums['blocked_work[].classification']) {
    const blocked_work = [{ description: 'Command unavailable', reason: 'Policy', classification }];
    assert.deepEqual(parseProgressReport(report({ blocked_work })).blocked_work, blocked_work);
  }
  for (const type of enums['artifacts[].type']) {
    const artifacts = [{ type, location: 'lib/orchestrator/contract.mjs', description: 'Evidence reference' }];
    assert.deepEqual(parseProgressReport(report({ artifacts })).artifacts, artifacts);
  }
});

test('reported scout aliases remain invalid; canonical replacements parse without mutating the report', () => {
  const saved = report({
    blocked_work: [{ description: 'Command refused', reason: 'Policy', classification: 'environment' }],
    artifacts: [{ type: 'context_pack', location: 'notes.md', description: 'Investigation notes' }],
  });
  assert.throws(() => parseProgressReport(saved), /invalid classification.*invalid artifact type/);
  const corrected = structuredClone(saved);
  corrected.blocked_work[0].classification = 'environment_limitation';
  corrected.artifacts[0].type = 'investigation';
  assert.deepEqual(parseProgressReport(corrected), corrected);
  assert.equal(saved.blocked_work[0].classification, 'environment');
  assert.equal(saved.artifacts[0].type, 'context_pack');
});
