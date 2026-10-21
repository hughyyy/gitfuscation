// reauth.test.ts — reattribution correctness: identities, dates, topology,
// tags, backups, dry-run/execute agreement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGit } from '../src/gitutil.ts';
import { planReauth, executeReauth, topoOrder } from '../src/reauth.ts';
import { parseIdentityMap, mapIdentity } from '../src/identity-map.ts';
import { buildFixture, type Fixture } from './fixture.ts';

const OWNER = { name: 'Owner Person', email: 'own@github.example' };

const { map: IDENT, errors: IDENT_ERRORS } = parseIdentityMap({
  rows: [
    { from: { match: 'bernie@local', mode: 'email' }, to: OWNER },
    { from: { match: 'bernie@localhost', mode: 'email' }, to: OWNER },
    { from: { match: 'astro@local', mode: 'email' }, to: OWNER },
  ],
  fallback: null,
});
assert.deepEqual(IDENT_ERRORS, []);

async function logLines(dir: string, fmt: string, ref = 'refs/heads/main'): Promise<string[]> {
  return (await runGit(['log', `--format=${fmt}`, ref], { cwd: dir })).trim().split('\n').filter((l) => l.length > 0);
}

test('identity map matching: email, name, full, fallback precedence', () => {
  assert.deepEqual(mapIdentity(IDENT, 'bernie', 'bernie@local'), OWNER);
  assert.equal(mapIdentity(IDENT, 'someone', 'someone@x.io'), null);
  const withFallback = { ...IDENT, fallback: { name: 'Catchall', email: 'all@gh.com' } };
  assert.deepEqual(mapIdentity(withFallback, 'someone', 'someone@x.io'), withFallback.fallback);
  const byName = parseIdentityMap({
    rows: [{ from: { match: 'bernie', mode: 'name' }, to: OWNER }],
  }).map;
  assert.deepEqual(mapIdentity(byName, 'bernie', 'whatever@x'), OWNER);
  const byFull = parseIdentityMap({
    rows: [{ from: { match: 'astro <astro@local>', mode: 'full' }, to: OWNER }],
  }).map;
  assert.deepEqual(mapIdentity(byFull, 'astro', 'astro@local'), OWNER);
});

test('identity map validation rejects malformed rows', () => {
  for (const raw of [
    { rows: [{ from: { mode: 'email' }, to: OWNER }] }, // missing match
    { rows: [{ from: { match: 'x', mode: 'bogus' }, to: OWNER }] },
    { rows: [{ from: { match: 'x', mode: 'email' }, to: { name: '', email: 'e@x' } }] },
    { rows: 'nope' },
    { fallback: {} },
  ]) {
    assert.ok(parseIdentityMap(raw as never).errors.length > 0, JSON.stringify(raw));
  }
});

async function setup(): Promise<{ dir: string; fixture: Fixture }> {
  const root = await mkdtemp(path.join(tmpdir(), 'reauth-'));
  const fixture = await buildFixture(root);
  return { dir: fixture.dir, fixture };
}

test('topoOrder handles deep linear histories without stack overflow', () => {
  const n = 25000;
  const parents = new Map<string, string[]>();
  for (let i = 1; i < n; i += 1) {
    parents.set(`c${i}`, [`c${i - 1}`]);
  }
  parents.set('c0', []);
  const order = topoOrder(parents, [`c${n - 1}`]);
  assert.equal(order.length, n);
  assert.equal(order[0], 'c0');
  assert.equal(order[n - 1], `c${n - 1}`);
});

test('topoOrder preserves ancestor-first order across merges', () => {
  // diamond: A -> B -> D, A -> C -> D
  const parents = new Map<string, string[]>([
    ['D', ['B', 'C']],
    ['B', ['A']],
    ['C', ['A']],
    ['A', []],
  ]);
  const order = topoOrder(parents, ['D']);
  assert.deepEqual(order, ['A', 'B', 'C', 'D']);
});

test('dry-run reports exactly the identity changes', async () => {
  const { dir, fixture } = await setup();
  const plan = await planReauth(dir, IDENT, {});
  assert.equal(plan.commitsTotal, 6);
  assert.equal(plan.affectedCommits, 6); // c6 changes too (its parent changed)
  assert.equal(plan.identityCommits, 5); // bernie×2, bernie@localhost×2, astro×1
  assert.equal(plan.untouchedCommits, 0);
  assert.equal(plan.changes.length, 3);
  assert.equal(plan.changes.reduce((a, c) => a + c.commitCount, 0), 5);
  assert.ok(plan.refsToMove.some((m) => m.ref === 'refs/heads/main'));
  assert.ok(plan.refsToMove.some((m) => m.ref === 'refs/heads/dev'));
  assert.ok(plan.refsToMove.some((m) => m.ref === 'refs/tags/alpha'));
  // old tip preserved for backup bookkeeping
  assert.ok(plan.refsToMove.find((m) => m.ref === 'refs/heads/main')!.oldTip === fixture.headOid);
});

test('dry-run does not persist objects', async () => {
  const { dir } = await setup();
  const before = (await runGit(['count-objects'], { cwd: dir })).trim();
  await planReauth(dir, IDENT, {});
  const after = (await runGit(['count-objects'], { cwd: dir })).trim();
  assert.equal(after, before, 'planning must not write objects');
});

test('execute reattributes every matched commit, preserves dates/messages/trees', async () => {
  const { dir, fixture } = await setup();

  const datesBefore = await logLines(dir, '%at');
  const msgsBefore = await logLines(dir, '%s');
  const treeBefore = (await runGit(['ls-tree', '-r', 'HEAD'], { cwd: dir })).trim();
  const oldHead = fixture.headOid;

  const result = await executeReauth(dir, IDENT, {});
  assert.equal(result.identityCommits, 5);
  assert.equal(result.backupRefs.length, 3);
  assert.ok(result.backupRefs.includes('refs/backup/heads/main'));
  assert.equal(result.newObjectCount, 6 + 1); // 6 commits + rebuilt annotated tag

  const emails = await logLines(dir, '%aE');
  assert.equal(emails.length, 6, 'commit count preserved');
  assert.deepEqual(emails.sort(), ['other@example.com', 'own@github.example', 'own@github.example', 'own@github.example', 'own@github.example', 'own@github.example']);
  // maintainer commit keeps its identity (unmapped) but its SHA changes (parent changed)
  const otherEmails = await logLines(dir, '%aN <%aE>');
  assert.ok(otherEmails.some((l) => l === 'other <other@example.com>'));

  // Dates and messages byte-identical (reverse order preserved within log output)
  assert.deepEqual(await logLines(dir, '%at'), datesBefore);
  assert.deepEqual(await logLines(dir, '%s'), msgsBefore);

  // Trees identical
  assert.equal((await runGit(['ls-tree', '-r', 'HEAD'], { cwd: dir })).trim(), treeBefore);

  // Committer rewritten as well
  const committers = await logLines(dir, '%cE');
  assert.equal(committers.filter((e) => e === 'own@github.example').length, 5);

  // New head differs from old
  assert.notEqual((await runGit(['rev-parse', 'HEAD'], { cwd: dir })).trim(), oldHead);
  // fsck clean
  await runGit(['fsck', '--strict'], { cwd: dir });
});

test('merge topology preserved (two parents), annotated tag retargeted', async () => {
  const { dir, fixture } = await setup();
  await executeReauth(dir, IDENT, {});

  // The merge commit still has two parents in the new history.
  const mergeLine = (await runGit(['rev-list', '--parents', 'refs/heads/main'], { cwd: dir })).trim().split('\n');
  const mergeParents = mergeLine.find((l) => l.split(' ').length === 3);
  assert.ok(mergeParents !== undefined, 'merge commit with two parents must exist');

  // Tag still points (transitively) at the commit with message third commit.
  const tagTarget = (await runGit(['rev-parse', 'refs/tags/alpha^{commit}'], { cwd: dir })).trim();
  const targetMsg = (await runGit(['log', '-1', '--format=%s', tagTarget], { cwd: dir })).trim();
  assert.equal(targetMsg, 'third commit');
  // The annotated tag OBJECT itself changed id (retargeted), and is still a tag.
  const tagType = (await runGit(['cat-file', '-t', 'refs/tags/alpha'], { cwd: dir })).trim();
  assert.equal(tagType, 'tag');
  assert.notEqual((await runGit(['rev-parse', 'refs/tags/alpha'], { cwd: dir })).trim(), fixture.tagOid);

  // dev branch moved and its tip is the new c4
  const devTip = (await runGit(['rev-parse', 'refs/heads/dev'], { cwd: dir })).trim();
  const devMsg = (await runGit(['log', '-1', '--format=%s', devTip], { cwd: dir })).trim();
  assert.equal(devMsg, 'dev branch work');
});

test('backup refs retain the full original history', async () => {
  const { dir, fixture } = await setup();
  await executeReauth(dir, IDENT, {});
  const backupHead = (await runGit(['rev-parse', 'refs/backup/heads/main'], { cwd: dir })).trim();
  assert.equal(backupHead, fixture.headOid, 'backup points at the original tip');
  assert.equal((await runGit(['rev-list', 'refs/backup/heads/main', '--count'], { cwd: dir })).trim(), '6');
  const backupEmails = (await runGit(['log', 'refs/backup/heads/main', '--format=%aE'], { cwd: dir })).trim().split('\n');
  assert.ok(backupEmails.every((e) => e !== 'own@github.example'), 'backup history is pristine');
});

test('execute agrees with the dry-run plan', async () => {
  const { dir } = await setup();
  const plan = await planReauth(dir, IDENT, {});
  const exec = await executeReauth(dir, IDENT, {});
  assert.deepEqual(exec.changes, plan.changes);
  assert.equal(exec.identityCommits, plan.identityCommits);
  assert.equal(exec.refsToMove.length, plan.refsToMove.length);
});

test('dirty worktree blocks execution', async () => {
  const { dir } = await setup();
  await writeFile(path.join(dir, 'README.md'), 'dirty edit\n', 'utf8');
  await assert.rejects(() => executeReauth(dir, IDENT, {}), /dirty worktree/);
});

test('no-op mapping: unaffected commits keep their oids', async () => {
  const { dir, fixture } = await setup();
  const empty = parseIdentityMap({}).map; // no rows, no fallback
  const plan = await planReauth(dir, empty, {});
  assert.equal(plan.affectedCommits, 0);
  assert.equal(plan.refsToMove.length, 0); // nothing changes -> nothing moves
  await executeReauth(dir, empty, {});
  assert.equal((await runGit(['rev-parse', 'HEAD'], { cwd: dir })).trim(), fixture.headOid);
});
