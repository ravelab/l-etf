# E2E tests (Puppeteer)

Browser end-to-end specs against a live Next.js server. Specs live in `specs/`
and export `name`, optional `tags`, and `run({ browser, baseUrl, page })`.

**Requirements:** by default the runner builds a Next.js production bundle and starts an ephemeral server. Set `E2E_TEST_BASE_URL` (or `SNAPSHOT_TEST_BASE_URL`) to point at an existing server — that is what CI does after each Vercel deploy.

## Commands

- `npm run test:e2e` — run all specs sequentially in one browser (alias: `e2e-tests`).
- `npm run test:e2e -- --grep partial-name` — run specs whose exported name includes the substring.
- `E2E_TEST_TAGS=smoke npm run test:e2e` — run only specs that export `tags = ["smoke"]` (production post-deploy job).

## Env

- `E2E_TEST_BASE_URL` — override base URL (default managed local prod server; `SNAPSHOT_TEST_BASE_URL` is also accepted).
- `E2E_TEST_TAGS` — comma/space-separated tag filter; every listed tag must be present on the spec.
- `LETF_BROWSER_COVERAGE_DIR` — when set, record Chrome V8 JS coverage into that directory.
- `E2E_TEST_TIMEOUT_MS` — Puppeteer default timeout (default 90000).
- `E2E_TEST_SUMMARY_STABLE_MS` / `E2E_TEST_SUMMARY_STABLE_TICKS` / `E2E_TEST_SUMMARY_DEADLINE_MS` — tune run-summary stabilization waits.

Artifacts: `e2e-tests/report.html` and `e2e-tests/last-run.json` after each run.
