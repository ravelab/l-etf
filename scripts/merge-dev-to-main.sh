#!/bin/sh
# Fast-forward origin/dev into main and push it — Vercel's production branch is main, so this alone
# triggers the production deploy, then waits for the post-deploy Actions smoke to confirm
# production is actually healthy, not just built.
#   npm run promote
#   npm run promote:now      # same promotion, without waiting for the post-deploy suite
#
# --no-verify drops only the waiting. Everything that makes the promotion *right* still happens:
# local dev may not be ahead of origin/dev, and main is fast-forwarded or refused. What you give
# up is knowing production is healthy — so check the run yourself afterwards; the command is
# printed at the end.
#
# Nothing here touches your working tree, so this runs while you — or an agent — are mid-edit.
set -eu

root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$root"

if [ "${LETF_SKIP_VERIFY:-0}" = "1" ]; then verify=skip; else verify=wait; fi
for argument in "$@"; do
  case "$argument" in
    --no-verify|--skip-verify) verify=skip ;;
    *) echo "✗ Unknown option: $argument (expected --no-verify)" >&2; exit 2 ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo '✗ The GitHub CLI (gh) is required. Install it, then run: gh auth login' >&2
  exit 1
fi

echo '→ Fetching origin…'
git fetch origin dev main

# Promoting is about what has been pushed and tested, never about what is on this disk. The one
# thing worth checking is that local dev is not ahead — otherwise you promote a commit believing it
# contains work that only ever existed here.
if git rev-parse --verify --quiet dev >/dev/null; then
  if [ "$(git rev-parse dev)" != "$(git rev-parse origin/dev)" ]; then
    if git merge-base --is-ancestor dev origin/dev; then
      echo "  local dev is behind origin/dev — promoting origin/dev, which is the tested one."
    else
      echo '✗ Local dev has commits origin/dev does not. Push them first (npm run push:dev).' >&2
      exit 1
    fi
  fi
fi

promoted_sha="$(git rev-parse origin/dev)"
echo "→ Promoting origin/dev at $(git rev-parse --short "$promoted_sha")."

# Read before main moves, so the wait at the end can insist on the production deployment this
# promotion causes rather than one left over from an earlier promotion of the same commit.
latest_production_deployment="$(gh api "repos/$(gh repo view --json nameWithOwner --jq '.nameWithOwner')/deployments?environment=Production&per_page=1" --jq '.[0].id // 0' 2>/dev/null || echo 0)"

# A ref-to-ref push. Git refuses a non-fast-forward update unless forced, so this keeps exactly the
# guarantee of `git merge --ff-only`, without checking out main or moving this tree.
if [ "$(git rev-parse origin/main)" = "$promoted_sha" ]; then
  echo '  main already points there; nothing to push.'
  latest_production_deployment=0
else
  echo '→ Fast-forwarding main…'
  if ! git push origin "$promoted_sha:refs/heads/main"; then
    echo '✗ main could not be fast-forwarded to dev. Someone has committed to main directly.' >&2
    exit 1
  fi
fi

# Best effort: bring the local main ref along so `git log main` reads true.
git fetch origin main:main >/dev/null 2>&1 || true

echo
if [ "$verify" = "skip" ]; then
  echo '✓ Promoted dev to main — production is deploying. Not verified: --no-verify skipped the wait.'
  echo "  Check it yourself: DEPLOY_TEST_ENVIRONMENT=Production ./scripts/wait-deploy-tests.sh $promoted_sha"
  exit 0
fi

DEPLOY_TEST_ENVIRONMENT=Production DEPLOY_TEST_AFTER_DEPLOYMENT="$latest_production_deployment" \
  "$root/scripts/wait-deploy-tests.sh" "$promoted_sha"

echo
echo '✓ Promoted dev to main — production is live and verified.'
