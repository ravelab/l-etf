import assert from "node:assert/strict";
import test from "node:test";
import { isOnOrAfterFirstMondayOfMonth } from "../src/lib/monthly-build-marker";

test("the monthly refresh opens on the first Monday and can catch up through month-end", () => {
  assert.equal(isOnOrAfterFirstMondayOfMonth("2026-09-06"), false);
  assert.equal(isOnOrAfterFirstMondayOfMonth("2026-09-07"), true);
  assert.equal(isOnOrAfterFirstMondayOfMonth("2026-09-08"), true);
  assert.equal(isOnOrAfterFirstMondayOfMonth("2026-09-30"), true);
  assert.equal(isOnOrAfterFirstMondayOfMonth("2026-10-01"), false);
  assert.equal(isOnOrAfterFirstMondayOfMonth("2026-10-05"), true);
  assert.equal(isOnOrAfterFirstMondayOfMonth("2027-02-01"), true);
});
