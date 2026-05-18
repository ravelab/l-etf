#!/bin/bash
set -e

echo "=== Pre-push: Fetching data and generating snapshots ==="

# 1. Fetch data (fetches latest prices/rates and saves to local CSV)
echo "Running fetch-data..."
npm run fetch-data

# 2. Generate snapshots (uses the fetched data)
echo "Generating snapshots..."
npm run snapshots:generate

# 3. Check for changes in data or snapshots
CHANGES=$(git status --porcelain src/lib/data/seed/ src/lib/tool-snapshots/)

if [ -n "$CHANGES" ]; then
  echo "=== Data or snapshots have changed! ==="
  echo "$CHANGES"
  echo ""
  echo "Adding changes to current commit..."
  git add src/lib/data/seed/ src/lib/tool-snapshots/

  echo "Changes staged. Please commit them and push again."
  exit 1
fi

# 4. Run snapshot loading tests
echo ""
echo "=== Running snapshot loading tests ==="
./scripts/test-snapshots.sh

echo "=== Pre-push check passed ==="
exit 0
