// reauth.ts — repair incorrect commit attribution on a repo you own: rebuilds
// commit objects with identical trees, dates, and messages, mapping only the
// author/committer identity. Destructive (SHAs change): backs up every touched
// ref under refs/backup/.

import { runGit, fsck } from './gitutil.ts';
import { mapIdentity, type IdentityMap } from './identity-map.ts';

export interface ReauthOptions {
  rewriteCommitter?: boolean; // default true
  includeTags?: boolean; // default true
}

export interface ChangeGroup {
  fromIdentity: string;
  toIdentity: string;
  commitCount: number;
}

export interface RefMove {
  ref: string;
  oldTip: string;
  newTip: string;
}

export interface ReauthPlan {
  repoPath: string;
  changes: ChangeGroup[]; // identity reattributions (from -> to, count)
  affectedCommits: number; // commits that got a new oid (incl. structural)
  identityCommits: number; // commits whose identity actually changed
  untouchedCommits: number;
  commitsTotal: number;
  strippedSignatures: number;
  refsToMove: RefMove[];
  rewriteCommitter: boolean;
}

export interface ReauthResult extends ReauthPlan {
  backupRefs: string[];
  newObjectCount: number;
}

export interface CommitRef {
  ref: string;
  objectType: string; // 'commit' | 'tag'
  oid: string; // direct ref target (commit oid, or tag-object oid)
  peeledOid: string; // dereferenced commit oid
}

interface ParsedCommit {
  header: string;
  message: string;
  parents: string[];
  author: string;
  committer: string;
}

interface Ident {
  tag: string;
  name: string;
  email: string;
  date: string; // trailing "epoch tz" tokens, preserved verbatim
}

const IDENT_RE = /^(\w+) (.*) <([^>]*)> (\d+ [+-]\d{4})$/;

function parseIdent(line: string): Ident | null {
  const m = line.match(IDENT_RE);
  if (m === null) return null;
  return { tag: m[1] as string, name: m[2] as string, email: m[3] as string, date: m[4] as string };
}

function parseCommit(raw: string): ParsedCommit {
  const nl = raw.indexOf('\n\n');
  const header = nl === -1 ? raw : raw.slice(0, nl);
  const message = nl === -1 ? '' : raw.slice(nl + 2);
  const lines = header.split('\n');
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const ln of lines) {
    if (ln.startsWith('parent ')) parents.push(ln.slice('parent '.length));
    else if (ln.startsWith('author ')) author = ln;
    else if (ln.startsWith('committer ')) committer = ln;
  }
  return { header, message, parents, author, committer };
}

/** Drop gpgsig header lines (their signature binds the old object; it breaks). */
function stripSignatures(headerLines: string[]): string[] {
  const out: string[] = [];
  let skipContinuation = false;
  for (const ln of headerLines) {
    if (ln.startsWith('gpgsig')) {
      skipContinuation = true;
      continue;
    }
    if (skipContinuation && (ln.startsWith(' ') || ln === '')) continue;
    skipContinuation = false;
    out.push(ln);
  }
  return out;
}

async function enumerateRefs(repoPath: string, includeTags: boolean): Promise<CommitRef[]> {
  const patterns = ['refs/heads'];
  if (includeTags) patterns.push('refs/tags');
  const fmt = '%(refname)%09%(objecttype)%09%(objectname)%09%(*objectname)';
  const out = await runGit(['for-each-ref', `--format=${fmt}`, ...patterns], { cwd: repoPath });
  const refs: CommitRef[] = [];
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    const [ref, objectType, oid, peeled] = line.split('\t');
    refs.push({
      ref: ref as string,
      objectType: objectType as string,
      oid: oid as string,
      peeledOid: peeled !== undefined && peeled !== '' ? peeled : (oid as string),
    });
  }
  return refs;
}

async function loadParents(repoPath: string, refs: CommitRef[]): Promise<Map<string, string[]>> {
  const out = await runGit(
    ['rev-list', '--parents', ...refs.map((r) => r.ref)],
    { cwd: repoPath },
  );
  const parents = new Map<string, string[]>();
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    const [oid, ...ps] = line.split(' ');
    parents.set(oid as string, ps as string[]);
  }
  return parents;
}

/**
 * Ancestor-first order (parents before children) via iterative DFS post-order
 * over shared commits. Each tip's subtree is fully drained before the next tip
 * starts, mirroring the original recursion (marking a node visited at push is
 * only safe when its whole subtree completes before any other walk can
 * reference it). Iterative: deep linear histories must not blow the stack.
 */
export function topoOrder(parents: Map<string, string[]>, tips: string[]): string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  const stack: Array<{ oid: string; next: number }> = [];
  for (const tip of tips) {
    if (visited.has(tip)) continue;
    visited.add(tip);
    stack.push({ oid: tip, next: 0 });
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { oid: string; next: number };
      const ps = parents.get(top.oid) ?? [];
      if (top.next < ps.length) {
        const p = ps[top.next] as string;
        top.next += 1;
        if (!visited.has(p)) {
          visited.add(p);
          stack.push({ oid: p, next: 0 });
        }
      } else {
        order.push(top.oid);
        stack.pop();
      }
    }
  }
  return order;
}

interface RewrittenCommit {
  oldOid: string;
  newOid: string;
  fromIdentity: string | null;
  toIdentity: string | null;
  identityChanged: boolean;
}

async function computeMapping(
  repoPath: string,
  order: string[],
  parentMap: Map<string, string[]>,
  identityMap: IdentityMap,
  rewriteCommitter: boolean,
  writeObjects: boolean,
): Promise<{ mapping: Map<string, string>; rewritten: RewrittenCommit[]; strippedSignatures: number }> {
  const mapping = new Map<string, string>();
  const rewritten: RewrittenCommit[] = [];
  let strippedSignatures = 0;

  for (const oid of order) {
    const parsed = parseCommit(await runGit(['cat-file', 'commit', oid], { cwd: repoPath }));
    const aI = parseIdent(parsed.author);
    const cI = parseIdent(parsed.committer);
    const toAuthor = aI !== null ? mapIdentity(identityMap, aI.name, aI.email) : null;
    const toCommitter =
      rewriteCommitter && cI !== null ? mapIdentity(identityMap, cI.name, cI.email) : null;
    const newParents = parsed.parents.map((p) => {
      const mappedParent = mapping.get(p);
      if (mappedParent === undefined) {
        throw new Error(`topology error: parent ${p} of ${oid} not mapped`);
      }
      return mappedParent;
    });
    const parentsChanged = newParents.some((np, i) => np !== parsed.parents[i]);
    const hasSignature = parsed.header.includes('gpgsig');
    if (toAuthor === null && toCommitter === null && !parentsChanged && !hasSignature) {
      mapping.set(oid, oid);
      continue;
    }

    const headerLines = parsed.header.split('\n');
    const kept = stripSignatures(headerLines);
    if (kept.length !== headerLines.length) strippedSignatures += 1;

    let parentIdx = 0;
    const outLines = kept.map((ln) => {
      if (ln.startsWith('parent ')) {
        return `parent ${newParents[parentIdx++]}`;
      }
      if (ln.startsWith('author ') && toAuthor !== null && aI !== null) {
        return `author ${toAuthor.name} <${toAuthor.email}> ${aI.date}`;
      }
      if (ln.startsWith('committer ') && toCommitter !== null && cI !== null) {
        return `committer ${toCommitter.name} <${toCommitter.email}> ${cI.date}`;
      }
      return ln;
    });
    const newRaw = outLines.join('\n') + '\n\n' + parsed.message;
    const args = writeObjects
      ? ['hash-object', '-w', '-t', 'commit', '--stdin']
      : ['hash-object', '-t', 'commit', '--stdin'];
    const newOid = (await runGit(args, { cwd: repoPath, input: newRaw })).trim();
    mapping.set(oid, newOid);

    const identityChanged = toAuthor !== null || toCommitter !== null;
    rewritten.push({
      oldOid: oid,
      newOid,
      fromIdentity:
        identityChanged && aI !== null ? `${aI.name} <${aI.email}>` : null,
      toIdentity:
        identityChanged && toAuthor !== null ? `${toAuthor.name} <${toAuthor.email}>` : null,
      identityChanged,
    });
  }
  return { mapping, rewritten, strippedSignatures };
}

/** Rebuild an annotated tag object targeting the mapped commit; null if untouched. */
function rebuildTagRaw(raw: string, mapping: Map<string, string>): { newRaw: string; target: string } | null {
  const nl = raw.indexOf('\n\n');
  const header = nl === -1 ? raw : raw.slice(0, nl);
  const message = nl === -1 ? '' : raw.slice(nl + 2);
  let target: string | null = null;
  const lines = header.split('\n').map((ln) => {
    if (ln.startsWith('object ')) {
      const oid = ln.slice('object '.length);
      target = mapping.get(oid) ?? oid;
      return `object ${target}`;
    }
    return ln;
  });
  if (target === null) return null;
  return { newRaw: lines.join('\n') + '\n\n' + message, target };
}

async function computeRefMoves(
  repoPath: string,
  refs: CommitRef[],
  mapping: Map<string, string>,
  writeObjects: boolean,
): Promise<RefMove[]> {
  const moves: RefMove[] = [];
  for (const r of refs) {
    if (r.objectType === 'tag') {
      const raw = await runGit(['cat-file', 'tag', r.oid], { cwd: repoPath });
      const rebuilt = rebuildTagRaw(raw, mapping);
      if (rebuilt === null || rebuilt.newRaw === raw) continue;
      const args = writeObjects
        ? ['hash-object', '-w', '-t', 'tag', '--stdin']
        : ['hash-object', '-t', 'tag', '--stdin'];
      const newOid = (await runGit(args, { cwd: repoPath, input: rebuilt.newRaw })).trim();
      if (newOid !== r.oid) moves.push({ ref: r.ref, oldTip: r.oid, newTip: newOid });
      continue;
    }
    // lightweight tag or branch head -> commit tip
    const newTip = mapping.get(r.oid);
    if (newTip !== undefined && newTip !== r.oid) {
      moves.push({ ref: r.ref, oldTip: r.oid, newTip });
    }
  }
  return moves;
}

function buildPlan(
  repoPath: string,
  rewritten: RewrittenCommit[],
  commitsTotal: number,
  strippedSignatures: number,
  refsToMove: RefMove[],
  rewriteCommitter: boolean,
): ReauthPlan {
  const byChange = new Map<string, ChangeGroup>();
  let identityCommits = 0;
  for (const r of rewritten) {
    if (!r.identityChanged) continue;
    identityCommits += 1;
    const key = `${r.fromIdentity} -> ${r.toIdentity}`;
    const existing = byChange.get(key);
    if (existing === undefined) {
      byChange.set(key, {
        fromIdentity: r.fromIdentity ?? '',
        toIdentity: r.toIdentity ?? '',
        commitCount: 1,
      });
    } else {
      existing.commitCount += 1;
    }
  }
  return {
    repoPath,
    changes: [...byChange.values()].sort((a, b) => b.commitCount - a.commitCount),
    affectedCommits: rewritten.length,
    identityCommits,
    untouchedCommits: commitsTotal - rewritten.length,
    commitsTotal,
    strippedSignatures,
    refsToMove,
    rewriteCommitter,
  };
}

async function assertCleanWorktree(repoPath: string): Promise<void> {
  const dirty = (await runGit(['status', '--porcelain'], { cwd: repoPath })).trim();
  if (dirty !== '') {
    throw new Error(
      'refusing to rewrite a dirty worktree (uncommitted changes present). Commit or stash first.',
    );
  }
}

/**
 * Dry-run: compute and report what reattribution would change, without writing
 * objects or moving refs (non-persisting hash-object).
 */
export async function planReauth(
  repoPath: string,
  identityMap: IdentityMap,
  opts: ReauthOptions = {},
): Promise<ReauthPlan> {
  await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: repoPath });
  const refs = await enumerateRefs(repoPath, opts.includeTags ?? true);
  const parentMap = await loadParents(repoPath, refs);
  const tips = refs.map((r) => r.peeledOid).filter((t) => parentMap.has(t));
  const order = topoOrder(parentMap, tips);
  const { mapping, rewritten, strippedSignatures } = await computeMapping(
    repoPath, order, parentMap, identityMap, opts.rewriteCommitter ?? true, false,
  );
  const refsToMove = await computeRefMoves(repoPath, refs, mapping, false);
  return buildPlan(repoPath, rewritten, order.length, strippedSignatures, refsToMove, opts.rewriteCommitter ?? true);
}

/**
 * Execute reattribution: rebuild the commit DAG with mapped identities (same
 * trees/dates/messages), back up every moved ref under refs/backup/, then
 * compact. Destructive — callers must confirm first.
 */
export async function executeReauth(
  repoPath: string,
  identityMap: IdentityMap,
  opts: ReauthOptions = {},
): Promise<ReauthResult> {
  await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: repoPath });
  await assertCleanWorktree(repoPath);
  const refs = await enumerateRefs(repoPath, opts.includeTags ?? true);
  const parentMap = await loadParents(repoPath, refs);
  const tips = refs.map((r) => r.peeledOid).filter((t) => parentMap.has(t));
  const order = topoOrder(parentMap, tips);
  const { mapping, rewritten, strippedSignatures } = await computeMapping(
    repoPath, order, parentMap, identityMap, opts.rewriteCommitter ?? true, true,
  );
  const refsToMove = await computeRefMoves(repoPath, refs, mapping, true);

  const backupRefs: string[] = [];
  for (const move of refsToMove) {
    const backupRef = `refs/backup/${move.ref.replace(/^refs\//, '')}`;
    await runGit(['update-ref', backupRef, move.oldTip], { cwd: repoPath });
    backupRefs.push(backupRef);
  }
  for (const move of refsToMove) {
    await runGit(['update-ref', move.ref, move.newTip], { cwd: repoPath });
  }

  await runGit(['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'], { cwd: repoPath });
  await runGit(['gc', '--prune=now', '--quiet'], { cwd: repoPath });
  await fsck(repoPath);

  return {
    ...buildPlan(repoPath, rewritten, order.length, strippedSignatures, refsToMove, opts.rewriteCommitter ?? true),
    backupRefs,
    newObjectCount: rewritten.length + refsToMove.filter((m) => m.ref.startsWith('refs/tags/')).length,
  };
}
