// settings.test.ts — SPEC §3 schema: defaults, validation, no silent coercion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSettings,
  computeRuntimeDefaults,
  defaultSettings,
  DEFAULT_HOUR_WEIGHTS,
  type RuntimeDefaults,
} from '../src/settings.ts';

const RUNTIME: RuntimeDefaults = {
  authorName: 'Test User',
  authorEmail: 'test@example.com',
  tzOffset: -5,
  identitySource: 'git',
};

function norm(raw: unknown) {
  return normalizeSettings(raw, RUNTIME);
}

test('empty input yields defaults with no errors', () => {
  const { settings, errors } = norm({});
  assert.deepEqual(errors, []);
  const base = defaultSettings(RUNTIME);
  assert.deepEqual(settings, base, 'empty input must equal defaults');
});

test('identity defaults come from the supplied runtime', () => {
  const { settings } = norm({});
  assert.equal(settings.output.authorName, 'Test User');
  assert.equal(settings.output.authorEmail, 'test@example.com');
  assert.equal(settings.output.tzOffset, -5);
});

test('unknown settings keys are rejected', () => {
  for (const raw of [
    { wibble: 1 },
    { output: { repoNmae: 'x' } },
    { activity: { meenCommitsPerDay: 3 } },
    { timeline: { durationDays_: 1 } },
    { content: { fileCount_: 1 } },
    { preview: { colorScale_: 'github' } },
  ]) {
    const { errors } = norm(raw);
    assert.equal(errors.length, 1, `expected 1 error for ${JSON.stringify(raw)}`);
    assert.match(errors[0], /unknown setting/);
  }
});

test('wrong types produce errors and keep defaults', () => {
  const cases: Array<[string, unknown]> = [
    ['timeline.durationDays', 'abc'],
    ['timeline.durationDays', 3.5],
    ['activity.seed', 'abc'],
    ['activity.totalCommits', 'many'],
    ['output.tzOffset', 3.5],
    ['activity.hourWeights', [1, 2, 3]],
    ['activity.hourWeights', 'lots'],
    ['preview.absoluteThresholds', [1, 2, 3]],
    ['activity.burstProbability', 'high'],
    ['timeline.startDate', '2025/10/01'],
    ['content.filesPerCommit', 9],
    ['output.repoName', ''],
    ['activity.totalCommits', 0],
  ];
  for (const [path, bad] of cases) {
    const raw: Record<string, unknown> = {};
    const [group, key] = path.split('.');
    raw[group] = { [key]: bad };
    const { errors } = norm(raw);
    assert.equal(errors.length, 1, `expected error for ${path}=${JSON.stringify(bad)}, got ${JSON.stringify(errors)}`);
    assert.match(errors[0], new RegExp(`^${path.replace('.', '\\.')}`));
  }
});

test('range violations are errors, not silently clamped', () => {
  for (const [path, bad] of [
    ['output.tzOffset', 15],
    ['activity.streakPersistence', 1.5],
    ['activity.burstProbability', -0.1],
    ['timeline.durationDays', 0],
    ['activity.meanCommitsPerDay', 0],
    ['activity.meanGapDays', 0],
  ] as Array<[string, number]>) {
    const [group, key] = path.split('.');
    const { errors } = norm({ [group]: { [key]: bad } });
    assert.equal(errors.length, 1, `expected error for ${path}=${bad}: ${JSON.stringify(errors)}`);
  }
});

test('valid values round-trip through normalization', () => {
  const raw = {
    output: { repoName: 'demo', outPath: 'tmp/demo', branchName: 'master', tzOffset: 2 },
    timeline: { startDate: '2025-01-15', durationDays: 90, weekStart: 'monday' },
    activity: { seed: 99, totalCommits: 500, meanCommitsPerDay: 3.2, maxCommitsPerDay: 60 },
    content: { fileCount: 12, contentStyle: 'lorem', filesPerCommit: 2 },
    preview: { colorScale: 'absolute', absoluteThresholds: [2, 4, 10, 30] },
  };
  const { settings, errors } = norm(raw);
  assert.deepEqual(errors, []);
  assert.equal(settings.output.repoName, 'demo');
  assert.equal(settings.output.branchName, 'master');
  assert.equal(settings.output.tzOffset, 2);
  assert.equal(settings.timeline.startDate, '2025-01-15');
  assert.equal(settings.timeline.durationDays, 90);
  assert.equal(settings.timeline.weekStart, 'monday');
  assert.equal(settings.activity.seed, 99);
  assert.equal(settings.activity.totalCommits, 500);
  assert.equal(settings.activity.meanCommitsPerDay, 3.2);
  assert.equal(settings.activity.maxCommitsPerDay, 60);
  assert.equal(settings.content.fileCount, 12);
  assert.equal(settings.content.contentStyle, 'lorem');
  assert.equal(settings.content.filesPerCommit, 2);
  assert.equal(settings.preview.colorScale, 'absolute');
  assert.deepEqual(settings.preview.absoluteThresholds, [2, 4, 10, 30]);
});

test('hourWeights must be exactly 24 non-negative numbers', () => {
  assert.deepEqual(norm({}).settings.activity.hourWeights, DEFAULT_HOUR_WEIGHTS);
  const neg = [...DEFAULT_HOUR_WEIGHTS];
  neg[3] = -1;
  assert.equal(norm({ activity: { hourWeights: neg } }).errors.length, 1);
  const ok = [...DEFAULT_HOUR_WEIGHTS];
  ok[3] = 0;
  assert.deepEqual(norm({ activity: { hourWeights: ok } }).errors, []);
});

test('normalization deep-copies; input arrays are not shared', () => {
  const { settings } = norm({});
  settings.activity.hourWeights[0] = 999;
  assert.equal(norm({}).settings.activity.hourWeights[0], DEFAULT_HOUR_WEIGHTS[0]);
});

test('signwriter and randomness defaults and validation', () => {
  assert.equal(norm({}).settings.signwriter.fullStrength, 60);
  assert.equal(norm({}).settings.signwriter.grouped, false);
  assert.equal(norm({}).settings.signwriter.groupMeanMinutes, 30);
  assert.deepEqual(norm({}).settings.signwriter.overrides, {});
  assert.equal(norm({}).settings.activity.generateRandom, true);
  // valid overrides round-trip
  const ok = norm({ signwriter: { overrides: { '2025-03-05': 4, '2025-03-06': 0 } } });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.settings.signwriter.overrides, { '2025-03-05': 4, '2025-03-06': 0 });
  // invalid forms -> errors
  for (const raw of [
    { signwriter: { overrides: { '2025-13-99': 2 } } }, // bad date key
    { signwriter: { overrides: { '2025-03-05': 9 } } }, // level out of range
    { signwriter: { overrides: { '2025-03-05': 1.5 } } }, // non-integer
    { signwriter: { fullStrength: 4 } }, // below minimum
    { signwriter: { fullStrength: 5001 } }, // above maximum
    { signwriter: { fullStrength: 100.5 } }, // non-integer
    { signwriter: { groupMeanMinutes: 0 } },
    { signwriter: { groupMeanMinutes: 1441 } },
    { signwriter: { grouped: 'yes' } },
    { activity: { generateRandom: 'no' } },
    { signwriter: { bogus: 1 } },
  ]) {
    assert.ok(norm(raw as never).errors.length > 0, JSON.stringify(raw));
  }
});

test('non-object or missing settings handle cleanly', () => {
  assert.equal(norm(undefined).errors.length, 0);
  assert.equal(norm(null).errors.length, 0);
  assert.equal(norm('nope').errors.length, 1);
  assert.equal(norm([1, 2]).errors.length, 1);
  assert.equal(norm({ output: 5 }).errors.length, 1);
});

test('computeRuntimeDefaults prefers env, falls back to git config', () => {
  const saved = {
    name: process.env.GIT_AUTHOR_NAME,
    email: process.env.GIT_AUTHOR_EMAIL,
  };
  try {
    process.env.GIT_AUTHOR_NAME = 'Env Person';
    process.env.GIT_AUTHOR_EMAIL = 'env@example.com';
    const r = computeRuntimeDefaults();
    assert.equal(r.authorName, 'Env Person');
    assert.equal(r.authorEmail, 'env@example.com');
    assert.equal(r.identitySource, 'env');
  } finally {
    if (saved.name === undefined) delete process.env.GIT_AUTHOR_NAME;
    else process.env.GIT_AUTHOR_NAME = saved.name;
    if (saved.email === undefined) delete process.env.GIT_AUTHOR_EMAIL;
    else process.env.GIT_AUTHOR_EMAIL = saved.email;
  }
});
