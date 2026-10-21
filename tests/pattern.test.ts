// pattern.test.ts — pattern README rendering (auto + from an existing repo).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  defaultSettings,
  normalizeSettings,
  type RuntimeDefaults,
  type Settings,
} from '../src/settings.ts';
import { patternMarkdown, patternFromSettings, chartFromRepo } from '../src/pattern.ts';
import { generateRepo } from '../src/materialize.ts';
import { runGit } from '../src/gitutil.ts';
import { buildFixture } from './fixture.ts';

const RUNTIME: RuntimeDefaults = {
  authorName: 'Pattern Person',
  authorEmail: 'pattern@example.com',
  tzOffset: 0,
  identitySource: 'git',
};

function settings(overrides: Record<string, unknown> = {}): Settings {
  const { settings: s, errors } = normalizeSettings(
    {
      timeline: { startDate: '2025-01-05', durationDays: 60 },
      activity: { seed: 8, burstProbability: 0 },
      ...overrides,
    },
    RUNTIME,
  );
  assert.deepEqual(errors, []);
  return s;
}

test('patternFromSettings renders title, chart, stats for the schedule', () => {
  const s = settings();
  const md = patternFromSettings(s);
  assert.match(md, /^# activity-history/);
  assert.match(md, /^```/m);
  assert.match(md, /legend:/m);
  assert.match(md, /Commits: \d+ over 60 days/);
  assert.match(md, /Window: 2025-01-05 → 2025-03-05/);
  assert.match(md, /Authored by: Pattern Person <pattern@example.com>/);
  // The ASCII grid has exactly 7 labeled weekday rows.
  const block = md.split('```')[1] ?? '';
  for (const label of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
    assert.ok(block.includes(label), `row label ${label}`);
  }
});

test('painted banner shows as full-strength cells in the pattern', () => {
  const s = settings({
    signwriter: {
      fullStrength: 100,
      overrides: { '2025-01-10': 4, '2025-01-11': 1 },
    },
  });
  const md = patternFromSettings(s);
  assert.match(md, /day\(s\) painted at full strength \(100 commits\)/);
  assert.match(md, /maxDay: 100/);
  assert.match(md, /▓|█/, 'dense cells appear in the chart');
});

test('generated repo contains a static README with the pattern', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitfuscation-'));
  const { settings: s, errors } = normalizeSettings(
    {
      output: { outPath: path.join(dir, 'repo') },
      timeline: { startDate: '2025-04-01', durationDays: 30 },
      activity: { seed: 21, totalCommits: 90 },
      content: { fileCount: 8 },
    },
    RUNTIME,
  );
  assert.deepEqual(errors, []);
  const result = await generateRepo(s);

  const readme = await readFile(path.join(result.outPath, 'README.md'), 'utf8');
  assert.match(readme, /^# activity-history/);
  assert.match(readme, /legend:/);

  // The README is static: only the initial scaffold commit touches it.
  const touchedBy = (await runGit(['log', '--format=%s', '--', 'README.md'], { cwd: result.outPath }))
    .trim()
    .split('\n')
    .filter((l) => l.length > 0);
  assert.equal(touchedBy.length, 1);
  assert.equal(touchedBy[0], 'chore: initial scaffold');
});

test('pattern embeds program version and exact generation settings', () => {
  const s = settings();
  const md = patternFromSettings(s);
  assert.match(md, /Program version: 0\.1a/);
  assert.match(md, /Generation settings \(exact\):/);
  const jsonBlock = md.split('```json')[1]?.split('```')[0] ?? '';
  assert.ok(jsonBlock.includes('"repoName": "activity-history"'), 'settings JSON embedded');
  assert.ok(jsonBlock.includes('"seed": 8'));
  assert.ok(jsonBlock.includes('"durationDays": 60'));
  // Without stored settings (arbitrary existing repo) the README still pins the version.
  const bare = patternMarkdown(
    {
      cells: [],
      weeks: 1,
      rows: 7,
      weekStart: 'sunday',
      totals: { commits: 0, activeDays: 0, maxDay: 0, burstDays: 0 },
      seed: 0,
      startDate: '',
      endDate: '',
    },
    'repo',
    'A',
    'a@b',
  );
  assert.match(bare, /Program version: 0\.1a/);
  assert.match(bare, /Generation settings: not recorded/);
});

test('pattern rendering is deterministic (no timestamps/clocks)', () => {
  const s = settings();
  assert.equal(patternFromSettings(s), patternFromSettings(settings()));
});

test('chartFromRepo reconstructs the same pattern from git history', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitfuscation-'));
  const { settings: s, errors } = normalizeSettings(
    {
      output: { outPath: path.join(dir, 'repo'), authorName: 'H', authorEmail: 'h@x.io' },
      timeline: { startDate: '2025-06-01', durationDays: 40 },
      activity: { seed: 5, totalCommits: 70 },
      content: { fileCount: 6 },
    },
    RUNTIME,
  );
  assert.deepEqual(errors, []);
  await generateRepo(s);

  const { payload, author, email } = await chartFromRepo(path.join(dir, 'repo'));
  assert.equal(payload.totals.commits, 71); // 70 scheduled + 1 scaffold
  assert.equal(author, 'H');
  assert.equal(email, 'h@x.io');
  assert.equal(payload.startDate, '2025-06-01');
  // Levels follow the github relative scale consistently.
  const maxCell = payload.cells.find((c) => c.count === payload.totals.maxDay);
  assert.equal(maxCell?.level, 4);
});

test('chartFromRepo handles an empty repo', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitfuscation-'));
  const repo = path.join(dir, 'empty');
  await runGit(['init', '-b', 'main', repo]);
  const { payload } = await chartFromRepo(repo);
  assert.equal(payload.totals.commits, 0);
  assert.deepEqual(payload.cells, []);
});
