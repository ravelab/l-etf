import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EXTRA_STRATEGY_IDS,
  appendExtraStrategiesUrlParam,
  getSignalRule,
  isSignalRuleLabel,
  listSignalRules,
  normalizeExtraStrategyIds,
  parseExtraStrategiesUrlParam,
  registerSignalRule,
  runSignalRule,
  withSignalRuleLines,
  type SignalRule,
} from "@/lib/simulation/signal-rules";
import { NDX_THREE_GATE_RULE } from "@/lib/simulation/three-gate";
import { simulateBacktest } from "@/lib/simulation/engine";
import { findEtfResult } from "@/lib/simulation/result-lookup";
import { createPresetEtfConfig, ETF_PRESETS } from "@/lib/simulation/presets";
import { shortBacktestAssetLabel } from "@/lib/strategy-page-data";
import type { PricePoint, RatePoint } from "@/lib/simulation/types";

/** Out while the close is more than 3% under its 5-day high. */
const NEAR_HIGH: SignalRule = {
  id: "test-near-high",
  label: "NearHigh",
  title: "Near High",
  description: "Test rule.",
  warmUpDays: 5,
  indices: ["nasdaq100"],
  regime: (_dates, closes) =>
    closes.map((close, i) => i >= 4 && close >= Math.max(...closes.slice(i - 4, i + 1)) * 0.97),
};

const LINE = { smaIndex: "nasdaq100", smaPeriod: 20, smaUpperBuffer: 1, smaLowerBuffer: 1 } as const;

function withRule<T>(rule: SignalRule, fn: () => T): T {
  const unregister = registerSignalRule(rule);
  try {
    return fn();
  } finally {
    unregister();
  }
}

function isoDates(count: number): string[] {
  const start = Date.UTC(2000, 0, 3);
  return Array.from({ length: count }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}

/** Rises, drops ~10%, recovers: the rule exits and re-enters once. */
function closes(): number[] {
  const out = [100];
  for (let i = 0; i < 40; i++) out.push(out[out.length - 1] * 1.004);
  for (let i = 0; i < 10; i++) out.push(out[out.length - 1] * 0.99);
  for (let i = 0; i < 40; i++) out.push(out[out.length - 1] * 1.006);
  return out;
}

function tqqq(id: string) {
  return createPresetEtfConfig(id, ETF_PRESETS.TQQQ, {
    smaEnabled: true, smaPeriod: 20, smaUpperBuffer: 1, smaLowerBuffer: 1, smaVolGate: true, riskOffAsset: "VGSH",
  });
}

test("NDX 3-Gate is offered, and no extra strategy is ticked by default", () => {
  assert.deepEqual(DEFAULT_EXTRA_STRATEGY_IDS, []);
  assert.ok(listSignalRules().includes(NDX_THREE_GATE_RULE));
  assert.equal(getSignalRule("ndx-3-gate"), NDX_THREE_GATE_RULE);
  assert.match(NDX_THREE_GATE_RULE.sourceUrl ?? "", /^https:\/\/willperryyy\.github\.io\/tqqq-gate\//);
});

test("normalizeExtraStrategyIds keeps registered ids once, in picker order", () => {
  withRule(NEAR_HIGH, () => {
    assert.deepEqual(
      normalizeExtraStrategyIds([NEAR_HIGH.id, "nope", 7, "ndx-3-gate", NEAR_HIGH.id]),
      ["ndx-3-gate", NEAR_HIGH.id]
    );
  });
  assert.deepEqual(normalizeExtraStrategyIds(undefined), []);
  assert.deepEqual(normalizeExtraStrategyIds("ndx-3-gate"), []);
});

test("the xs URL param round-trips the selection; absent means none", () => {
  const params = new URLSearchParams();
  appendExtraStrategiesUrlParam(params, []);
  assert.equal(params.toString(), "");
  assert.deepEqual(parseExtraStrategiesUrlParam(params), []);
  appendExtraStrategiesUrlParam(params, ["ndx-3-gate"]);
  assert.equal(params.get("xs"), "ndx-3-gate");
  assert.deepEqual(parseExtraStrategiesUrlParam(params), ["ndx-3-gate"]);
  assert.deepEqual(parseExtraStrategiesUrlParam(new URLSearchParams("xs=bogus,ndx-3-gate")), ["ndx-3-gate"]);
});

test("register, look up, and unregister a rule", () => {
  assert.throws(() => getSignalRule(NEAR_HIGH.id), /Unknown signal rule/);
  assert.equal(isSignalRuleLabel("NearHigh"), false);
  withRule(NEAR_HIGH, () => {
    assert.equal(getSignalRule(NEAR_HIGH.id), NEAR_HIGH);
    assert.equal(isSignalRuleLabel("NearHigh"), true);
    assert.throws(() => registerSignalRule(NEAR_HIGH), /already registered/);
  });
  assert.throws(() => getSignalRule(NEAR_HIGH.id), /Unknown signal rule/);
});

test("runSignalRule emits one signal per regime change and no SMA line", () => {
  const prices = closes();
  const dates = isoDates(prices.length);
  const { signals, smaValues, invested } = runSignalRule(NEAR_HIGH, dates, prices, LINE);
  assert.deepEqual(invested, NEAR_HIGH.regime(dates, prices, LINE));
  assert.equal(smaValues.length, dates.length, "full length, so the page shows the line's trade dates");
  assert.ok(smaValues.every(Number.isNaN), "NaN for a rule with no SMA");
  const changes = invested.flatMap((v, i) => (i > 0 && v !== invested[i - 1] ? [{ date: dates[i], type: v ? "buy" : "sell" }] : []));
  assert.deepEqual(signals.map(({ date, type }) => ({ date, type })), changes);
  assert.deepEqual(signals.map((s) => s.type), ["buy", "sell", "buy"]);
});

test("runSignalRule rejects a regime or SMA that does not cover every date", () => {
  const bad: SignalRule = { ...NEAR_HIGH, regime: () => [true] };
  assert.throws(() => runSignalRule(bad, isoDates(3), [1, 2, 3], LINE), /1 decisions for 3 dates/);
  const badSma: SignalRule = { ...NEAR_HIGH, regime: () => [true, true, true], smaValues: () => [1] };
  assert.throws(() => runSignalRule(badSma, isoDates(3), [1, 2, 3], LINE), /1 SMA values for 3 dates/);
});

test("withSignalRuleLines adds a twin of each matching simulated SMA line, after the page's own", () => {
  withRule(NEAR_HIGH, () => {
    const upro = createPresetEtfConfig("etf1", ETF_PRESETS.UPRO, { smaEnabled: true, riskOffAsset: "BRK.B+GLDM" });
    const configs = [upro, tqqq("etf2")];
    const out = withSignalRuleLines(configs, [NEAR_HIGH.id]);
    assert.deepEqual(out.slice(0, 2), configs);
    assert.equal(out.length, 3, "UPRO is outside the rule's indices");
    assert.deepEqual(out[2], { ...configs[1], id: "etf3", signalRule: NEAR_HIGH.id, smaVolGate: false },
      "keeps the line's band; the rule owns the gates");
  });
});

test("withSignalRuleLines skips real-ETF, SMA-off and existing rule lines; no ids, no change", () => {
  withRule(NEAR_HIGH, () => {
    const real = { ...tqqq("etf1"), name: "TQQQ-real", simulated: false };
    const off = { ...tqqq("etf2"), smaEnabled: false };
    const ruled = { ...tqqq("etf3"), signalRule: NEAR_HIGH.id };
    assert.deepEqual(withSignalRuleLines([real, off, ruled], [NEAR_HIGH.id]), [real, off, ruled]);
    assert.deepEqual(withSignalRuleLines([tqqq("etf1")], []), [tqqq("etf1")]);
  });
  assert.throws(() => withSignalRuleLines([tqqq("etf1")], ["nope"]), /Unknown signal rule/);
});

test("the engine runs a rule line on the rule's signals, under the rule's name", () => {
  withRule(NEAR_HIGH, () => {
    const prices = closes();
    const dates = isoDates(prices.length);
    const points: PricePoint[] = prices.map((close, i) => ({ date: dates[i], adj_close: close, close, open: close, adj_open: close }));
    const rates: RatePoint[] = [{ date: dates[0], rateType: "borrow", rateValue: 0.02 }];
    const vgsh = prices.map(() => 100);
    const result = simulateBacktest(points, rates, withSignalRuleLines([tqqq("etf1")], [NEAR_HIGH.id]), {
      riskOffValuesByAsset: { VGSH: vgsh },
      riskOffOpenValuesByAsset: { VGSH: vgsh },
    });
    const ruled = findEtfResult(result, "etf2-sma");
    const sma = findEtfResult(result, "etf1-sma");
    assert.ok(ruled && sma);
    assert.equal(ruled.name, "TQQQ (NearHigh, VGSH)");
    assert.equal(shortBacktestAssetLabel(ruled.name), "TQQQ NearHigh");
    assert.deepEqual(ruled.smaSignals, runSignalRule(NEAR_HIGH, dates, prices, LINE).signals);
    assert.equal(ruled.smaPrices.length, ruled.dates.length, "has details to show");
    assert.notDeepEqual(ruled.dailyValues, sma.dailyValues, "not deduped onto the SMA line");
    assert.equal(findEtfResult(result, "etf2-base")?.dailyValues, findEtfResult(result, "etf1-base")?.dailyValues,
      "its buy-and-hold twin is the same TQQQ line");
  });
});

test("a name in rule form with an unregistered label is left whole", () => {
  assert.equal(shortBacktestAssetLabel("TQQQ (Mystery, VGSH)"), "TQQQ (Mystery, VGSH)");
});
