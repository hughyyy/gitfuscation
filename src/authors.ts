// authors.ts — per-repo authorship read layer: who authored what, when.

import { runGit } from './gitutil.ts';

export interface AuthorDay {
  dateKey: string;
  count: number;
}

export interface AuthorStat {
  identity: string; // 'Name <email>'
  name: string;
  email: string;
  count: number;
  first: number; // epoch seconds (author date)
  last: number;
  days: AuthorDay[]; // chronological day buckets (author-date calendar day)
}

export interface RepoAuthors {
  path: string;
  name: string;
  head: string;
  branches: string[];
  tagCount: number;
  commitCount: number;
  lastActivity: number;
  authors: AuthorStat[];
}

function parseIsoDay(iso: string): string {
  // %aI -> '2026-02-03T11:00:00+11:00'; the contribution day is its date part.
  return iso.slice(0, 10);
}

/**
 * Enumerate authorship across ALL refs (heads + tags). Days bucket by the
 * author-date calendar day (as recorded in the commit's own timezone), which
 * is how GitHub renders the contribution graph.
 */
export async function inspectAuthors(repoPath: string): Promise<RepoAuthors> {
  const head =
    (await runGit(['symbolic-ref', '--short', 'HEAD'], { cwd: repoPath }).catch(() => '')).trim() ||
    (await runGit(['branch', '--show-current'], { cwd: repoPath })).trim();

  const branches = (
    await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: repoPath })
  )
    .trim()
    .split('\n')
    .filter((l) => l.length > 0);

  const tagOut = await runGit(['for-each-ref', '--format=%(refname)', 'refs/tags'], { cwd: repoPath }).catch(() => '');
  const tagCount = tagOut.trim() === '' ? 0 : tagOut.trim().split('\n').filter((l) => l.length > 0).length;

  const commitCount = Number(
    (await runGit(['rev-list', '--count', '--all'], { cwd: repoPath }).catch(() => '0')).trim() || '0',
  );

  const lastActivity = Number(
    (await runGit(['log', '-1', '--all', '--format=%ct'], { cwd: repoPath }).catch(() => '0')).trim() || '0',
  );

  const byIdentity = new Map<string, AuthorStat>();
  if (commitCount > 0) {
    // oid<TAB>name<TAB>email<TAB>authorDateISO
    const out = await runGit(
      ['log', '--all', '--format=%H%x09%an%x09%ae%x09%aI'],
      { cwd: repoPath },
    );
    for (const line of out.split('\n')) {
      if (line.trim() === '') continue;
      const parts = line.split('\t');
      if (parts.length < 4) continue;
      const [, name, email, iso] = parts as [string, string, string, string];
      const at = Math.floor(new Date(iso).getTime() / 1000);
      const identity = `${name} <${email}>`;
      let stat = byIdentity.get(identity);
      if (stat === undefined) {
        stat = { identity, name, email, count: 0, first: at, last: at, days: [] };
        byIdentity.set(identity, stat);
      }
      stat.count += 1;
      stat.first = Math.min(stat.first, at);
      stat.last = Math.max(stat.last, at);
    }
    // Build day buckets per author from a second pass (sorted by author date).
    const outSorted = await runGit(
      ['log', '--all', '--date-order', '--format=%an%x09%ae%x09%aI'],
      { cwd: repoPath },
    );
    const dayMap = new Map<string, Map<string, number>>();
    for (const line of outSorted.split('\n')) {
      if (line.trim() === '') continue;
      const [name, email, iso] = line.split('\t');
      const identity = `${name} <${email}>`;
      const dayKey = parseIsoDay(iso);
      let m = dayMap.get(identity);
      if (m === undefined) {
        m = new Map();
        dayMap.set(identity, m);
      }
      m.set(dayKey, (m.get(dayKey) ?? 0) + 1);
    }
    for (const stat of byIdentity.values()) {
      const m = dayMap.get(stat.identity);
      if (m !== undefined) {
        stat.days = [...m.entries()]
          .map(([dateKey, count]) => ({ dateKey, count }))
          .sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0));
      }
    }
  }

  const authors = [...byIdentity.values()].sort((a, b) => b.count - a.count);
  return {
    path: repoPath,
    name: repoPath.split('/').pop() ?? repoPath,
    head,
    branches,
    tagCount,
    commitCount,
    lastActivity,
    authors,
  };
}
