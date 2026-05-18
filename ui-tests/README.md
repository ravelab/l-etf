# UI regression tests (Puppeteer)

These specs assert regressions for TR benchmark labels, per-section titles (distinct combo section start dates, or distinct Avg Inflation lines when history-wrap applies), and a frozen run summary until the user runs again.

`config.mjs` waits until loading indicators clear **and** sweep tables have rows (or an empty-state message) in a **single** predicate so brief gaps between load phases cannot flake the harness.

**Requirements:** a running Next dev server on the same host/port as the snapshot tests (default `http://127.0.0.1:3000`). The repo script `./scripts/test-snapshots.sh` starts the dev server if needed, runs `npm run snapshots:test`, then `npm run ui-tests`.

**Commands:**

- `npm run ui-tests` — run all specs sequentially in one browser.
- `npm run ui-tests -- --grep partial-name` — run specs whose exported name includes the substring.

**Environment:**

- `UI_TEST_BASE_URL` — override base URL (default `http://127.0.0.1:3000`; `SNAPSHOT_TEST_BASE_URL` is also accepted).
- `UI_TEST_TIMEOUT_MS` — Puppeteer default timeout (default 300000).
- `UI_TEST_SUMMARY_STABLE_MS` / `UI_TEST_SUMMARY_STABLE_TICKS` / `UI_TEST_SUMMARY_DEADLINE_MS` — tune run-summary stabilization waits.

Artifacts: `ui-tests/report.html` and `ui-tests/last-run.json` after each run.
