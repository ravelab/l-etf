import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `data/index-ndx-1985.csv` carries real Nasdaq-100 closes for the window between
 * the index's launch and the first date Yahoo's `^NDX` covers. It is committed
 * rather than fetched at build time, so these tests are what stand between the
 * artifact and silent rot — including the check that caught a vendor file that
 * looked like deeper NDX history but was Composite back-propagation.
 */

const NDX_LAUNCH_DATE = "1985-01-31";
const YAHOO_NDX_FIRST_DATE = "1985-10-01";

function readCsv(filename: string): Array<Record<string, string>> {
  const raw = readFileSync(join(process.cwd(), "data", filename), "utf-8").trim();
  const [header, ...lines] = raw.split("\n");
  const cols = header.split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

const ndx1985 = readCsv("index-ndx-1985.csv").map((r) => ({ date: r.date, close: Number(r.close) }));
const indexNq = readCsv("index-nq.csv").map((r) => ({ date: r.date, close: Number(r.close) }));

test("ndx 1985: starts at the launch date on the index's own base", () => {
  assert.equal(ndx1985[0].date, NDX_LAUNCH_DATE);
  // A base other than 125 means the feed rebased, and spliced levels would no
  // longer meet Yahoo's series at the seam.
  assert.equal(Math.abs(ndx1985[0].close - 125) < 0.01, true, `launch base was ${ndx1985[0].close}`);
});

test("ndx 1985: covers every session up to where Yahoo's ^NDX takes over", () => {
  const gap = ndx1985.filter((r) => r.date >= NDX_LAUNCH_DATE && r.date < YAHOO_NDX_FIRST_DATE);
  assert.equal(gap.length, 168, `expected 168 sessions before the Yahoo seam, got ${gap.length}`);

  const dates = ndx1985.map((r) => r.date);
  assert.deepEqual(dates, [...dates].sort(), "dates must be ascending");
  assert.equal(new Set(dates).size, dates.length, "dates must be unique");
  for (const row of ndx1985) {
    assert.equal(Number.isFinite(row.close) && row.close > 0, true, `bad close on ${row.date}`);
  }
});

test("ndx 1985: tracks the real index where we can check it", () => {
  // Oct-Dec 1985 is genuine Yahoo `^NDX` in index-nq.csv and stays that way after
  // the splice, so it remains a valid "is this actually NDX?" probe. A Composite
  // backfill cannot reproduce NDX's daily returns; a real feed matches them.
  const byDate = new Map(indexNq.map((r) => [r.date, r.close] as const));
  const overlap = ndx1985.filter((r) => r.date >= YAHOO_NDX_FIRST_DATE && byDate.has(r.date));
  assert.equal(overlap.length > 50, true, `need a real overlap to validate, got ${overlap.length}`);

  const returnDiffs: number[] = [];
  for (let i = 1; i < overlap.length; i++) {
    const prev = overlap[i - 1];
    const curr = overlap[i];
    const ours = byDate.get(curr.date)!;
    const oursPrev = byDate.get(prev.date)!;
    returnDiffs.push(Math.abs(curr.close / prev.close - ours / oursPrev));
  }
  returnDiffs.sort((a, b) => a - b);
  const median = returnDiffs[Math.floor(returnDiffs.length / 2)];
  assert.equal(median < 1e-4, true, `median daily return divergence ${median} is too large to be the same index`);
});
