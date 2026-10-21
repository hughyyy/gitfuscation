// server.ts — Node http server: static UI + /api endpoints (SPEC §5).
// Single-flight generation: concurrent /api/generate gets HTTP 409.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { URL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSettings, normalizeSettings, computeRuntimeDefaults, type Settings } from './settings.ts';
import { previewFor } from './preview.ts';
import { generateRepo } from './materialize.ts';
import { LEVEL_COLORS } from './schedule.ts';
import { scanRepos } from './repoindex.ts';
import { inspectAuthors } from './authors.ts';
import {
  loadIdentityMap,
  saveIdentityMap,
  parseIdentityMap,
  DEFAULT_IDENTITY_MAP_PATH,
  type IdentityMap,
} from './identity-map.ts';
import { planReauth, executeReauth } from './reauth.ts';
import { runGit } from './gitutil.ts';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const MAX_BODY = 1 * 1024 * 1024;

interface GenerateStatus {
  running: boolean;
  phase: string;
  done: number;
  total: number;
  error?: string;
  result?: unknown;
  startedAt?: number;
}

export interface ServerOptions {
  host?: string;
  port?: number;
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) {
      throw new Error('request body too large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' });
    return null;
  }
  return raw;
}

/** Repo scan root: env GITFUSCATION_REPO_ROOT, else the parent of this project. */
function resolveRepoRoot(): string {
  return process.env.GITFUSCATION_REPO_ROOT ?? path.resolve(process.cwd(), '..');
}

async function isWorktree(repoPath: string): Promise<boolean> {
  try {
    const out = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: repoPath });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

async function serveStatic(url: URL, res: ServerResponse): Promise<void> {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(UI_DIR, requested));
  if (!filePath.startsWith(UI_DIR) || !filePath.startsWith(path.join(UI_DIR, path.sep))) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

export function startServer(opts: ServerOptions = {}): {
  server: Server;
  port: number;
} {
  const runtime = computeRuntimeDefaults();
  const status: GenerateStatus = { running: false, phase: 'idle', done: 0, total: 0 };
  let serverPort = opts.port ?? 0;

  const listener = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
    const isStaticFile = ['.html', '.js', '.css', '.svg'].some((e) => url.pathname.endsWith(e));
    const isIndex = url.pathname === '/' || url.pathname.startsWith('/ui/');
    if (req.method === 'GET' && (isIndex || isStaticFile)) {
      await serveStatic(url, res);
      return;
    }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/settings-defaults') {
        sendJson(res, 200, {
          settings: defaultSettings(runtime),
          identity: {
            source: runtime.identitySource,
            authorName: runtime.authorName,
            authorEmail: runtime.authorEmail,
          },
          colorPalette: LEVEL_COLORS,
        });
        return;
      }

      // --- Authorship: repo list, inspection, identity map, reauth ---
      if (req.method === 'GET' && url.pathname === '/api/repos') {
        const asked = url.searchParams.get('root');
        const trimmed = asked?.trim() ?? '';
        const candidate = trimmed !== '' ? path.resolve(trimmed) : resolveRepoRoot();
        try {
          const st = await stat(candidate);
          if (!st.isDirectory()) {
            sendJson(res, 400, { error: `not a directory: ${candidate}` });
            return;
          }
        } catch {
          sendJson(res, 400, { error: `no such directory: ${candidate}` });
          return;
        }
        try {
          const repos = await scanRepos(candidate);
          sendJson(res, 200, { root: candidate, repos });
        } catch (e) {
          sendJson(res, 500, { error: (e as Error).message });
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/repo/authors') {
        const repoPath = url.searchParams.get('path');
        if (repoPath === null) {
          sendJson(res, 400, { error: 'missing path query parameter' });
          return;
        }
        if (!(await isWorktree(repoPath))) {
          sendJson(res, 400, { error: `not a git worktree: ${repoPath}` });
          return;
        }
        try {
          sendJson(res, 200, await inspectAuthors(repoPath));
        } catch (e) {
          sendJson(res, 500, { error: (e as Error).message });
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/identity-map') {
        const { map, errors } = loadIdentityMap();
        if (errors.length > 0) {
          sendJson(res, 500, { errors });
          return;
        }
        sendJson(res, 200, { map, path: DEFAULT_IDENTITY_MAP_PATH });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/identity-map') {
        let raw: unknown;
        try {
          raw = JSON.parse(await readBody(req));
        } catch {
          sendJson(res, 400, { error: 'invalid JSON body' });
          return;
        }
        const { map, errors } = parseIdentityMap(raw);
        if (errors.length > 0) {
          sendJson(res, 400, { errors });
          return;
        }
        saveIdentityMap(map);
        sendJson(res, 200, { map });
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/repo/reauth')) {
        const execute = url.pathname.endsWith('/execute');
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const repoPath = (body as Record<string, unknown>).path;
        if (typeof repoPath !== 'string' || !(await isWorktree(repoPath))) {
          sendJson(res, 400, { error: `not a git worktree: ${String(repoPath)}` });
          return;
        }
        const { map, errors } = parseIdentityMap((body as Record<string, unknown>).identityMap);
        if (errors.length > 0) {
          sendJson(res, 400, { errors });
          return;
        }
        const opts = {
          rewriteCommitter: (body as Record<string, unknown>).rewriteCommitter as boolean | undefined,
          includeTags: (body as Record<string, unknown>).includeTags as boolean | undefined,
        };
        const mapObj: IdentityMap = map;
        try {
          if (execute) {
            sendJson(res, 200, await executeReauth(repoPath, mapObj, opts));
          } else {
            sendJson(res, 200, await planReauth(repoPath, mapObj, opts));
          }
        } catch (e) {
          sendJson(res, 400, { error: (e as Error).message });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        sendJson(res, 200, status);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/preview') {
        let raw: unknown;
        try {
          raw = JSON.parse(await readBody(req));
        } catch {
          sendJson(res, 400, { error: 'invalid JSON body' });
          return;
        }
        const { settings, errors } = normalizeSettings(raw, runtime);
        if (errors.length > 0) {
          sendJson(res, 400, { errors });
          return;
        }
        sendJson(res, 200, previewFor(settings));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/generate') {
        if (status.running) {
          sendJson(res, 409, { error: 'a generation is already running' });
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(await readBody(req));
        } catch {
          sendJson(res, 400, { error: 'invalid JSON body' });
          return;
        }
        const { settings, errors } = normalizeSettings(raw, runtime);
        if (errors.length > 0) {
          sendJson(res, 400, { errors });
          return;
        }
        status.running = true;
        status.startedAt = Date.now();
        status.error = undefined;
        status.result = undefined;
        status.phase = 'generating';
        status.done = 0;
        status.total = 0;
        // Fire and forget; the client polls /api/status.
        void generateRepo(settings, (done, total) => {
          status.done = done;
          status.total = total;
        })
          .then((result) => {
            status.phase = 'done';
            status.done = status.total;
            status.result = { ...result, identitySource: settings.output.authorEmail };
          })
          .catch((e: Error) => {
            status.phase = 'error';
            status.error = e.message;
          })
          .finally(() => {
            status.running = false;
          });
        sendJson(res, 202, { accepted: true });
        return;
      }
      sendJson(res, 404, { error: `no route ${req.method} ${url.pathname}` });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
  };

  const server = createServer((req, res) => {
    void listener(req, res);
  });

  server.listen(opts.port ?? 8315, opts.host ?? '127.0.0.1');
  const addr = server.address();
  if (addr !== null && typeof addr === 'object') serverPort = addr.port;
  return { server, port: serverPort };
}
