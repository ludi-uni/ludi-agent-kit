import test from 'node:test';
import assert from 'node:assert/strict';
import { sum, average } from '../src/math.js';

test('sum adds numbers', () => assert.equal(sum([1, 2, 3]), 6));
test('average of [2, 4] is 3', () => assert.equal(average([2, 4]), 3));
test('average of empty list is 0', () => assert.equal(average([]), 0));
