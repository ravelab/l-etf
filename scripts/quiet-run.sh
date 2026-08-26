#!/bin/sh
set -eu

label="$1"
shift
output_file="$(mktemp)"
trap 'rm -f "$output_file"' EXIT

if "$@" >"$output_file" 2>&1; then
  printf '✓ %s\n' "$label"
else
  printf '✗ %s failed\n\n' "$label" >&2
  cat "$output_file" >&2
  exit 1
fi
