import assert from 'node:assert/strict';
import test from 'node:test';
import { dueDailySlot, dueFormSlotKey } from './schedule-slots.js';

test('delayed form invocation claims the latest logical Eastern slot', () => {
  const key = dueFormSlotKey(
    new Date('2026-07-21T11:15:00Z'),
    ['00:00', '06:00', '12:00', '18:00']
  );
  assert.equal(key, '2026-07-21T06:00-America/New_York');
});

test('daily recovery shortly after midnight claims the previous Eastern day', () => {
  const slot = dueDailySlot(new Date('2026-07-22T04:30:00Z'), '23:30');
  assert.deepEqual(slot, {
    key: '2026-07-21T23:30-America/New_York',
    reportDate: '2026-07-21',
  });
});
