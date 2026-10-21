// authors.test.ts + repoindex.test.ts — read layer: repo discovery + authorship.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectAuthors } from '../src/authors.ts';
import { scanRepos } from '../src/repoindex.ts';
import { saveIdentityMap, loadIdentityMap, defaultIdentityMap, type IdentityMap } from '../src/identity-map.ts';
import { hashObject, writeTree, commitTree, updateRef, initRepo, identityEnv } from '../src/gitutil.ts';
import { buildFixture } from './fixture.ts';

test('inspectAuthors aggregates identities, counts, dates, day buckets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'authors-'));
  const dir = (await buildFixture(root)).dir;

  const repo = await inspectAuthors(dir);
  assert.equal(repo.commitCount, 6);
  assert.deepEqual(repo.branches.sort(), ['dev', 'main']);
  assert.equal(repo.head, 'main');
  assert.equal(repo.tagCount, 1);

  const byId = new Map(repo.authors.map((a) => [a.identity, a]));
  assert.equal(byId.get('bernie <bernie@local>')?.count, 2);
  assert.equal(byId.get('bernie <bernie@localhost>')?.count, 2);
  assert.equal(byId.get('astro <astro@local>')?.count, 1);
  assert.equal(byId.get('other <other@example.com>')?.count, 1);

  assert.ok(repo.authors[0].count >= repo.authors[repo.authors.length - 1].count, 'sorted desc');

  const bern = byId.get('bernie <bernie@local>')!;
  assert.ok(bern.first < bern.last);
  assert.ok(bern.days.length >= 1);
  assert.ok(bern.days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.dateKey) && d.count > 0));
  const totalDays = bern.days.reduce((a, b) => a + b.count, 0);
  assert.equal(totalDays, 2);
});

test('scanRepos discovers worktrees, skips non-repos and node_modules, sorts by activity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scan-'));
  const a = `${root}/repoA`;
  const b = `${root}/nested/repoB`;
  await mkdir(a, { recursive: true });
  await mkdir(b, { recursive: true });
  await mkdir(`${root}/plain-dir`, { recursive: true });
  await mkdir(`${root}/node_modules/shadow`, { recursive: true });

  const mkRepo = async (dir: string, epoch: number): Promise<void> => {
    await initRepo(dir, 'main');
    const blob = await hashObject(dir, dir + '\n');
    const tree = await writeTree(dir, [{ path: 'f.txt', oid: blob }]);
    const commit = await commitTree(
      dir,
      tree,
      [],
      identityEnv({ output: { authorName: 'x', authorEmail: 'x@y', tzOffset: 0 } }, epoch),
      'c',
    );
    await updateRef(dir, 'refs/heads/main', commit);
  };
  await mkRepo(a, 1750000000); // older
  await mkRepo(b, 1750003000); // newer

  const found = await scanRepos(root);
  assert.equal(found.length, 2);
  const rels = found.map((r) => r.rel).sort();
  assert.deepEqual(rels, ['nested/repoB', 'repoA']);
  assert.ok(found.every((r) => r.commits === 1 && r.heads === 1));
  assert.ok(found.some((r) => r.topAuthors.length === 1 && r.topAuthors[0].count === 1));
  // newest first
  for (let i = 1; i < found.length; i += 1) {
    assert.ok(found[i - 1].lastActivity >= found[i].lastActivity);
  }
});

test('identity map round-trips through the file', async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'map-')), 'm.json');
  const map: IdentityMap = {
    rows: [{ from: { match: 'b@l', mode: 'email' }, to: { name: 'N', email: 'n@x' } }],
    fallback: { name: 'F', email: 'f@x' },
  };
  saveIdentityMap(map, file);
  const loaded = loadIdentityMap(file);
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.map.rows, map.rows);
  assert.deepEqual(loaded.map.fallback, map.fallback);
  assert.deepEqual(loadIdentityMap('/nonexistent.json').map, defaultIdentityMap());
});
