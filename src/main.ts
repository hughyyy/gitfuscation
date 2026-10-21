#!/usr/bin/env node
// main.ts — CLI: serve | preview | generate (SPEC §2).

import { readFileSync } from 'node:fs';
import { normalizeSettings, computeRuntimeDefaults, type Settings } from './settings.ts';
import { previewFor, renderAscii } from './preview.ts';
import { generateRepo } from './materialize.ts';
import { startServer } from './server.ts';

const USAGE = `gitfuscation — generate synthetic activity history

Usage: node src/main.ts <command> [options]

Commands:
  serve                    Start the web UI at http://127.0.0.1:8315
  preview [--config f]     Print the contribution chart for settings (ASCII)
  generate [--config f]    Generate the history repo from settings

Options:
  --config <path>  JSON settings file (optional: falls back to defaults)
  --port <n>       serve: listen port (default 8315)
  --host <h>       serve: listen host (default 127.0.0.1)
  -h, --help       Show this help
`;

interface CliArgs {
  config?: string;
  port?: number;
  host?: string;
}

function parseArgs(argv: string[]): { cmd: string; args: CliArgs } {
  const cmd = argv[0] ?? '';
  const args: CliArgs = {};
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--config') args.config = argv[++i];
    else if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--host') args.host = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(USAGE);
      process.exit(0);
    }
  }
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

  console.log(USAGE);
  process.exit(cmd === '' ? 1 : 0);
}

void main();
