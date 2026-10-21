# gitfuscation — Specification + Implementation Plan

Date: 2026-10-21 · Status: draft v0.1

## 1. Overview

`gitfuscation` is a tooling suite for generating synthetic noise history that protects activity privacy. Two products share one core:

- **Day 1 — Activity generator**: create a brand-new repo containing a year of
  history whose per-day commit pattern looks human: long active streaks,
  occasional gaps, weekend/Friday-night boosts (but never guarantees), and rare
  burst days with 100+ commits. A dependency-free web UI previews the GitHub
  contribution chart from settings *before* generating the repo.

### Ground rules (verified facts the design depends on)

GitHub's contribution graph counts a commit only when all hold:

1. The commit's **author date** determines its calendar day (committer date does
   not).
2. The commit lands on the repository's **default branch** (`main`/`master`, or
   the `gh-pages` branch). Commits on long-running side branches do not count
   until merged into the default branch.
3. The commit **author email** is a verified email linked to the GitHub account
   that should receive credit. Removing the email later removes the credit.
4. Private repos are hidden from profiles unless "private contributions" are
   enabled in account settings.
5. The graph may take up to ~24 h to refresh after a push.

Consequences for the design:

- We set *both* author and committer dates, and write commits directly to the
  default branch.
- Author identity (name + email) must be configurable and surfaced prominently;
  defaulting to `git config user.name`/`user.email` is not enough — a user whose
  local identity isn't their GitHub identity gets an empty graph.
- All date arithmetic uses a **fixed UTC offset** (configurable), never a
  changing DST offset, so an evening commit cannot silently roll to the next
  calendar day.

Scope note: this tool changes history in repos you own. GitHub may treat
synthetic mass activity as spam/abuse; the tool does not bypass attribution
rules — it relies on honest author identity and own repos.

## 2. Architecture

Zero-dependency Python 3.11+ backend (stdlib only) + vanilla HTML/CSS/JS front
end (no build step). Git is driven through its plumbing commands via
`subprocess` for speed and correctness.

```
gitfuscation/
  README.md
  SPEC.md
  src/gitfuscation/
    __init__.py

    settings.py          # schema, defaults, validation, JSON (de)serialization
    schedule.py          # activity model -> ordered list of commits (core)
    content.py           # file corpus, text generators, commit-message bank
    gitutil.py           # plumbing wrappers (hash-object, mktree, commit-tree,
                         #   update-ref, fast helpers)
    materialize.py       # Day 1: schedule -> fresh repo

    preview.py           # schedule -> contribution matrix (levels, 7xN)
    server.py            # ThreadingHTTPServer + /api endpoints + static UI
  ui/
    index.html, app.js, style.css
  tests/
    test_schedule.py, test_preview.py
    test_materialize.py, test_rewrite.py
  generated/             # scratch output, gitignored
```

CLI entry points (`python -m gitfuscation …`):

| Command | Purpose |
|---|---|
| `serve` | Start web UI at `http://127.0.0.1:8315` |
| `preview --config c.json` | Print ASCII contribution chart to the terminal |
| `generate --config c.json` | Generate the repo from a config, print summary |

### Core invariant

**Preview reproducibility**: the preview and `generate` call the *same*
`schedule.generate(settings)` function with the same settings and seed. The
chart shown in the UI is exactly the history the repo will contain. `generate`
never re-rolls randomness.

## 3. Settings model (Day 1 / shared)

Single JSON settings object, namespaced by concern. Values with defaults;
validation in `settings.py` (clamp + type-check, explicit error list, no silent
coercion).

### 3.1 `output`

|Key|Type|Default|Meaning|
|---|---|---|---|
|`repoName`|str|`activity-history`|Repo/branch name source|
|`outPath`|str|`generated/activity-history`|Where the repo is created|
|`branchName`|str|`main`|Default branch the commits land on|
|`authorName`|str|env `GIT_AUTHOR_NAME` → `GIT_COMMITTER_NAME` → `git config user.name` → `gitfuscation`|Author/committer name (same both)|
|`authorEmail`|str|`git config user.email` → `gitfuscation@localhost`|Must be a **verified GitHub email** for graph credit|
|`tzOffset`|int|local UTC offset at run time|Fixed offset (e.g. `-5`) applied to every timestamp|

### 3.2 `timeline`

|Key|Type|Default|Meaning|
|---|---|---|---|
|`startDate`|str (ISO) or null|null → 12 months + 1 day before today|First visible day; set so the repo ends "today"|
|`durationDays`|int|365|Days generated from `startDate` (inclusive)|
|`weekStart`|enum `sunday`/`monday`|`sunday`|Day a preview column begins on (rendering only)|

### 3.3 `activity` (the schedule controls)

|Key|Type|Default|Meaning|
|---|---|---|---|
|`seed`|int|`20261021`|PRNG seed; same seed ⇒ same schedule|
|`totalCommits`|int or null|null|If set, the generator rescales daily counts so the sum matches (overrides mean)|
|`meanCommitsPerDay`|float|5|Baseline Poisson intensity for an *active* day|
|`maxCommitsPerDay`|int|140|Hard cap per day (bursts clamp here)|
|`burstProbability`|float|0.04|Per-active-day chance of a burst (large multiplier)|
|`burstMultiplierMax`|float|12|Burst multiplies mean this much (before cap)|
|`weekendBoost`|float|1.5|Multiplies *activity probability* on Fri/Sat/Sun|
|`weekendCommitBoost`|float|1.4|Multiplies per-day *commit count* on Fri/Sat/Sun|
|`streakPersistence`|float|0.88|P(day active \| previous active)|
|`meanGapDays`|float|2.0|Mean rest-gap length when a streak breaks|
|`hourWeights`|array[24]|table §3.3.1|Relative commit likelihood per hour-of-day (UTC-offset clock)|
|`minMinutesBetweenCommits`|int|3|Reserve this floor between consecutive commits of a day|
|`commitCountStyle`|enum `random`/`fixed`|`random`|`fixed` makes every active day emit exactly `meanCommitsPerDay` (for testing)|

**3.3.1 Default `hourWeights`** (bimodal weekday profile; evening-dominant):

```
0  1  2   3   4   5  6  7  8  9  10 11
0, 0, 1,  1,  1,  1, 2, 4, 6, 6, 5, 5,
12 13 14  15  16  17 18 19 20 21 22 23
6, 7, 7,  7,  8,  9, 10,12,14,14,12, 8
```

`weekendCommitBoost` additionally raises the evening hours (18–02) on Fri/Sat by
weighting the same table — giving the Friday-night effect without forcing it on
every weekend.

### 3.4 `content`

|Key|Type|Default|Meaning|
|---|---|---|---|
|`fileCount`|int|24|Initial corpus size; a few new files appear over the year|
|`contentStyle`|enum `markdown`/`lorem`/`words`|`markdown`|Text flavor used to fill files|
|`filesPerCommit`|int (1..4)|1|How many files a single commit touches (rare)|
|`newFileProbability`|float|0.02|Per-commit chance to add a new file|
|`commitMessageStyle`|enum `conventional`/`random`|`conventional`|Message templates, see §4.4|
|`bodyProbability`|float|0.12|Chance a commit carries an extra body paragraph|

### 3.5 `preview`

|Key|Type|Default|Meaning|
|---|---|---|---|
|`colorScale`|enum `github`/`absolute`|`github`|Level computation, §5.1|
|`absoluteThresholds`|array[4]|`[1, 3, 8, 20]`|Used when `colorScale=absolute`: count ≥ t_i ⇒ level i+1|

## 4. Day 1 — Activity generator

### 4.1 Schedule algorithm (`schedule.py`)

Produces `list[Commit]` (timestamp + per-commit file plan), generated top-down:

**Layer A — streak/gap states.** A hidden Markov chain over days
`[startDate, startDate+durationDays)`:

- Day 0 active. `p_active(next | active) = clamp(streakPersistence ·
  weekdayFactor, 0.05, 0.99)` where `weekdayFactor = weekendBoost` on
  Fri/Sat/Sun else 1.0.
- When a streak breaks, gap length `G ~ Geometric(p_gap)`, `meanGapDays =
  1/p_gap` clamped to at least 1. After the gap, the chain resumes active.
- Chain output: `active[d] ∈ {0,1}`. Weekends are boosted but the 0.99 cap keeps
  some weekend days dead — matching the "higher, but not guaranteed" requirement.
- Tuning test (see §9): over `durationDays=365`, the share of Fri/Sat/Sun days
  active must exceed the share of Mon–Thu active, and a run must contain ≥2 gaps
  of ≥2 consecutive dead days, but also ≥6 streaks of ≥4 consecutive active days.

**Layer B — per-day commit counts.** For each active day `d`:

```
base  = Poisson(meanCommitsPerDay)
boost = weekendBoost (Fri/Sat/Sun) else 1        # multiplies base
burst = (rand() < burstProbability) ? Uniform(4, burstMultiplierMax) : 1
n     = min(maxCommitsPerDay, round(base * boost * burst))
n     = max(n, 1)
```

If `totalCommits` is set, rescale all days by `target/Σn` (rounding and
distributing remainders day-by-day) before the cap; `maxCommitsPerDay` is then
applied after rescale so the total is honored.

**Layer C — timestamps within a day.** For a day with `n` commits:

1. Sample `n` hour indices with replacement, weighted by `hourWeights`
   (multiplied by the weekend-evening bump on Fri/Sat).
2. For each of the `n` (hour, then minute-second jitter) draws, sort ascending;
   enforce `minMinutesBetweenCommits` floor by pushing later commits forward.
3. Combine with the day's date at the configured `tzOffset`.

**Layer D — commit file plans.** See §4.3.

Determinism: `random.Random(seed)`; all draws drawn in a strict, documented order
(states, then counts, then times, then files) so a seed reproduces byte-identical
schedules across runs and across the preview/generate paths.

### 4.2 Materialization (`materialize.py`)

Creates the repo with plumbing commands only; no working-tree churn, no `git
add`/`git commit` per commit.

1. `git init -b <branchName> <outPath>`.
2. Build the initial corpus: `fileCount` files at seed content (see §4.4).
   Record `state = {path: blob_oid}` and compute the initial tree.
3. **Initial commit**: all files, `author_date = startDate 00:00 tz`, message
   `chore: initial scaffold`.
4. For each scheduled commit in chronological order:

   - Update content: choose `1..filesPerCommit` files (weighted so active files
     accumulate history; occasional brand-new file per `newFileProbability`);
     append a dated entry; write new blobs via
     `git hash-object -w --stdin`.
   - Rebuild the tree: emit the whole `state` as one `git mktree` input (dozens
     of entries ⇒ ~1 ms), producing `new_tree`.
   - `git commit-tree <new_tree> -p <HEAD>`, with
     `GIT_AUTHOR_{NAME,EMAIL,DATE}` and `GIT_COMMITTER_{NAME,EMAIL,DATE}` set —
     `DATE` formatted `"@<unix> <tz>"`.
   - `git update-ref refs/heads/<branch> <new_sha>`.

5. `git gc --quiet`, then report: commit count, per-day histogram, first/last
   dates, file count, branch.

Performance: each commit is 3 subprocess calls over ~24 file entries — well under
a millisecond of git work each. 5,000 commits ≈ a few seconds. Single
chronological parent chain keeps topology trivially correct.

### 4.3 Per-commit file plan

- Files are paths like `docs/architecture.md`, `notes/<topic>.md`,
  `src/tools.py`, `ideas/<n>.md`, … (style-dependent pool).
- A commit picks files weighted by *recency* (files touched more recently are
  somewhat more likely — mirrors how humans cluster work), plus a small uniform
  floor so stale files still grow.
- Each touch appends an entry: a level-2 `## <date>` heading followed by 1–3
  generated sentences (content style). Diffs therefore look like continuous
  note-taking rather than rewriting.
- When a new file is added, it starts with a header plus its first entries.

### 4.4 Text & message generation (`content.py`)

- **Markdown style**: heading + backtick code fences + bullet list + prose word
  salad drawn from a keyword bank → realistic README/notes flavor.
- **Lorem style**: lorem-ipsum paragraphs.
- **Words style**: random dictionary strings.
- Messages (conventional default): `{type}({scope}): {verb} {noun}` with type
  mixed per file kind (`feat`/`fix`/`docs`/`chore`/`refactor`/`test`/`style`),
  e.g. `docs(tools): annotate pipeline invariants`. `bodyProbability` adds a
  1–2 sentence lorem body. `random` style string-concats random words.
- Content must be deterministic from `seed` (no time/random external calls).

## 5. Web UI

Single page, `ThreadingHTTPServer`, endpoints:

|Route|Method|Behaviour|
|---|---|---|
|`/`|GET|`ui/index.html` + static assets|
|`/api/preview`|POST|Body = settings; returns contribution matrix + stats (below). Runs schedule + preview layer, never touches git.|
|`/api/generate`|POST|Body = settings; runs `materialize` in a worker (single global lock — one generation at a time), streams nothing, returns summary + repo path.|
|`/api/health`|GET|`{"ok": true}`|

**Preview response schema:**

```jsonc
{
  "cells": [[level, dayCount, dateISO], ...],   // one per day, chronological
  "weeks": 53, "rows": 7,
  "weekStart": "sunday",
  "totals": {"commits": 2431, "activeDays": 187, "maxDay": 132, "burstDays": 4},
  "seed": 20261021
}
```

**Rendering** (`app.js`): a 7×N CSS/SVG grid (GitHub-like 10–11 px cells, 2–3 px
gap, rounded 2 px). Column `w` holds the 7 consecutive days starting at
`weekStart`; month labels and year ticks above, day labels (Mon/Wed/Fri) on the
left. Colors from a 5-stop palette (`#ebedf0` empty … `#216e39` dense). Settings
panel grouped by the §3 sections; sliders/inputs map 1:1 to the settings keys.
Any change debounces (250 ms) → `POST /api/preview` → re-render, so the chart
tracks the user's edits live. "Generate repo" → `POST /api/generate` → summary
panel (commit count, first/last date, file count, path) plus an explicit
checklist reminding the GitHub attribution rules (§1) and force-push guidance.

### 5.1 Level computation (`preview.py`)

- `colorScale=github` (default): reproduce the classic GitHub relative scale.
  With `max` = max daily count over the window:
  `level = 0` if 0; else `1 + ⌊4·count/max⌋` … i.e. thresholds
  `count ≥ max/4 → 2`, `≥ max/2 → 3`, `≥ 3·max/4 → 4`, with `count>0 → 1`.
  This yields "dark green = a few, bright green = many" exactly as described.
- `colorScale=absolute`: level via `absoluteThresholds`, so the chart is stable
  regardless of peak days.

## 7. Implementation plan

|#|Milestone|Work|Acceptance|
|---|---|---|---|
|M0|Scaffold|Layout per §2; `settings.py` schema+validation; CLI skeleton|`python -m gitfuscation serve` prints banner; invalid config returns a clean error list|
|M1|Schedule engine|`schedule.py` complete (layers A–D, determinism, `totalCommits` rescale)|`test_schedule.py` green: determinism, weekday lift, ≥2 gaps & ≥6 streaks per year window, monotonic intra-day clock, totalCommons≈target, burst days appear|
|M2|Materializer|`gitutil.py` + `materialize.py`|`test_materialize.py` green: builds a real repo; `git rev-list --count` == schedule count; `git log` author dates match schedule exactly; default branch has all commits; corpus file count matches setting|
|M3|Preview parity|`preview.py` + wiring `schedule→preview`|`test_preview.py` green: `generate(s)` then `preview(s)` agree cell-by-cell on the same seed; github-scaling thresholds behave per §5.1|
|M4|Web UI|`server.py` + `ui/*`|Browser-driven check: edit settings → chart re-renders; generate → repo appears with matching stats; `api/health` ok (*manual note*: push to a real GitHub account and watch the graph — ~24 h refresh)|
|M5|Docs & polish|`README.md` (quick start, attribution checklist), sample config|End-to-end: `serve`, tweak, generate, `git log --pretty=%aD` shows a plausible year|

Milestone order is dependency-driven: M1 is the only math, M2 the only git
plumbing, M4 needs M1+M3. M3 parity is the guardrail that keeps the preview

## 8. Risks & mitigations

|Risk|Impact|Mitigation|
|---|---|---|
|Generated history is "too perfect" (all weekdays, clean streaks)|Detectable / fails the brief|HMM gaps + burst randomness + weekend noise; assert the §4.1 statistical tests in CI|
|GitHub attribution silent no-op (private repos, unverified email, non-default branch)|User thinks it failed|UI checklist + settings defaults pulled from `git config`, but surfaced as editable; docs call out verified-email requirement|
|Timezone/DST day drift|Evening commits count on wrong day|Fixed `tzOffset` applied to every timestamp; test asserts day boundaries|
|Total count mismatch after rescale+cap|User confusion|Rescale before cap; report final actual total in the summary|

|Large bursts > GitHub's graph resolution|One flat dark cell|Bursts are the *point* (user asked for >100 days); intensity scale is capped at level 4 anyway|

## 9. Verification strategy (non-negotiable checks)

- **Statistical sanity of a generated year** (run over several seeds, asserted in
  `test_schedule.py`):
  - Share of active weekend days > share of active weekdays.
  - ≥6 streaks of ≥4 consecutive active days; ≥2 gaps of ≥2 dead days.
  - ≥1 day with >100 commits; some days with 0.
  - Determinism: same seed ⇒ identical schedule (byte comparison).
- **Repo correctness** (integration): `git fsck --strict` passes; commit count,
  all author dates, branch tip, and file contents exactly match the schedule.
- **UI** (browser drive, manual or scripted): chart equals
  `git log --pretty=%ad` counts per day on the generated repo.

## 10. Open questions for the owner

1. `authorEmail` default: hard default `gitfuscation@localhost` vs prompt-on-start
   for first-time users (the biggest cause of invisible graphs).
2. Should `totalCommits` default on so the chart has a predictable total, or stay
   `null` (mean-driven) for realism-first?
3. Remote push: include `git push --force` helper at launch, or leave as a
   documented manual step?
