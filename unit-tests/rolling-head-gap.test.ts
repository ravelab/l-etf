import test from "node:test";
import assert from "node:assert/strict";
import { buildRollingWindows } from "../src/lib/simulation/rolling";
import type { PricePoint } from "../src/lib/simulation/types";

/** Daily rows across [startYear, endYear], skipping any date inside `gap`. */
function dailySeries(
  startIso: string,
  endIso: string,
  gap?: { from: string; to: string }
): PricePoint[] {
  const out: PricePoint[] = [];
  let t = Date.parse(`${startIso}T00:00:00Z`);
  const end = Date.parse(`${endIso}T00:00:00Z`);
  let v = 100;
  while (t <= end) {
    const date = new Date(t).toISOString().slice(0, 10);
    const dow = new Date(t).getUTCDay();
    const inGap = gap !== undefined && date >= gap.from && date <= gap.to;
    if (dow !== 0 && dow !== 6 && !inGap) {
      v *= 1.0003;
      out.push({ date, adj_close: v, close: v });
    }
    t += 86400000;
  }
  return out;
}

function yearsBetween(a: string, b: string): number {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / (365.25 * 86400000);
}

test("a window whose head is late across a long data gap is rejected", () => {
  // Four months of missing sessions, like a prolonged exchange closure. Cursors
  // inside the gap all snap forward to the first post-gap session, which used to
  // score zero missing days because the target END landed inside real data.
  const prices = dailySeries("1910-01-01", "1930-12-31", { from: "1914-08-01", to: "1914-12-11" });

  const windows = buildRollingWindows({
    prices,
    windowLength: 10,
    historyWrap: false,
  });

  assert.ok(windows.length > 0, "expected some 10-year windows");
  for (const w of windows) {
    const span = yearsBetween(w.startDate, w.endDate);
    assert.ok(
      span > 9.9,
      `window ${w.startDate}..${w.endDate} spans ${span.toFixed(2)}y; a "10-year" window must not be materially short`
    );
  }
});

test("ordinary month-start snapping is still admitted", () => {
  // A normal series only snaps a few days (weekends/holidays); those windows
  // must survive, or the guard would silently thin out every sweep.
  const prices = dailySeries("1990-01-01", "2010-12-31");
  const windows = buildRollingWindows({ prices, windowLength: 5, historyWrap: false });

  assert.ok(windows.length > 150, `expected a full set of 5-year windows, got ${windows.length}`);
});
