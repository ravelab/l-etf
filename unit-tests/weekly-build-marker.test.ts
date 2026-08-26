import test from "node:test";
import assert from "node:assert/strict";
import {
  mondayOfWeek,
  newYorkDateKey,
  isWeeklyBuildMarkerStorageReady,
  readLastWeeklyRunTradingDate,
  writeLastWeeklyRunTradingDate,
} from "../src/lib/weekly-build-marker";

test("newYorkDateKey formats the calendar date in New York", () => {
  assert.equal(newYorkDateKey(new Date("2026-05-12T01:00:00.000Z")), "2026-05-11");
  assert.equal(newYorkDateKey(new Date("2026-05-12T05:00:00.000Z")), "2026-05-12");
});

test("mondayOfWeek anchors weekdays and weekends to the current trading week", () => {
  assert.equal(mondayOfWeek("2026-05-11"), "2026-05-11");
  assert.equal(mondayOfWeek("2026-05-12"), "2026-05-11");
  assert.equal(mondayOfWeek("2026-05-17"), "2026-05-11");
});

test("weekly build marker is a no-op without Redis config", async () => {
  const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
  const prevToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  try {
    assert.equal(isWeeklyBuildMarkerStorageReady(), false);
    assert.equal(await readLastWeeklyRunTradingDate(), null);
    await writeLastWeeklyRunTradingDate("2026-05-12");
  } finally {
    if (prevUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = prevUrl;
    if (prevToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = prevToken;
  }
});
