#!/bin/sh
# Commit everything on dev, push dev, then promote dev to main (production).
#   npm run ship -- "your commit message"
set -eu

root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$root"

msg="${1:-}"
if [ -z "$msg" ]; then
  echo '✗ Provide a commit message: npm run ship -- "your commit message"' >&2
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "dev" ]; then
  echo "✗ Run this from the dev branch. Current branch: ${branch:-unknown}" >&2
  exit 1
fi

# Whatever becomes of this ship, it ends by saying what is covered. A number is worth as much
# when a deploy fails as when it lands — more, since a failed ship is when somebody is deciding
# what to do next — and leaving it inside an Actions log is no way to hand it to anybody.
report_coverage() {
  node "$root/scripts/print-coverage.mjs" --sha "$(git rev-parse HEAD 2>/dev/null || echo HEAD)" 2>/dev/null || true
}
trap report_coverage EXIT

echo '→ Running pre-ship checks…'
npm run --silent check
echo

git add -A
if git diff --cached --quiet; then
  echo '→ Nothing to commit; pushing and promoting the current dev tip.'
else
  if git diff --cached --name-only | grep -qE '(^|/)\.env(\.|$)|credentials|secrets'; then
    echo '✗ Refusing to commit — staged files look like secrets (.env, credentials, secrets)' >&2
    git reset HEAD >/dev/null 2>&1 || true
    exit 1
  fi
  git commit -m "$msg"
fi

git push origin dev

# Block until the post-deploy Actions suite is green for this tip. Without this, a failed
# check is easy to miss while promote has already fast-forwarded main.
LETF_SKIP_PUSH=1 "$root/scripts/push-dev.sh"

"$root/scripts/merge-dev-to-main.sh"
