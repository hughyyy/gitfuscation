# gitfuscation

Tooling for generating synthetic activity history — and painting custom banners via the contributions counter. See [SPEC.md](SPEC.md) for the full design.

## Day 1: activity generator

Creates a brand-new repo containing a year of history whose per-day commit
pattern looks human: long active streaks, occasional gaps, weekend and
Friday-night boosts (never guaranteed), and rare marathon days with 100+
commits. A web UI previews the GitHub-style contribution chart from your
settings **before** the repo exists, so you can tune until the chart looks
right, then generate.

### Quick start

```bash
npm install          # dev deps only (typescript, @types/node); zero runtime deps
node src/main.ts serve
# open http://127.0.0.1:8315
```

Tweak the settings on the left — the chart re-renders live. When it looks
right, click **Generate repo**.

### CLI

```bash
# default-settings preview (a full year ending today)
node src/main.ts preview

# from a config file
node src/main.ts preview --config config.example.json
node src/main.ts generate --config config.example.json
```

### Before you push (read this)

GitHub's contribution graph has hard rules — miss one and the graph silently
stays empty:

1. The commit **author email must be a verified email linked to your GitHub
   account**. The tool defaults to your `git config` author identity and warns
   loudly when it falls back to a placeholder.
2. Commits are counted only on the **default branch** (`main`). The generator
   writes everything there.
3. The graph refreshes within ~24 hours of a push.
4. Private-repo contributions are hidden unless "private contributions" is
   enabled in your account settings.

```bash
cd generated/activity-history
git remote add origin git@github.com:you/activity-history.git
git push -u origin main
```

### Tests

```bash
npm test          # 33 tests: schedule statistics, settings validation,
                  # materialization + fsck, preview parity, determinism
npm run typecheck # tsc --noEmit
```

### Settings

The full settings schema (with defaults) lives in SPEC §3. Highlights:

| Setting | Default | What it does |
|---|---|---|
| `timeline.durationDays` | 365 | Window length |
| `activity.seed` | 20261021 | Deterministic output — same seed ⇒ same history |
| `activity.totalCommits` | null | Optional exact total; otherwise realism-first |
| `activity.meanCommitsPerDay` | 5 | Baseline for active days |
| `activity.burstProbability` / `burstMinCommits` | 0.04 / 40 | Marathon days (100+ commits) |
| `activity.weekendBoost` / `weekendCommitBoost` | 1.5 / 1.4 | Fri/Sat/Sun lift (never guaranteed) |
| `activity.streakPersistence` / `meanGapDays` | 0.88 / 2 | Streaks and breaks |
| `output.replace` | false | Allow overwriting an existing out path |
| `preview.colorScale` | github | `github` (relative) or `absolute` thresholds |

## Repositories: inspect authorship + reattribution

Inspect any repo under a root directory (default: the parent of this project —
e.g. `Source/`), see its author breakdown and timeline, and reattribute commits
to the right GitHub identity. Useful for correcting machine-local agentic
coding that committed under a box identity (e.g. `bernie <bernie@localhost>`):

```
node src/main.ts serve            # → open http://127.0.0.1:8315 → Repositories
node src/main.ts authors /path/to/repo          # CLI summary
node src/main.ts reauth /path/to/repo --dry-run  # plan only
node src/main.ts reauth /path/to/repo            # apply the identity map
```

Identity mapping lives in `identity-map.json` (gitignored, personal config):

```json
{
  "rows": [
    { "from": { "match": "bernie@localhost", "mode": "email" },
      "to":   { "name": "Your Name", "email": "you@users.noreply.github.com" } }
  ],
  "fallback": { "name": "Your Name", "email": "you@users.noreply.github.com" }
}
```

Match modes: `email`, `name`, or `full` (`Name <email>`). First match wins;
`fallback` catches every author not matched (useful when the whole box was one
person under several emails).

**How it works and how to stay safe:** commits are rebuilt object-by-object —
same tree, same author/committer **dates**, same messages — only the identity
lines change, and parent links are remapped so topology (merges, branches) is
preserved. Annotated tags are retargeted. Before touching anything the tool
refuses dirty worktrees, creates `refs/backup/*` pointing at the original tips
(restore with `git update-ref refs/heads/main refs/backup/heads/main`), expires
reflogs, and runs `git fsck`. SHAs change — force-push if the repo has a
remote:

```
git push --force --all origin
git push --force --tags origin   # if tags moved
```

Note: only local `refs/heads` + `refs/tags` are rewritten; remote-tracking refs
(`refs/remotes/*`) keep the old history until you fetch after the force-push.
