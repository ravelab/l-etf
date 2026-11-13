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
//
// Sleeves with DIFFERENT baskets cannot swap like for like, so the richer sleeve
// instead hands the poorer a pro-rata slice of everything it holds, in kind. If
// the re-entering sleeve is the richer one, its surplus basket stays unsold with
// the sleeve that remains risk-off; if it is the poorer, it receives a slice of
// the other basket and sells it with its own when it buys back in. Either way the
// only sales are the ones re-entry needs to reach half the fund.

import { buildEtfResult, createFuturesSleeve } from "@/lib/simulation/futures";
import type {
  FuturesSleeve,
  FuturesStrategyParams,
  FuturesStrategyResult,
  FuturesTransactionRow,
  SleeveHoldings,
} from "@/lib/simulation/futures";
import type { EtfResult } from "@/lib/simulation/types";
import type { TreasuryHoldings } from "@/lib/simulation/futures-collateral";
import { FuturesCashAccount } from "./futures-cash-account";

export type DualSleeveFuturesParams = {
  /** Row name in the results table, e.g. "Max 4.5x SPX / Max 3.5x NDX SMA". */
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

/** Ledger rows `[from, to)` of `sleeve`, booked while the other sleeve held `other`. */
type LedgerSegment = { sleeve: number; from: number; to: number; other: Record<string, number> };

function addPositions(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a };
  for (const [symbol, qty] of Object.entries(b)) out[symbol] = (out[symbol] ?? 0) + qty;
  return out;
}

function scaled(values: number[] | null, factor: number): number[] | null {
  return values ? values.map((v) => v * factor) : null;
}

function sum(a: number[] | null, b: number[] | null): number[] | null {
  if (!a && !b) return null;
  const length = Math.max(a?.length ?? 0, b?.length ?? 0);
  return Array.from({ length }, (_, j) => (a?.[j] ?? 0) + (b?.[j] ?? 0));
}

/**
 * Moves the richer sleeve's surplus over half the fund to the poorer one as a
 * proportional slice of its cash, basket shares and accrued interest.
 */
function combineTreasuries(a: SleeveHoldings, b: SleeveHoldings, aWeight: number, bWeight: number) {
  if (!a.treasuryHoldings && !b.treasuryHoldings) return undefined;
  return { SGOV: (a.treasuryHoldings?.SGOV ?? 0) * aWeight + (b.treasuryHoldings?.SGOV ?? 0) * bWeight,
    VGSH: (a.treasuryHoldings?.VGSH ?? 0) * aWeight + (b.treasuryHoldings?.VGSH ?? 0) * bWeight };
}

function moveSurplusInKind(sleeves: readonly FuturesSleeve[], cursor: readonly number[]): void {
  const equity = sleeves.map((sleeve, k) => sleeve.equityAt(cursor[k]));
  const half = (equity[0] + equity[1]) / 2;
  const donor = equity[0] >= equity[1] ? 0 : 1;
  const recipient = 1 - donor;
  if (!(equity[donor] > 0) || !(equity[donor] > half)) return;
  const moved = (equity[donor] - half) / equity[donor];
  const from = sleeves[donor].readHoldings();
  const to = sleeves[recipient].readHoldings();
  sleeves[donor].writeHoldings({
    cash: from.cash * (1 - moved),
    commoditiesCash: (from.commoditiesCash ?? 0) * (1 - moved),
    treasuryHoldings: combineTreasuries(from, to, 1 - moved, 0),
    riskOffShares: scaled(from.riskOffShares, 1 - moved),
    riskOffCash: scaled(from.riskOffCash, 1 - moved),
    pendingCashInterest: from.pendingCashInterest * (1 - moved),
  }, cursor[donor], half);
  sleeves[recipient].writeHoldings({
    cash: to.cash + from.cash * moved,
    commoditiesCash: (to.commoditiesCash ?? 0) + (from.commoditiesCash ?? 0) * moved,
    treasuryHoldings: combineTreasuries(from, to, moved, 1),
    riskOffShares: sum(to.riskOffShares, scaled(from.riskOffShares, moved)),
    riskOffCash: sum(to.riskOffCash, scaled(from.riskOffCash, moved)),
    pendingCashInterest: to.pendingCashInterest + from.pendingCashInterest * moved,
  }, cursor[recipient], half);
}

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
    commoditiesCash: ((a.commoditiesCash ?? 0) + (b.commoditiesCash ?? 0)) / 2,
    treasuryHoldings: combineTreasuries(a, b, 0.5, 0.5),
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
  params: DualSleeveFuturesParams,
  onCloseTreasuries?: (date: string, holdings: TreasuryHoldings) => void,
): FuturesStrategyResult {
  const initialEquity = Number.isFinite(params.initialEquity) ? Math.max(0, params.initialEquity) : 0;
  const half = initialEquity / 2;
  const sleeves: FuturesSleeve[] = [];
  // Both indices share one physical cash account, transfer band and Treasury
  // maintenance pass. Analytical callers without collateral retain their path.
  const cashAccount = params.primary.treasuryCollateral && params.secondary.treasuryCollateral
    ? new FuturesCashAccount() : undefined;
  // Every ledger row is booked inside exactly one of these runs, in the order the
  // fund executes them. Recording the OTHER sleeve's positions at that moment is
  // what lets each row carry the fund's holdings rather than one sleeve's.
  const segments: LedgerSegment[] = [];
  const attribute = (s: number, run: () => void) => {
    const other = sleeves[1 - s]?.positions() ?? {};
    const from = sleeves[s]?.transactionCount() ?? 0;
    run();
    segments.push({ sleeve: s, from, to: sleeves[s].transactionCount(), other });
  };
  attribute(0, () => sleeves.push(createFuturesSleeve({ ...params.primary, initialEquity: half }, cashAccount, run => attribute(0, run))));
  attribute(1, () => sleeves.push(createFuturesSleeve({ ...params.secondary, initialEquity: half }, cashAccount, run => attribute(1, run))));

  // The two index families keep their own trading calendars, so the fund walks the
  // union and steps a sleeve only on the days it actually has.
  const dates = [...new Set(sleeves.flatMap((sleeve) => sleeve.dates))].sort();
  const dayIndexByDate = sleeves.map(
    (sleeve) => new Map(sleeve.dates.map((date, i) => [date, i]))
  );
  const cursor = sleeves.map(() => 0);
  const dailyValues: number[] = [];
  const sameBasket = params.primary.riskOffAsset === params.secondary.riskOffAsset;

  for (const [k, date] of dates.entries()) {
    const nextIdx = dayIndexByDate.map((byDate) => byDate.get(date));

    if (k > 0) {
      const bothWereRiskOff = sleeves.every((sleeve, s) => !investedAt(sleeve, cursor[s]));
      const oneTurnsRiskOn = sleeves.some((sleeve, s) => {
        const i = nextIdx[s];
        return i !== undefined && investedAt(sleeve, i);
      });
      if (bothWereRiskOff && oneTurnsRiskOn) {
        if (sameBasket) resetToHalves(sleeves, cursor);
        else moveSurplusInKind(sleeves, cursor);
      }
    }

    for (const [s, sleeve] of sleeves.entries()) {
      const i = nextIdx[s];
      // Day 0 is established by the sleeve factory, so it is never stepped.
      if (i === undefined || i === 0) continue;
      attribute(s, () => sleeve.stepDay(i));
      cursor[s] = i;
    }
    cashAccount?.close();

    dailyValues.push(sleeves.reduce((sum, sleeve, s) => sum + sleeve.equityAt(cursor[s]), 0));
    if (onCloseTreasuries) {
      const holdings = sleeves.map(sleeve => sleeve.readHoldings());
      onCloseTreasuries(date, combineTreasuries(holdings[0], holdings[1], 1, 1) ?? { SGOV: 0, VGSH: 0 });
    }
  }

  const finished: FuturesStrategyResult[] = [];
  for (const [s, sleeve] of sleeves.entries()) attribute(s, () => finished.push(sleeve.finish()));
  const [primaryResult, secondaryResult] = finished;
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
  // Holdings follow the same rule: a row's own positions plus the other sleeve's at
  // the moment the row executed (see `attribute`).
  const fundRows = (
    own: FuturesStrategyResult,
    other: FuturesStrategyResult,
    otherSleeve: FuturesSleeve,
    ownIsPrimary: boolean,
    otherPositionsByRow: ReadonlyArray<Record<string, number>>
  ): FuturesTransactionRow[] => {
    const ownEquity = byDateWithCarryForward(own.etfResult.dates, own.etfResult.dailyValues);
    const otherEquity = byDateWithCarryForward(other.etfResult.dates, other.etfResult.dailyValues);
    const otherExcess = byDateWithCarryForward(
      otherSleeve.dates,
      otherSleeve.dates.map((_, i) => otherSleeve.excessLiquidityAt(i))
    );
    return own.transactions.map((row, r) => ({
      ...row,
      equity: row.equity + otherEquity(row.date),
      spxEquity: ownIsPrimary ? ownEquity(row.date) : otherEquity(row.date),
      excessLiquidity: row.excessLiquidity + otherExcess(row.date),
      ...(row.holdingsAfter
        ? { holdingsAfter: addPositions(row.holdingsAfter, otherPositionsByRow[r] ?? {}) }
        : {}),
    }));
  };

  const otherPositionsByRow = sleeves.map((_, s) => {
    const out: Array<Record<string, number>> = [];
    for (const seg of segments) {
      if (seg.sleeve !== s) continue;
      for (let r = seg.from; r < seg.to; r++) out[r] = seg.other;
    }
    return out;
  });
  const rowsBySleeve = [
    fundRows(primaryResult, secondaryResult, sleeves[1], true, otherPositionsByRow[0]),
    fundRows(secondaryResult, primaryResult, sleeves[0], false, otherPositionsByRow[1]),
  ];
  // Execution order, so each row's holdings follow from the one before it. The
  // stable date sort only matters if one sleeve's calendar ends before the other's,
  // which would otherwise leave its closing rows after the later dates.
  const transactions: FuturesTransactionRow[] = segments
    .flatMap((seg) => rowsBySleeve[seg.sleeve].slice(seg.from, seg.to))
    .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));

  // CAGR, drawdown and Sortino must come from the FUND's curve, never the primary
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
    name: params.primary.smaVolGate ? params.displayName.replace(/ SMA$/, " SMA Vol RSI") : params.displayName,
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
    // figure would compare two different targets. Keep both figures for the results
    // table instead of presenting an ambiguous fund-level average.
    avgActualLeverageRiskOn: NaN,
    maxAbsLeverageDeltaRiskOnPct: NaN,
    sleeveLeverageMetrics: {
      primary: {
        avgActualLeverageRiskOn: primaryResult.avgActualLeverageRiskOn,
        maxAbsLeverageDeltaRiskOnPct: primaryResult.maxAbsLeverageDeltaRiskOnPct,
      },
      secondary: {
        avgActualLeverageRiskOn: secondaryResult.avgActualLeverageRiskOn,
        maxAbsLeverageDeltaRiskOnPct: secondaryResult.maxAbsLeverageDeltaRiskOnPct,
      },
    },
    riskOffSessionDayCount: dates.filter((_, k) =>
      sleeves.every((sleeve, s) => !investedAt(sleeve, dayIndexByDate[s].get(dates[k]) ?? cursor[s]))
    ).length,
    sessionDayCount: dates.length,
  };
}
