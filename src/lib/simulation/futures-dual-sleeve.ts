// A futures fund run as two independent sleeves, one per index family.
//
// The sleeves are NOT rebalanced against each other. Each compounds on its own,
// so a long run leaves them at whatever weights their returns produced. The single
// exception: on a day when both sleeves were risk-off and one is about to go
// risk-on, the fund resets to 50/50.
//
// That exception is free, and the timing is why. Both sleeves hold the SAME
// risk-off basket (one `riskOffAsset` for the whole fund), and the reset is
// applied BEFORE the day is stepped, while the re-entering sleeve still holds its
// basket rather than the futures it is about to buy. Giving each sleeve half of
// every combined holding leaves the fund's total share count in each ticker
// untouched, so nothing is traded and no spread or commission is due — only the
// internal attribution moves. Splitting the drifted weights any other way, or
// applying it a day later, would both book real trades.

import { buildEtfResult, createFuturesSleeve } from "@/lib/simulation/futures";
import type {
  FuturesSleeve,
  FuturesStrategyParams,
  FuturesStrategyResult,
  FuturesTransactionRow,
  SleeveHoldings,
} from "@/lib/simulation/futures";
import type { EtfResult } from "@/lib/simulation/types";

export type DualSleeveFuturesParams = {
  /** Row name in the results table, e.g. "Max 4.5x SPX / Max 3x NDX SMA". */
  displayName: string;
  /** Whole-fund equity at inception; each sleeve opens with half. */
  initialEquity: number;
  /**
   * Sleeve whose index, SMA series and leverage label stand for the fund in the
   * single-index fields of {@link FuturesStrategyResult}.
   */
  primary: Omit<FuturesStrategyParams, "initialEquity" | "displayName">;
  secondary: Omit<FuturesStrategyParams, "initialEquity" | "displayName">;
};

function halfOfSum(a: number[] | null, b: number[] | null): number[] | null {
  if (!a && !b) return null;
  const length = Math.max(a?.length ?? 0, b?.length ?? 0);
  return Array.from({ length }, (_, j) => ((a?.[j] ?? 0) + (b?.[j] ?? 0)) / 2);
}

/**
 * Hands both sleeves half of every combined holding, which is exactly half the
 * combined value each and leaves the fund's positions unchanged.
 */
function resetToHalves(sleeves: readonly FuturesSleeve[], cursor: readonly number[]): void {
  const [a, b] = sleeves.map((sleeve) => sleeve.readHoldings());
  const half: SleeveHoldings = {
    cash: (a.cash + b.cash) / 2,
    riskOffShares: halfOfSum(a.riskOffShares, b.riskOffShares),
    riskOffCash: halfOfSum(a.riskOffCash, b.riskOffCash),
    pendingCashInterest: (a.pendingCashInterest + b.pendingCashInterest) / 2,
  };
  const combined = sleeves.reduce((sum, sleeve, k) => sum + sleeve.equityAt(cursor[k]), 0);
  for (const [k, sleeve] of sleeves.entries()) {
    sleeve.writeHoldings(half, cursor[k], combined / 2);
  }
}

/**
 * Reads a sleeve's per-day series by date, carrying the last value forward for a
 * date the sleeve did not trade — the two index families keep different calendars.
 */
function byDateWithCarryForward(dates: string[], values: readonly number[]): (date: string) => number {
  const exact = new Map(dates.map((date, i) => [date, values[i] ?? 0]));
  return (date: string) => {
    const hit = exact.get(date);
    if (hit !== undefined) return hit;
    let lo = 0;
    let hi = dates.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] <= date) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best >= 0 ? values[best] ?? 0 : 0;
  };
}

/** Regime a sleeve is in on its own day `i`; an out-of-range day carries the last one. */
function investedAt(sleeve: FuturesSleeve, i: number): boolean {
  if (sleeve.invested.length === 0) return false;
  const clamped = Math.max(0, Math.min(i, sleeve.invested.length - 1));
  return Boolean(sleeve.invested[clamped]);
}

export function simulateDualSleeveFuturesStrategy(
  params: DualSleeveFuturesParams
): FuturesStrategyResult {
  const initialEquity = Number.isFinite(params.initialEquity) ? Math.max(0, params.initialEquity) : 0;
  const half = initialEquity / 2;
  const sleeves: FuturesSleeve[] = [
    createFuturesSleeve({ ...params.primary, initialEquity: half }),
    createFuturesSleeve({ ...params.secondary, initialEquity: half }),
  ];

  // The two index families keep their own trading calendars, so the fund walks the
  // union and steps a sleeve only on the days it actually has.
  const dates = [...new Set(sleeves.flatMap((sleeve) => sleeve.dates))].sort();
  const dayIndexByDate = sleeves.map(
    (sleeve) => new Map(sleeve.dates.map((date, i) => [date, i]))
  );
  const cursor = sleeves.map(() => 0);
  const dailyValues: number[] = [];

  for (const [k, date] of dates.entries()) {
    const nextIdx = dayIndexByDate.map((byDate) => byDate.get(date));

    if (k > 0) {
      const bothWereRiskOff = sleeves.every((sleeve, s) => !investedAt(sleeve, cursor[s]));
      const oneTurnsRiskOn = sleeves.some((sleeve, s) => {
        const i = nextIdx[s];
        return i !== undefined && investedAt(sleeve, i);
      });
      if (bothWereRiskOff && oneTurnsRiskOn) resetToHalves(sleeves, cursor);
    }

    for (const [s, sleeve] of sleeves.entries()) {
      const i = nextIdx[s];
      // Day 0 is established by the sleeve factory, so it is never stepped.
      if (i === undefined || i === 0) continue;
      sleeve.stepDay(i);
      cursor[s] = i;
    }

    dailyValues.push(sleeves.reduce((sum, sleeve, s) => sum + sleeve.equityAt(cursor[s]), 0));
  }

  const [primaryResult, secondaryResult] = sleeves.map((sleeve) => sleeve.finish());
  const finalEquity = dailyValues[dailyValues.length - 1] ?? 0;
  const costDollars = [primaryResult, secondaryResult].reduce((sum, result) => {
    const sleeveFinal = result.etfResult.dailyValues.at(-1) ?? 0;
    return sum + (result.etfResult.totalTradingCostPct / 100) * sleeveFinal;
  }, 0);

  // The ledger belongs to the FUND, so Value and Excess Liquidity have to be the
  // fund's. Each sleeve stamps its rows with its own equity — about half the fund —
  // which the transaction table would otherwise divide by the fund's full starting
  // amount and report as 0.50x from the first row. Add the other sleeve's
  // end-of-day figures for that date. `Leverage Δ` stays the acting sleeve's: it is
  // measured against that sleeve's own target, and the two targets differ.
  const fundRows = (
    own: FuturesStrategyResult,
    other: FuturesStrategyResult,
    otherSleeve: FuturesSleeve
  ): FuturesTransactionRow[] => {
    const otherEquity = byDateWithCarryForward(other.etfResult.dates, other.etfResult.dailyValues);
    const otherExcess = byDateWithCarryForward(
      otherSleeve.dates,
      otherSleeve.dates.map((_, i) => otherSleeve.excessLiquidityAt(i))
    );
    return own.transactions.map((row) => ({
      ...row,
      equity: row.equity + otherEquity(row.date),
      excessLiquidity: row.excessLiquidity + otherExcess(row.date),
    }));
  };

  const transactions: FuturesTransactionRow[] = [
    ...fundRows(primaryResult, secondaryResult, sleeves[1]),
    ...fundRows(secondaryResult, primaryResult, sleeves[0]),
  ].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));

  // CAGR, drawdown and Sharpe must come from the FUND's curve, never the primary
  // sleeve's — spreading the sleeve's result would keep its own statistics beside
  // the fund's values. The SMA overlay is the primary sleeve's, realigned onto the
  // union calendar so a day only the other index traded does not shift it.
  const primaryDates = primaryResult.etfResult.dates;
  const primarySmaByDate = new Map(
    primaryDates.map((date, i) => [date, primaryResult.etfResult.smaPrices[i]])
  );
  let lastSma = Number.NaN;
  const smaPrices = dates.map((date) => {
    const value = primarySmaByDate.get(date);
    if (value !== undefined && Number.isFinite(value)) lastSma = value;
    return lastSma;
  });

  const etfResult: EtfResult = buildEtfResult({
    id: "dual-sleeve-futures-sma",
    name: params.displayName,
    sourceIndex: params.primary.index,
    dates,
    dailyValues,
    smaSignals: primaryResult.etfResult.smaSignals,
    smaPrices,
    totalTradingCostPct: finalEquity > 0 ? (costDollars / finalEquity) * 100 : 0,
  });

  return {
    etfResult,
    targetLeverage: params.primary.targetLeverage,
    index: params.primary.index,
    transactions,
    initialEquity,
    // Leverage is measured per sleeve against its own target, so a single fund-level
    // figure would compare two different targets. Reported by the sleeves, not here.
    avgActualLeverageRiskOn: NaN,
    maxAbsLeverageDeltaRiskOnPct: NaN,
    riskOffSessionDayCount: dates.filter((_, k) =>
      sleeves.every((sleeve, s) => !investedAt(sleeve, dayIndexByDate[s].get(dates[k]) ?? cursor[s]))
    ).length,
    sessionDayCount: dates.length,
  };
}
