#!/bin/bash
set -o pipefail

# Pre-push: snapshot + UI regression tests. Both runners build a Next.js
# production bundle and start their own ephemeral server, so no dev server
# is required here. Set SNAPSHOT_TEST_SKIP_BUILD=1 / E2E_TEST_SKIP_BUILD=1
# (or both) to reuse an existing .next directory across runs.

echo "Running snapshot loading tests..."
if npm run snapshots:test 2>&1 | tee /tmp/snapshot-test.log; then
  echo ""
  echo "✅ Snapshot tests passed"
else
  echo ""
  echo "❌ Snapshot tests failed"
  exit 1
fi

# Reuse the build for UI tests since snapshots:test just produced one.
echo "Running UI regression tests..."
if E2E_TEST_SKIP_BUILD=1 npm run test:e2e 2>&1 | tee /tmp/e2e-test.log; then
  echo ""
  echo "✅ UI tests passed"
else
  echo ""
  echo "❌ UI tests failed"
  exit 1
fi

exit 0
