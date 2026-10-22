// claim.test.ts — the shipped claim.sh re-authors a generated repo in place.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeSettings, type RuntimeDefaults, type Settings } from '../src/settings.ts';
import { generateRepo } from '../src/materialize.ts';
import { runGit, listCommits } from '../src/gitutil.ts';

const RUNTIME: RuntimeDefaults = {
  authorName: 'Original Author',
  authorEmail: 'original@example.com',
  tzOffset: 0,
  identitySource: 'git',
};

const run = promisify(execFile);

async function generatedRepo(durationDays = 30): Promise<{ repo: string; settings: Settings }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitfuscation-claim-'));
  const { settings, errors } = normalizeSettings(
    {
      output: { outPath: path.join(dir, 'repo') },
      timeline: { startDate: '2025-02-01', durationDays },
      activity: { seed: 7, totalCommits: 45 },
      content: { fileCount: 6 },
    },
    RUNTIME,
  );
  assert.deepEqual(errors, []);
  const result = await generateRepo(settings);
  return { repo: result.outPath, settings };
}

/** Run the script with stdin filled in (the interactive prompt path). */
function runWithInput(cwd: string, script: string, input: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn('sh', [script], { cwd });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) resolve(output);
    else reject(new Error(`claim.sh exited ${code}:\n${output}`));
  });
  child.stdin.end(input);
  return promise;
}

async function identities(repo: string): Promise<string[]> {
  const out = await runGit(['log', '--format=%an <%ae> | %cn <%ce>'], { cwd: repo });
  return out.trim().split('\n').filter((line) => line.length > 0);
}

test('generated repo ships an executable claim script', async () => {
  const { repo } = await generatedRepo();
  const script = path.join(repo, 'claim.sh');

  const mode = (await runGit(['ls-files', '-s', 'claim.sh'], { cwd: repo })).trim().split(/\s+/)[0];
  assert.equal(mode, '100755', 'script is executable in the index');
  const info = await stat(script);
  assert.ok((info.mode & 0o111) !== 0, 'script is executable in the checkout');

  // The script is static: only the initial scaffold commit touches it.
  const touchedBy = (await runGit(['log', '--format=%s', '--', 'claim.sh'], { cwd: repo }))
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
  assert.deepEqual(touchedBy, ['chore: initial scaffold']);
});

test('claim script rewrites every commit to the supplied identity', async () => {
  const { repo } = await generatedRepo();
  const script = path.join(repo, 'claim.sh');
  const readmeBefore = await readFile(path.join(repo, 'README.md'), 'utf8');
  const before = await listCommits(repo);

  await run('sh', [script, 'New Owner', 'owner@example.com'], { cwd: repo });

  const after = await listCommits(repo);
  assert.equal(after.length, before.length, 'commit count preserved');
  assert.deepEqual(
    after.map((c) => c.authorTime),
    before.map((c) => c.authorTime),
    'author dates preserved second-for-second',
  );
  for (const line of await identities(repo)) {
    assert.equal(line, 'New Owner <owner@example.com> | New Owner <owner@example.com>');
  }

  assert.equal(await readFile(path.join(repo, 'README.md'), 'utf8'), readmeBefore, 'README untouched');
  const status = (await runGit(['status', '--porcelain'], { cwd: repo })).trim();
  assert.equal(status, '', 'worktree clean after rewrite');
  assert.equal((await runGit(['config', 'user.name'], { cwd: repo })).trim(), 'New Owner');
  assert.equal((await runGit(['config', 'user.email'], { cwd: repo })).trim(), 'owner@example.com');

  // Backup refs and the pre-rewrite objects are gone.
  const backupRefs = (await runGit(['for-each-ref', 'refs/original'], { cwd: repo })).trim();
  assert.equal(backupRefs, '');
  await runGit(['fsck', '--strict'], { cwd: repo });
});

test('claim script prompts for a name and email when called without arguments', async () => {
  const { repo } = await generatedRepo(14);
  const script = path.join(repo, 'claim.sh');

  const output = await runWithInput(repo, script, 'Prompted Person\nprompted@example.com\n');
  assert.match(output, /Name/);
  assert.match(output, /Email/);
  assert.match(output, /Rewrote \d+ commit\(s\) to Prompted Person <prompted@example.com>/);

  for (const line of await identities(repo)) {
    assert.equal(line, 'Prompted Person <prompted@example.com> | Prompted Person <prompted@example.com>');
  }
});

test('claim script refuses a dirty worktree', async () => {
  const { repo } = await generatedRepo(14);
  const script = path.join(repo, 'claim.sh');
  await execFile('sh', ['-c', 'printf "dirty\\n" >> README.md'], { cwd: repo });

  await assert.rejects(run('sh', [script, 'New Owner', 'owner@example.com'], { cwd: repo }), /uncommitted changes/);
});
