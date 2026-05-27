import test from "node:test";
import assert from "node:assert/strict";
import { decodeBacktestParams } from "@/lib/url-state";

test("decodeBacktestParams returns null when no recognized params present", () => {
  assert.equal(decodeBacktestParams(""), null);
  assert.equal(decodeBacktestParams("?foo=bar"), null);
});

test("decodeBacktestParams parses valid numeric SMA params", () => {
  const result = decodeBacktestParams("?sd=2020-01-01&smaPsp=185&smaPnq=150&smatspU=3.6&smatspL=3.6&smatnqU=12&smatnqL=8");
  assert.ok(result !== null);
  assert.equal(result.smaSpPeriod, 185);
  assert.equal(result.smaNqPeriod, 150);
  assert.equal(result.smaSpUpperBuffer, 3.6);
  assert.equal(result.smaSpLowerBuffer, 3.6);
  assert.equal(result.smaNqUpperBuffer, 12);
  assert.equal(result.smaNqLowerBuffer, 8);
});

test("decodeBacktestParams returns undefined (not NaN) for non-numeric SMA params", () => {
  const result = decodeBacktestParams("?sd=2020-01-01&smaPsp=invalid&smaPnq=NaN&smatspU=abc&smatspL=&smatnqU=abc&smatnqL=");
  assert.ok(result !== null);
  assert.equal(result.smaSpPeriod, undefined);
  assert.equal(result.smaNqPeriod, undefined);
  assert.equal(result.smaSpUpperBuffer, undefined);
  assert.equal(result.smaSpLowerBuffer, undefined);
  assert.equal(result.smaNqUpperBuffer, undefined);
  assert.equal(result.smaNqLowerBuffer, undefined);
});

test("decodeBacktestParams returns undefined for absent SMA params", () => {
  const result = decodeBacktestParams("?sd=2020-01-01");
  assert.ok(result !== null);
  assert.equal(result.smaSpPeriod, undefined);
  assert.equal(result.smaNqPeriod, undefined);
  assert.equal(result.smaSpUpperBuffer, undefined);
  assert.equal(result.smaSpLowerBuffer, undefined);
  assert.equal(result.smaNqUpperBuffer, undefined);
  assert.equal(result.smaNqLowerBuffer, undefined);
});

test("decodeBacktestParams parses ETF configs and date range", () => {
  const result = decodeBacktestParams("?sd=2020-01-01&ed=2024-12-31&e0_n=UPRO");
  assert.ok(result !== null);
  assert.equal(result.startDate, "2020-01-01");
  assert.equal(result.endDate, "2024-12-31");
  assert.equal(result.etfConfigs?.length, 1);
  assert.equal(result.etfConfigs?.[0].name, "UPRO");
});
