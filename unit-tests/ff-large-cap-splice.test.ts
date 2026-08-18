import test from "node:test";
import assert from "node:assert/strict";

import { spliceFfLargeCapHistory } from "../src/lib/data/ff-large-cap-splice";
import type { DailyPrice } from "../src/lib/data/storage/types";

const SPLICE_START = "1926-07-01";
const SPLICE_END = "1988-04-06";

function row(date: string, adj: number, close: number, open?: number): DailyPrice {
  return { date, adj_close: adj, close, open, name: "SP500-TR", source: "old" };
}

// Two pre-splice rows, three spliced rows, two untouched modern rows.
function sampleRows(): DailyPrice[] {
  return [
    row("1926-06-29", 50, 25, 24),
    row("1926-06-30", 51, 25.5, 25.2),
    row(SPLICE_START, 52, 26, 25.8),
    row("1926-07-02", 53, 26.5, 26.4),
    row("1988-04-05", 100, 50, 49),
    row(SPLICE_END, 110, 55, 54),
    row("1988-04-07", 121, 60.5, 60),
  ];
}

// FF levels imply +10% on 1926-07-02, +25% on 1988-04-05, +100% on 1988-04-06.
function sampleFf() {
  return [
    { date: SPLICE_START, adj_close: 10 },
    { date: "1926-07-02", adj_close: 11 },
    { date: "1988-04-05", adj_close: 13.75 },
    { date: SPLICE_END, adj_close: 27.5 },
  ];
}

function splice(rows = sampleRows(), ffRows = sampleFf()) {
  return spliceFfLargeCapHistory({
    rows,
    ffRows,
    spliceStart: SPLICE_START,
    spliceEndExclusive: SPLICE_END,
    name: "FF-HI30-TR",
    source: "famafrench",
  });
}

test("leaves rows at and after the splice end untouched", () => {
  const { rows } = splice();
  assert.deepEqual(rows[5], sampleRows()[5]);
  assert.deepEqual(rows[6], sampleRows()[6]);
});

test("spliced window carries Fama-French returns, anchored to the modern seam", () => {
  const { rows, replacedCount } = splice();
  assert.equal(replacedCount, 3);
  // Anchor 110 walked back through the FF growth on 1988-04-06 (x2).
  assert.equal(rows[4].adj_close, 55);
  // ...then back through 1988-04-05 (x1.25).
  assert.equal(rows[3].adj_close, 44);
  // ...then back through 1926-07-02 (x1.1).
  assert.ok(Math.abs(rows[2].adj_close! - 40) < 1e-9);
});

test("spliced rows reproduce the Fama-French daily returns exactly", () => {
  const { rows } = splice();
  const ff = sampleFf();
  for (let i = 1; i < ff.length - 1; i++) {
    const expected = ff[i].adj_close / ff[i - 1].adj_close;
    const actual = rows[i + 2].adj_close! / rows[i + 1].adj_close!;
    assert.ok(Math.abs(actual / expected - 1) < 1e-12, `return mismatch at ${ff[i].date}`);
  }
});

test("holds close/adj_close ratio invariant so the splice is idempotent", () => {
  const original = sampleRows();
  const { rows } = splice();
  for (let i = 2; i < 5; i++) {
    const before = original[i].close! / original[i].adj_close!;
    const after = rows[i].close! / rows[i].adj_close!;
    assert.ok(Math.abs(after / before - 1) < 1e-12, `ratio drifted at ${rows[i].date}`);
  }
});

test("keeps both seams continuous and preserves pre-splice returns", () => {
  const original = sampleRows();
  const { rows, rescaledCount } = splice();
  assert.equal(rescaledCount, 2);

  // The 1926 seam return is the ORIGINAL S&P return, not an FF one.
  const expected = original[2].adj_close! / original[1].adj_close!;
  const actual = rows[2].adj_close! / rows[1].adj_close!;
  assert.ok(Math.abs(actual / expected - 1) < 1e-12, "1926 seam return changed");

  // Pre-splice daily returns survive the constant rescale.
  const beforeRet = original[1].adj_close! / original[0].adj_close!;
  const afterRet = rows[1].adj_close! / rows[0].adj_close!;
  assert.ok(Math.abs(afterRet / beforeRet - 1) < 1e-12, "pre-1926 return changed");

  // Same for the price column.
  const beforeClose = original[2].close! / original[1].close!;
  const afterClose = rows[2].close! / rows[1].close!;
  assert.ok(Math.abs(afterClose / beforeClose - 1) < 1e-12, "1926 close seam changed");
});

test("preserves each spliced row's open-to-close gap", () => {
  const original = sampleRows();
  const { rows } = splice();
  for (let i = 2; i < 5; i++) {
    const before = original[i].open! / original[i].close!;
    const after = rows[i].open! / rows[i].close!;
    assert.ok(Math.abs(after / before - 1) < 1e-12, `open gap drifted at ${rows[i].date}`);
  }
});

test("relabels spliced rows and only those", () => {
  const { rows } = splice();
  assert.deepEqual(
    rows.map((r) => r.name),
    ["SP500-TR", "SP500-TR", "FF-HI30-TR", "FF-HI30-TR", "FF-HI30-TR", "SP500-TR", "SP500-TR"]
  );
});

test("applying the splice twice is a no-op", () => {
  const once = splice().rows;
  const twice = splice(once).rows;
  for (let i = 0; i < once.length; i++) {
    assert.ok(Math.abs(twice[i].adj_close! / once[i].adj_close! - 1) < 1e-12, `drift at ${once[i].date}`);
    assert.ok(Math.abs(twice[i].close! / once[i].close! - 1) < 1e-12, `close drift at ${once[i].date}`);
  }
});

test("throws when a Fama-French return is missing for a spliced date", () => {
  const ff = sampleFf().filter((r) => r.date !== "1926-07-02");
  assert.throws(() => splice(sampleRows(), ff), /missing Fama-French return/);
});

test("throws when the anchor row has no adj_close", () => {
  const rows = sampleRows();
  rows[5] = { ...rows[5], adj_close: undefined };
  assert.throws(() => splice(rows), /no usable adj_close/);
});

test("throws when the splice window is empty", () => {
  assert.throws(
    () =>
      spliceFfLargeCapHistory({
        rows: sampleRows(),
        ffRows: sampleFf(),
        spliceStart: "1990-01-01",
        spliceEndExclusive: SPLICE_END,
        name: "FF-HI30-TR",
        source: "famafrench",
      }),
    /empty splice window/
  );
});
