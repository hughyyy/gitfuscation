// repoindex.ts — discover git worktrees under a root dir and summarize them.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './gitutil.ts';

export interface RepoSummary {
  name: string;
  rel: string; // path relative to the scan root
  path: string; // absolute
  commits: number;
  heads: number;
  lastActivity: number; // epoch seconds of newest commit across all refs
  topAuthors: Array<{ identity: string; count: number }>;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'generated', 'build', '.cache']);

async function isWorktree(dir: string): Promise<boolean> {
  try {
    const s = await stat(path.join(dir, '.git'));
    return s.isDirectory() || s.isFile(); // normal repo, or submodule/worktree (.git file)
  } catch {
    return false;
  }
}

async function summarize(dir: string, rel: string): Promise<RepoSummary | null> {
  try {
    const heads =
      Number(
        (await runGit(['for-each-ref', '--format=%(refname)', 'refs/heads'], { cwd: dir }))
          .trim().split('\n').filter((l) => l.length > 0).length,
      ) || 0;
    const commits =
      Number((await runGit(['rev-list', '--count', '--all'], { cwd: dir })).trim()) || 0;
    // Latest commit date across heads and tags (fall back to heads).
    let lastActivity = 0;
    try {
      lastActivity = Number(
        (await runGit(['log', '-1', '--all', '--format=%ct'], { cwd: dir })).trim(),
      );
    } catch {
      lastActivity = 0;
    }
    let topAuthors: Array<{ identity: string; count: number }> = [];
    if (commits > 0) {
      const out = await runGit(['log', '--all', '--format=%an <%ae>'], { cwd: dir });
      const tally = new Map<string, number>();
      for (const line of out.split('\n')) {
        if (line.trim() === '') continue;
        tally.set(line, (tally.get(line) ?? 0) + 1);
      }
      topAuthors = [...tally.entries()]
        .map(([identity, count]) => ({ identity, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 4);
    }
    return { name: rel.split('/').pop() ?? rel, rel, path: dir, commits, heads, lastActivity, topAuthors };
  } catch {
    return null; // unreadable/corrupt repo — skip
  }
}

/**
 * Recursively find git worktrees under `root` (depth-limited), skipping build
 * dirs. Returns newest-first by last activity.
 */
export async function scanRepos(root: string, maxDepth = 3): Promise<RepoSummary[]> {
  const found: RepoSummary[] = [];
  const visit = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    if (await isWorktree(dir)) {
      const summary = await summarize(dir, rel);
      if (summary !== null) found.push(summary);
      return; // do not descend into sub-repos
    }
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    const dirs = await Promise.all(
      entries.map(async (e) => {
        if (SKIP_DIRS.has(e)) return null;
        if (e.startsWith('.')) return null;
        const p = path.join(dir, e);
        try {
          return (await stat(p)).isDirectory() ? p : null;
        } catch {
          return null;
        }
      }),
    );
    for (const d of dirs) {
      if (d !== null) {
        const relChild = rel === '' ? path.basename(d) : `${rel}/${path.basename(d)}`;
        await visit(d, relChild, depth + 1);
      }
    }
  };
  await visit(root, '', 0);
  found.sort((a, b) => b.lastActivity - a.lastActivity);
  return found;
}
