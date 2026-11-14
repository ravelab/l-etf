import test from "node:test";
import assert from "node:assert/strict";
import { appendMicroFuturesUrlParam, readMicroFuturesUrlParam } from "@/lib/micro-futures-url";
import { DEFAULT_MICRO_FUTURES } from "@/lib/simulation/defaults";

test("Micro Futures defaults on", () => {
  assert.equal(DEFAULT_MICRO_FUTURES, true);
});

test("the page writes the switch both ways, so a link can ask for full contracts", () => {
  const on = new URLSearchParams();
  appendMicroFuturesUrlParam(on, true);
  assert.equal(on.get("mf"), "1");
  const off = new URLSearchParams();
  appendMicroFuturesUrlParam(off, false);
  assert.equal(off.get("mf"), "0");
  assert.equal(readMicroFuturesUrlParam(on), true);
  assert.equal(readMicroFuturesUrlParam(off), false);
});

test("a URL without mf leaves the page's state alone", () => {
  assert.equal(readMicroFuturesUrlParam(new URLSearchParams("sd=2000-01-01")), undefined);
  assert.equal(readMicroFuturesUrlParam(new URLSearchParams("mf=true")), true);
  assert.equal(readMicroFuturesUrlParam(new URLSearchParams("mf=false")), false);
});
