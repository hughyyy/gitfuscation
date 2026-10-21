// repos.js — inspect repos and reattribute authorship (no dependencies).

'use strict';

const PALETTE = ['#21262d', '#0e4429', '#006d32', '#26a641', '#39d353'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ROW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const $ = (sel) => document.querySelector(sel);

async function api(route, body) {
  const res = await fetch(route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(payload.error ?? payload.errors?.join('; ') ?? String(res.status)), { payload });
  return payload;
}

let repoRoot = '';
let currentRepository = null; // path of the repo being inspected
let currentRepo = null; // RepoAuthors from /api/repo/authors
let identityMap = { rows: [], fallback: null };
let currentPlan = null;

// ---------------------------------------------------------------------------
// Repo list
// ---------------------------------------------------------------------------

async function loadRepos() {
  const statusEl = $('#scan-status');
  statusEl.textContent = 'scanning...';
  const rootInput = $('#root-input').value.trim();
  try {
    const data = await api(`/api/repos?root=${encodeURIComponent(rootInput)}`);
    repoRoot = data.root;
    if ($('#root-input').value.trim() === '') {
      $('#root-input').value = data.root;
    }
    const list = $('#repo-list');
    list.innerHTML = data.repos.length === 0 ? '<p class="dim">no git repos found</p>' : '';
    for (const repo of data.repos) {
      const card = document.createElement('section');
      const authors = repo.topAuthors.map((a) => `${a.identity} ×${a.count}`).join(', ') || '—';
      card.innerHTML = `
        <h2>${repo.name}</h2>
        <p class="dim mono" style="margin:0 0 6px;">${repo.rel}</p>
        <p style="margin:0 0 4px;">commits: <b>${repo.commits}</b> · heads: <b>${repo.heads}</b> · last activity: <b>${new Date(repo.lastActivity * 1000).toISOString().slice(0, 10)}</b></p>
        <p class="dim" style="margin:0 0 8px; font-size:12px;">${authors}</p>
        <a class="inspect" data-path="${repo.path}">inspect →</a>`;
      list.appendChild(card);
      card.querySelector('.inspect').addEventListener('click', () => inspect(repo.path));
    }
    statusEl.textContent = `${data.repos.length} repo(s)`;
  } catch (e) {
    statusEl.textContent = 'scan failed';
    console.error(e);
  }
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function githubLevel(count, max) {
  if (count <= 0) return 0;
  if (max <= 0) return 1;
  return Math.min(4, Math.max(1, 1 + Math.floor((4 * count) / max)));
}

async function inspect(repoPath) {
  currentRepository = repoPath;
  const data = await api(`/api/repo/authors?path=${encodeURIComponent(repoPath)}`);
  currentRepo = data;
  $('#detail').classList.remove('hidden');
  $('#detail-meta').innerHTML = `
    <section>
      <h2>${data.name}</h2>
      <p class="dim mono" style="margin:0;">${data.path}</p>
      <div class="stats" style="margin-top:8px;">
        <span>branch: <b>${data.head}</b></span>
        <span>commits: <b>${data.commitCount}</b></span>
        <span>heads: <b>${data.branches.length}</b> ${data.branches.join(', ')}</span>
        <span>tags: <b>${data.tagCount}</b></span>
        <span>last activity: <b>${new Date(data.lastActivity * 1000).toISOString().slice(0, 10)}</b></span>
      </div>
    </section>`;
  renderAuthors(data.authors);
  renderHeatmap(data.authors, new Set());
}

function renderAuthors(authors) {
  const el = $('#authors');
  el.innerHTML = authors.length === 0 ? '<p class="dim">no commits</p>' : '';
  const total = authors.reduce((a, b) => a + b.count, 0) || 1;
  for (const a of authors) {
    const row = document.createElement('div');
    row.className = 'author-row';
    const pct = Math.round((a.count / total) * 100);
    row.innerHTML = `
      <label class="check"><input type="checkbox" data-identity="${a.identity}" checked /> <span class="mono">${a.identity}</span></label>
      <div class="bar"><span style="width:${pct}%"></span></div>
      <span style="min-width:90px;text-align:right;">${a.count} cmp · ${a.days.length} days</span>`;
    el.appendChild(row);
  }
  el.querySelectorAll('input[data-identity]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const selected = new Set(
        [...el.querySelectorAll('input[data-identity]:checked')].map((c) => c.dataset.identity),
      );
      renderHeatmap(currentRepo.authors, selected);
    });
  });
}

function renderHeatmap(authors, selected) {
  const el = $('#heatmap');
  if (currentRepo.commitCount === 0) {
    el.innerHTML = '<p class="dim">no commits</p>';
    return;
  }
  const perDay = new Map();
  for (const a of authors) {
    if (!selected.has(a.identity) && selected.size > 0) continue;
    for (const d of a.days) perDay.set(d.dateKey, (perDay.get(d.dateKey) ?? 0) + d.count);
  }
  const days = [...perDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (days.length === 0) {
    el.innerHTML = '<p class="dim">no selection</p>';
    return;
  }
  const max = Math.max(...days.map((d) => d[1]));
  // Align to Sunday columns.
  const first = new Date(`${days[0][0]}T00:00:00Z`).getUTCDay();
  const lead = first;
  const weeks = Math.ceil((days.length + lead) / 7);
  const byIndex = new Map(days.map((d, i) => [i, d[1]]));

  let html = '<div class="month-row" style="display:flex;margin-left:40px;">';
  let prevMonth = '';
  for (let col = 0; col < weeks; col += 1) {
    const idx = col * 7 - lead;
    const [dateKey] = days[idx] ?? ['', 0];
    const m = idx >= 0 && idx < days.length ? MONTHS[Number(dateKey.slice(5, 7)) - 1] : null;
    let label = '';
    if (m !== null && m !== prevMonth) {
      label = m;
      prevMonth = m;
    }
    html += `<span class="month" style="width:14px;">${label}</span>`;
  }
  html += '</div>';
  for (let row = 0; row < 7; row += 1) {
    html += `<div style="display:flex;align-items:center;"><span style="width:34px;font-size:10px;color:var(--dim);text-align:right;padding-right:6px;">${ROW_LABELS[row]}</span>`;
    for (let col = 0; col < weeks; col += 1) {
      const idx = col * 7 + row - lead;
      const count = byIndex.get(idx);
      const color = count === undefined ? '#21262d' : PALETTE[githubLevel(count, max)];
      const title = days[idx] !== undefined ? `${days[idx][0]} — ${days[idx][1]} commits` : '';
      html += `<div class="cell" style="width:11px;height:11px;background:${color};margin-right:3px;border-radius:2px;" title="${title}"></div>`;
    }
    html += '</div>';
  }
  el.innerHTML = html;
  // Re-emit with escaping so titles (date + integer) survive the DOM round-trip.
  const div = document.createElement('div');
  div.innerHTML = html;
  el.innerHTML = div.innerHTML;
}

// ---------------------------------------------------------------------------
// Identity map editor
// ---------------------------------------------------------------------------

function renderMap() {
  const rows = $('#map-rows');
  rows.innerHTML = '';
  identityMap.rows.forEach((row, i) => addRow(row, i));
  const fe = $('#fallback-enable');
  fe.checked = identityMap.fallback !== null;
  $('#fallback-row').classList.toggle('hidden', identityMap.fallback === null);
  if (identityMap.fallback !== null) {
    $('#fallback-name').value = identityMap.fallback.name;
    $('#fallback-email').value = identityMap.fallback.email;
  }
}

function addRow(row, index) {
  const rows = $('#map-rows');
  const div = document.createElement('div');
  div.className = 'map-row';
  div.innerHTML = `
    <select data-field="mode">
      <option value="email" ${row.mode === 'email' ? 'selected' : ''}>email</option>
      <option value="name" ${row.mode === 'name' ? 'selected' : ''}>name</option>
      <option value="full" ${row.mode === 'full' ? 'selected' : ''}>name+email</option>
    </select>
    <input data-field="match" type="text" placeholder="match (e.g. bernie@local)" value="${row.match}" />
    <input data-field="toName" type="text" placeholder="target name" value="${row.to.name}" />
    <input data-field="toEmail" type="text" placeholder="target email" value="${row.to.email}" />
    <button class="btn secondary remove" title="remove rule">✕</button>`;
  div.querySelector('.remove').addEventListener('click', () => {
    identityMap.rows.splice(index, 1);
    renderMap();
  });
  rows.appendChild(div);
}

function collectMap() {
  const rows = [...$('#map-rows').children].map((div) => ({
    from: {
      match: div.querySelector('[data-field="match"]').value,
      mode: div.querySelector('[data-field="mode"]').value,
    },
    to: {
      name: div.querySelector('[data-field="toName"]').value,
      email: div.querySelector('[data-field="toEmail"]').value,
    },
  }));
  const fallback =
    $('#fallback-enable').checked
      ? { name: $('#fallback-name').value, email: $('#fallback-email').value }
      : null;
  return { rows, fallback };
}

// ---------------------------------------------------------------------------
// Reauth
// ---------------------------------------------------------------------------

function reauthBody() {
  return {
    path: currentRepository,
    identityMap: collectMap(),
    rewriteCommitter: $('#rewrite-committer').checked,
    includeTags: $('#include-tags').checked,
  };
}

async function plan() {
  currentPlan = null;
  $('#execute-btn').disabled = true;
  const out = $('#plan-out');
  out.textContent = 'planning...';
  try {
    const plan = await api('/api/repo/reauth/plan', reauthBody());
    currentPlan = plan;
    const html = [];
    if (plan.changes.length === 0) {
      html.push('<p>No reattribution will occur — every author is already mapped or unmapped.</p>');
    } else {
      html.push('<table class="plan-table"><tr><th style="text-align:left;">from</th><th style="text-align:left;">to</th><th>commits</th></tr>');
      for (const c of plan.changes) {
        html.push(`<tr><td class="mono">${c.fromIdentity}</td><td class="mono">${c.toIdentity}</td><td style="text-align:center;">${c.commitCount}</td></tr>`);
      }
      html.push('</table>');
    }
    html.push(`<p style="margin:8px 0 0; font-size:12px; color:var(--dim);">affected: ${plan.affectedCommits} · identity change: ${plan.identityCommits} · untouched: ${plan.untouchedCommits} · total: ${plan.commitsTotal} · signatures stripped: ${plan.strippedSignatures}</p>`);
    if (plan.refsToMove.length > 0) {
      html.push(`<p style="margin:4px 0 0; font-size:12px; color:var(--dim);">refs to move (${plan.refsToMove.length}): ${plan.refsToMove.map((m) => m.ref).join(', ')}</p>`);
    }
    out.innerHTML = html.join('');
    $('#execute-btn').disabled = plan.changes.length === 0;
    $('#reauth-status').textContent = '';
  } catch (e) {
    out.textContent = 'plan failed: ' + (e.message ?? String(e));
  }
}

async function execute() {
  if (!$('#confirm-sha').checked) {
    $('#reauth-status').textContent = 'confirm the SHA-change notice first';
    return;
  }
  const out = $('#plan-out');
  const status = $('#reauth-status');
  status.textContent = 'rewriting...';
  $('#execute-btn').disabled = true;
  try {
    const result = await api('/api/repo/reauth/execute', reauthBody());
    status.textContent = 'done';
    out.innerHTML = `
      <p style="margin:0 0 6px;">Rewrote <b>${result.newObjectCount}</b> objects; <b>${result.identityCommits}</b> commits reattributed.</p>
      <p style="margin:0 0 6px; font-size:12px; color:var(--dim);">Backups: <span class="mono">${result.backupRefs.join(', ') || 'none'}</span></p>
      <p class="rewrite-note">Reattribution changes SHAs (identity only — dates and content are preserved). If this repo has a remote, force-push to apply: <span class="mono">git push --force --all origin</span> (and <span class="mono">--tags</span> if tags moved). Push the backup refs too if you want the old history mirrored.</p>`;
    await inspect(currentRepository);
  } catch (e) {
    status.textContent = 'reattribution failed';
    out.textContent = (e.payload && e.payload.error) || String(e.message ?? e);
  } finally {
    $('#execute-btn').disabled = true;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  $('#refresh-btn').addEventListener('click', loadRepos);
  $('#add-row-btn').addEventListener('click', () => {
    addRow({ mode: 'email', match: '', to: { name: '', email: '' } }, identityMap.rows.length);
  });
  $('#fallback-enable').addEventListener('change', () => {
    $('#fallback-row').classList.toggle('hidden', !$('#fallback-enable').checked);
  });
  $('#save-map-btn').addEventListener('click', async () => {
    try {
      await api('/api/identity-map', collectMap());
      $('#map-status').textContent = 'saved';
    } catch (e) {
      $('#map-status').textContent = 'invalid: ' + (e.payload?.errors?.join('; ') ?? e.message);
    }
  });
  $('#plan-btn').addEventListener('click', plan);
  $('#execute-btn').addEventListener('click', execute);
  try {
    const { map } = await api('/api/identity-map');
    identityMap = { rows: map.rows, fallback: map.fallback };
  } catch (e) {
    $('#map-status').textContent = 'map load failed';
  }
  renderMap();
  await loadRepos();
}

boot();
