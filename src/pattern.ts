// pattern.ts — render the contribution pattern as an ASCII markdown file.
// Used automatically by the generator (README.md in every generated repo) and
// by the CLI `readme` command for existing repos.

import { runGit } from './gitutil.ts';
import { previewFor, renderAscii, type PreviewPayload } from './preview.ts';
import type { Settings, OutputSettings } from './settings.ts';
import { STATIC_CONTENT_FILES } from './content.ts';
import { PROGRAM_VERSION } from './version.ts';

export const PATTERN_README_PATH: string = STATIC_CONTENT_FILES[0];

/**
 * The history-shaping settings embedded in the README: everything the
 * generation depends on, minus environmental knobs (outPath, replace).
 */
export type GenerationSettings = Omit<Settings, 'output'> & {
  output: Omit<OutputSettings, 'outPath' | 'replace'>;
};

/** Markdown document embedding the ASCII contribution chart. */
export function patternMarkdown(
  payload: PreviewPayload,
  title: string,
  author: string,
  email: string,
  settings: GenerationSettings | null = null,
): string {
  const chart = renderAscii(payload);
  const paintedDays = payload.cells.filter((c) => c.count === payload.totals.maxDay && payload.totals.maxDay > 0).length;
  const t = payload.totals;
  const paintNote =
    paintedDays > 0
      ? `\n${paintedDays} day(s) painted at full strength (${t.maxDay} commits).\n`
      : '';
  const settingsBlock =
    settings === null
      ? '- Generation settings: not recorded (repo predates settings capture)'
      : `- Generation settings (exact):\n\n  \`\`\`json\n  ${JSON.stringify(settings, null, 2).replace(/\n/g, '\n  ')}\n  \`\`\``;
  return `# ${title}

Generated git history${t.activeDays > 0 && t.maxDay > 0 && paintedDays > 0 ? ' whose contribution graph spells a message' : ''}.
The chart below shows exactly what the contribution graph looks like for this
repository. GitHub re-colors cells with its own relative algorithm when pushed,
so the exact shades may differ from the preview — the shape and pattern are
what this history produces.
${paintNote}
\`\`\`
${chart}
\`\`\`

Legend: \`█\` = most commits in a day, \`░\` = a few, blank = none.

- Commits: ${t.commits} over ${payload.cells.length} days (${t.activeDays} active)
- Window: ${payload.startDate} → ${payload.endDate}
- Authored by: ${author} <${email}>
- Generated with [gitfuscation](https://github.com/hughyyy/gitfuscation)
- Program version: ${PROGRAM_VERSION}
${settingsBlock}
`;
}

/** Pattern for the settings-derived schedule (what the generator will build). */
export function patternFromSettings(settings: Settings): string {
  // Embed the exact history-shaping settings; outPath/replace are environment
  // (where the repo was written), not parameters of the history itself, so
  // excluding them keeps regeneration byte-identical anywhere.
  const { output: out, ...rest } = settings;
  const { outPath: _outPath, replace: _replace, ...output } = out;
  const embedded = { ...rest, output };
  return patternMarkdown(
    previewFor(settings),
    settings.output.repoName,
    settings.output.authorName,
    settings.output.authorEmail,
    embedded,
  );
}

interface RepoChart {
  payload: PreviewPayload;
  author: string;
  email: string;
}

/**
 * Reconstruct the chart for an existing repo from its actual history (git log
 * author dates), relative-scaled like GitHub. Used by `readme <path>`.
 */
export async function chartFromRepo(repoPath: string): Promise<RepoChart> {
  const out = await runGit(['log', '--format=%aI%x09%an%x09%ae'], { cwd: repoPath }).catch(() => '');
  const counts = new Map<string, number>();
  let author = '';
  let email = '';
  let first = '';
  let last = '';
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    const [iso, name, mail] = line.split('\t');
    const key = (iso as string).slice(0, 10);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (name !== undefined && author === '') {
      author = name;
      email = mail ?? '';
    }
    if (first === '' || key < first) first = key;
    if (last === '' || key > last) last = key;
  }
  if (first === '') {
    return {
      payload: {
        cells: [],
        weeks: 1,
        rows: 7,
        weekStart: 'sunday',
        totals: { commits: 0, activeDays: 0, maxDay: 0, burstDays: 0 },
        seed: 0,
        startDate: '',
        endDate: '',
      },
      author,
      email,
    };
  }
  const cells: Array<{ level: number; count: number; dateISO: string }> = [];
  const cursor = new Date(`${first}T00:00:00Z`);
  const end = new Date(`${last}T00:00:00Z`);
  const endMs = end.getTime();
  for (const d = cursor; d.getTime() <= endMs; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    cells.push({ level: 0, count: counts.get(key) ?? 0, dateISO: key });
  }
  const max = cells.reduce((a, b) => Math.max(a, b.count), 0);
  for (const c of cells) {
    c.level = c.count === 0 ? 0 : Math.min(4, Math.max(1, 1 + Math.floor((4 * c.count) / max)));
  }
  const lead = new Date(`${first}T00:00:00Z`).getUTCDay();
  const payload: PreviewPayload = {
    cells,
    weeks: Math.max(1, Math.ceil((cells.length + lead) / 7)),
    rows: 7,
    weekStart: 'sunday',
    totals: {
      commits: cells.reduce((a, b) => a + b.count, 0),
      activeDays: cells.filter((c) => c.count > 0).length,
      maxDay: max,
      burstDays: cells.filter((c) => c.count > 100).length,
    },
    seed: 0,
    startDate: first,
    endDate: last,
  };
  return { payload, author, email };
}
