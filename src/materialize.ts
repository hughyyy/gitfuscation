// materialize.ts — Day 1: schedule -> fresh repo via plumbing (SPEC §4.2).

import { mkdir, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Settings } from './settings.ts';
import { generateSchedule, type Schedule, type ScheduleTotals } from './schedule.ts';
import { makeContentSession, applyCommit, commitMessage } from './content.ts';
import {
  initRepo,
  hashObject,
  writeTree,
  commitTree,
  updateRef,
  runGit,
  fsck,
  identityEnv,
} from './gitutil.ts';

export interface GenerateResult {
  outPath: string;
  commitCount: number; // including the initial scaffold commit
  scheduleCommits: number;
  fileCount: number;
  firstCommitEpoch: number;
  lastCommitEpoch: number;
  branch: string;
  totals: ScheduleTotals;
  identitySource?: string;
}

function isWithin(outPath: string, root: string): boolean {
  const rel = path.relative(root, outPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function ensureEmptyDir(outPath: string, replace: boolean): Promise<void> {
  let exists = false;
  let empty = false;
  try {
    await stat(outPath);
    exists = true;
    const entries = await readdir(outPath);
    empty = entries.length === 0;
  } catch {
    // does not exist
  }
  if (exists && !empty) {
    if (!replace) {
      throw new Error(
        `outPath exists and is not empty (${outPath}); remove it, set output.replace: true, or pick another path`,
      );
    }
    await rm(outPath, { recursive: true, force: true });
  }
  await mkdir(outPath, { recursive: true });
}

/**
 * Create a fresh repo implementing `settings`' scheduled history.
 * Deterministic under the settings seed: the same settings regenerate the same
 * history (the preview and generate paths share generateSchedule).
 */
export async function generateRepo(
  settings: Settings,
  onProgress?: (done: number, total: number) => void,
): Promise<GenerateResult> {
  const cwd = path.resolve(settings.output.outPath);
  const projectRoot = process.cwd();
  if (!isWithin(cwd, projectRoot) && !path.isAbsolute(settings.output.outPath)) {
    throw new Error(`refusing to write outside the project: ${cwd}`);
  }
  await ensureEmptyDir(cwd, settings.output.replace);

  const schedule: Schedule = generateSchedule(settings);
  const branch = settings.output.branchName;

  await initRepo(cwd, branch);
  const ref = `refs/heads/${branch}`;

  const session = makeContentSession(settings);
  const state = new Map<string, string>(); // path -> blob oid
  for (const [filePath, content] of session.files) {
    state.set(filePath, await hashObject(cwd, content));
  }

  const treeFor = async (): Promise<string> => {
    const entries = [...state.entries()].map(([filePath, oid]) => ({
      path: filePath,
      oid,
    }));
    return writeTree(cwd, entries);
  };

  let head = await commitTree(
    cwd,
    await treeFor(),
    [],
    identityEnv(settings, schedule.days[0]?.epoch ?? Date.now() / 1000),
    'chore: initial scaffold',
  );
  await updateRef(cwd, ref, head);

  const total = schedule.commits.length;
  for (let i = 0; i < total; i += 1) {
    const commit = schedule.commits[i];
    const touched = applyCommit(session, commit.dateKey);
    for (const filePath of touched) {
      state.set(filePath, await hashObject(cwd, session.files.get(filePath) ?? ''));
    }
    const env = identityEnv(settings, commit.ts);
    const message = commitMessage(session.rng, touched, settings);
    head = await commitTree(cwd, await treeFor(), [head], env, message);
    await updateRef(cwd, ref, head);
    if (onProgress && (i % 64 === 0 || i === total - 1)) onProgress(i + 1, total);
  }

  await fsck(cwd);
  await runGit(['gc', '--quiet'], { cwd });

  return {
    outPath: cwd,
    commitCount: 1 + total,
    scheduleCommits: total,
    fileCount: state.size,
    firstCommitEpoch: schedule.days[0]?.epoch ?? 0,
    lastCommitEpoch: total > 0 ? schedule.commits[total - 1].ts : schedule.days[0]?.epoch ?? 0,
    branch,
    totals: schedule.totals,
  };
}
