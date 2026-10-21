// version.test.ts — program version tracking.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROGRAM_VERSION, bumpVersion } from '../src/version.ts';

test('current program version is 0.1g', () => {
  assert.equal(PROGRAM_VERSION, '0.1g');
});

test('bumpVersion increments letters then minor', () => {
  assert.equal(bumpVersion('0.1a'), '0.1b');
  assert.equal(bumpVersion('0.1y'), '0.1z');
  assert.equal(bumpVersion('0.1z'), '0.2a');
  assert.equal(bumpVersion('2.9z'), '2.10a');
});

test('bumpVersion rejects malformed labels', () => {
  assert.throws(() => bumpVersion('0.1'), /unrecognized/);
  assert.throws(() => bumpVersion('v0.1a'), /unrecognized/);
  assert.throws(() => bumpVersion(''), /unrecognized/);
});
