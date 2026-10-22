// claim.ts — the self-service re-attribution script shipped in every generated
// repo (SPEC §4.2). Standalone POSIX shell: it needs only git, so a cloner can
// run it without the generator or Node.

export const CLAIM_SCRIPT_PATH = 'claim.sh';

/**
 * Rewrites author and committer identity (name + email) on every commit of
 * every local branch and tag. Dates, messages, trees, and the README pattern
 * are untouched, so the generated art survives intact.
 */
export const CLAIM_SCRIPT = `#!/bin/sh
# claim.sh — re-author this generated history to your own git identity.
#
# Run this inside a clone, before pushing to your own remote. Every commit on
# every local branch and tag keeps its date, message, and files; only the
# author and committer name/email change. The contribution pattern in README.md
# is preserved exactly, so the artwork stays the same.
#
# Usage:
#   ./claim.sh                                  # prompts for both values
#   ./claim.sh "Ada Lovelace" ada@example.com   # non-interactive
#
set -eu

die() {
  printf 'claim: %s\\n' "$*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || die "git is required"

cd "$(git rev-parse --show-toplevel)" 2>/dev/null || die "not inside a git repository"
git rev-parse --verify --quiet HEAD >/dev/null || die "repository has no commits"

if [ -n "$(git status --porcelain)" ]; then
  die "working tree has uncommitted changes; commit or stash them first"
fi

name="\${1-}"
email="\${2-}"

if [ -z "$name" ]; then
  current_name="$(git config user.name || true)"
  printf 'Name'
  [ -z "$current_name" ] || printf ' [%s]' "$current_name"
  printf ': '
  IFS= read -r name || true
  [ -n "$name" ] || name="$current_name"
fi

if [ -z "$email" ]; then
  current_email="$(git config user.email || true)"
  printf 'Email'
  [ -z "$current_email" ] || printf ' [%s]' "$current_email"
  printf ': '
  IFS= read -r email || true
  [ -n "$email" ] || email="$current_email"
fi

[ -n "$name" ] || die "a name is required"
case "$name" in
  *[[:cntrl:]]*|*'<'*|*'>'*) die "name must not contain control characters, '<' or '>'" ;;
esac
case "$email" in
  ?*@?*) ;;
  *) die "an email is required (got '$email')" ;;
esac
case "$email" in
  *[[:cntrl:]]*|*' '*|*'<'*|*'>'*) die "email must not contain spaces, control characters, '<' or '>'" ;;
esac

# Values travel through the environment so the filter script stays a constant:
# no quoting of user input into shell code.
GITFUSC_NAME="$name"
GITFUSC_EMAIL="$email"
export GITFUSC_NAME GITFUSC_EMAIL

# Only the four identity variables are overridden; GIT_AUTHOR_DATE and
# GIT_COMMITTER_DATE come from the original commits, so dates are preserved.
FILTER_BRANCH_SQUELCH_WARNING=1 \\
git filter-branch --force --env-filter '
export GIT_AUTHOR_NAME="$GITFUSC_NAME"
export GIT_AUTHOR_EMAIL="$GITFUSC_EMAIL"
export GIT_COMMITTER_NAME="$GITFUSC_NAME"
export GIT_COMMITTER_EMAIL="$GITFUSC_EMAIL"
' --tag-name-filter cat -- --branches --tags

# Drop filter-branch's backup refs and the now-unreachable originals, so the
# clone contains only the rewritten history.
git for-each-ref --format='delete %(refname)' refs/original | git update-ref --stdin
git reflog expire --expire=now --all
git gc --prune=now --quiet

git config user.name "$name"
git config user.email "$email"

printf '\\nRewrote %s commit(s) to %s <%s>.\\n' "$(git rev-list --count HEAD)" "$name" "$email"
cat <<'DONE'

README.md still records the identity the history was generated with; the
commit graph now belongs to you. To publish under your account:

  git remote set-url origin git@github.com:<you>/<repo>.git
  git push --force --all origin
  git push --force --tags origin
DONE
`;
