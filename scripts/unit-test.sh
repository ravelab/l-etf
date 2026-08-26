#!/bin/sh
# Unit suite with a coverage line at the end.
#
# Quiet on success (one pass line + coverage); full TAP on failure. The coverage
# floor (≥80% lines/functions, ≥70% branches) is enforced here so `test:unit`
# and `test:coverage` are the same command — UI/browser suites are not counted.
set -eu

root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$root"

mkdir -p coverage
output_file="$(mktemp)"
trap 'rm -f "$output_file"' EXIT

if node --import tsx --experimental-test-coverage \
  --test-coverage-include='src/**' \
  --test-coverage-exclude='src/**/*.d.ts' \
  --test-coverage-lines=80 \
  --test-coverage-functions=80 \
  --test-coverage-branches=70 \
  --test unit-tests/**/*.test.ts >"$output_file" 2>&1
then
  pass="$(rg -n '^# pass ' "$output_file" | tail -1 | awk '{print $3}')"
  fail="$(rg -n '^# fail ' "$output_file" | tail -1 | awk '{print $3}')"
  tests="$(rg -n '^# tests ' "$output_file" | tail -1 | awk '{print $3}')"
  if [ -n "${pass:-}" ] && [ -n "${tests:-}" ]; then
    printf '✓ unit tests · %s passed' "$pass"
    if [ "${fail:-0}" != "0" ]; then
      printf ' · %s failed' "$fail"
    fi
    printf ' · %s total\n' "$tests"
  else
    printf '✓ unit tests · passed\n'
  fi

  summary="$(rg -n 'all files' "$output_file" | tail -1 | sed 's/^[^|]*|//' | tr -s ' ')"
  # summary looks like:  89.01 |    81.92 |   88.94 |
  lines="$(printf '%s' "$summary" | awk -F'|' '{gsub(/ /,"",$1); print $1}')"
  branches="$(printf '%s' "$summary" | awk -F'|' '{gsub(/ /,"",$2); print $2}')"
  functions="$(printf '%s' "$summary" | awk -F'|' '{gsub(/ /,"",$3); print $3}')"
  printf '✓ unit coverage · %s%% lines · %s%% branches · %s%% functions\n' \
    "${lines:-?}" "${branches:-?}" "${functions:-?}"
else
  printf '✗ unit tests failed (need ≥80%% lines/functions, ≥70%% branches)\n\n' >&2
  # Prefer the coverage table + failure reason over the full TAP dump when the
  # gate alone failed; otherwise dump the tail of TAP.
  if rg -q 'Coverage for|not met|below' "$output_file"; then
    rg -n 'Error:|all files|Coverage for|not met|below' "$output_file" >&2 || true
    tail -40 "$output_file" >&2
  else
    cat "$output_file" >&2
  fi
  exit 1
fi
