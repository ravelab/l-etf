#!/bin/sh
# Wait for the GitHub Actions "Test the deployment" run that Vercel triggers after a push.
#
#   scripts/wait-deploy-tests.sh [sha]
#   DEPLOY_TEST_TIMEOUT=900 scripts/wait-deploy-tests.sh
#   DEPLOY_TEST_ENVIRONMENT=Production scripts/wait-deploy-tests.sh <sha>
#   DEPLOY_TEST_AFTER_DEPLOYMENT=6099732107 DEPLOY_TEST_ENVIRONMENT=Production …
#
# A promoted commit is deployed twice — once as dev's preview, once as production — and the two
# Actions runs are identical in everything `gh run list` can see: same workflow, same commit, same
# `deployment_status` event. Waiting on "the run for this commit" therefore matched the preview run
# that had already passed, and reported production verified before production had been built, let
# alone tested.
#
# So when DEPLOY_TEST_ENVIRONMENT is set, the deployment comes first and the run is found through
# it: wait for a deployment of that environment at this commit, then take the first run created at
# or after it. DEPLOY_TEST_AFTER_DEPLOYMENT additionally requires that deployment to be newer than
# a given deployment id, which is how a promotion insists on the deployment it just triggered
# rather than one left over from an earlier promotion of the same commit.
set -eu

root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$root"

if ! command -v gh >/dev/null 2>&1; then
  echo '✗ GitHub CLI (gh) is required to watch post-deploy tests' >&2
  echo '  https://cli.github.com/' >&2
  exit 1
fi

sha="${1:-$(git rev-parse HEAD)}"
workflow='Test the deployment'
timeout_seconds="${DEPLOY_TEST_TIMEOUT:-1200}"
poll_seconds=15
started_at="$(date +%s)"
short="$(printf '%s' "$sha" | cut -c1-7)"
environment="${DEPLOY_TEST_ENVIRONMENT:-}"
after_deployment="${DEPLOY_TEST_AFTER_DEPLOYMENT:-0}"
case "$after_deployment" in
  ''|*[!0-9]*) echo "✗ DEPLOY_TEST_AFTER_DEPLOYMENT must be a deployment id (got: $after_deployment)" >&2; exit 2 ;;
esac

if [ -n "$environment" ]; then
  echo "→ Waiting for the ${environment} deployment of ${short}…"
else
  echo "→ Waiting for post-deploy tests on ${short}…"
fi

since=''
repository=''
if [ -n "$environment" ]; then
  repository="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
  while :; do
    now="$(date +%s)"
    elapsed="$((now - started_at))"
    if [ "$elapsed" -ge "$timeout_seconds" ]; then
      echo "✗ Timed out after ${timeout_seconds}s waiting for a ${environment} deployment of ${short}" >&2
      [ "$after_deployment" != '0' ] && echo "  (one newer than deployment ${after_deployment})" >&2
      exit 1
    fi

    deployment="$(gh api "repos/${repository}/deployments?sha=${sha}&environment=${environment}&per_page=50" \
      --jq "[.[] | select(.id > ${after_deployment})]
            | sort_by(.id) | last | \"\(.id) \(.created_at)\"" 2>/dev/null || true)"
    if [ -z "$deployment" ] || [ "$deployment" = "null null" ]; then
      printf '  …no %s deployment yet (%ss)\n' "$environment" "$elapsed"
      sleep "$poll_seconds"
      continue
    fi

    deployment_id="${deployment%% *}"
    deployment_at="${deployment##* }"
    state="$(gh api "repos/${repository}/deployments/${deployment_id}/statuses?per_page=50" \
      --jq 'sort_by(.created_at) | last | .state // empty' 2>/dev/null || true)"
    case "$state" in
      success)
        echo "  ${environment} deployment ${deployment_id} is live (${deployment_at})"
        since="$deployment_at"
        break
        ;;
      failure|error)
        echo "✗ The ${environment} deployment ${deployment_id} ended in ${state}; there is nothing to test" >&2
        exit 1
        ;;
      *)
        printf '  …%s deployment %s (%ss)\n' "$environment" "${state:-pending}" "$elapsed"
        sleep "$poll_seconds"
        ;;
    esac
  done
  echo "→ Waiting for post-deploy tests on ${short}…"
fi

run_id=''
while :; do
  now="$(date +%s)"
  elapsed="$((now - started_at))"
  if [ "$elapsed" -ge "$timeout_seconds" ]; then
    echo "✗ Timed out after ${timeout_seconds}s waiting for \"${workflow}\" on ${short}" >&2
    if [ -n "$run_id" ]; then
      gh run view "$run_id" --json url --jq '.url' 2>/dev/null >&2 || true
    fi
    exit 1
  fi

  if [ -n "$since" ]; then
    id="$(gh run list --workflow "$workflow" --commit "$sha" --limit 30 --json databaseId,createdAt \
      --jq "[.[] | select(.createdAt >= \"${since}\")] | sort_by(.createdAt) | first | .databaseId // empty" 2>/dev/null || true)"
  else
    id="$(gh run list --workflow "$workflow" --commit "$sha" --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)"
  fi
  if [ -z "$id" ]; then
    printf '  …no Actions run yet (%ss)\n' "$elapsed"
    sleep "$poll_seconds"
    continue
  fi

  if [ "$run_id" != "$id" ]; then
    run_id="$id"
    url="$(gh run view "$run_id" --json url --jq '.url')"
    echo "  Found run ${run_id} — ${url}"
  fi

  status="$(gh run view "$run_id" --json status,conclusion --jq '.status')"
  conclusion="$(gh run view "$run_id" --json status,conclusion --jq '.conclusion // empty')"

  case "$status" in
    completed)
      case "$conclusion" in
        success)
          echo '✓ Post-deploy tests passed'
          exit 0
          ;;
        *)
          url="$(gh run view "$run_id" --json url --jq '.url')"
          echo "✗ Post-deploy tests ${conclusion}" >&2
          echo "  ${url}" >&2
          gh run view "$run_id" --json jobs --jq '
            .jobs[]
            | select(.conclusion != "success" and .conclusion != "skipped" and .conclusion != null)
            | "  · \(.name): \(.conclusion)"
          ' 2>/dev/null >&2 || true
          exit 1
          ;;
      esac
      ;;
    *)
      printf '  …%s (%ss)\n' "$status" "$elapsed"
      sleep "$poll_seconds"
      ;;
  esac
done
