// schedule.test.ts — SPEC §4.1, §5.1, §9 statistical sanity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, type RuntimeDefaults, type Settings } from '../src/settings.ts';
import {
  generateSchedule,
  resolveWindow,
  rescaleToTotal,
  dayTimestamps,
  githubLevel,
  levelFor,
  mulberry32,
  type Schedule,
} from '../src/schedule.ts';

const RUNTIME: RuntimeDefaults = {
  authorName: 'Test User',
  authorEmail: 'test@example.com',
  tzOffset: 0,
  identitySource: 'git',
};

function settings(overrides: (s: Settings) => void = () => {}): Settings {
  const s = defaultSettings(RUNTIME);
  s.timeline.startDate = '2025-10-01';
  overrides(s);
  return s;
}

interface StreakGapStats {
  streaks: number; // runs of >=4 consecutive active days
  gaps: number; // runs of >=2 consecutive inactive days inside the window
}

function stats(schedule: Schedule): StreakGapStats {
  let streaks = 0;
  let gaps = 0;
  let run = 0;
  for (const d of schedule.days) {
    if (d.active) {
      run += 1;
      if (run === 4) streaks += 1;
    } else {
      run = 0;
    }
  }
  run = 0;
  for (const d of schedule.days.slice(1)) {
    if (!d.active) {
      run += 1;
      if (run === 2) gaps += 1;
    } else {
      run = 0;
    }
  }
  return { streaks, gaps };
}

function activeShares(schedule: Schedule): { weekend: number; weekday: number } {
  let wdAct = 0;
  let wdTot = 0;
  let weAct = 0;
  let weTot = 0;
  for (const d of schedule.days) {
    const wd = new Date(d.epoch * 1000).getUTCDay();
    if (wd === 0 || wd === 5 || wd === 6) {
      weTot += 1;
      if (d.active) weAct += 1;
    } else {
      wdTot += 1;
      if (d.active) wdAct += 1;
    }
  }
  return { weekend: weAct / weTot, weekday: wdAct / wdTot };
}

test('same seed and settings produce an identical schedule', () => {
  const s = settings();
  const a = generateSchedule(s);
  const b = generateSchedule(s);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test('different seeds produce different schedules', () => {
  const a = generateSchedule(settings((s) => (s.activity.seed = 1)));
  const b = generateSchedule(settings((s) => (s.activity.seed = 2)));
  assert.notDeepEqual(a.days.map((d) => d.count), b.days.map((d) => d.count));
});

test('burst days are uniform draws within [floor, maxCommitsPerDay]', () => {
  const s = settings();
  s.activity.maxCommitsPerDay = 120;
  s.activity.burstMinCommits = 50;
  s.activity.burstProbability = 1; // every active day is a marathon
  const schedule = generateSchedule(s);
  const burstCounts = schedule.days.filter((d) => d.count > 0).map((d) => d.count);
  assert.ok(burstCounts.length > 0);
  for (const c of burstCounts) {
    assert.ok(c >= 50 && c <= 120, `burst day out of range: ${c}`);
  }
  // Non-burst noise still exists when bursts are off.
  s.activity.burstProbability = 0;
  const quiet = generateSchedule(s);
  const maxQuiet = Math.max(...quiet.days.map((d) => d.count));
  assert.ok(maxQuiet < 50, `expected no marathon days, got max ${maxQuiet}`);
});

test('statistical sanity holds across several seeds (SPEC §9)', () => {
  for (const seed of [20261021, 42, 1337, 777, 99991]) {
    const s = settings((x) => (x.activity.seed = seed));
    const schedule = generateSchedule(s);
    const shares = activeShares(schedule);
    const sg = stats(schedule);
    assert.ok(
      shares.weekend > shares.weekday,
      `seed ${seed}: weekend share ${shares.weekend.toFixed(3)} not > weekday share ${shares.weekday.toFixed(3)}`,
    );
    assert.ok(sg.streaks >= 6, `seed ${seed}: only ${sg.streaks} streaks >= 4 days`);
    assert.ok(sg.gaps >= 2, `seed ${seed}: only ${sg.gaps} gaps >= 2 days`);
    assert.ok(schedule.totals.burstDays >= 1, `seed ${seed}: no day with >100 commits`);
    assert.ok(
      schedule.days.some((d) => d.count === 0),
      `seed ${seed}: no fully empty days`,
    );
    assert.ok(schedule.days.length === 365, `seed ${seed}: wrong window size`);
  }
});

test('intra-day commit times are ascending with a min gap, within the day', () => {
  const s = settings();
  s.activity.maxCommitsPerDay = 140;
  s.activity.minMinutesBetweenCommits = 3;
  const schedule = generateSchedule(s);
  const day = schedule.days.find((d) => d.count > 100) ?? schedule.days.find((d) => d.count > 1)!;
  assert.ok(day.count >= 2);
  const times = dayTimestamps(
    mulberry32(1),
    day.epoch,
    day.count,
    new Date(day.epoch * 1000).getUTCDay(),
    s.activity,
    0,
  );
  assert.equal(times.length, day.count);
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] > times[i - 1], `not strictly ascending at ${i}`);
    const minGap = s.activity.minMinutesBetweenCommits * 60;
    assert.ok(
      times[i] - times[i - 1] >= minGap,
      `gap too small at ${i}: ${times[i] - times[i - 1]} < ${minGap}`,
    );
  }
  for (const t of times) {
    assert.ok(t >= day.epoch && t < day.epoch + 86400, `timestamp outside day: ${t}`);
  }
  // Same generator path is what the schedule embeds: no timestamp precedes the
  // previous commit of the same day.
  const dayCommits = schedule.commits.filter((c) => c.dateKey === day.dateKey);
  for (let i = 1; i < dayCommits.length; i += 1) {
    assert.ok(dayCommits[i].ts > dayCommits[i - 1].ts);
  }
});

test('fixed commitCountStyle emits exactly mean per active day', () => {
  const s = settings();
  s.activity.commitCountStyle = 'fixed';
  s.activity.meanCommitsPerDay = 7;
  const schedule = generateSchedule(s);
  for (const d of schedule.days) {
    if (d.count > 0) assert.equal(d.count, 7);
  }
});

test('rescaleToTotal hits the target sum (no cap interference)', () => {
  const counts = [5, 0, 12, 0, 0, 30, 2, 1, 8];
  const total = 100;
  const rescaled = rescaleToTotal(counts, total, 10000);
  assert.equal(rescaled.reduce((a, b) => a + b, 0), total);
  for (let i = 0; i < counts.length; i += 1) {
    if (counts[i] === 0) assert.equal(rescaled[i], 0, 'zero days stay zero');
    else assert.ok(rescaled[i] > 0);
  }
});

test('totalCommits setting rescales the schedule total (SPEC §3.3)', () => {
  const s = settings();
  s.activity.totalCommits = 900;
  const schedule = generateSchedule(s);
  assert.ok(Math.abs(schedule.totals.commits - 900) <= 900 / 40, `off target: ${schedule.totals.commits}`);
});

test('window with explicit startDate covers exactly durationDays days', () => {
  const s = settings();
  s.timeline.startDate = '2024-02-29'; // leap day
  s.timeline.durationDays = 100;
  const schedule = generateSchedule(s);
  assert.equal(schedule.days.length, 100);
  assert.equal(schedule.days[0].dateKey, '2024-02-29');
  assert.equal(schedule.days[99].dateKey, '2024-06-07');
  assert.equal(resolveWindow(s.timeline, 0).startEpoch, Date.UTC(2024, 1, 29) / 1000);
});

test('default window ends today and spans durationDays days', () => {
  const s = settings();
  s.timeline.startDate = null;
  s.timeline.durationDays = 365;
  const { startEpoch, durationDays } = resolveWindow(s.timeline, 5);
  assert.equal(durationDays, 365);
  const lastMidnight = startEpoch + (365 - 1) * 86400;
  const now = new Date();
  const todayMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000 - 5 * 3600;
  assert.equal(lastMidnight, todayMidnight);
});

test('commits are globally chronologically ordered', () => {
  const s = settings();
  const schedule = generateSchedule(s);
  for (let i = 1; i < schedule.commits.length; i += 1) {
    assert.ok(schedule.commits[i].ts > schedule.commits[i - 1].ts);
  }
});

test('githubLevel boundaries follow SPEC §5.1', () => {
  assert.equal(githubLevel(0, 100), 0);
  assert.equal(githubLevel(1, 100), 1);
  assert.equal(githubLevel(24, 100), 1);
  assert.equal(githubLevel(25, 100), 2);
  assert.equal(githubLevel(49, 100), 2);
  assert.equal(githubLevel(50, 100), 3);
  assert.equal(githubLevel(74, 100), 3);
  assert.equal(githubLevel(75, 100), 4);
  assert.equal(githubLevel(100, 100), 4);
});

test('absolute color scale uses thresholds in order', () => {
  const s = settings();
  s.preview.colorScale = 'absolute';
  s.preview.absoluteThresholds = [1, 3, 8, 20];
  assert.equal(levelFor(0, s.preview, 999), 0);
  assert.equal(levelFor(1, s.preview, 999), 2);
  assert.equal(levelFor(4, s.preview, 999), 3);
  assert.equal(levelFor(9, s.preview, 999), 4);
  assert.equal(levelFor(30, s.preview, 999), 4);
});

test('signwriter overrides replace counts exactly; level 0 erases', () => {
  const s = settings((x) => {
    x.activity.burstProbability = 0;
    x.signwriter.overrides = {
      '2025-10-01': 4, // first day, window start
      '2025-10-02': 1,
      '2025-10-03': 0, // erase whatever was generated
    };
  });
  const schedule = generateSchedule(s);
  const byKey = new Map(schedule.days.map((d) => [d.dateKey, d.count]));
  assert.equal(byKey.get('2025-10-01'), 60); // levelCounts[3]
  assert.equal(byKey.get('2025-10-02'), 6); // levelCounts[0]
  assert.equal(byKey.get('2025-10-03'), 0);
  // Deterministic with the same overrides (parity with preview/generate).
  assert.deepEqual(generateSchedule(s).days, schedule.days);
});

test('signwriter overrides outside the window are ignored', () => {
  const s = settings((x) => {
    x.signwriter.overrides = { '1999-01-01': 4, '2035-12-31': 2 };
  });
  const schedule = generateSchedule(s);
  const base = generateSchedule(settings());
  assert.deepEqual(schedule.days.map((d) => d.count), base.days.map((d) => d.count));
});

test('signwriter totals reflect painted counts', () => {
  const s = settings((x) => {
    x.activity.burstProbability = 0;
    x.signwriter.overrides = { '2025-10-05': 4 };
  });
  const schedule = generateSchedule(s);
  const base = generateSchedule(settings((z) => (z.activity.burstProbability = 0)));
  const delta = schedule.totals.commits - base.totals.commits;
  assert.equal(delta, 60 - base.days.find((d) => d.dateKey === '2025-10-05')!.count);
});

test('tz offset keeps evenings on the intended calendar day', () => {
  const s = settings();
  s.output.tzOffset = -5; // e.g. US Eastern
  s.timeline.startDate = '2025-06-01';
  const schedule = generateSchedule(s);
  for (const d of schedule.days) {
    const parts = d.dateKey.split('-').map(Number);
    const expectedMidnight = Date.UTC(parts[0], parts[1] - 1, parts[2]) / 1000 - -5 * 3600;
    assert.equal(d.epoch, expectedMidnight, d.dateKey);
  }
  // A commit at 23:00 local must map to the *next* UTC day but same dateKey day.
  const commit = schedule.commits.find((c) => {
    const local = new Date((c.ts + -5 * 3600) * 1000);
    return local.getUTCHours() >= 22;
  });
  if (commit) {
    const local = new Date((commit.ts + -5 * 3600) * 1000);
    const localKey =
      `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-` +
      `${String(local.getUTCDate()).padStart(2, '0')}`;
    assert.equal(commit.dateKey, localKey);
  }
});
