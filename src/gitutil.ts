// gitutil.ts — thin wrappers over git plumbing commands (SPEC §4.2).
// All calls are async `execFile` invocations; identity/dates travel via env.

import { spawn } from 'node:child_process';

export class GitError extends Error {
  readonly args: string[];
  readonly stderr: string;

  constructor(message: string, args: string[], stderr: string) {
    super(`${message}\n$ git ${args.join(' ')}\n${stderr.trim()}`);
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
  }
}

export interface GitEnv {
  GIT_AUTHOR_NAME: string;
  GIT_AUTHOR_EMAIL: string;
  GIT_AUTHOR_DATE: string;
  GIT_COMMITTER_NAME: string;
  GIT_COMMITTER_EMAIL: string;
  GIT_COMMITTER_DATE: string;
}

/** Format a git date string: '@<unix> <±HHMM>' from epoch seconds + tz offset. */
export function gitDate(epochSec: number, tzOffset: number): string {
  const sign = tzOffset >= 0 ? '+' : '-';
  const abs = Math.abs(tzOffset);
  const hh = String(Math.floor(abs)).padStart(2, '0');
  const mm = String((abs - Math.floor(abs)) * 60).padStart(2, '0');
  return `@${Math.floor(epochSec)} ${sign}${hh}${mm}`;
}

export function identityEnv(
  settings: { output: { authorName: string; authorEmail: string; tzOffset: number } },
  epochSec: number,
): GitEnv {
  const date = gitDate(epochSec, settings.output.tzOffset);
  return {
    GIT_AUTHOR_NAME: settings.output.authorName,
    GIT_AUTHOR_EMAIL: settings.output.authorEmail,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: settings.output.authorName,
    GIT_COMMITTER_EMAIL: settings.output.authorEmail,
    GIT_COMMITTER_DATE: date,
  };
}

export async function runGit(
  args: string[],
  opts: { cwd?: string; input?: string; env?: Record<string, string> } = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new GitError(`git failed (exit ${code})`, args, stderr || stdout));
      }
    });
    child.stdin.on('error', () => {
      // stdin may close before we write when git exits early; swallow.
    });
    if (opts.input != null) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** `git init -b <branch>` in a fresh directory. */
export function initRepo(cwd: string, branch: string): Promise<string> {
  return runGit(['init', '-b', branch], { cwd });
}

/** Write a blob from stdin content; returns the object id. */
export async function hashObject(cwd: string, content: string): Promise<string> {
  const out = await runGit(['hash-object', '-w', '--stdin'], { cwd, input: content });
  return out.trim();
}

interface TreeNode {
  dirs: Map<string, TreeNode>;
  files: Map<string, { oid: string; mode: string }>; // name -> blob
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Build a tree object from flat path->blob entries, nesting directories so
 * `git mktree` sees no slashed paths (tree entries are single-level).
 * Entries are sorted per level so hashes are canonical. Returns the tree id.
 */
export async function writeTree(
  cwd: string,
  entries: Array<{ path: string; oid: string; mode?: string }>,
): Promise<string> {
  if (entries.length === 0) return EMPTY_TREE;
  const root: TreeNode = { dirs: new Map(), files: new Map() };
  for (const e of entries) {
    const parts = e.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (next === undefined) {
        next = { dirs: new Map(), files: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1] as string, { oid: e.oid, mode: e.mode ?? '100644' });
  }
  const nameCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const render = async (node: TreeNode): Promise<string> => {
    const lines: Array<{ mode: string; type: string; oid: string; name: string }> = [];
    for (const [name, child] of node.dirs) {
      lines.push({ mode: '040000', type: 'tree', oid: await render(child), name });
    }
    for (const [name, entry] of node.files) {
      lines.push({ mode: entry.mode, type: 'blob', oid: entry.oid, name });
    }
    lines.sort((a, b) => nameCompare(a.name, b.name));
    const input = lines.map((l) => `${l.mode} ${l.type} ${l.oid}\t${l.name}`).join('\n') + '\n';
    const out = await runGit(['mktree'], { cwd, input });
    return out.trim();
  };
  return render(root);
}

export async function commitTree(
  cwd: string,
  tree: string,
  parents: string[],
  identity: GitEnv,
  message: string,
): Promise<string> {
  const args = ['commit-tree', tree];
  for (const p of parents) args.push('-p', p);
  const parts = message.split('\n\n');
  args.push('-m', parts[0]);
  if (parts.length > 1 && parts[1] !== '') args.push('-m', parts[1]);
  const out = await runGit(args, { cwd, env: identity as unknown as Record<string, string> });
  return out.trim();
}

export async function updateRef(
  cwd: string,
  ref: string,
  oid: string,
): Promise<void> {
  await runGit(['update-ref', ref, oid], { cwd });
}

/** `git log --format=%H\t%at` — one line per commit, oldest first. */
export async function listCommits(cwd: string, rev: string = 'HEAD'): Promise<Array<{ oid: string; authorTime: number }>> {
  const out = await runGit(
    ['log', '--format=%H%x09%at', '--reverse', rev],
    { cwd },
  );
  return out
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const [oid, at] = l.split('\t');
      return { oid, authorTime: Number(at) };
    });
}

/** `git fsck --strict` — throws on corruption. */
export function fsck(cwd: string): Promise<string> {
  return runGit(['fsck', '--strict'], { cwd });
}
