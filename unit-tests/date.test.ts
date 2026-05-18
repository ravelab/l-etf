import test from "node:test";
import assert from "node:assert/strict";
import { getIsoDate } from "../src/lib/date";

test("getIsoDate returns YYYY-MM-DD", () => {
  const date = new Date(2020, 11, 31); // Dec 31
  assert.equal(getIsoDate(date), "2020-12-31");
  
  const date2 = new Date(2021, 0, 1); // Jan 1
  assert.equal(getIsoDate(date2), "2021-01-01");
});
