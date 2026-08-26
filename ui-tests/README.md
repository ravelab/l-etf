# UI regression tests (Puppeteer)

These specs assert regressions for TR benchmark labels, per-section titles (distinct combo section start dates, or distinct Avg Inflation lines when history-wrap applies), and a frozen run summary until the user runs again.

`config.mjs` waits until loading indicators clear **and** sweep tables have rows (or an empty-state message) in a **single** predicate so brief gaps between load phases cannot flake the harness.

**Requirements:** by default the runner builds a Next.js production bundle and starts an ephemeral server. Set `UI_TEST_BASE_URL` (or `SNAPSHOT_TEST_BASE_URL`) to point at an existing server — that is what CI does after each Vercel deploy.

**Commands:**

- `npm run test:ui` — run all specs sequentially in one browser (alias: `ui-tests`).
- `npm run test:ui -- --grep partial-name` — run specs whose exported name includes the substring.
- `UI_TEST_TAGS=smoke npm run test:ui` — run only specs that export `tags = ["smoke"]` (production post-deploy job).

**Environment:**

- `UI_TEST_BASE_URL` — override base URL (default managed local prod server; `SNAPSHOT_TEST_BASE_URL` is also accepted).
- `UI_TEST_TAGS` — comma/space-separated tag filter; every listed tag must be present on the spec.
- `VERCEL_AUTOMATION_BYPASS_SECRET` — forwarded as Vercel protection-bypass headers for protected previews.
- `UI_TEST_TIMEOUT_MS` — Puppeteer default timeout (default 90000).
- `UI_TEST_SUMMARY_STABLE_MS` / `UI_TEST_SUMMARY_STABLE_TICKS` / `UI_TEST_SUMMARY_DEADLINE_MS` — tune run-summary stabilization waits.

Artifacts: `ui-tests/report.html` and `ui-tests/last-run.json` after each run.
