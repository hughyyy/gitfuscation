// fixture.ts — build a small multi-author repo for authors/reauth tests.
// Topology: main c1→c2→c3→(merge c4)→c5→c6; dev branch c4 merged into c5;
// annotated tag "alpha" on c3 (an ancestor, NOT a tip — exercises the
// peeled-oid enum bug).

import { mkdir } from 'node:fs/promises';
import {
  runGit,
  hashObject,
  writeTree,
  commitTree,
  updateRef,
  initRepo,
  gitDate,
  type GitEnv,
} from '../src/gitutil.ts';

export function identEnv(
  name: string,
  email: string,
  epoch: number,
  tzOffset = 0,
): GitEnv {
  const date = gitDate(epoch, tzOffset);
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: date,
  };
}

export interface Fixture {
  dir: string;
  oids: Record<string, string>;
  headOid: string;
  tagOid: string; // annotated tag object id
  messages: Record<string, string>;
}

/** 2025-01-01 09:00 UTC etc. */
const D = (d: number, h: number): number => Date.UTC(2025, 0, d, h) / 1000;

export async function buildFixture(root: string, name = 'fixture'): Promise<Fixture> {
  const dir = `${root}/${name}`;
  await mkdir(dir, { recursive: true });
  await initRepo(dir, 'main');

  const blob = async (content: string): Promise<string> => hashObject(dir, content);
  const b1 = await blob('hello world\n');
  const b2 = await blob('hello world\n\nextra notes\n');
  const b3 = await blob('hello world\n\nconst a = 1;\n');
  const tree0 = await writeTree(dir, [{ path: 'README.md', oid: b1 }]);
  const tree1 = await writeTree(dir, [
    { path: 'README.md', oid: b1 },
    { path: 'notes.md', oid: b2 },
  ]);
  const tree2 = await writeTree(dir, [
    { path: 'README.md', oid: b1 },
    { path: 'notes.md', oid: b2 },
    { path: 'src/a.ts', oid: b3 },
  ]);
  const treeDev = await writeTree(dir, [
    { path: 'README.md', oid: b1 },
    { path: 'notes.md', oid: b2 },
    { path: 'dev.txt', oid: b2 },
  ]);

  const mk = async (tree: string, parents: string[], env: GitEnv, msg: string): Promise<string> =>
    commitTree(dir, tree, parents, env, msg);

  const c1 = await mk(tree0, [], identEnv('bernie', 'bernie@local', D(1, 9)), 'first commit');
  const c2 = await mk(tree1, [c1], identEnv('bernie', 'bernie@localhost', D(3, 18)), 'second commit');
  const c3 = await mk(tree2, [c2], identEnv('astro', 'astro@local', D(5, 12)), 'third commit');
  const c4 = await mk(treeDev, [c2], identEnv('bernie', 'bernie@local', D(6, 10)), 'dev branch work');
  const c5 = await mk(tree2, [c3, c4], identEnv('bernie', 'bernie@localhost', D(7, 15)), 'merge dev into main');
  const c6 = await mk(tree2, [c5], identEnv('other', 'other@example.com', D(8, 11)), 'maintainer tweak');

  await updateRef(dir, 'refs/heads/main', c6);
  await updateRef(dir, 'refs/heads/dev', c4);

  // Materialize the working tree so `git status` is clean (commit-tree builds
  // objects only).
  await runGit(['reset', '--hard', 'main'], { cwd: dir });

  const tagRaw = `object ${c3}\ntype commit\ntag alpha\ntagger bernie <bernie@local> ${D(5, 13)} +0000\n\nrelease candidate\n`;
  const tagOid = (await runGit(['hash-object', '-w', '-t', 'tag', '--stdin'], { cwd: dir, input: tagRaw })).trim();
  await updateRef(dir, 'refs/tags/alpha', tagOid);

  return {
    dir,
    oids: { c1, c2, c3, c4, c5, c6 },
    headOid: c6,
    tagOid,
    messages: {
      c1: 'first commit',
      c2: 'second commit',
      c3: 'third commit',
      c4: 'dev branch work',
      c5: 'merge dev into main',
      c6: 'maintainer tweak',
    },
  };
}
