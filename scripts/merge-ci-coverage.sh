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
rm -rf coverage/unit-v8 coverage/unit-jsdom coverage/unit-art coverage/browser-art
mkdir -p coverage/unit-v8 coverage/unit-jsdom coverage/browser-v8

gh run download "$run_id" -n coverage-unit -D coverage/unit-art || {
  echo "✗ missing coverage-unit artifact" >&2
  exit 1
}

# Artifact layout: unit-v8/ (NODE_V8 dumps) + unit-jsdom/ (Vitest Istanbul JSON).
if [ -d coverage/unit-art/unit-v8 ]; then
  find coverage/unit-art/unit-v8 -type f -name '*.json' -exec cp {} coverage/unit-v8/ \;
elif [ -d coverage/unit-art/coverage/unit-v8 ]; then
  find coverage/unit-art/coverage/unit-v8 -type f -name '*.json' -exec cp {} coverage/unit-v8/ \;
else
  # Flat fallback: V8 dumps are coverage-<pid>-*.json; never treat Istanbul finals as V8.
  find coverage/unit-art -type f -name 'coverage-*.json' \
    ! -name 'coverage-final.json' \
    ! -name 'coverage-summary.json' \
    -exec cp {} coverage/unit-v8/ \;
fi

if [ -f coverage/unit-art/unit-jsdom/coverage-final.json ]; then
  cp coverage/unit-art/unit-jsdom/coverage-final.json coverage/unit-jsdom/
elif [ -f coverage/unit-art/coverage/unit-jsdom/coverage-final.json ]; then
  cp coverage/unit-art/coverage/unit-jsdom/coverage-final.json coverage/unit-jsdom/
else
  find coverage/unit-art -type f -name 'coverage-final.json' -exec cp {} coverage/unit-jsdom/ \; || true
fi

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

echo "→ Merging unit + browser E2E…"
if [ "${E2E_JOB_RESULT:-}" = "failure" ]; then
  note="(e2e had failures — browser coverage is whatever finished before exit)"
  echo "→ $note"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$note" >> "$GITHUB_STEP_SUMMARY"
  fi
fi
node scripts/coverage-combined.mjs --no-run

if [ -f coverage/combined/coverage-summary.json ]; then
  node -e "const c=require('./coverage/combined/coverage-summary.json').total; const line='✓ combined coverage · '+c.statements.pct+'% statements · '+c.branches.pct+'% branches · '+c.functions.pct+'% functions · '+c.lines.pct+'% lines'; console.log(line); if (process.env.GITHUB_STEP_SUMMARY) require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY, line+'\n');"
fi
