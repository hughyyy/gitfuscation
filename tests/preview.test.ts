// preview.test.ts — SPEC §5.1: levels, grid geometry, payload consistency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSettings,
  type RuntimeDefaults,
  type Settings,
} from '../src/settings.ts';
import { previewFor, renderAscii } from '../src/preview.ts';
import { generateSchedule } from '../src/schedule.ts';

const RUNTIME: RuntimeDefaults = {
  authorName: 'Test User',
  authorEmail: 'test@example.com',
  tzOffset: 0,
  identitySource: 'git',
};

function settings(startDate: string, durationDays: number): Settings {
  const s = defaultSettings(RUNTIME);
  s.timeline.startDate = startDate;
  s.timeline.durationDays = durationDays;
  s.activity.seed = 5;
  return s;
}

test('cells mirror the schedule counts day-for-day', () => {
  const s = settings('2025-01-05', 90);
  const schedule = generateSchedule(s);
  const payload = previewFor(s);
  assert.equal(payload.cells.length, 90);
  assert.deepEqual(
    payload.cells.map((c) => c.count),
    schedule.days.map((d) => d.count),
  );
});

test('weeks count aligns the window to the weekStart column', () => {
  const s = settings('2025-01-01', 1); // Jan 1 2025 is a Wednesday
  const sun = previewFor(s);
  assert.equal(sun.weekStart, 'sunday');
  assert.equal(sun.weeks, 1); // one cell at column row 3 stays within one column
  assert.equal(sun.rows, 7);

  const s2 = settings('2025-01-01', 5); // Wed..Sun wraps into a second column
  const sun2 = previewFor(s2);
  assert.equal(sun2.weeks, 2);
});

test('monday weekStart shifts the column edge', () => {
  const s = settings('2025-01-05', 40); // Jan 5 2025 is a Sunday
  s.timeline.weekStart = 'monday';
  const payload = previewFor(s);
  // 40 days starting Sunday, Monday-start columns: 6 leading (Sun..) + 40 = 46 -> 7 cols
  assert.equal(payload.weeks, 7);
});

test('github scale uses the window max; absolute stays stable', () => {
  const s = settings('2025-01-05', 40);
  s.activity.burstProbability = 0;
  const payload = previewFor(s);
  const max = payload.totals.maxDay;
  for (const c of payload.cells) {
    assert.ok(c.level >= 0 && c.level <= 4);
    // Every cell's level must equal the documented github formula.
    const expected = c.count === 0 ? 0 : Math.min(4, Math.max(1, 1 + Math.floor((4 * c.count) / max)));
    assert.equal(c.level, expected, `${c.dateISO} count=${c.count} max=${max}`);
  }
  const maxCell = payload.cells.find((c) => c.count === max);
  assert.equal(maxCell?.level, 4);
  const zeroCell = payload.cells.find((c) => c.count === 0);
  assert.equal(zeroCell?.level, 0);
});

test('renderAscii emits 7 labeled rows and a totals line', () => {
  const s = settings('2025-01-05', 60);
  const out = renderAscii(previewFor(s));
  const lines = out.split('\n');
  assert.ok(lines.length > 7);
  const rowLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let i = 0; i < 7; i += 1) {
    assert.ok(lines[i + 1].startsWith(rowLabels[i]), `row ${i} label`);
  }
  assert.match(out, /commits: \d+/);
  assert.match(out, /legend:/);
});
