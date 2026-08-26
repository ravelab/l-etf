#!/bin/sh
# Push the current tip to origin/dev, then wait for the post-deploy Actions suite
# ("Test the deployment") that Vercel triggers for the resulting preview.
#
#   npm run push:dev
#   LETF_SKIP_PUSH=1 npm run push:dev   # re-wait on the tip already pushed
#
# Requires an authenticated `gh` CLI (`gh auth login`).
set -eu

root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$root"

if ! command -v gh >/dev/null 2>&1; then
  echo '✗ The GitHub CLI (gh) is required. Install it, then run: gh auth login' >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo '✗ gh is not authenticated. Run: gh auth login' >&2
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "dev" ]; then
  echo "✗ Run this from the dev branch. Current branch: ${branch:-unknown}" >&2
  exit 1
fi

if [ "${LETF_SKIP_PUSH:-0}" != "1" ]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo '✗ Working tree is not clean. Commit or stash first, then re-run.' >&2
    exit 1
  fi
  echo "→ Pushing $(git rev-parse --short HEAD) to origin/dev…"
  git push origin HEAD:dev
else
  echo 'LETF_SKIP_PUSH=1 — not pushing; waiting on CI for the local tip.'
fi

# Named rather than left to "whatever ran for this commit": once a commit has also been promoted
# it has a production run too, and re-waiting on an already-pushed tip would otherwise watch that
# one — which runs only the smoke subset and so proves much less than it appears to.
DEPLOY_TEST_ENVIRONMENT=Preview "$root/scripts/wait-deploy-tests.sh"
