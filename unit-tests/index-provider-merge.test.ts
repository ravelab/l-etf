import test from "node:test";
import assert from "node:assert/strict";
import { mergeAdjustedPricesWithRawIndexBars } from "@/lib/data/index-provider-merge";

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
  });

  assert.deepEqual(result.missingRawDates, ["2026-07-21"]);
  assert.deepEqual(
    result.rows.map((row) => row.date),
    ["2026-07-20", "2026-08-12", "2026-08-13"]
  );
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
  });

  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.missingRawDates, ["2026-08-12", "2026-08-13"]);
});
