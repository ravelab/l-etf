import test from "node:test";
import assert from "node:assert/strict";
import {
  appendPerIndexStartUrlParam,
  PER_INDEX_EARLIEST_START_DATE,
  PER_INDEX_START_DATES,
  readPerIndexStartUrlParam,
  resolveIndexStartDates,
} from "../src/lib/per-index-start";

test("SPX/NDX start runs each index from its own real series", () => {
  assert.deepEqual(PER_INDEX_START_DATES, { sp500: "1988-04-06", nasdaq100: "1985-01-31" });
  assert.equal(PER_INDEX_EARLIEST_START_DATE, "1985-01-31");
  assert.deepEqual(resolveIndexStartDates("1885-03-20", true), { sp500: "1988-04-06", nasdaq100: "1985-01-31" });
});

test("a common start date drives both indices", () => {
  // The bug this replaces: picking "SPX proto" still ran from 1988/1985.
  assert.deepEqual(resolveIndexStartDates("1885-03-20", false), { sp500: "1885-03-20", nasdaq100: "1885-03-20" });
});

test("the URL turns per-index start on only with sdi=1", () => {
  assert.equal(readPerIndexStartUrlParam(new URLSearchParams("sd=1985-01-31&sdi=1")), true);
  assert.equal(readPerIndexStartUrlParam(new URLSearchParams("sd=1885-03-20")), false);
  assert.equal(readPerIndexStartUrlParam(new URLSearchParams("sd=1885-03-20&sdi=0")), false);
  assert.equal(readPerIndexStartUrlParam(new URLSearchParams("letf=UPRO")), undefined);
});

test("appendPerIndexStartUrlParam writes the flag only when on", () => {
  const on = new URLSearchParams("sd=1985-01-31");
  appendPerIndexStartUrlParam(on, true);
  assert.equal(on.toString(), "sd=1985-01-31&sdi=1");

  const off = new URLSearchParams("sd=1885-03-20&sdi=1");
  appendPerIndexStartUrlParam(off, false);
  assert.equal(off.toString(), "sd=1885-03-20");
});
