# gitfuscation

**Two things:** protect your real activity with synthetic noise history, and paint artwork onto your contribution graph.

## Features

- **Activity generator** — a fresh repo with a year of human-looking commit history: streaks, gaps, weekend/Friday-night boosts, rare 100+ commit marathons. Preview the GitHub-style chart, tune live, generate.
- **Signwriter** — click/drag shades onto the chart (or import an image → greyscale pixels) and the repo contains exactly your design. Two per-button brushes, grouped sessions, full-strength slider (5–5000). The banner is real: paint it, refresh, generate.
- **Pattern README** — every generated repo ships with an ASCII chart of the pattern, the exact settings, and the program version.
- **Claim script** — every generated repo ships `claim.sh`: a cloner runs it, enters their name + email, and the entire history re-authors to their account. Dates, messages, files, and the pattern README are untouched, so the art survives.
- **Attribution repair** (`reauth`) — fix wrong commit authors (e.g. machine-local commits) on repos you own. Identity-only: every date, message, and file preserved.

## Quick start

```bash
npm install
node src/main.ts serve        # → http://127.0.0.1:8315
```

Tune on the left → the chart re-renders live → **Generate repo**. Then push:

```bash
cd generated/activity-history
gh repo create my-banner --public --source . --push
```

Anyone can re-claim a generated repo for their own account:

```bash
cd my-banner
./claim.sh "Your Name" you@example.com   # or run it bare to be prompted
git remote set-url origin git@github.com:you/my-banner.git
git push --force --all origin
```

Your settings and painted design survive refreshes (localStorage); Export/Import moves them as JSON.

**CLI:** `preview | generate | repos | authors | reauth | readme` (try `node src/main.ts <cmd> --help`).

## Settings (essentials — full schema in [SPEC.md](SPEC.md) §3)

| Setting | Default | What it does |
|---|---|---|
| `timeline.durationDays` | 365 | Window length |
| `activity.generateRandom` | true | Off = blank canvas (painted days only) |
| `activity.seed` | 20261024 | Same seed ⇒ same history |
| `activity.meanCommitsPerDay` | 5 | Baseline for active days |
| `activity.burstProbability` / `burstMinCommits` | 0.04 / 40 | Marathon days |
| `activity.weekendBoost` / `weekendCommitBoost` | 1.5 / 1.4 | Fri/Sat/Sun lift (never guaranteed) |
| `activity.streakPersistence` / `meanGapDays` | 0.88 / 2 | Streaks and breaks |
| `signwriter.fullStrength` | 60 | Commits painted at level 4 (levels 1–3 scale by quarter) |
| `signwriter.grouped` / `groupMeanMinutes` | false / 30 | Pack a painted day into a short session |
| `output.replace` | false | Overwrite an existing out path |

## Warnings

- **Author email must be a verified GitHub email** or the graph stays empty. The tool auto-detects your `git config` identity and warns loudly on fallback.
- Commits count only on the **default branch** (`main`) — generation writes there.
- Private repos hide contributions unless *private contributions* is enabled.
- The graph refreshes within **~24 h** of a push.
- GitHub re-colors cells with its *relative* scale — the painted shape survives, exact shades may differ.

### Attribution repair (the small print)

```bash
node src/main.ts reauth path/to/repo --dry-run   # plan first
node src/main.ts reauth path/to/repo             # apply identity-map.json
```

`identity-map.json` maps old → new identities (`email`/`name`/`full` match modes + an optional catch-all `fallback`). Rewrites back up every ref under `refs/backup/*`, refuse dirty worktrees, and change SHAs — force-push if the repo has a remote.

**Tests:** `npm test` · `npm run typecheck`. Every change bumps the version. Full design: [SPEC.md](SPEC.md).
