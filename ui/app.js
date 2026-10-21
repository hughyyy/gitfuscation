// app.js — gitfuscation web UI (no dependencies).
// Form mirrors the settings schema 1:1; any change debounces -> /api/preview.
// "Generate repo" -> /api/generate, then polls /api/status.

'use strict';

const PALETTE_DEFAULT = ['#21262d', '#0e4429', '#006d32', '#26a641', '#39d353'];

/** Read one form control by settings path. */
function control(path) {
  return document.querySelector(`[data-path="${path}"]`);
}

function setValue(path, value) {
  const el = control(path);
  if (!el) return;
  if (el.type === 'checkbox') {
    el.checked = Boolean(value);
  } else {
    el.value = value;
  }
  if (el.type === 'range') {
    const out = el.closest('.range-row')?.querySelector('output');
    if (out) out.textContent = value;
  }
}

function collectSettings() {
  const out = {};
  for (const el of document.querySelectorAll('[data-path]')) {
    const path = el.dataset.path.split('.');
    let value; // string | number | boolean per control type
    if (el.type === 'checkbox') value = el.checked;
    else if (el.type === 'number' || el.type === 'range') {
      value = el.value === '' ? '' : Number(el.value);
    } else {
      value = el.value;
    }
    if (path.length === 3) {
      // Array member: group.key.index
      out[path[0]] ??= {};
      out[path[0]][path[1]] ??= [];
      out[path[0]][path[1]][Number(path[2])] = value;
      continue;
    }
    out[path[0]] ??= {};
    out[path[0]][path[1]] = value;
  }
  // Empty means null for the two nullable fields.
  for (const p of ['timeline.startDate', 'activity.totalCommits']) {
    const el = control(p);
    if (el && el.value === '') {
      const parts = p.split('.');
      out[parts[0]][parts[1]] = null;
    }
  }
  return out;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.error ?? payload.errors?.join('; ') ?? `${res.status}`);
    err.payload = payload;
    throw err;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Chart rendering
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ROW_LABELS = {
  sunday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  monday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
};

function weekdayOf(dateISO) {
  return new Date(`${dateISO}T00:00:00Z`).getUTCDay();
}

function leadDays(weekStart, firstWeekday) {
  return weekStart === 'sunday' ? firstWeekday : (firstWeekday + 6) % 7;
}

function renderChart(payload, palette, weekStartOverride) {
  const weekStart = weekStartOverride ?? payload.weekStart;
  const { weeks, cells } = payload;
  const lead = leadDays(weekStart, weekdayOf(cells[0].dateISO));
  const chart = document.getElementById('chart');
  chart.innerHTML = '';

  // Month ticks
  const months = document.createElement('div');
  months.className = 'month-row';
  let prevMonth = '';
  for (let col = 0; col < weeks; col += 1) {
    const idx = col * 7 - lead;
    const m = idx >= 0 && idx < cells.length ? MONTHS[Number(cells[idx].dateISO.slice(5, 7)) - 1] : null;
    const span = document.createElement('span');
    span.className = 'month';
    if (m && m !== prevMonth) {
      span.textContent = m;
      prevMonth = m;
    }
    months.appendChild(span);
  }
  chart.appendChild(months);

  // Weekday rows
  const labels = ROW_LABELS[weekStart];
  for (let row = 0; row < 7; row += 1) {
    const line = document.createElement('div');
    line.className = 'row';
    const lab = document.createElement('span');
    lab.className = 'row-label';
    lab.textContent = labels[row];
    line.appendChild(lab);
    for (let col = 0; col < weeks; col += 1) {
      const idx = col * 7 + row - lead;
      const cell = document.createElement('div');
      cell.className = 'cell';
      if (idx >= 0 && idx < cells.length) {
        const c = cells[idx];
        cell.style.background = palette[c.level] ?? PALETTE_DEFAULT[0];
        cell.title = `${c.dateISO} — ${c.count} commit${c.count === 1 ? '' : 's'}`;
        if (c.count === 0) cell.classList.add('empty');
      } else {
        cell.classList.add('empty');
      }
      line.appendChild(cell);
    }
    chart.appendChild(line);
  }
}

function renderStats(payload) {
  const s = document.getElementById('stats');
  const t = payload.totals;
  s.innerHTML = '';
  for (const [label, value] of [
    ['commits', t.commits],
    ['active days', t.activeDays],
    ['max in a day', t.maxDay],
    ['burst days (>100)', t.burstDays],
    ['window', `${payload.startDate} → ${payload.endDate}`],
  ]) {
    const span = document.createElement('span');
    span.innerHTML = `${label}: <b>${value}</b>`;
    s.appendChild(span);
  }
}

function renderLegend(palette) {
  const legend = document.getElementById('legend');
  legend.innerHTML = 'Less';
  for (const color of palette) {
    const swatch = document.createElement('span');
    swatch.className = 'cell';
    swatch.style.background = color;
    legend.appendChild(swatch);
  }
  const more = document.createElement('span');
  more.textContent = 'More';
  legend.appendChild(more);
}

// ---------------------------------------------------------------------------
// State & events
// ---------------------------------------------------------------------------

let debounceTimer = null;

function schedulePreview() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    const statusEl = document.getElementById('status-line');
    try {
      const payload = await api('/api/preview', collectSettings());
      renderChart(payload, palette);
      renderStats(payload);
      renderLegend(palette);
      hideErrors();
      statusEl.textContent = '';
    } catch (e) {
      showErrors(e);
    }
  }, 250);
}

// ---------------------------------------------------------------------------
// Generate flow
// ---------------------------------------------------------------------------

async function pollStatus(btn) {
  const statusEl = document.getElementById('status-line');
  for (;;) {
    const status = await api('/api/status');
    if (status.phase === 'done') {
      showResult(status.result);
      statusEl.textContent = 'done';
      return;
    }
    if (status.phase === 'error') {
      showErrors(new Error(status.error ?? 'generation failed'));
      statusEl.textContent = '';
      btn.disabled = false;
      return;
    }
    statusEl.textContent = `generating... ${status.done}/${status.total || '?'} commits`;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function onGenerate() {
  const btn = document.getElementById('generate-btn');
  btn.disabled = true;
  hideErrors();
  document.getElementById('result').classList.add('hidden');
  try {
    await api('/api/generate', collectSettings());
    await pollStatus(btn);
  } catch (e) {
    showErrors(e);
  } finally {
    btn.disabled = false;
  }
}

function showResult(result) {
  const el = document.getElementById('result');
  el.classList.remove('hidden');
  el.innerHTML = `
    <h3>Generated</h3>
    <div class="row">
      <span>commits: <b>${result.commitCount}</b></span>
      <span>files: <b>${result.fileCount}</b></span>
      <span>branch: <b>${result.branch}</b></span>
      <span>path: <code>${result.outPath}</code></span>
    </div>
    <ul>
      <li>Before pushing: confirm the author email is a <b>verified email on the GitHub account</b> you want credited.</li>
      <li>Push to the <b>default branch</b> — commits on side branches are not counted by the contribution graph.</li>
      <li>The graph refreshes within ~24 hours of the push.</li>
    </ul>`;
}

function showErrors(e) {
  const el = document.getElementById('errors');
  el.classList.remove('hidden');
  const errors = e.payload?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    el.innerHTML = '<ul>' + errors.map((x) => `<li>${x}</li>`).join('') + '</ul>';
  } else {
    el.textContent = 'Error: ' + (e.message ?? String(e));
  }
}

function hideErrors() {
  document.getElementById('errors').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let palette = PALETTE_DEFAULT;

async function boot() {
  const health = document.getElementById('health');
  try {
    const info = await api('/api/settings-defaults');
    health.textContent = 'server ok';
    health.classList.add('ok');
    palette = info.colorPalette ?? palette;
    const defaults = info.settings;
    for (const [k, v] of Object.entries(flatten(defaults))) {
      setValue(k, v);
    }
    const input = control('timeline.startDate');
    if (input && defaults.timeline.startDate === null) input.value = '';
    const total = control('activity.totalCommits');
    if (total && defaults.activity.totalCommits === null) total.value = '';

    if (
      info.identity.source !== 'git' ||
      String(info.identity.authorEmail).endsWith('@localhost')
    ) {
      document.getElementById('identity-email').textContent = info.identity.authorEmail;
      document.getElementById('identity-banner').classList.remove('hidden');
    }

    for (const el of document.querySelectorAll('[data-path]')) {
      el.addEventListener('input', schedulePreview);
      el.addEventListener('change', schedulePreview);
    }
    document.getElementById('generate-btn').addEventListener('click', onGenerate);

    schedulePreview();
  } catch (e) {
    health.textContent = 'server unreachable';
    health.classList.add('bad');
    showErrors(e);
  }
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i += 1) {
        flatten({ [String(i)]: v[i] }, p, out);
      }
    } else if (v !== null && typeof v === 'object') {
      flatten(v, p, out);
    } else {
      out[p] = v;
    }
  }
  return out;
}

boot();
