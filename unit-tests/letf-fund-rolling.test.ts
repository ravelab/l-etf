import test from "node:test";
import assert from "node:assert/strict";
import { runLetfFundRollingWindows } from "@/lib/simulation/letf-fund-rolling";
import { runParallelVariants } from "@/lib/simulation/parallel";
import { createPresetEtfConfig, ETF_PRESETS } from "@/lib/simulation/presets";
import type { EtfConfig, PricePoint } from "@/lib/simulation/types";

const DAYS = 3 * 365;
const points = (f: (i: number) => number): PricePoint[] =>
  Array.from({ length: DAYS }, (_, i) => {
    const close = f(i);
    return { date: new Date(Date.UTC(2015, 0, 1 + i)).toISOString().slice(0, 10), open: close, close, adj_close: close };
  });
const SP = points((i) => 100 * Math.exp(0.0004 * i + 0.05 * Math.sin(i / 23)));
const NQ = points((i) => 200 * Math.exp(0.0006 * i + 0.08 * Math.sin(i / 31 + 1)));
const SGOV = SP.map((_, i) => 100 * (1 + 0.00005 * i));
const RATES = [{ date: SP[0].date, rateType: "borrow", rateValue: 0.02 }];
const END = SP.at(-1)!.date;

function sleeveConfig(name: "UPRO" | "TQQQ", lowerBuffer: number): EtfConfig {
  return createPresetEtfConfig(`${name}-sma`, ETF_PRESETS[name], {
    smaEnabled: true, smaPeriod: 20, smaUpperBuffer: 0, smaLowerBuffer: lowerBuffer, riskOffAsset: "SGOV",
    smaExecutionMode: "next-day-open",
  });
}

async function engineRows(prices: PricePoint[], config: EtfConfig, historyWrap: boolean) {
  const [result] = await runParallelVariants({
    prices, rates: RATES, windowLength: 1, startDate: SP[30].date, endDate: END, historyWrap,
    variants: [{ label: config.id, config }],
    riskOffValuesByAsset: { SGOV }, riskOffOpenValuesByAsset: { SGOV },
  });
  return new Map(result.simulations.map((run) => [`${run.startDate}|${run.endDate}`, run]));
}

for (const historyWrap of [false, true]) {
  test(`with no exits every window is half of each engine row (historyWrap ${historyWrap})`, async () => {
    const upro = sleeveConfig("UPRO", 99);
    const tqqq = sleeveConfig("TQQQ", 99);
    const fund = await runLetfFundRollingWindows({
      spx: { prices: SP, config: upro, riskOffValuesByAsset: { SGOV }, riskOffOpenValuesByAsset: { SGOV } },
      ndx: { prices: NQ, config: tqqq, riskOffValuesByAsset: { SGOV }, riskOffOpenValuesByAsset: { SGOV } },
      rates: RATES, windowLength: 1, startDate: SP[30].date, endDate: END, historyWrap,
    });
    const [uproRows, tqqqRows] = await Promise.all([engineRows(SP, upro, historyWrap), engineRows(NQ, tqqq, historyWrap)]);
    assert.ok(fund.length > 12, `windows: ${fund.length}`);
    assert.equal(fund.some((run) => run.usedHistoryWrap), historyWrap);
    for (const run of fund) {
      const key = `${run.startDate}|${run.endDate}`;
      const expected = (uproRows.get(key)!.finalValue + tqqqRows.get(key)!.finalValue) / 2;
      assert.ok(Math.abs(run.finalValue - expected) <= 1e-9 * expected, `${key}: ${run.finalValue} vs ${expected}`);
    }
  });
}

test("windows where a sleeve trades still produce a finite fund", async () => {
  const fund = await runLetfFundRollingWindows({
    spx: { prices: SP, config: sleeveConfig("UPRO", 0), riskOffValuesByAsset: { SGOV }, riskOffOpenValuesByAsset: { SGOV } },
    ndx: { prices: NQ, config: sleeveConfig("TQQQ", 0), riskOffValuesByAsset: { SGOV }, riskOffOpenValuesByAsset: { SGOV } },
    rates: RATES, windowLength: 1, startDate: SP[30].date, endDate: END,
  });
  assert.ok(fund.some((run) => run.tradeCount > 0), "the band must trade");
  for (const run of fund) {
    assert.ok(Number.isFinite(run.finalValue) && run.finalValue > 0);
    assert.ok(run.maxDrawdownPct >= 0 && run.maxDrawdownPct < 100);
  }
});
