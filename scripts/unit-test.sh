#!/bin/sh
# Unit suite = node:test (logic) + Vitest/jsdom (components), then one overall
# coverage line over all of src/** (unloaded files count as 0%).
#
# Quiet on success; full output on failure. NODE_V8_COVERAGE dumps (default
# coverage/unit-v8) and Vitest's coverage/unit-jsdom/ also feed the combined
# unit+browser merge.
set -eu

root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$root"

mkdir -p coverage
UNIT_V8="${NODE_V8_COVERAGE:-$root/coverage/unit-v8}"
rm -rf "$UNIT_V8" "$root/coverage/unit-jsdom"
mkdir -p "$UNIT_V8"
export NODE_V8_COVERAGE="$UNIT_V8"

output_file="$(mktemp)"
trap 'rm -f "$output_file"' EXIT

# Prefer grep: GitHub-hosted runners do not ship ripgrep.
match() {
  grep -E "$@" || true
}

run_node_unit() {
  # No --test-coverage-* thresholds: Node only measures loaded files.
  # Overall floor / honesty comes from unit-coverage-report.mjs after jsdom merges in.
  node --import tsx --experimental-test-coverage \
    --test-coverage-include='src/**' \
    --test-coverage-exclude='src/**/*.d.ts' \
    --test unit-tests/**/*.test.ts
}

run_jsdom_unit() {
  npx vitest run --coverage --reporter=dot
}

if run_node_unit >"$output_file" 2>&1; then
  pass="$(match '^# pass ' "$output_file" | tail -1 | awk '{print $3}')"
  fail="$(match '^# fail ' "$output_file" | tail -1 | awk '{print $3}')"
  tests="$(match '^# tests ' "$output_file" | tail -1 | awk '{print $3}')"
  if [ -n "${pass:-}" ] && [ -n "${tests:-}" ]; then
    printf '✓ unit tests (node) · %s passed' "$pass"
    if [ "${fail:-0}" != "0" ]; then
      printf ' · %s failed' "$fail"
    fi
    printf ' · %s total\n' "$tests"
  else
    printf '✓ unit tests (node) · passed\n'
  fi
else
  printf '✗ unit tests (node) failed\n\n' >&2
  cat "$output_file" >&2
  exit 1
fi

if run_jsdom_unit >"$output_file" 2>&1; then
  # Vitest prints "Tests  N passed" (or similar) — keep it short.
  vitest_line="$(match 'Test Files|Tests ' "$output_file" | tail -1 | sed 's/^ *//')"
  if [ -n "${vitest_line:-}" ]; then
    printf '✓ unit tests (jsdom) · %s\n' "$vitest_line"
  else
    printf '✓ unit tests (jsdom) · passed\n'
  fi
else
  printf '✗ unit tests (jsdom) failed\n\n' >&2
  cat "$output_file" >&2
  exit 1
fi

node scripts/unit-coverage-report.mjs
