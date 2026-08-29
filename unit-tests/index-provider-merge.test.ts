import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeAdjustedPricesWithRawIndexBars,
  mergeIncrementalIndexRows,
} from "@/lib/data/index-provider-merge";

test("an isolated raw-index gap does not discard later matched rows", () => {
  const result = mergeAdjustedPricesWithRawIndexBars({
    adjustedRows: [
      { date: "2026-07-20", adjClose: 590 },
      { date: "2026-07-21", adjClose: 591 },
      { date: "2026-08-12", adjClose: 620 },
      { date: "2026-08-13", adjClose: 622 },
    ],
    rawBars: [
      { date: "2026-07-20", open: 7700, close: 7720 },
      { date: "2026-08-12", open: 7760, close: 7780 },
      { date: "2026-08-13", open: 7785, close: 7799 },
    ],
    name: "VOO",
    source: "yahoo(open+close)+tiingo(adj_close)",
    adjustedOnlySource: "tiingo(adj_close)",
  });

  assert.deepEqual(result.missingRawDates, ["2026-07-21"]);
  assert.deepEqual(
    result.rows.map((row) => row.date),
    ["2026-07-20", "2026-07-21", "2026-08-12", "2026-08-13"]
  );
  assert.deepEqual(result.rows[1], {
    date: "2026-07-21",
    adj_close: 591,
    name: "VOO",
    source: "tiingo(adj_close)",
  });
  assert.deepEqual(result.rows.at(-1), {
    date: "2026-08-13",
    adj_close: 622,
    open: 7785,
    close: 7799,
    name: "VOO",
    source: "yahoo(open+close)+tiingo(adj_close)",
  });
});

test("reports every adjusted row when no raw bars match", () => {
  const result = mergeAdjustedPricesWithRawIndexBars({
    adjustedRows: [
      { date: "2026-08-12", adjClose: 620 },
      { date: "2026-08-13", adjClose: 622 },
    ],
    rawBars: [],
    name: "VOO",
    source: "test",
    adjustedOnlySource: "tiingo(adj_close)",
  });

  assert.deepEqual(result.rows, [
    { date: "2026-08-12", adj_close: 620, name: "VOO", source: "tiingo(adj_close)" },
    { date: "2026-08-13", adj_close: 622, name: "VOO", source: "tiingo(adj_close)" },
  ]);
  assert.deepEqual(result.missingRawDates, ["2026-08-12", "2026-08-13"]);
});

test("backfills a provisional overlap without blocking later tail rows", () => {
  const fresh = mergeAdjustedPricesWithRawIndexBars({
    adjustedRows: [
      { date: "2026-08-10", adjClose: 711.25 },
      { date: "2026-08-11", adjClose: 712.5 },
      { date: "2026-08-12", adjClose: 713.75 },
    ],
    rawBars: [
      { date: "2026-08-11", open: 7760, close: 7780 },
      { date: "2026-08-12", open: 7785, close: 7799 },
    ],
    name: "VOO",
    source: "yahoo(open+close)+tiingo(adj_close)",
    adjustedOnlySource: "tiingo(adj_close)",
  });

  const result = mergeIncrementalIndexRows({
    storedRows: [{
      date: "2026-08-10",
      adj_close: 710.295,
      open: 7751.74,
      close: 7753.11,
      name: "VOO",
      source: "yahoo(open+close)+provisional(adj_close)",
    }],
    freshRows: fresh.rows,
    rebaseRatio: null,
  });

  assert.deepEqual(fresh.missingRawDates, ["2026-08-10"]);
  assert.deepEqual(result.rows.map((row) => row.date), [
    "2026-08-10",
    "2026-08-11",
    "2026-08-12",
  ]);
  assert.deepEqual(result.rows[0], {
    date: "2026-08-10",
    adj_close: 711.25,
    open: 7751.74,
    close: 7753.11,
    name: "VOO",
    source: "yahoo(open+close)+tiingo(adj_close)",
  });
  assert.equal(result.appendedCount, 2);
});

test("never appends a brand-new index row that has no close", () => {
  // Tiingo publishes VOO's adjusted close hours before Yahoo has the ^GSPC bar,
  // so a build landing in that window sees an adjusted-only tail row. Appending
  // it puts a close-less date on the axis, and every SMA path throws on it
  // ("Missing close price for sp500 on <date>") until the next build.
  const fresh = mergeAdjustedPricesWithRawIndexBars({
    adjustedRows: [
      { date: "2026-08-27", adjClose: 708.75 },
      { date: "2026-08-28", adjClose: 707.24 },
    ],
    rawBars: [{ date: "2026-08-27", open: 7710.34, close: 7730.99 }],
    name: "VOO",
    source: "yahoo(open+close)+tiingo(adj_close)",
    adjustedOnlySource: "tiingo(adj_close)",
  });

  const result = mergeIncrementalIndexRows({
    storedRows: [{
      date: "2026-08-26",
      adj_close: 704.2,
      open: 7666.88,
      close: 7675.7,
      name: "VOO",
      source: "yahoo(open+close)+tiingo(adj_close)",
    }],
    freshRows: fresh.rows,
    rebaseRatio: null,
  });

  assert.deepEqual(fresh.missingRawDates, ["2026-08-28"]);
  assert.deepEqual(result.rows.map((row) => row.date), ["2026-08-26", "2026-08-27"]);
  assert.equal(result.appendedCount, 1);
  assert.ok(result.rows.every((row) => row.close != null));
});
