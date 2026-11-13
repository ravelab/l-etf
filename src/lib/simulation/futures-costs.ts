/**
 * What a futures backtest pays to trade: IBKR's per-contract fees (CPI-scaled to
 * the trade date), half-tick spreads, and risk-off ETF commissions.
 */

import { type FuturesContractSymbol } from "./futures-contracts";
import { getSymbolSpread } from "@/lib/constants";

/**
 * IBKR's all-in cost to trade one contract, per side, quoted in FEE_SCHEDULE_ANCHOR
 * dollars: $0.85 IBKR execution plus CME exchange/clearing/regulatory (~$1.39 on ES,
 * ~$1.60 on NQ).
 */
export const IBKR_FEE_PER_CONTRACT: Record<FuturesContractSymbol, number> = {
  ES: 2.24,
  NQ: 2.45,
  // Micro E-minis: $0.25 IBKR execution plus ~$0.37 CME/NFA. About 2.7x an E-mini
  // per dollar of notional, which is why micros only carry a sleeve's remainder.
  MES: 0.62,
  MNQ: 0.62,
};

/**
 * The dollars every fixed-dollar broker constant here is quoted in: CPI-U at this date.
 * Older trades pay the CPI-deflated equivalent, so a 1970 fill is charged a 1970-nominal
 * commission rather than a 2026 one. The level is spelled out instead of read off the CPI
 * series because that series is truncated at the simulation's end date — a window ending
 * in 1980 carries no 2026 row to anchor on.
 */
export const FEE_SCHEDULE_ANCHOR_DATE = "2026-07-01";

export const FEE_SCHEDULE_ANCHOR_CPI = 332.813;

const DEFAULT_RISKOFF_COMMISSION_PER_SHARE = 0.005;

const DEFAULT_RISKOFF_MIN_COMMISSION = 1.0;

const DEFAULT_RISKOFF_MAX_COMMISSION_PCT_NOTIONAL = 0.01;

export function getFuturesHalfSpreadPerContract(symbol: string): number {
  if (symbol.startsWith("MES")) return 0.625;
  if (symbol.startsWith("MNQ")) return 0.25;
  if (symbol.startsWith("ES")) return 6.25;
  if (symbol.startsWith("NQ")) return 2.5;
  return 0;
}

export function getTransactionSpreadCost(params: {
  instrument: "futures" | "riskoff";
  symbol: string;
  qtyDelta: number;
  fillPrice: number;
  dollarScale?: number;
}): number {
  if (params.instrument === "futures") {
    const dollarScale = Number.isFinite(params.dollarScale) && (params.dollarScale ?? 0) > 0
      ? (params.dollarScale as number)
      : 1;
    return Math.abs(params.qtyDelta) * getFuturesHalfSpreadPerContract(params.symbol) * dollarScale;
  }
  const spreadFrac = getSymbolSpread(params.symbol, false);
  const notional = Math.abs(params.qtyDelta) * params.fillPrice;
  return notional * spreadFrac;
}

export function getRiskOffCommission(params: {
  qtyDelta: number;
  fillPrice: number;
  dollarScale?: number;
}): number {
  const shares = Math.abs(params.qtyDelta);
  const notional = shares * params.fillPrice;
  if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(notional) || notional <= 0) return 0;
  const dollarScale = Number.isFinite(params.dollarScale) && (params.dollarScale ?? 0) > 0
    ? (params.dollarScale as number)
    : 1;
  const variable = shares * DEFAULT_RISKOFF_COMMISSION_PER_SHARE * dollarScale;
  const capped = Math.min(variable, notional * DEFAULT_RISKOFF_MAX_COMMISSION_PCT_NOTIONAL);
  return Math.max(DEFAULT_RISKOFF_MIN_COMMISSION * dollarScale, capped);
}

export function buildInflationDollarCostScaleLookup(
  monthlyCpi: Array<{ date: string; value: number }> | undefined,
  anchorDate: string,
  /**
   * CPI level at `anchorDate`, used when the series stops short of it — the engine only
   * ever sees CPI up to the simulation's end date. Without it a window ending in 1980
   * would anchor on 1980 and charge a present-day fee schedule in 1980 dollars.
   */
  anchorCpiFallback?: number
): (date: string) => number {
  const rows = (monthlyCpi ?? [])
    .filter((row) => Number.isFinite(row.value) && row.value > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 2) return () => 1;

  const lastRow = rows[rows.length - 1]!;
  let anchorCpi = NaN;
  if (lastRow.date >= anchorDate) {
    for (const row of rows) {
      if (row.date <= anchorDate) anchorCpi = row.value;
      else break;
    }
  } else if (Number.isFinite(anchorCpiFallback) && (anchorCpiFallback as number) > 0) {
    anchorCpi = anchorCpiFallback as number;
  }
  if (!Number.isFinite(anchorCpi) || anchorCpi <= 0) anchorCpi = lastRow.value;

  const cpiAtOrBefore = (date: string) => {
    let lo = 0;
    let hi = rows.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (rows[mid]!.date <= date) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return rows[Math.max(0, found)]!.value;
  };

  return (date: string) => {
    const cpi = cpiAtOrBefore(date);
    const scale = cpi / anchorCpi;
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
  };
}
