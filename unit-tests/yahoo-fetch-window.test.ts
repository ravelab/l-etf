import test from "node:test";
import assert from "node:assert/strict";
import { fetchYahooDailyBarsByDate } from "@/lib/data/fetcher";

const DAY_SECONDS = 24 * 60 * 60;

function nySessionTimestamp(isoDate: string): number {
  // 09:30 New York (EDT) expressed in epoch seconds.
  return Math.floor(Date.parse(`${isoDate}T09:30:00-04:00`) / 1000);
}

function chartPayloadFor(dates: string[]) {
  return {
    chart: {
      result: [
        {
          meta: {},
          timestamp: dates.map(nySessionTimestamp),
          indicators: {
            quote: [
              {
                open: dates.map((_, i) => 100 + i),
                close: dates.map((_, i) => 101 + i),
              },
            ],
          },
        },
      ],
    },
  };
}

async function captureFetchUrl(
  run: () => Promise<unknown>,
  payload: unknown
): Promise<URL> {
  const originalFetch = globalThis.fetch;
  let requestedUrl: string | null = null;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return {
      ok: true,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as typeof fetch;

  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(requestedUrl, "expected fetch to be called");
  return new URL(requestedUrl!);
}

test("recent fetch with startDate requests a window that covers that date", async () => {
  const startDate = "2026-06-01";
  const payload = chartPayloadFor(["2026-06-01", "2026-06-02"]);

  const url = await captureFetchUrl(
    () => fetchYahooDailyBarsByDate("^GSPC", { startDate }),
    payload
  );

  assert.equal(url.searchParams.get("range"), null, "must not use the fixed 1mo range");
  const period1 = Number(url.searchParams.get("period1"));
  const period2 = Number(url.searchParams.get("period2"));
  assert.ok(Number.isFinite(period1), "period1 must be set");
  assert.ok(Number.isFinite(period2), "period2 must be set");
  assert.ok(
    period1 <= Date.parse(`${startDate}T00:00:00Z`) / 1000,
    `period1 (${period1}) must reach back to ${startDate}`
  );
  assert.ok(period1 >= Date.parse(`${startDate}T00:00:00Z`) / 1000 - 7 * DAY_SECONDS,
    "period1 should not reach back much further than startDate");
  assert.ok(period2 >= Math.floor(Date.now() / 1000) - 60, "period2 must extend to now");
});

test("recent fetch with startDate parses the returned bars", async () => {
  const payload = chartPayloadFor(["2026-06-01", "2026-06-02"]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response) as typeof fetch;

  try {
    const bars = await fetchYahooDailyBarsByDate("^GSPC", { startDate: "2026-06-01" });
    assert.deepEqual(bars.get("2026-06-01"), { close: 101, open: 100 });
    assert.deepEqual(bars.get("2026-06-02"), { close: 102, open: 101 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recent fetch without startDate keeps the 1-month window", async () => {
  const url = await captureFetchUrl(
    () => fetchYahooDailyBarsByDate("^GSPC"),
    chartPayloadFor(["2026-06-01"])
  );

  assert.equal(url.searchParams.get("range"), "1mo");
  assert.equal(url.searchParams.get("period1"), null);
});

test("fullHistory fetch requests the entire history regardless of startDate", async () => {
  const url = await captureFetchUrl(
    () => fetchYahooDailyBarsByDate("^GSPC", { fullHistory: true, startDate: "2026-06-01" }),
    chartPayloadFor(["2026-06-01"])
  );

  assert.equal(url.searchParams.get("period1"), "0");
  assert.equal(url.searchParams.get("range"), null);
});

test("recent fetch rejects a malformed startDate", async () => {
  await assert.rejects(
    () => fetchYahooDailyBarsByDate("^GSPC", { startDate: "06/01/2026" }),
    /Invalid Yahoo window start date/
  );
});
