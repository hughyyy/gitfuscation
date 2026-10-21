#!/usr/bin/env node
// main.ts — CLI: serve | preview | generate | repos | authors | reauth.

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeSettings, computeRuntimeDefaults, type Settings } from './settings.ts';
import { previewFor, renderAscii } from './preview.ts';
import { generateRepo } from './materialize.ts';
import { startServer } from './server.ts';
import { scanRepos } from './repoindex.ts';
import { inspectAuthors } from './authors.ts';
import { loadIdentityMap, type IdentityMap } from './identity-map.ts';
import { planReauth, executeReauth } from './reauth.ts';
import { runGit } from './gitutil.ts';
import { chartFromRepo, patternMarkdown } from './pattern.ts';

const USAGE = `gitfuscation — generate synthetic activity history, paint contribution art, and repair commit attribution

Usage: node src/main.ts <command> [options]

Commands:
  serve                          Start the web UI at http://127.0.0.1:8315
  preview [--config f]           Print the contribution chart for settings (ASCII)
  generate [--config f]          Generate the history repo from settings
  repos [--root d]               List git repos under a root directory
  authors <path>                 Summarize authorship of a repo
  reauth <path> [-> options]     Reattribute authorship in a repo (see below)
  readme <path> [--commit]       Write the pattern README for a repo

Options:
  --config <path>     JSON settings file (optional: falls back to defaults)
  --port <n>          serve: listen port (default 8315)
  --host <h>          serve: listen host (default 127.0.0.1)
  --root <dir>        repos: scan root (default parent of this project)
  --map <file>        reauth: identity map JSON (default identity-map.json)
  --dry-run           reauth: plan only, write nothing
  --no-committer      reauth: leave committer identity unchanged
  --no-tags           reauth: leave tags untouched
  -h, --help          Show this help
`;

interface CliArgs {
  config?: string;
  port?: number;
  host?: string;
  root?: string;
  map?: string;
  dryRun?: boolean;
  noCommitter?: boolean;
  noTags?: boolean;
  commit?: boolean;
  path?: string;
}

function parseArgs(argv: string[]): { cmd: string; args: CliArgs } {
  const cmd = argv[0] ?? '';
  const args: CliArgs = {};
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--config') args.config = argv[++i];
    else if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--host') args.host = argv[++i];
    else if (argv[i] === '--root') args.root = argv[++i];
    else if (argv[i] === '--map') args.map = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--no-committer') args.noCommitter = true;
    else if (argv[i] === '--no-tags') args.noTags = true;
    else if (argv[i] === '--commit') args.commit = true;
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(USAGE);
      process.exit(0);
    }
  }
  args.path = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
  return { cmd, args };
}

function loadSettings(configPath: string | undefined): Settings {
  let raw: unknown = {};
  if (configPath !== undefined) {
    let text: string;
    try {
      text = readFileSync(configPath, 'utf8');
    } catch {
      console.error(`cannot read config: ${configPath}`);
      process.exit(2);
    }
    try {
      raw = JSON.parse(text);
    } catch (e) {
      console.error(`invalid JSON in ${configPath}: ${(e as Error).message}`);
      process.exit(2);
    }
  }
  const { settings, errors } = normalizeSettings(raw);
  if (errors.length > 0) {
    console.error(`invalid settings (${errors.length}):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(2);
  }
  return settings;
}

function identityWarning(settings: Settings): void {
  if (settings.output.authorEmail.endsWith('@localhost')) {
    console.warn(
      `\nwarning: author email "${settings.output.authorEmail}" is a fallback. GitHub credits commits\n` +
        `only to a verified email linked to your account; set output.authorEmail to make the graph work.`,
    );
  }
}

async function main(): Promise<void> {
  const { cmd, args } = parseArgs(process.argv.slice(2));

  if (cmd === 'serve') {
    const { server, port } = startServer({ host: args.host, port: args.port });
    const host = args.host ?? '127.0.0.1';
    console.log(`gitfuscation web UI: http://${host}:${port}`);
    console.log('press Ctrl+C to stop');
    const shutdown = (): void => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  if (cmd === 'preview') {
    const settings = loadSettings(args.config);
    const payload = previewFor(settings);
    console.log(renderAscii(payload));
    identityWarning(settings);
    return;
  }

  if (cmd === 'generate') {
    const settings = loadSettings(args.config);
    const result = await generateRepo(settings, (done, total) => {
      process.stderr.write(`\rcommits: ${done}/${total}  `);
      if (done === total) process.stderr.write('\n');
    });
    console.log(JSON.stringify(result, null, 2));
    identityWarning(settings);
    return;
  }

  if (cmd === 'repos') {
    const root = args.root ?? resolveRepoRootCli();
    const repos = await scanRepos(root);
    console.log(`repos under ${root}: ${repos.length}`);
    for (const r of repos) {
      const authors = r.topAuthors.map((a) => `${a.identity}×${a.count}`).join(', ') || '—';
      console.log(
        `${r.rel}  commits=${r.commits} heads=${r.heads} last=${new Date(r.lastActivity * 1000).toISOString().slice(0, 10)}  ${authors}`,
      );
    }
    return;
  }

  if (cmd === 'authors') {
    const repoPath = args.path ?? '';
    if (repoPath === '') {
      console.error('authors: missing <path> argument');
      process.exit(2);
    }
    await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: repoPath });
    const repo = await inspectAuthors(repoPath);
    console.log(`# ${repo.name}  (${repo.path})`);
    console.log(`head: ${repo.head}  branches: ${repo.branches.join(', ')}  tags: ${repo.tagCount}  commits: ${repo.commitCount}`);
    for (const a of repo.authors) {
      const share = ((a.count / Math.max(1, repo.commitCount)) * 100).toFixed(0);
      console.log(
        `${a.identity.padEnd(40)} ${String(a.count).padStart(4)} commits (${share}%)  activeDays=${a.days.length}  first=${new Date(a.first * 1000).toISOString().slice(0, 10)} last=${new Date(a.last * 1000).toISOString().slice(0, 10)}`,
      );
    }
    return;
  }

  if (cmd === 'readme') {
    const repoPath = args.path ?? '';
    if (repoPath === '') {
      console.error('readme: missing <path> argument');
      process.exit(2);
    }
    await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: repoPath });
    const { payload, author, email } = await chartFromRepo(repoPath);
    const title = path.basename(path.resolve(repoPath));
    const markdown = patternMarkdown(payload, title, author, email);
    const target = path.join(repoPath, 'README.md');
    await writeFile(target, markdown, 'utf8');
    console.log(`wrote ${target} (${markdown.length} bytes)`);
    if (args.commit) {
      await runGit(['add', 'README.md'], { cwd: repoPath });
      await runGit(['commit', '-m', 'docs: add contribution pattern chart'], {
        cwd: repoPath,
        env: {
          GIT_AUTHOR_NAME: author,
          GIT_AUTHOR_EMAIL: email,
          GIT_COMMITTER_NAME: author,
          GIT_COMMITTER_EMAIL: email,
        },
      });
      console.log(`committed as ${author} <${email}>`);
    }
    return;
  }

  if (cmd === 'reauth') {
    const repoPath = args.path ?? '';
    if (repoPath === '') {
      console.error('reauth: missing <path> argument');
      process.exit(2);
    }
    const { map, errors } = loadIdentityMap(args.map);
    if (errors.length > 0) {
      console.error(`identity map: ${errors.join('; ')}`);
      process.exit(2);
    }
    const identityMap: IdentityMap = map;
    if (map.rows.length === 0 && map.fallback === null) {
      console.error('identity map is empty — add rows or a fallback first (see identity-map.json)');
      process.exit(2);
    }
    const opts = {
      rewriteCommitter: !args.noCommitter,
      includeTags: !args.noTags,
    };
    const result = args.dryRun
      ? await planReauth(repoPath, identityMap, opts)
      : await executeReauth(repoPath, identityMap, opts);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(USAGE);
  process.exit(cmd === '' ? 1 : 0);
}

function resolveRepoRootCli(): string {
  return process.env.GITFUSCATION_REPO_ROOT ?? path.dirname(process.cwd());
}

void main();
