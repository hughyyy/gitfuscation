// schedule.ts — the activity model (SPEC §4.1): settings -> ordered commits.
//
// Layers, in strict deterministic draw order:
//   A. streak/gap hidden Markov chain over days
//   B. per-day commit counts (Poisson + weekend boost + bursts)
//   C. timestamps within each day (hour weights + ordering + min gap)
//
// All randomness flows from one mulberry32(seed). Content-layer randomness
// (file selection, wording) must use a SEPARATE stream (content.ts derives its
// own rng) so preview/generate parity only depends on this module.

import type {
  ActivitySettings,
  PreviewSettings,
  Settings,
  TimelineSettings,
} from './settings.ts';
import { levelCountsFor } from './settings.ts';

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

/** Deterministic 32-bit PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Knuth's Poisson sample: mean lambda >= 0, integer >= 0. */
function poissonSample(rng: () => number, lambda: number): number {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DayInfo {
  dateKey: string; // 'YYYY-MM-DD' in the settings tz offset
  epoch: number; // epoch seconds of tz-midnight
  index: number;
  count: number;
  active: boolean;
}

export interface CommitInfo {
  ts: number; // epoch seconds (UTC instant; the day is per tzOffset)
  dateKey: string;
  index: number; // 0-based ordinal in the whole schedule
}

export interface ScheduleTotals {
  commits: number;
  activeDays: number;
  maxDay: number;
  burstDays: number; // days with count > 100
}

export interface Schedule {
  days: DayInfo[];
  commits: CommitInfo[];
  totals: ScheduleTotals;
  seed: number;
}

// ---------------------------------------------------------------------------
// Time windows
// ---------------------------------------------------------------------------

function parseDateKey(dk: string): [number, number, number] {
  const [y, m, d] = dk.split('-').map(Number);
  return [y, m, d];
}

/**
 * Window of `durationDays` consecutive tz-local days.
 * startDate given -> that day; else the window ends today.
 */
export function resolveWindow(
  tl: TimelineSettings,
  tzOffset: number,
): { startEpoch: number; durationDays: number } {
  let startEpoch: number;
  if (tl.startDate != null) {
    const [y, m, d] = parseDateKey(tl.startDate);
    startEpoch = Date.UTC(y, m - 1, d) / 1000 - tzOffset * 3600;
  } else {
    const now = new Date();
    const todayUtcMidnight =
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
    startEpoch = todayUtcMidnight - tzOffset * 3600 - (tl.durationDays - 1) * 86400;
  }
  return { startEpoch, durationDays: tl.durationDays };
}

export function dateKeyOfEpoch(epoch: number, tzOffset: number): string {
  const d = new Date((epoch + tzOffset * 3600) * 1000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

function weekdayOfEpoch(epoch: number, tzOffset: number): number {
  return new Date((epoch + tzOffset * 3600) * 1000).getUTCDay();
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export const WEEKEND_DAY = [5, 6, 0] as const; // Fri, Sat, Sun (getUTCDay)
const FRIDAY_SATURDAY = [5, 6] as const;

function isOneOf(day: number, days: readonly number[]): boolean {
  return days.includes(day);
}

/** Layer A: active/resting states, weekday-boosted streak persistence. */
export function computeStates(
  rng: () => number,
  durationDays: number,
  weekdayOf: (i: number) => number,
  activity: ActivitySettings,
): boolean[] {
  const active = new Array<boolean>(durationDays).fill(false);
  active[0] = true;
  const pGap = 1 / (activity.meanGapDays + 1);
  let i = 0;
  while (i < durationDays - 1) {
    const nextWeekend = isOneOf(weekdayOf(i + 1), WEEKEND_DAY);
    const p = clamp(
      activity.streakPersistence * (nextWeekend ? activity.weekendBoost : 1),
      0.05,
      0.99,
    );
    if (rng() < p) {
      active[i + 1] = true;
      i += 1;
      continue;
    }
    // Gap starts at i+1: length G ~ Geometric(1 - q); mean failures = meanGapDays.
    const gap = 1 + Math.floor(Math.log(rng()) / Math.log(1 - pGap));
    const end = Math.min(durationDays - 1, i + gap);
    for (let j = i + 1; j <= end; j += 1) active[j] = false;
    const resume = i + gap + 1;
    if (resume < durationDays) {
      active[resume] = true;
      i = resume;
    } else {
      break;
    }
  }
  return active;
}

/** Layer B: per-day commit counts. `fixed` style disables boost/burst. */
export function computeCounts(
  rng: () => number,
  active: boolean[],
  weekdayOf: (i: number) => number,
  activity: ActivitySettings,
): number[] {
  const counts = active.map(() => 0);
  for (let i = 0; i < active.length; i += 1) {
    if (!active[i]) continue;
    const weekend = isOneOf(weekdayOf(i), WEEKEND_DAY);
    if (activity.commitCountStyle === 'fixed') {
      counts[i] = clamp(
        Math.round(activity.meanCommitsPerDay),
        1,
        activity.maxCommitsPerDay,
      );
      continue;
    }
    const base = poissonSample(rng, activity.meanCommitsPerDay);
    const boost = weekend ? activity.weekendBoost : 1;
    let n: number;
    if (rng() < activity.burstProbability) {
      // Marathon day: uniform floor..cap (floor >= max(40, 6*mean)).
      const floor = Math.min(
        activity.maxCommitsPerDay,
        Math.max(40, 6 * activity.meanCommitsPerDay, activity.burstMinCommits),
      );
      n = floor + Math.floor(rng() * (activity.maxCommitsPerDay - floor + 1));
    } else {
      n = Math.round(base * boost);
    }
    counts[i] = clamp(Math.max(1, n), 1, activity.maxCommitsPerDay);
  }
  return counts;
}

/**
 * Layer B tail: if totalCommits is set, rescale counts to hit the target
 * (round, distribute remainder day-by-day), then apply maxCommitsPerDay.
 */
export function rescaleToTotal(
  counts: number[],
  totalCommits: number,
  maxCommitsPerDay: number,
): number[] {
  const sum = counts.reduce((a, b) => a + b, 0);
  if (sum === 0) return counts.slice();
  const factor = totalCommits / sum;
  const scaled = counts.map((c) => (c === 0 ? 0 : Math.max(1, Math.round(c * factor))));
  let diff = totalCommits - scaled.reduce((a, b) => a + b, 0);
  let guard = scaled.length * 2;
  while (diff !== 0 && guard-- > 0) {
    if (diff > 0) {
      const i = scaled.findIndex((c) => c > 0);
      if (i === -1) break;
      scaled[i] += 1;
      diff -= 1;
    } else {
      let i = -1;
      for (let j = scaled.length - 1; j >= 0; j -= 1) {
        if (scaled[j] > 1) {
          i = j;
          break;
        }
      }
      if (i === -1) break;
      scaled[i] -= 1;
      diff += 1;
    }
  }
  return scaled.map((c) => Math.min(maxCommitsPerDay, c));
}

/** Sample an hour index from the (possibly weekend-boosted) weight table. */
function sampleHourIndex(rng: () => number, weights: number[]): number {
  const wTotal = weights.reduce((a, b) => a + b, 0);
  let r = rng() * wTotal;
  for (let h = 0; h < 24; h += 1) {
    r -= weights[h];
    if (r <= 0) return h;
  }
  return 23;
}

/**
 * Grouped painted day: n commits packed into a session window of mean length
 * `meanMinutes`, starting at an hour-weighted time, at a steady 1s+ cadence
 * (deterministic). `shorter time period` than the random-spread path.
 */
function groupedTimestamps(
  rng: () => number,
  dayEpoch: number,
  count: number,
  weights: number[],
  startSecond: number,
  meanMinutes: number,
): number[] {
  const hour = sampleHourIndex(rng, weights);
  const start = dayEpoch + hour * 3600 + startSecond;
  const unit = Math.max(1, Math.floor((meanMinutes * 60) / Math.max(1, count)));
  const dayEnd = dayEpoch + 86400 - 1;
  const span = (count - 1) * unit;
  const begin = Math.max(dayEpoch, Math.min(start, dayEnd - span));
  const times: number[] = [];
  for (let k = 0; k < count; k += 1) times.push(begin + k * unit);
  return times;
}

/**
 * Layer C: sample n ascending timestamps within day i, enforcing the min gap.
 * Friday/Saturday get the evening-night hour bump (weekendCommitBoost on 18-02).
 * `grouped` packs painted days into a tight session window instead of a random
 * spread; for very large counts the min gap relaxes so a day can physically fit.
 */
export function dayTimestamps(
  rng: () => number,
  dayEpoch: number,
  count: number,
  weekday: number,
  activity: ActivitySettings,
  tzOffset: number,
  grouped: { enabled: boolean; meanMinutes: number } = { enabled: false, meanMinutes: 30 },
): number[] {
  if (count === 0) return [];
  const weights = [...activity.hourWeights];
  if (isOneOf(weekday, FRIDAY_SATURDAY)) {
    for (let h = 0; h < 24; h += 1) {
      if (h <= 2 || h >= 18) weights[h] *= activity.weekendCommitBoost;
    }
  }
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) weights.fill(1);

  if (grouped.enabled) {
    return groupedTimestamps(
      rng,
      dayEpoch,
      count,
      weights,
      Math.floor(rng() * 60) * 60,
      grouped.meanMinutes,
    );
  }

  const cdf: number[] = [];
  let acc = 0;
  const wTotal = weights.reduce((a, b) => a + b, 0);
  for (const w of weights) {
    acc += w;
    cdf.push(acc / wTotal);
  }
  // A day holds `count` commits: relax the min gap if the requested one cannot
  // physically fit (e.g. 5000 painted commits at 3 min apart).
  const maxGap = Math.max(1, Math.floor((86400 - 120) / Math.max(1, count)));
  const minGap = Math.min(activity.minMinutesBetweenCommits * 60, maxGap);

  const times: number[] = [];
  for (let k = 0; k < count; k += 1) {
    let r = rng() * wTotal;
    let hour = 23;
    for (let h = 0; h < 24; h += 1) {
      if (r <= cdf[h]) {
        hour = h;
        break;
      }
      r -= weights[h];
    }
    const minute = Math.floor(rng() * 60);
    const second = Math.floor(rng() * 60);
    times.push(dayEpoch + hour * 3600 + minute * 60 + second);
  }
  times.sort((a, b) => a - b);
  for (let k = 1; k < times.length; k += 1) {
    if (times[k] - times[k - 1] < minGap) times[k] = times[k - 1] + minGap;
  }
  const dayEnd = dayEpoch + 86400 - 1;
  // Right-bound cascade: last commit no later than day end, gaps preserved.
  for (let k = times.length - 1; k >= 0; k -= 1) {
    times[k] = Math.min(times[k], dayEnd - (times.length - 1 - k) * minGap);
  }
  // Re-ascend: floor is bounded by dayEnd - (n-1-k)*minGap (shown by the bound
  // of times[k-1]), so this cannot push past the day end.
  for (let k = 1; k < times.length; k += 1) {
    if (times[k] < times[k - 1] + minGap) {
      times[k] = times[k - 1] + minGap;
    }
  }
  return times;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Generate the full schedule for settings. Same seed + settings => identical
 * schedule (deterministic draw order: states, counts, times). Pure: no git,
 * no clock beyond the window resolution, no content randomness.
 */
export function generateSchedule(settings: Settings): Schedule {
  const rng = mulberry32(settings.activity.seed);
  const { startEpoch, durationDays } = resolveWindow(
    settings.timeline,
    settings.output.tzOffset,
  );
  const tz = settings.output.tzOffset;
  const weekdayOf = (i: number): number => weekdayOfEpoch(startEpoch + i * 86400, tz);

  let counts: number[];
  let active: boolean[];
  if (settings.activity.generateRandom) {
    active = computeStates(rng, durationDays, weekdayOf, settings.activity);
    counts = computeCounts(rng, active, weekdayOf, settings.activity);
    if (settings.activity.totalCommits != null) {
      counts = rescaleToTotal(
        counts,
        settings.activity.totalCommits,
        settings.activity.maxCommitsPerDay,
      );
    }
  } else {
    // No randomness: a blank canvas that only painted days fill.
    active = new Array<boolean>(durationDays).fill(false);
    counts = new Array<number>(durationDays).fill(0);
  }
  // Signwriter: painted levels replace the generated counts for those days
  // (level 0 erases -> no commits). Applied identically for preview/generate
  // so the painted banner is what the repo contains.
  const dayIndexByKey = new Map<string, number>();
  for (let i = 0; i < durationDays; i += 1) {
    dayIndexByKey.set(dateKeyOfEpoch(startEpoch + i * 86400, tz), i);
  }
  const levelCounts = levelCountsFor(settings.signwriter.fullStrength);
  for (const [dateKey, level] of Object.entries(settings.signwriter.overrides)) {
    const idx = dayIndexByKey.get(dateKey);
    if (idx === undefined) continue; // outside the window (e.g. after a timeline change)
    counts[idx] = level === 0 ? 0 : (levelCounts[level - 1] ?? levelCounts[levelCounts.length - 1] ?? 40);
  }

  const days: DayInfo[] = [];
  const commits: CommitInfo[] = [];
  for (let i = 0; i < durationDays; i += 1) {
    const epoch = startEpoch + i * 86400;
    const dateKey = dateKeyOfEpoch(epoch, tz);
    const count = counts[i];
    days.push({ dateKey, epoch, index: i, count, active: active[i] });
    const times = dayTimestamps(rng, epoch, count, weekdayOf(i), settings.activity, tz, {
      enabled: settings.signwriter.grouped,
      meanMinutes: settings.signwriter.groupMeanMinutes,
    });
    for (const ts of times) {
      commits.push({ ts, dateKey, index: commits.length });
    }
  }

  let commitsTotal = 0;
  let maxDay = 0;
  let burstDays = 0;
  for (const d of days) {
    commitsTotal += d.count;
    maxDay = Math.max(maxDay, d.count);
    if (d.count > 100) burstDays += 1;
  }

  return {
    days,
    commits,
    totals: {
      commits: commitsTotal,
      activeDays: days.filter((d) => d.count > 0).length,
      maxDay,
      burstDays,
    },
    seed: settings.activity.seed,
  };
}

// ---------------------------------------------------------------------------
// Preview levels (SPEC §5.1) — kept here so preview parity is cell-exact.
// ---------------------------------------------------------------------------

/** Empty = background; green dark-to-bright as commits increase (GitHub 2023+). */
export const LEVEL_COLORS = ['#21262d', '#0e4429', '#006d32', '#26a641', '#39d353'];

/** GitHub-style relative level: 0 | 1 + floor(4*count/max), count>0 => >=1. */
export function githubLevel(count: number, max: number): number {
  if (count <= 0) return 0;
  if (max <= 0) return 1;
  return Math.min(4, Math.max(1, 1 + Math.floor((4 * count) / max)));
}

export function levelFor(count: number, preview: PreviewSettings, max: number): number {
  if (count <= 0) return 0;
  if (preview.colorScale === 'absolute') {
    let level = 1;
    for (const t of preview.absoluteThresholds) {
      if (count >= t) level += 1;
    }
    return Math.min(4, level);
  }
  return githubLevel(count, max);
}
