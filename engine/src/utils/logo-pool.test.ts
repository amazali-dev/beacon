import assert from 'node:assert/strict';
import test from 'node:test';
import { selectLogoCandidates } from './logo-pool.js';

test('logo pool keeps brand selection sticky and provides a distinct retry', async () => {
  const first = await selectLogoCandidates('brand-logo-test-a');
  const repeated = await selectLogoCandidates('brand-logo-test-a');

  assert.equal(first[0]?.id, repeated[0]?.id);
  assert.notEqual(first[0]?.id, first[1]?.id);
});

test('logo pool assigns distinct primaries to different brands', async () => {
  const first = await selectLogoCandidates('brand-logo-test-b');
  const second = await selectLogoCandidates('brand-logo-test-c');

  assert.notEqual(first[0]?.id, second[0]?.id);
});
