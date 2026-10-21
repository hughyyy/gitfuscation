// settings.ts — schema, defaults, validation, JSON (de)serialization.
//
// Single settings object, namespaced per SPEC §3. Validation is strict:
// wrong types/unknown keys produce errors, defaults fill omissions.

import { execFileSync } from 'node:child_process';

export type WeekStart = 'sunday' | 'monday';
export type CommitCountStyle = 'random' | 'fixed';
export type ContentStyle = 'markdown' | 'lorem' | 'words';
export type MessageStyle = 'conventional' | 'random';
export type ColorScale = 'github' | 'absolute';

export interface OutputSettings {
  repoName: string;
  outPath: string;
  branchName: string;
  authorName: string;
  authorEmail: string;
  tzOffset: number; // fixed UTC offset in hours, applied to every timestamp
  replace: boolean; // true: remove an existing outPath before generating
}

export interface TimelineSettings {
  startDate: string | null; // 'YYYY-MM-DD' or null -> today - (durationDays - 1)
  durationDays: number;
  weekStart: WeekStart;
}

export interface ActivitySettings {
  seed: number;
  totalCommits: number | null;
  meanCommitsPerDay: number;
  maxCommitsPerDay: number;
  burstProbability: number;
  burstMinCommits: number; // floor for a burst (marathon) day's count
  weekendBoost: number;
  weekendCommitBoost: number;
  streakPersistence: number;
  meanGapDays: number;
  hourWeights: number[]; // length 24, relative likelihood per hour (tz clock)
  minMinutesBetweenCommits: number;
  commitCountStyle: CommitCountStyle;
}

export interface ContentSettings {
  fileCount: number;
  contentStyle: ContentStyle;
  filesPerCommit: number; // 1..4
  newFileProbability: number;
  commitMessageStyle: MessageStyle;
  bodyProbability: number;
}

export interface PreviewSettings {
  colorScale: ColorScale;
  absoluteThresholds: number[]; // length 4
}

/** Signwriter: paint arbitrary levels onto specific days (banner art). */
export interface SignwriterSettings {
  levelCounts: number[]; // [L1..L4] commits per painted level, strictly increasing
  overrides: Record<string, number>; // dateKey 'YYYY-MM-DD' -> level 0..4
}

export interface Settings {
  output: OutputSettings;
  timeline: TimelineSettings;
  activity: ActivitySettings;
  content: ContentSettings;
  preview: PreviewSettings;
  signwriter: SignwriterSettings;
}

export const DEFAULT_SIGNWRITER_LEVEL_COUNTS = [6, 14, 28, 60];

export type IdentitySource = 'env' | 'git' | 'fallback';

export interface RuntimeDefaults {
  authorName: string;
  authorEmail: string;
  tzOffset: number;
  identitySource: IdentitySource;
}

export const DEFAULT_HOUR_WEIGHTS = [
  0, 0, 1, 1, 1, 1, 2, 4, 6, 6, 5, 5,
  6, 7, 7, 7, 8, 9, 10, 12, 14, 14, 12, 8,
];

export const DEFAULT_ABSOLUTE_THRESHOLDS = [1, 3, 8, 20];

// Static membership tables (getUTCDay keys) — Record lookups, not Sets.
// weekend = Fri(5), Sat(6), Sun(0); friday-night boost = Fri(5), Sat(6).
const WEEKEND_DAYS: Record<number, boolean> = { 0: true, 5: true, 6: true };
const FRIDAY_SATURDAY: Record<number, boolean> = { 5: true, 6: true };

export function isWeekendDateKey(dateKey: string): boolean {
  const [y, m, d] = dateKey.split('-').map(Number);
  return WEEKEND_DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] === true;
}

export function isFridaySaturday(dateKey: string): boolean {
  const [y, m, d] = dateKey.split('-').map(Number);
  return FRIDAY_SATURDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] === true;
}

/** Local UTC offset in hours at the current moment (e.g. -5). */
export function localTzOffset(): number {
  return -new Date().getTimezoneOffset() / 60;
}

function gitConfig(key: string): string | null {
  try {
    const out = execFileSync('git', ['config', '--get', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/** Resolve author identity + timezone from env -> git config -> fallback. */
export function computeRuntimeDefaults(): RuntimeDefaults {
  const envName =
    process.env.GIT_AUTHOR_NAME ?? process.env.GIT_COMMITTER_NAME ?? null;
  const envEmail =
    process.env.GIT_AUTHOR_EMAIL ?? process.env.GIT_COMMITTER_EMAIL ?? null;

  let authorName: string | null = envName;
  let authorEmail: string | null = envEmail;
  let identitySource: IdentitySource = 'env';

  if (authorName == null || authorEmail == null) {
    const name = authorName ?? gitConfig('user.name');
    const email = authorEmail ?? gitConfig('user.email');
    if (name != null && email != null) {
      authorName = name;
      authorEmail = email;
      identitySource = 'env';
      if (envName == null && envEmail == null) identitySource = 'git';
    }
  }
  if (authorName == null || authorName === '') {
    authorName = 'gitfuscation';
    identitySource = 'fallback';
  }
  if (authorEmail == null || authorEmail === '') {
    authorEmail = 'gitfuscation@localhost';
    identitySource = 'fallback';
  }
  return {
    authorName,
    authorEmail,
    tzOffset: localTzOffset(),
    identitySource,
  };
}

export function defaultSettings(
  runtime: RuntimeDefaults = computeRuntimeDefaults(),
): Settings {
  return {
    output: {
      repoName: 'activity-history',
      outPath: 'generated/activity-history',
      branchName: 'main',
      authorName: runtime.authorName,
      authorEmail: runtime.authorEmail,
      tzOffset: runtime.tzOffset,
      replace: false,
    },
    timeline: {
      startDate: null,
      durationDays: 365,
      weekStart: 'sunday',
    },
    activity: {
      seed: 20261021,
      totalCommits: null,
      meanCommitsPerDay: 5,
      maxCommitsPerDay: 140,
      burstProbability: 0.04,
      burstMinCommits: 40,
      weekendBoost: 1.5,
      weekendCommitBoost: 1.4,
      streakPersistence: 0.88,
      meanGapDays: 2.0,
      hourWeights: [...DEFAULT_HOUR_WEIGHTS],
      minMinutesBetweenCommits: 3,
      commitCountStyle: 'random',
    },
    content: {
      fileCount: 24,
      contentStyle: 'markdown',
      filesPerCommit: 1,
      newFileProbability: 0.02,
      commitMessageStyle: 'conventional',
      bodyProbability: 0.12,
    },
    preview: {
      colorScale: 'github',
      absoluteThresholds: [...DEFAULT_ABSOLUTE_THRESHOLDS],
    },
    signwriter: {
      levelCounts: [...DEFAULT_SIGNWRITER_LEVEL_COUNTS],
      overrides: {},
    },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type ErrorCollector = { errors: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function err(col: ErrorCollector, path: string, msg: string): void {
  col.errors.push(`${path}: ${msg}`);
}

function num(
  col: ErrorCollector,
  path: string,
  v: unknown,
  fallback: number,
): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    err(col, path, `expected a finite number, got ${JSON.stringify(v)}`);
    return fallback;
  }
  return v;
}

function int(
  col: ErrorCollector,
  path: string,
  v: unknown,
  fallback: number,
): number {
  const n = num(col, path, v, fallback);
  if (v !== undefined && !Number.isInteger(n)) {
    err(col, path, `expected an integer, got ${n}`);
  }
  return n;
}

function clampNum(
  col: ErrorCollector,
  path: string,
  v: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = num(col, path, v, fallback);
  if (v !== undefined && (n < min || n > max)) {
    err(col, path, `must be within [${min}, ${max}], got ${n}`);
  }
  return n;
}

function enumStr<T extends string>(
  col: ErrorCollector,
  path: string,
  v: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    err(col, path, `must be one of ${allowed.join(', ')}, got ${JSON.stringify(v)}`);
    return fallback;
  }
  return v as T;
}

function numArray(
  col: ErrorCollector,
  path: string,
  v: unknown,
  fallback: number[],
  length: number,
): number[] {
  if (v === undefined) return [...fallback];
  if (!Array.isArray(v) || v.length !== length || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    err(col, path, `expected an array of ${length} numbers`);
    return [...fallback];
  }
  return [...v];
}

/**
 * Merge raw input over defaults; collect errors (never coerce). Callers must
 * treat any non-empty `errors` as invalid and refuse to proceed.
 */
export function normalizeSettings(raw: unknown, runtime: RuntimeDefaults = computeRuntimeDefaults()): { settings: Settings; errors: string[] } {
  const col: ErrorCollector = { errors: [] };
  const base = defaultSettings(runtime);

  if (raw === undefined || raw === null) return { settings: base, errors: [] };
  if (!isRecord(raw)) {
    return { settings: base, errors: ['settings: expected an object'] };
  }

  // Unknown top-level keys
  const knownGroups = ['output', 'timeline', 'activity', 'content', 'preview', 'signwriter'];
  for (const k of Object.keys(raw)) {
    if (!knownGroups.includes(k)) err(col, `settings.${k}`, 'unknown setting');
  }

  const s: Settings = JSON.parse(JSON.stringify(base)); // deep copy

  // output
  const o = raw.output;
  if (o !== undefined) {
    if (!isRecord(o)) err(col, 'output', 'expected an object');
    else {
      for (const k of Object.keys(o)) {
        if (!['repoName', 'outPath', 'branchName', 'authorName', 'authorEmail', 'tzOffset', 'replace'].includes(k)) {
          err(col, `output.${k}`, 'unknown setting');
        }
      }
      if (o.replace !== undefined && typeof o.replace !== 'boolean') {
        err(col, 'output.replace', `expected a boolean, got ${JSON.stringify(o.replace)}`);
      } else if (typeof o.replace === 'boolean') {
        s.output.replace = o.replace;
      }
      const str = (path: string, key: string, fallback: string): void => {
        const v = (o as Record<string, unknown>)[key];
        if (v === undefined) return;
        if (typeof v !== 'string' || v === '') {
          err(col, `output.${key}`, `expected a non-empty string, got ${JSON.stringify(v)}`);
        }
        void path;
      };
      str('output', 'repoName', s.output.repoName);
      str('output', 'outPath', s.output.outPath);
      str('output', 'branchName', s.output.branchName);
      str('output', 'authorName', s.output.authorName);
      str('output', 'authorEmail', s.output.authorEmail);
      const tz = int(col, 'output.tzOffset', (o as Record<string, unknown>).tzOffset, s.output.tzOffset);
      if ((o as Record<string, unknown>).tzOffset !== undefined && (tz < -14 || tz > 14)) {
        err(col, 'output.tzOffset', `must be within [-14, 14], got ${tz}`);
      }
      // Apply validated values
      s.output.repoName = pick(o, 'repoName', s.output.repoName);
      s.output.outPath = pick(o, 'outPath', s.output.outPath);
      s.output.branchName = pick(o, 'branchName', s.output.branchName);
      s.output.authorName = pick(o, 'authorName', s.output.authorName) || (typeof o.authorName === 'string' ? '' : s.output.authorName);
      s.output.authorEmail = pick(o, 'authorEmail', s.output.authorEmail) || (typeof o.authorEmail === 'string' ? '' : s.output.authorEmail);
      s.output.tzOffset = tz;
    }
  }

  // timeline
  const t = raw.timeline;
  if (t !== undefined) {
    if (!isRecord(t)) err(col, 'timeline', 'expected an object');
    else {
      for (const k of Object.keys(t)) {
        if (!['startDate', 'durationDays', 'weekStart'].includes(k)) {
          err(col, `timeline.${k}`, 'unknown setting');
        }
      }
      if (t.startDate !== undefined && t.startDate !== null) {
        if (typeof t.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.startDate) || Number.isNaN(Date.parse(t.startDate + 'T00:00:00Z'))) {
          err(col, 'timeline.startDate', `expected 'YYYY-MM-DD' or null, got ${JSON.stringify(t.startDate)}`);
        }
        s.timeline.startDate = typeof t.startDate === 'string' ? t.startDate : null;
      }
      s.timeline.durationDays = clampNum(col, 'timeline.durationDays', t.durationDays, s.timeline.durationDays, 1, 3660);
      if (t.durationDays !== undefined && !Number.isInteger(s.timeline.durationDays)) {
        err(col, 'timeline.durationDays', `expected an integer, got ${t.durationDays}`);
      }
      s.timeline.weekStart = enumStr(col, 'timeline.weekStart', t.weekStart, ['sunday', 'monday'] as const, s.timeline.weekStart);
    }
  }

  // activity
  const a = raw.activity;
  if (a !== undefined) {
    if (!isRecord(a)) err(col, 'activity', 'expected an object');
    else {
      for (const k of Object.keys(a)) {
        if (!['seed', 'totalCommits', 'meanCommitsPerDay', 'maxCommitsPerDay', 'burstProbability', 'burstMinCommits', 'weekendBoost', 'weekendCommitBoost', 'streakPersistence', 'meanGapDays', 'hourWeights', 'minMinutesBetweenCommits', 'commitCountStyle'].includes(k)) {
          err(col, `activity.${k}`, 'unknown setting');
        }
      }
      s.activity.seed = int(col, 'activity.seed', a.seed, s.activity.seed);
      if (a.totalCommits !== undefined && a.totalCommits !== null) {
        s.activity.totalCommits = int(col, 'activity.totalCommits', a.totalCommits, s.activity.totalCommits ?? 1000);
        if (s.activity.totalCommits !== null && s.activity.totalCommits < 1) {
          err(col, 'activity.totalCommits', `must be >= 1, got ${s.activity.totalCommits}`);
        }
      }
      s.activity.meanCommitsPerDay = clampNum(col, 'activity.meanCommitsPerDay', a.meanCommitsPerDay, s.activity.meanCommitsPerDay, 0.1, 200);
      s.activity.maxCommitsPerDay = clampNum(col, 'activity.maxCommitsPerDay', a.maxCommitsPerDay, s.activity.maxCommitsPerDay, 1, 10000);
      s.activity.burstProbability = clampNum(col, 'activity.burstProbability', a.burstProbability, s.activity.burstProbability, 0, 1);
      s.activity.burstMinCommits = clampNum(col, 'activity.burstMinCommits', a.burstMinCommits, s.activity.burstMinCommits, 1, s.activity.maxCommitsPerDay);
      s.activity.weekendBoost = clampNum(col, 'activity.weekendBoost', a.weekendBoost, s.activity.weekendBoost, 0, 10);
      s.activity.weekendCommitBoost = clampNum(col, 'activity.weekendCommitBoost', a.weekendCommitBoost, s.activity.weekendCommitBoost, 0, 10);
      s.activity.streakPersistence = clampNum(col, 'activity.streakPersistence', a.streakPersistence, s.activity.streakPersistence, 0, 1);
      s.activity.meanGapDays = clampNum(col, 'activity.meanGapDays', a.meanGapDays, s.activity.meanGapDays, 0.05, 60);
      const hw = numArray(col, 'activity.hourWeights', a.hourWeights, s.activity.hourWeights, 24);
      if (a.hourWeights !== undefined && hw.some((x) => x < 0)) {
        err(col, 'activity.hourWeights', 'weights must be >= 0');
      }
      s.activity.hourWeights = hw;
      s.activity.minMinutesBetweenCommits = clampNum(col, 'activity.minMinutesBetweenCommits', a.minMinutesBetweenCommits, s.activity.minMinutesBetweenCommits, 0, 1440);
      s.activity.commitCountStyle = enumStr(col, 'activity.commitCountStyle', a.commitCountStyle, ['random', 'fixed'] as const, s.activity.commitCountStyle);
      if (s.activity.maxCommitsPerDay * s.activity.minMinutesBetweenCommits > 1440) {
        err(col, 'activity.maxCommitsPerDay', `a day cannot fit ${s.activity.maxCommitsPerDay} commits at ${s.activity.minMinutesBetweenCommits} min apart; reduce one of them`);
      }
    }
  }

  // content
  const c = raw.content;
  if (c !== undefined) {
    if (!isRecord(c)) err(col, 'content', 'expected an object');
    else {
      for (const k of Object.keys(c)) {
        if (!['fileCount', 'contentStyle', 'filesPerCommit', 'newFileProbability', 'commitMessageStyle', 'bodyProbability'].includes(k)) {
          err(col, `content.${k}`, 'unknown setting');
        }
      }
      s.content.fileCount = clampNum(col, 'content.fileCount', c.fileCount, s.content.fileCount, 1, 500);
      if (c.fileCount !== undefined && !Number.isInteger(s.content.fileCount)) {
        err(col, 'content.fileCount', `expected an integer, got ${c.fileCount}`);
      }
      s.content.contentStyle = enumStr(col, 'content.contentStyle', c.contentStyle, ['markdown', 'lorem', 'words'] as const, s.content.contentStyle);
      s.content.filesPerCommit = clampNum(col, 'content.filesPerCommit', c.filesPerCommit, s.content.filesPerCommit, 1, 4);
      if (c.filesPerCommit !== undefined && !Number.isInteger(s.content.filesPerCommit)) {
        err(col, 'content.filesPerCommit', `expected an integer, got ${c.filesPerCommit}`);
      }
      s.content.newFileProbability = clampNum(col, 'content.newFileProbability', c.newFileProbability, s.content.newFileProbability, 0, 1);
      s.content.commitMessageStyle = enumStr(col, 'content.commitMessageStyle', c.commitMessageStyle, ['conventional', 'random'] as const, s.content.commitMessageStyle);
      s.content.bodyProbability = clampNum(col, 'content.bodyProbability', c.bodyProbability, s.content.bodyProbability, 0, 1);
    }
  }

  // preview
  const p = raw.preview;
  if (p !== undefined) {
    if (!isRecord(p)) err(col, 'preview', 'expected an object');
    else {
      for (const k of Object.keys(p)) {
        if (!['colorScale', 'absoluteThresholds'].includes(k)) {
          err(col, `preview.${k}`, 'unknown setting');
        }
      }
      s.preview.colorScale = enumStr(col, 'preview.colorScale', p.colorScale, ['github', 'absolute'] as const, s.preview.colorScale);
      const th = numArray(col, 'preview.absoluteThresholds', p.absoluteThresholds, s.preview.absoluteThresholds, 4);
      if (p.absoluteThresholds !== undefined && th.some((x) => x < 0) && !col.errors.some((e) => e.startsWith('preview.absoluteThresholds'))) {
        err(col, 'preview.absoluteThresholds', 'thresholds must be >= 0');
      }
      s.preview.absoluteThresholds = th;
    }
  }

  // signwriter
  const sw = raw.signwriter;
  if (sw !== undefined) {
    if (!isRecord(sw)) err(col, 'signwriter', 'expected an object');
    else {
      for (const k of Object.keys(sw)) {
        if (!['levelCounts', 'overrides'].includes(k)) {
          err(col, `signwriter.${k}`, 'unknown setting');
        }
      }
      const lc = numArray(col, 'signwriter.levelCounts', sw.levelCounts, s.signwriter.levelCounts, 4);
      if (sw.levelCounts !== undefined) {
        const ints = lc.every((x) => Number.isInteger(x) && x >= 1);
        if (!ints) err(col, 'signwriter.levelCounts', 'must be 4 positive integers');
        for (let i = 1; i < lc.length; i += 1) {
          if (lc[i] !== undefined && lc[i - 1] !== undefined && lc[i] <= lc[i - 1]) {
            err(col, 'signwriter.levelCounts', 'must be strictly increasing');
            break;
          }
        }
      }
      s.signwriter.levelCounts = lc;
      if (sw.overrides !== undefined) {
        if (!isRecord(sw.overrides)) {
          err(col, 'signwriter.overrides', 'expected an object of dateKey -> level');
        } else {
          const clean: Record<string, number> = {};
          for (const [dateKey, level] of Object.entries(sw.overrides)) {
            if (
              !/^\d{4}-\d{2}-\d{2}$/.test(dateKey) ||
              Number.isNaN(Date.parse(`${dateKey}T00:00:00Z`))
            ) {
              err(col, `signwriter.overrides.${dateKey}`, 'expected a valid YYYY-MM-DD key');
              continue;
            }
            if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > 4) {
              err(col, `signwriter.overrides.${dateKey}`, 'level must be an integer 0..4');
              continue;
            }
            clean[dateKey] = level;
          }
          s.signwriter.overrides = clean;
        }
      }
    }
  }

  return { settings: s, errors: col.errors };
}

function pick(rec: Record<string, unknown>, key: string, fallback: string): string {
  const v = rec[key];
  return typeof v === 'string' && v !== '' ? v : fallback;
}
