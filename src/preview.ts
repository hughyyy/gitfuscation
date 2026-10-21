// preview.ts — schedule -> API payload + ASCII chart (SPEC §5, §5.1).

import type { Settings } from './settings.ts';
import { levelCountsFor } from './settings.ts';
import { generateSchedule, levelFor, type ScheduleTotals } from './schedule.ts';

export interface PreviewCell {
  level: number; // 0..4
  count: number;
  dateISO: string; // 'YYYY-MM-DD' in the settings tz offset
}

export interface PreviewPayload {
  cells: PreviewCell[];
  weeks: number;
  rows: number;
  weekStart: 'sunday' | 'monday';
  totals: ScheduleTotals;
  seed: number;
  startDate: string;
  endDate: string;
}

const ROW_LABELS: Record<'sunday' | 'monday', string[]> = {
  sunday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  monday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Days from the window start back to the nearest weekStart column edge. */
function leadDays(weekStart: 'sunday' | 'monday', firstWeekday: number): number {
  if (weekStart === 'sunday') return firstWeekday; // sunday = 0
  return (firstWeekday + 6) % 7; // monday = 1
}

/**
 * Absolute thresholds derived from signwriter level counts so a painted cell
 * renders exactly its painted level regardless of other days' activity:
 * thresholds sit at the midpoints between adjacent levels (plus L4+1 on top).
 */
export function signwriterThresholds(levelCounts: number[]): number[] {
  const [l1, l2, l3, l4] = levelCounts as [number, number, number, number];
  return [(l1 + l2) / 2, (l2 + l3) / 2, (l3 + l4) / 2, l4 + 1];
}

export function previewFor(settings: Settings): PreviewPayload {
  const schedule = generateSchedule(settings);
  const max = schedule.totals.maxDay;
  // While a banner is painted, render with exact painted levels (absolute
  // scale, thresholds derived from the level counts) so the chart matches the
  // intended shades. GitHub's own graph uses a relative scale on push.
  const paintedDays = Object.keys(settings.signwriter.overrides);
  const scale: Settings['preview'] =
    paintedDays.length > 0
      ? {
          colorScale: 'absolute',
          absoluteThresholds: signwriterThresholds(levelCountsFor(settings.signwriter.fullStrength)),
        }
      : settings.preview;
  const cells = schedule.days.map((d) => ({
    level: levelFor(d.count, scale, max),
    count: d.count,
    dateISO: d.dateKey,
  }));
  const firstWeekday = new Date(schedule.days[0].epoch * 1000).getUTCDay();
  const lead = leadDays(settings.timeline.weekStart, firstWeekday);
  const weeks = Math.max(1, Math.ceil((schedule.days.length + lead) / 7));
  return {
    cells,
    weeks,
    rows: 7,
    weekStart: settings.timeline.weekStart,
    totals: schedule.totals,
    seed: schedule.seed,
    startDate: schedule.days[0].dateKey,
    endDate: schedule.days[schedule.days.length - 1].dateKey,
  };
}

const LEVEL_CHARS = [' ', '\u2591', '\u2592', '\u2593', '\u2588'];

/**
 * Render the contribution matrix as an ASCII heatmap: month ticks on top,
 * row labels per weekday, one cell per day (level chars), aligned into
 * weekStart-anchored columns.
 */
export function renderAscii(payload: PreviewPayload): string {
  const lead = leadDays(payload.weekStart, new Date(`${payload.cells[0].dateISO}T00:00:00Z`).getUTCDay() as number);
  const days = payload.cells;
  const label = ROW_LABELS[payload.weekStart];
  const lines: string[] = [];

  // Month header
  const header: string[] = [];
  let prevMonth = '';
  for (let col = 0; col < payload.weeks; col += 1) {
    const dayIdx = col * 7 - lead;
    if (dayIdx >= 0 && dayIdx < days.length) {
      const m = MONTHS[Number(days[dayIdx].dateISO.slice(5, 7)) - 1];
      if (m !== prevMonth) {
        header.push(m.padEnd(7, ' '));
        prevMonth = m;
      } else {
        header.push(' '.repeat(7));
      }
    } else {
      header.push(' '.repeat(7));
    }
  }
  lines.push('       ' + header.join('').slice(0, payload.weeks * 7));

  for (let row = 0; row < 7; row += 1) {
    const cells: string[] = [];
    for (let col = 0; col < payload.weeks; col += 1) {
      const dayIdx = col * 7 + row - lead;
      const cell = dayIdx >= 0 && dayIdx < days.length ? days[dayIdx] : undefined;
      const ch = cell !== undefined ? LEVEL_CHARS[cell.level] : ' ';
      cells.push(ch + ' '.repeat(6));
    }
    lines.push(
      `${label[row].padEnd(7)}` + cells.join('').slice(0, payload.weeks * 7).replace(/ +$/g, ''),
    );
  }
  lines.push('');
  lines.push(
    `commits: ${payload.totals.commits}  activeDays: ${payload.totals.activeDays}  ` +
      `maxDay: ${payload.totals.maxDay}  burstDays(>100): ${payload.totals.burstDays}  ` +
      `window: ${payload.startDate} .. ${payload.endDate}  seed: ${payload.seed}`,
  );
  lines.push('legend: ' + LEVEL_CHARS.map((c, i) => `[${c}] level ${i}`).join('  '));
  return lines.join('\n');
}
