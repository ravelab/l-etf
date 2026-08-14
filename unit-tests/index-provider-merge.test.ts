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
