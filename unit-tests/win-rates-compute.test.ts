import test from "node:test";
import assert from "node:assert/strict";
import { computeWinRatesByWindowLength } from "../src/lib/simulation/win-rates";
import type { EtfConfig, PricePoint, RatePoint } from "../src/lib/simulation/types";

function tradingDays(count: number, startIso = "2018-01-02"): PricePoint[] {
  const out: PricePoint[] = [];
  const date = new Date(`${startIso}T00:00:00Z`);
  let px = 100;
  while (out.length < count) {
    const dow = date.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      // Mild drift with a mid-series dip so SMA and buy-and-hold diverge.
      const i = out.length;
      if (i > 40 && i < 55) px *= 0.97;
      else px *= 1.002;
      out.push({
        date: date.toISOString().slice(0, 10),
        close: px,
        adj_close: px,
        open: px * 0.999,
      });
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return out;
}

function flatRates(dates: string[]): RatePoint[] {
  return dates.map((date) => ({ date, rateValue: 0.02, rateType: "borrow" as const }));
}

function configs(): { sma: EtfConfig; noSma: EtfConfig } {
  const base = {
    name: "QLD",
    leverage: 2,
    expenseRatio: 0.95,
    simulated: true,
    smaPeriod: 10,
    smaUpperBuffer: 0,
    smaLowerBuffer: 0,
    smaIndex: "nasdaq100" as const,
    smaExecutionMode: "trigger-day-close" as const,
    riskOffAsset: "SGOV" as const,
  };
  return {
    sma: { ...base, id: "qld-sma", smaEnabled: true },
    noSma: { ...base, id: "qld-base", smaEnabled: false },
  };
}

test("computeWinRatesByWindowLength returns aligned year series and summary rows", async () => {
  const prices = tradingDays(280);
  const rates = flatRates(prices.map((p) => p.date));
  const riskOff = prices.map((p) => p.adj_close * 1.0001);
  const { sma, noSma } = configs();
  const startDate = prices[20]!.date;
  const endDate = prices[prices.length - 1]!.date;

  const progress: number[] = [];
  const result = await computeWinRatesByWindowLength({
    label: "QLD",
    prices,
    rates,
    smaConfig: sma,
    noSmaConfig: noSma,
    startDate,
    endDate,
    historyWrap: false,
    riskOffValuesByAsset: { SGOV: riskOff },
    riskOffOpenValuesByAsset: { SGOV: riskOff },
    sgovPoints: prices.map((p) => ({
      date: p.date,
      close: 100 + Number(p.date.slice(8, 10)) * 0.01,
      adj_close: 100 + Number(p.date.slice(8, 10)) * 0.01,
    })),
    monthlyCpi: [
      { date: "2018-01-01", value: 240 },
      { date: "2019-01-01", value: 245 },
    ],
    onProgress: (year) => progress.push(year),
  });

  assert.equal(result.label, "QLD");
  assert.equal(result.historyWrapApplied, false);
  assert.ok(result.years.length >= 3);
  assert.equal(result.years[0], 0.25);
  assert.equal(result.years[1], 0.5);
  assert.equal(result.beatsNonSma.length, result.years.length);
  assert.equal(result.beatsIndex.length, result.years.length);
  assert.equal(result.beatsSgov.length, result.years.length);
  assert.ok(progress.includes(0.25));
  assert.ok(progress.includes(1));

  // Short holding periods produce rolling windows; longer ones collapse to the
  // full available range (see buildRollingWindows), so win rates stay in [0,100].
  for (let i = 0; i < result.years.length; i++) {
    assert.ok(result.beatsNonSma[i]! >= 0 && result.beatsNonSma[i]! <= 100);
    assert.ok(result.beatsIndex[i]! >= 0 && result.beatsIndex[i]! <= 100);
    assert.ok(result.beatsSgov[i]! >= 0 && result.beatsSgov[i]! <= 100);
  }

  assert.equal(result.summaryRows.length, 3);
  assert.equal(result.summaryRows[0]!.label, "SMA");
  assert.equal(result.summaryRows[1]!.label, "No SMA");
  assert.equal(result.summaryRows[2]!.label, "QQQ");
  assert.ok(Number.isFinite(result.summaryRows[0]!.avg));
  assert.ok(result.summaryRows[0]!.beatsSma === null);
  assert.ok(result.earliestStartDate == null || result.earliestStartDate >= startDate);
});

test("computeWinRatesByWindowLength aborts when the signal fires", async () => {
  const prices = tradingDays(120);
  const rates = flatRates(prices.map((p) => p.date));
  const riskOff = prices.map((p) => p.adj_close);
  const { sma, noSma } = configs();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      computeWinRatesByWindowLength({
        label: "QLD",
        prices,
        rates,
        smaConfig: sma,
        noSmaConfig: noSma,
        startDate: prices[0]!.date,
        endDate: prices[prices.length - 1]!.date,
        historyWrap: false,
        riskOffValuesByAsset: { SGOV: riskOff },
        sgovPoints: prices,
        signal: controller.signal,
      }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
});
