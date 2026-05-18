import test from "node:test";
import assert from "node:assert/strict";
import { mondayOfWeek, newYorkDateKey } from "../src/lib/weekly-build-marker";

test("newYorkDateKey formats the calendar date in New York", () => {
  assert.equal(newYorkDateKey(new Date("2026-05-12T01:00:00.000Z")), "2026-05-11");
  assert.equal(newYorkDateKey(new Date("2026-05-12T05:00:00.000Z")), "2026-05-12");
});

test("mondayOfWeek anchors weekdays and weekends to the current trading week", () => {
  assert.equal(mondayOfWeek("2026-05-11"), "2026-05-11");
  assert.equal(mondayOfWeek("2026-05-12"), "2026-05-11");
  assert.equal(mondayOfWeek("2026-05-17"), "2026-05-11");
});
