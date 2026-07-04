import test from "node:test";
import assert from "node:assert/strict";
import { computeAdjustedRebaseRatio } from "@/lib/data/adjusted-rebase";

test("returns null when stored and fresh adjusted closes match", () => {
  const ratio = computeAdjustedRebaseRatio([
    { date: "2026-06-01", stored: 697.3, fresh: 697.3 },
    { date: "2026-06-02", stored: 698.1, fresh: 698.1 },
  ]);
  assert.equal(ratio, null);
});

test("returns the uniform ratio after a dividend re-adjustment", () => {
  // VOO quarterly dividend shifts every historical adjusted close by the
  // same factor (here ~0.6% down).
  const factor = 0.994;
  const stored = [697.3, 698.1, 695.49, 693.91];
  const pairs = stored.map((value, i) => ({
    date: `2026-06-0${i + 1}`,
    stored: value,
    fresh: value * factor,
  }));

  const ratio = computeAdjustedRebaseRatio(pairs);
  assert.ok(ratio !== null);
  assert.ok(Math.abs(ratio - factor) < 1e-9, `expected ~${factor}, got ${ratio}`);
});

test("throws when the overlap disagrees non-uniformly", () => {
  assert.throws(
    () =>
      computeAdjustedRebaseRatio([
        { date: "2026-06-01", stored: 697.3, fresh: 697.3 * 0.994 },
        { date: "2026-06-02", stored: 698.1, fresh: 698.1 }, // unchanged → not a re-adjustment
      ]),
    /2026-06-0/
  );
});

test("throws when a single overlap row is corrupted", () => {
  assert.throws(
    () =>
      computeAdjustedRebaseRatio([
        { date: "2026-06-01", stored: 697.3, fresh: 697.3 },
        { date: "2026-06-02", stored: 698.1, fresh: 123.45 },
        { date: "2026-06-03", stored: 695.49, fresh: 695.49 },
      ]),
    /non-uniform/i
  );
});

test("returns null for an empty or non-positive overlap", () => {
  assert.equal(computeAdjustedRebaseRatio([]), null);
  assert.equal(
    computeAdjustedRebaseRatio([{ date: "2026-06-01", stored: 0, fresh: 1 }]),
    null
  );
});

test("tolerates float noise within a uniform shift", () => {
  const factor = 0.994;
  const ratio = computeAdjustedRebaseRatio([
    { date: "2026-06-01", stored: 697.3, fresh: 697.3 * factor + 1e-7 },
    { date: "2026-06-02", stored: 698.1, fresh: 698.1 * factor - 1e-7 },
  ]);
  assert.ok(ratio !== null);
  assert.ok(Math.abs(ratio - factor) < 1e-6);
});
