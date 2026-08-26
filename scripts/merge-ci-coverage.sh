#!/bin/sh
# After preview UI finishes, wait for the push Test workflow on the same SHA,
# download unit + browser coverage artifacts, and merge into one report.
set -eu

root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$root"

SHA="${DEPLOY_SHA:-${GITHUB_SHA:-}}"
if [ -z "$SHA" ]; then
  echo "✗ DEPLOY_SHA (or GITHUB_SHA) is required" >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "✗ gh is required to download coverage artifacts from the Test workflow" >&2
  exit 1
fi

echo "→ Waiting for Test workflow on ${SHA}…"
run_id=""
status=""
conclusion=""
i=0
while [ "$i" -lt 90 ]; do
  i=$((i + 1))
  row="$(gh run list --workflow=test.yml --commit="$SHA" --limit 5 \
    --json databaseId,status,conclusion,createdAt \
    --jq 'sort_by(.createdAt) | reverse | .[0] // empty' 2>/dev/null || true)"
  if [ -n "$row" ] && [ "$row" != "null" ]; then
    run_id="$(printf '%s' "$row" | jq -r '.databaseId')"
    status="$(printf '%s' "$row" | jq -r '.status')"
    conclusion="$(printf '%s' "$row" | jq -r '.conclusion // empty')"
    if [ "$status" = "completed" ]; then
      break
    fi
    echo "  …Test run $run_id is $status (${i}0s)"
  else
    echo "  …no Test run for $SHA yet (${i}0s)"
  fi
  sleep 10
done

if [ -z "$run_id" ] || [ "${status:-}" != "completed" ]; then
  echo "✗ Timed out waiting for Test workflow on $SHA" >&2
  exit 1
fi
if [ "$conclusion" != "success" ]; then
  echo "✗ Test workflow $run_id concluded $conclusion — not merging partial coverage" >&2
  exit 1
fi

echo "→ Downloading unit coverage from Test run $run_id…"
rm -rf coverage/unit-v8 coverage/unit-art coverage/browser-art
mkdir -p coverage/unit-v8 coverage/browser-v8

gh run download "$run_id" -n coverage-unit -D coverage/unit-art || {
  echo "✗ missing coverage-unit artifact" >&2
  exit 1
}
find coverage/unit-art -type f -name '*.json' -exec cp {} coverage/unit-v8/ \;
unit_count="$(find coverage/unit-v8 -type f -name '*.json' | wc -l | tr -d ' ')"
if [ "$unit_count" = "0" ]; then
  echo "✗ no unit V8 coverage files after download" >&2
  find coverage/unit-art -type f | head -40 >&2
  exit 1
fi

# Browser coverage was downloaded by the workflow into coverage/browser-v8.
if [ ! -f coverage/browser-v8/client-coverage.json ]; then
  echo "✗ browser client-coverage.json missing" >&2
  find coverage/browser-v8 -type f 2>/dev/null | head -40 >&2
  exit 1
fi

echo "→ Merging unit + browser UI…"
node scripts/coverage-combined.mjs --no-run

if [ -f coverage/combined/coverage-summary.json ]; then
  node -e "const c=require('./coverage/combined/coverage-summary.json').total; const line='✓ combined coverage · '+c.statements.pct+'% statements · '+c.branches.pct+'% branches · '+c.functions.pct+'% functions · '+c.lines.pct+'% lines'; console.log(line); if (process.env.GITHUB_STEP_SUMMARY) require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY, line+'\n');"
fi
