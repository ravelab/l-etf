import test from "node:test";
import assert from "node:assert/strict";
import {
  appendSmaBufferUrlParams,
  deleteSmaBufferUrlParams,
  parseSmaBufferUrlParams,
  urlSmaBuffersMatchState,
} from "@/lib/sma-buffer-url-params";

test("appendSmaBufferUrlParams writes all four asymmetric keys", () => {
  const params = new URLSearchParams();
  appendSmaBufferUrlParams(params, {
    smaSpUpperBuffer: 3,
    smaSpLowerBuffer: 3.3,
    smaNqUpperBuffer: 20.4,
    smaNqLowerBuffer: 17.6,
    smaVolGate: false,
  });
  assert.equal(params.get("smatspU"), "3");
  assert.equal(params.get("vg"), null);
  assert.equal(params.get("smatspL"), "3.3");
  assert.equal(params.get("smatnqU"), "20.4");
  assert.equal(params.get("smatnqL"), "17.6");
});

test("parseSmaBufferUrlParams reads canonical keys", () => {
  const parsed = parseSmaBufferUrlParams(
    new URLSearchParams("smatspU=3&smatspL=3.3&smatnqU=20.4&smatnqL=17.6")
  );
  assert.deepEqual(parsed, {
    smaSpUpperBuffer: 3,
    smaSpLowerBuffer: 3.3,
    smaNqUpperBuffer: 20.4,
    smaNqLowerBuffer: 17.6,
    smaVolGate: false,
  });
});

test("volatility gate round-trips through the URL", () => {
  const params = new URLSearchParams();
  appendSmaBufferUrlParams(params, {
    smaSpUpperBuffer: 3,
    smaSpLowerBuffer: 3.3,
    smaNqUpperBuffer: 20.4,
    smaNqLowerBuffer: 17.6,
    smaVolGate: true,
  });
  assert.equal(params.get("vg"), "1");
  assert.equal(parseSmaBufferUrlParams(params).smaVolGate, true);
  const buffers = { smaSpUpperBuffer: 3, smaSpLowerBuffer: 3.3, smaNqUpperBuffer: 20.4, smaNqLowerBuffer: 17.6 };
  assert.equal(urlSmaBuffersMatchState(params, { ...buffers, smaVolGate: true }), true);
  assert.equal(urlSmaBuffersMatchState(params, { ...buffers, smaVolGate: false }), false);
  deleteSmaBufferUrlParams(params);
  assert.equal(params.get("vg"), null);
});

test("a URL without buffer keys leaves the volatility gate unset", () => {
  assert.equal(parseSmaBufferUrlParams(new URLSearchParams("sd=2020-01-01")).smaVolGate, undefined);
});

test("parseSmaBufferUrlParams ignores legacy upper-only keys", () => {
  const parsed = parseSmaBufferUrlParams(new URLSearchParams("smatsp=3&smatnq=20.4"));
  assert.deepEqual(parsed, {});
});

test("urlSmaBuffersMatchState requires canonical keys", () => {
  const params = new URLSearchParams("smatspU=3&smatnqU=20.4");
  assert.equal(
    urlSmaBuffersMatchState(params, { smaSpUpperBuffer: 3, smaNqUpperBuffer: 20.4 }),
    true
  );
  assert.equal(
    urlSmaBuffersMatchState(params, { smaSpUpperBuffer: 4, smaNqUpperBuffer: 20.4 }),
    false
  );
  assert.equal(
    urlSmaBuffersMatchState(new URLSearchParams("smatsp=3&smatnq=20.4"), { smaSpUpperBuffer: 3 }),
    true
  );
});

test("deleteSmaBufferUrlParams removes canonical keys", () => {
  const params = new URLSearchParams("smatspU=1&smatspL=2&smatnqU=3&smatnqL=4&sd=2020-01-01");
  deleteSmaBufferUrlParams(params);
  assert.equal(params.toString(), "sd=2020-01-01");
});
