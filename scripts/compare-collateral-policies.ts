/** Compare reserve composition without changing live accounts or generated snapshots. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createFuturesSleeve, DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY, type FuturesStrategyParams } from "../src/lib/simulation/futures";
import { simulateDualSleeveFuturesStrategy } from "../src/lib/simulation/futures-dual-sleeve";
import { buildFuturesLadderPlan } from "../src/lib/simulation/futures-plan";
import { buildFuturesRunPlans } from "../src/lib/simulation/futures-run-plan";
import { loadIndexPrices, loadBorrowRates, loadInflation, loadRiskOffRawSeriesForAssets } from "../src/lib/mcp/server-data";
import { alignRiskOffPriceSeries, getMarketDataWarmUpStartDate } from "../src/lib/fetch-market-data";
import { getDefaultSmaPeriod, getDefaultSmaUpperBuffer, getDefaultSmaLowerBuffer, DEFAULT_FUTURES_AMOUNT, DEFAULT_RISK_OFF_ASSETS, DEFAULT_LEVERAGE_TOLERANCE_PCT } from "../src/lib/simulation/defaults";
import type { TreasuryHoldings } from "../src/lib/simulation/futures-collateral";
import type { IndexKey } from "../src/lib/simulation/types";
import { cpiIndexRatioEndOverStart } from "../src/lib/inflation";

async function main() {
  const startDate = "1988-04-06", requestedEnd = "2026-11-13";
  const leverageTolerancePct = Number(process.env.LEVERAGE_TOLERANCE ?? DEFAULT_LEVERAGE_TOLERANCE_PCT);
  if (!Number.isFinite(leverageTolerancePct) || leverageTolerancePct < 0) throw new Error("Invalid LEVERAGE_TOLERANCE");
  const bands = Object.fromEntries((["sp500", "nasdaq100"] as const).map(index => [index, {
    period: getDefaultSmaPeriod(index), upperBuffer: getDefaultSmaUpperBuffer(index), lowerBuffer: getDefaultSmaLowerBuffer(index), volGate: true,
  }])) as Parameters<typeof buildFuturesLadderPlan>[0]["bands"];
  const warm = getMarketDataWarmUpStartDate(startDate, Math.max(280, bands.sp500.period, bands.nasdaq100.period));
  const [sp, nq, rates, cpi, raw] = await Promise.all([
    loadIndexPrices("sp500", warm, requestedEnd), loadIndexPrices("nasdaq100", warm, requestedEnd),
    loadBorrowRates(warm, requestedEnd), loadInflation(warm, requestedEnd),
    loadRiskOffRawSeriesForAssets(["BRK.B+GLDM", "VGSH", "SGOV"], warm, requestedEnd),
  ]);
  const endDate = [sp.at(-1)!.date, nq.at(-1)!.date, ...Object.values(raw).map(p => p.at(-1)!.date)].sort()[0];
  const prices = { sp500: sp.filter(p => p.date <= endDate), nasdaq100: nq.filter(p => p.date <= endDate) };
  const aligned = { sp500: alignRiskOffPriceSeries(prices.sp500.filter(p => p.date >= startDate), raw), nasdaq100: alignRiskOffPriceSeries(prices.nasdaq100.filter(p => p.date >= startDate), raw) };
  const steps = buildFuturesLadderPlan({ showEmulations: false, hasNasdaqData: true, bands, dualRiskOffAssets: DEFAULT_RISK_OFF_ASSETS });
  const output: unknown[] = [];
  const scenarios = [
    { id: "sgov-buffer", policy: "sgov-buffer", entryVgshPct: 100 },
    { id: "vgsh-only", policy: "vgsh-only", entryVgshPct: 100 },
    { id: "ndx-vgsh", policy: "ndx-vgsh", entryVgshPct: 100 },
    { id: "entry-only", policy: "entry-only", entryVgshPct: 100 },
    { id: "vgsh-above-sma", policy: "vgsh-above-sma", entryVgshPct: 100 },
    { id: "vgsh-above-sma-entry-80", policy: "vgsh-above-sma", entryVgshPct: 80 },
    { id: "vgsh-above-sma-ndx-only", policy: "vgsh-above-sma", entryVgshPct: 100 },
  ] as const;
  for (const scenario of scenarios) {
    const policy = scenario.policy;
    const plans = buildFuturesRunPlans({ steps, initialEquity: DEFAULT_FUTURES_AMOUNT,
      sleeveParams: (index: IndexKey, targetLeverage, maxLeverage, sma) => ({ index, prices: prices[index], rates, startDate, endDate,
        targetLeverage, maxLeverage, smaPeriod: sma.period, smaUpperBuffer: sma.upperBuffer, smaLowerBuffer: sma.lowerBuffer, smaVolGate: true,
        riskOffAsset: DEFAULT_RISK_OFF_ASSETS[index], treasuryCollateral: true, leverageTolerancePct,
        treasuryBuyPreference: scenario.id === "vgsh-above-sma-ndx-only" && index !== "nasdaq100" ? "entry-only" : policy,
        riskOnEntryVgshPct: scenario.entryVgshPct,
        riskOffCloseByTicker: aligned[index].closeValuesByAsset as Record<string, number[]>,
        riskOffOpenByTicker: aligned[index].openValuesByAsset as Record<string, number[]>, monthlyCpi: cpi,
        rollCalendarDaysBeforeExpiry: DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY,
      }) });
    for (const plan of plans) {
      const daily: Array<{ date: string; SGOV: number; VGSH: number; vgshPct: number | null }> = [];
      const observe = (date: string, h: TreasuryHoldings) => daily.push({ date, ...h, vgshPct: h.SGOV + h.VGSH > 1e-8 ? h.VGSH / (h.SGOV + h.VGSH) * 100 : null });
      const run = plan.kind === "dual" ? simulateDualSleeveFuturesStrategy(plan.dual, observe) : single(plan.single, observe);
      if (scenario.id === "sgov-buffer" && plan.kind === "dual" && leverageTolerancePct === DEFAULT_LEVERAGE_TOLERANCE_PCT) {
        const snapshot = JSON.parse(readFileSync("src/lib/tool-snapshots/futures.json", "utf8")).pageState;
        const expected = snapshot.result.etfResults.find((row: { name: string }) => row.name === run.etfResult.name);
        if (snapshot.startDate !== startDate || snapshot.endDate !== endDate || !expected ||
          Math.abs(expected.cagr - run.etfResult.cagr) > 1e-9 || Math.abs(expected.maxDrawdownPct - run.etfResult.maxDrawdownPct) > 1e-9) {
          throw new Error("Reserve comparison baseline must match the default futures snapshot; regenerate the snapshot if dates changed");
        }
      }
      const funded = daily.filter(d => d.vgshPct !== null);
      const last = daily.at(-1)!;
      const sumSgov = daily.reduce((s, d) => s + d.SGOV, 0), sumVgsh = daily.reduce((s, d) => s + d.VGSH, 0);
      const years = (Date.parse(endDate) - Date.parse(startDate)) / (365.25 * 86400000);
      const yearly = [...new Set(daily.map(d => d.date.slice(0, 4)))].map(year => {
        const rows = daily.filter(d => d.date.startsWith(year) && d.vgshPct !== null);
        return { year, averageVgshPct: rows.length ? rows.reduce((s, d) => s + d.vgshPct!, 0) / rows.length : null, endVgshPct: rows.at(-1)?.vgshPct ?? null };
      });
      const row = { policy: scenario.id, entryVgshPct: scenario.entryVgshPct, name: run.etfResult.name, startDate, endDate, initialEquity: DEFAULT_FUTURES_AMOUNT,
        averageDailyVgshPct: funded.reduce((s, d) => s + d.vgshPct!, 0) / funded.length,
        capitalWeightedVgshPct: sumVgsh / (sumSgov + sumVgsh) * 100, finalVgshPct: last.vgshPct,
        finalReserve: { SGOV: last.SGOV, VGSH: last.VGSH }, fundedDays: funded.length, emptyReserveDays: daily.length - funded.length,
        realCagr: (Math.pow(run.etfResult.finalValue / DEFAULT_FUTURES_AMOUNT / cpiIndexRatioEndOverStart(cpi, startDate, endDate), 1 / years) - 1) * 100,
        maxDrawdown: run.etfResult.maxDrawdownPct, yearly };
      output.push(row); console.log(JSON.stringify({ ...row, yearly: undefined }));
    }
  }
  mkdirSync("benchmark-results", { recursive: true });
  writeFileSync("benchmark-results/collateral-above-sma.json", JSON.stringify({ bands, leverageTolerancePct, riskOffAssets: DEFAULT_RISK_OFF_ASSETS,
    note: "Reserve = combined Treasury dollar holdings, excluding cash and futures notional. Daily averages exclude empty pools. Final mix is before forced liquidation. The fund uses the engine's actual two-sleeve in-kind resets. Default: buy SGOV while account holdings are below 200 equivalent shares or 20% of the Treasury pool; otherwise buy VGSH. Physical maintenance is netted account-wide; daily closes proxy live maintenance.", results: output }, null, 2));
}
function single(params: FuturesStrategyParams, observe: (date: string, h: TreasuryHoldings) => void) {
  const sleeve = createFuturesSleeve(params);
  for (let i = 0; i < sleeve.dates.length; i++) {
    if (i > 0) sleeve.stepDay(i);
    observe(sleeve.dates[i], sleeve.readHoldings().treasuryHoldings ?? { SGOV: 0, VGSH: 0 });
  }
  return sleeve.finish();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
