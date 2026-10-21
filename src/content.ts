// content.ts — file corpus, text generators, commit-message bank (SPEC §4.3/§4.4).
//
// Completely deterministic: derives its OWN rng stream from the settings seed
// (separate from schedule.ts) so preview/generate parity never depends on
// content draws, and content itself is reproducible.

import type { Settings } from './settings.ts';
import { mulberry32 } from './schedule.ts';

// ---------------------------------------------------------------------------
// Word banks
// ---------------------------------------------------------------------------

const NOUNS = [
  'pipeline', 'index', 'queue', 'adapter', 'schema', 'layout', 'hook', 'parser',
  'renderer', 'cache', 'worker', 'endpoint', 'middleware', 'migration',
  'fixture', 'monitor', 'daemon', 'registry', 'bundle', 'manifest',
] as const;

const VERBS = [
  'refine', 'expand', 'annotate', 'normalize', 'stabilize', 'consolidate',
  'document', 'prune', 'tune', 'harden', 'rework', 'wire', 'flush', 'rotate',
  'trim', 'propagate', 'shard', 'retry', 'relay', 'sanitize',
] as const;

const ADJECTIVES = [
  'incremental', 'deferred', 'atomic', 'lazy', 'eager', 'graceful', 'silent',
  'bounded', 'nominal', 'redundant',
] as const;

const TECH = [
  'buffer', 'latency', 'checksum', 'backpressure', 'timeout', 'backoff',
  'quota', 'lease', 'snapshot', 'window',
] as const;

const LOREM = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing',
  'elit', 'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore',
  'et', 'dolore', 'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam',
  'quis', 'nostrud', 'exercitation', 'ullamco', 'laboris', 'nisi',
  'aliquip', 'ex', 'ea', 'commodo', 'consequat', 'duis', 'aute', 'irure',
  'in', 'reprehenderit', 'voluptate', 'velit', 'esse', 'cillum', 'fugiat',
  'nulla', 'pariatur', 'excepteur', 'sint', 'occaecat', 'cupidatat',
  'proident', 'deserunt',
] as const;

const TOPICS = [
  'indexing', 'retries', 'backpressure', 'schema-drift', 'caching', 'leases',
  'snapshots', 'backoff', 'quotas', 'rendering', 'hydration', 'batching',
] as const;

const BASE_PATHS = [
  'docs/architecture.md', 'docs/roadmap.md', 'docs/runbook.md',
  'docs/security.md', 'docs/api.md', 'docs/benchmarks.md',
  'notes/scratchpad.md', 'notes/meetings.md', 'notes/research.md',
  'notes/decisions.md',
  'src/tools.ts', 'src/parser.ts', 'src/renderer.ts', 'src/cache.ts',
  'src/hooks.ts', 'src/worker.ts',
  'scripts/release.sh', 'scripts/bootstrap.sh', 'scripts/bench.sh',
  'tests/smoke.md', 'tests/perf.md', 'tests/fixtures.md',
] as const;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface ContentSession {
  files: Map<string, string>; // path -> full current content
  lastEntryDate: Map<string, string>; // path -> dateKey of last appended entry
  lastTouch: Map<string, number>; // path -> commit index of last touch
  nextIdea: number;
  nextTopic: number;
  commitIndex: number;
  readonly rng: () => number;
  readonly settings: Settings;
}

/** Pick helper: returns k distinct indices weighted by `weights` (no replace). */
function weightedSample(
  rng: () => number,
  weights: number[],
  k: number,
): number[] {
  const out: number[] = [];
  const active = weights.map((w, i) => ({ w, i })).filter((x) => x.w > 0);
  for (let t = 0; t < k && active.length > 0; t += 1) {
    const total = active.reduce((a, x) => a + x.w, 0);
    let r = rng() * total;
    let pick = active.length - 1;
    for (let i = 0; i < active.length; i += 1) {
      r -= active[i].w;
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    out.push(active[pick].i);
    active.splice(pick, 1);
  }
  return out;
}

function pickOne<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function sentence(rng: () => number): string {
  const pattern = Math.floor(rng() * 3);
  if (pattern === 0) {
    return `The ${pickOne(rng, ADJECTIVES)} ${pickOne(rng, NOUNS)} ${pickOne(rng, VERBS)}s the ${pickOne(rng, TECH)} path.`;
  }
  if (pattern === 1) {
    return `Revisited the ${pickOne(rng, NOUNS)} boundary: still ${pickOne(rng, ADJECTIVES)} under ${pickOne(rng, TECH)} pressure.`;
  }
  return `Moved the ${pickOne(rng, TECH)} handling into the ${pickOne(rng, ADJECTIVES)} ${pickOne(rng, NOUNS)} stage.`;
}

function loremSentence(rng: () => number): string {
  const words: string[] = [];
  const n = 6 + Math.floor(rng() * 6);
  for (let i = 0; i < n; i += 1) {
    let w = pickOne(rng, LOREM);
    if (i === 0) w = w.charAt(0).toUpperCase() + w.slice(1);
    words.push(w);
  }
  return words.join(' ') + '.';
}

function wordsLine(rng: () => number): string {
  const n = 8 + Math.floor(rng() * 8);
  const parts: string[] = [];
  for (let i = 0; i < n; i += 1) parts.push(pickOne(rng, [...NOUNS, ...VERBS, ...ADJECTIVES, ...TECH]));
  return parts.join(' ');
}

/** One content paragraph in the configured style followed by a blank line. */
function entryBody(rng: () => number, style: string): string {
  if (style === 'lorem') return loremSentence(rng) + '\n';
  if (style === 'words') return wordsLine(rng) + '.  ' + wordsLine(rng) + '.\n';
  const bullets = 1 + Math.floor(rng() * 3);
  const lines: string[] = [];
  for (let i = 0; i < bullets; i += 1) {
    if (rng() < 0.5) {
      lines.push('- ' + sentence(rng));
    } else {
      lines.push('  \u2022 `' + pickOne(rng, VERBS) + '-' + pickOne(rng, NOUNS) + '-' + pickOne(rng, ADJECTIVES) + '` ' + sentence(rng));
    }
  }
  return lines.join('\n') + '\n';
}

function heading(dateKey: string, rng: () => number): string {
  if (rng() < 0.3) return `## ${dateKey} ${pickOne(rng, TOPICS)}`;
  return `## ${dateKey}`;
}

function initialHeader(repoName: string): string {
  return `# ${repoName}\n\nWorking notes and scratch material for ${repoName}.\n\n`;
}

function newFilePath(session: ContentSession): string {
  if (session.rng() < 0.5) {
    return `ideas/idea-${session.nextIdea}.md`;
  }
  return `notes/${pickOne(session.rng, TOPICS)}-${session.nextTopic}.md`;
}

export function makeContentSession(settings: Settings): ContentSession {
  const rng = mulberry32((settings.activity.seed ^ 0x9e3779b9) >>> 0);
  const files = new Map<string, string>();
  const lastEntryDate = new Map<string, string>();
  const lastTouch = new Map<string, number>();
  const header = initialHeader(settings.output.repoName);
  const paths = [...BASE_PATHS];
  // Shuffle-append so the initial corpus varies by seed.
  for (let i = paths.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [paths[i], paths[j]] = [paths[j], paths[i]];
  }
  let pathIndex = 0;
  const count = Math.min(settings.content.fileCount, paths.length);
  for (pathIndex = 0; pathIndex < count; pathIndex += 1) {
    files.set(paths[pathIndex], header);
    lastEntryDate.set(paths[pathIndex], '');
    lastTouch.set(paths[pathIndex], 0);
  }
  // If the target corpus is bigger than the pool, synthesize extras.
  while (pathIndex < settings.content.fileCount) {
    const p = newFilePath({ files, lastEntryDate, lastTouch, nextIdea: 1, nextTopic: 1, commitIndex: 0, rng, settings });
    if (!files.has(p)) {
      files.set(p, header);
      lastEntryDate.set(p, '');
      lastTouch.set(p, 0);
      pathIndex += 1;
    }
  }
  return {
    files,
    lastEntryDate,
    lastTouch,
    nextIdea: 1,
    nextTopic: 1,
    commitIndex: 0,
    rng,
    settings,
  };
}

/**
 * Apply one scheduled commit: touch 1..filesPerCommit files (recency-weighted,
 * occasionally creating a new file), append dated entries. Returns touched
 * paths in deterministic order. Mutates the session.
 */
export function applyCommit(session: ContentSession, dateKey: string): string[] {
  const s = session.settings.content;
  const rng = session.rng;
  const touched: string[] = [];
  // 1..4 files per commit, weighted 82/12/4/2.
  const howManyRoll = rng();
  const howMany =
    howManyRoll < 0.82 ? 1 : howManyRoll < 0.94 ? 2 : howManyRoll < 0.98 ? 3 : 4;
  const fileList = [...session.files.keys()];
  const weights = fileList.map((p) => {
    const age = session.commitIndex - (session.lastTouch.get(p) ?? 0);
    return Math.max(0.3, 1 / (1 + age / 120));
  });
  const targets = weightedSample(rng, weights, Math.min(howMany, fileList.length));

  let newIdea = session.nextIdea;
  let newTopic = session.nextTopic;
  for (const idx of targets) {
    let path = fileList[idx];
    if (rng() < s.newFileProbability) {
      // Try to add a brand-new file instead of touching an existing one.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate =
          rng() < 0.5 ? `ideas/idea-${newIdea}.md` : `notes/${pickOne(rng, TOPICS)}-${newTopic}.md`;
        if (!session.files.has(candidate)) {
          path = candidate;
          if (candidate.startsWith('ideas/')) newIdea += 1;
          else newTopic += 1;
          session.files.set(path, initialHeader(session.settings.output.repoName) + entryBody(rng, s.contentStyle));
          break;
        }
      }
    }
    const current = session.files.get(path) ?? '';
    const lastDate = session.lastEntryDate.get(path) ?? '';
    const isNewDate = lastDate !== dateKey;
    const entry =
      (isNewDate ? heading(dateKey, rng) + '\n' : '') + entryBody(rng, s.contentStyle);
    session.files.set(path, current + entry);
    session.lastEntryDate.set(path, dateKey);
    session.lastTouch.set(path, session.commitIndex);
    touched.push(path);
  }
  session.nextIdea = newIdea;
  session.nextTopic = newTopic;
  session.commitIndex += 1;
  return touched;
}

// ---------------------------------------------------------------------------
// Commit messages
// ---------------------------------------------------------------------------

const MESSAGE_TYPES = ['feat', 'fix', 'docs', 'chore', 'refactor', 'test', 'style'] as const;

function typeForPath(path: string, rng: () => number): string {
  if (path.startsWith('docs/') || path.startsWith('notes/') || path.startsWith('ideas/')) {
    return 'docs';
  }
  if (path.startsWith('tests/')) return 'test';
  if (path.startsWith('scripts/')) return 'chore';
  if (rng() < 0.35) return 'feat';
  if (rng() < 0.6) return 'fix';
  return pickOne(rng, MESSAGE_TYPES);
}

function scopeForPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.(md|ts|sh)$/, '');
}

/** Deterministic conventional-style message (may include a body). */
export function commitMessage(
  rng: () => number,
  paths: string[],
  settings: Settings,
): string {
  const style = settings.content.commitMessageStyle;
  const first = paths[0] ?? 'docs';
  if (style === 'random') {
    const msg = `${pickOne(rng, ADJECTIVES)}-${pickOne(rng, NOUNS)}-${pickOne(rng, VERBS)}`;
    if (paths.length > 1) return `${msg} (${paths.length} files)`;
    return msg;
  }
  const type = typeForPath(first, rng);
  const scope = scopeForPath(first);
  const verb = pickOne(rng, VERBS);
  const noun = pickOne(rng, NOUNS);
  let msg = `${type}(${scope}): ${verb} ${noun}`;
  if (rng() < settings.content.bodyProbability) {
    msg += `\n\n${sentence(rng)} ${sentence(rng)}`;
  }
  return msg;
}
