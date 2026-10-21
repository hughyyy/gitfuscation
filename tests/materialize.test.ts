// materialize.test.ts — SPEC §4.2/§9: real repo correctness + preview parity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  normalizeSettings,
  type RuntimeDefaults,
  type Settings,
} from '../src/settings.ts';
import { generateRepo } from '../src/materialize.ts';
import { generateSchedule, dateKeyOfEpoch } from '../src/schedule.ts';
import { previewFor } from '../src/preview.ts';
import { runGit, listCommits } from '../src/gitutil.ts';

const RUNTIME: RuntimeDefaults = {
  authorName: 'Integ Test',
  authorEmail: 'integ@example.com',
  tzOffset: 0,
  identitySource: 'git',
};

function testSettings(outPath: string, durationDays = 45): Settings {
  const { settings, errors } = normalizeSettings(
    {
      output: { outPath, replace: true },
      timeline: { startDate: '2025-01-05', durationDays },
      activity: { seed: 11, totalCommits: 120, maxCommitsPerDay: 60 },
      content: { fileCount: 8 },
    },
    RUNTIME,
  );
  assert.deepEqual(errors, []);
  return settings;
}

test('generated repo matches the schedule exactly', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitfuscation-'));
  const settings = testSettings(path.join(dir, 'repo'));
  const result = await generateRepo(settings);

  const schedule = generateSchedule(settings);

  // Commit count (initial + scheduled)
  const count = (await runGit(['rev-list', '--count', 'HEAD'], { cwd: result.outPath })).trim();
  assert.equal(Number(count), 1 + schedule.totals.commits);
  assert.equal(result.totals.commits, schedule.totals.commits);

  // Author dates must match the schedule second-for-second (SPEC §9)
  const commits = await listCommits(result.outPath);
  assert.equal(commits.length, 1 + schedule.commits.length);
  assert.equal(commits[0].authorTime, schedule.days[0].epoch, 'initial commit at day-0 midnight');
  for (let i = 0; i < schedule.commits.length; i += 1) {
    assert.equal(commits[i + 1].authorTime, schedule.commits[i].ts, `commit ${i} date mismatch`);
  }

  // Default branch
  const branch = (await runGit(['branch', '--show-current'], { cwd: result.outPath })).trim();
  assert.equal(branch, 'main');

  // Tree file count matches the final session size
  const treeFiles = (await runGit(['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: result.outPath })).trim().split('\n').filter((l) => l.length > 0);
  assert.equal(treeFiles.length, result.fileCount);
  assert.ok(treeFiles.length >= 8, 'corpus files present');

  // fsck clean
  await runGit(['fsck', '--strict'], { cwd: result.outPath });

  await readdir(path.join(dir));
});

test('regeneration is byte-identical (same SHAs)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitfuscation-'));
  const a = await generateRepo(testSettings(path.join(dir, 'a')));
  const b = await generateRepo(testSettings(path.join(dir, 'b')));
  const shaA = (await runGit(['rev-list', 'HEAD'], { cwd: a.outPath })).trim().split('\n');
  const shaB = (await runGit(['rev-list', 'HEAD'], { cwd: b.outPath })).trim().split('\n');
  assert.deepEqual(shaB, shaA, 'deterministic regeneration must produce identical history');
});

test('preview and repo per-day counts agree exactly (parity)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitfuscation-'));
  const settings = testSettings(path.join(dir, 'repo'), 60);
  const result = await generateRepo(settings);

  const payload = previewFor(settings);
  assert.deepEqual(payload.cells.length, 60);

  // Repo per-day counts via author date + settings tz offset
  const commits = await listCommits(result.outPath);
  const perDay = new Map<string, number>();
  for (const c of commits.slice(1)) {
    const key = dateKeyOfEpoch(c.authorTime, settings.output.tzOffset);
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  for (const cell of payload.cells) {
    const repoCount = perDay.get(cell.dateISO) ?? 0;
    assert.equal(repoCount, cell.count, `${cell.dateISO}: repo ${repoCount} != preview ${cell.count}`);
  }
});

test('outPath exists without replace -> clear error', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitfuscation-'));
  const settings = testSettings(path.join(dir, 'repo'), 10);
  settings.output.replace = false; // testSettings defaults to replace:true
  await generateRepo(settings);
  await assert.rejects(() => generateRepo(settings), /exists and is not empty/);
  const retry = { ...settings, output: { ...settings.output, replace: true } };
  const ok = await generateRepo(retry);
  assert.ok(ok.commitCount >= 2);
});
