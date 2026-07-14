import type { SmaTradeRow } from "@/lib/sma-trade-rows";

/**
 * Per-segment metrics for the SMA card's Trade Days table. A segment runs from
 * one trade row to the next (or to the window end for the last row).
 *
 * `eventPrice` on each row and `finalEtfPrice` are anchored to end-of-window
 * dollars (see buildSmaTradeRows), so a ratio of two of them is already a REAL
 * return — never deflate it by inflation again. Only `riskOffLookups` hold raw
 * nominal prices and need the single inflation deflation.
 */
export interface SmaSegmentContext {
  tradeRows: SmaTradeRow[];
  /** Last date of the backtest window (segment end for the final row). */
  endDate: string;
  /** ETF trade price on endDate — same end-of-window dollars as row eventPrices. */
  finalEtfPrice: number;
  annualizedInflation: number;
  /** date → nominal close, one map per risk-off component. */
  riskOffLookups: Array<Map<string, number>>;
}

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

function getYearsBetween(ctx: SmaSegmentContext, index: number): number | null {
  const current = ctx.tradeRows[index]?.tradingDay;
  const next = ctx.tradeRows[index + 1]?.tradingDay ?? ctx.endDate;
  if (!current || !next) return null;
  const ms = new Date(`${next}T00:00:00Z`).getTime() - new Date(`${current}T00:00:00Z`).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms / MS_PER_YEAR;
}

export function getDaysTillNextEvent(ctx: SmaSegmentContext, index: number): number | null {
  if (ctx.tradeRows[index]?.isEndLiquidation) return null;
  const current = ctx.tradeRows[index]?.tradingDay;
  const next = ctx.tradeRows[index + 1]?.tradingDay ?? ctx.endDate;
  if (!current || !next) return null;
  const currentMs = new Date(`${current}T00:00:00Z`).getTime();
  const nextMs = new Date(`${next}T00:00:00Z`).getTime();
  if (!Number.isFinite(currentMs) || !Number.isFinite(nextMs)) return null;
  return Math.max(0, Math.round((nextMs - currentMs) / 86400000));
}

/** Real CAGR of holding the ETF over a risk-on segment (row must be a buy). */
export function getRiskOnRealCagr(ctx: SmaSegmentContext, index: number): number | null {
  if (ctx.tradeRows[index]?.isEndLiquidation) return null;
  const currentPrice = ctx.tradeRows[index]?.eventPrice;
  const nextPrice = ctx.tradeRows[index + 1]?.eventPrice ?? ctx.finalEtfPrice;
  if (
    currentPrice == null || nextPrice == null ||
    !Number.isFinite(currentPrice) || !Number.isFinite(nextPrice) ||
    currentPrice <= 0 || nextPrice <= 0
  ) return null;
  if (ctx.tradeRows[index]?.signalType !== "buy") return null;
  const years = getYearsBetween(ctx, index);
  if (!years || years <= 0) return null;
  // Anchored-price ratio is already a real return.
  const realRatio = nextPrice / currentPrice;
  if (realRatio <= 0) return null;
  return (Math.pow(realRatio, 1 / years) - 1) * 100;
}

/** Real total return of the equal-weight risk-off basket over a risk-off segment (row must be a sell). */
export function getRiskOffTotalRealReturn(ctx: SmaSegmentContext, index: number): number | null {
  if (ctx.tradeRows[index]?.isEndLiquidation) return null;
  if (ctx.tradeRows[index]?.signalType !== "sell") return null;
  if (ctx.riskOffLookups.length === 0) return null;
  const sellDate = ctx.tradeRows[index]?.tradingDay;
  const buyDate = ctx.tradeRows[index + 1]?.tradingDay ?? ctx.endDate;
  if (!sellDate || !buyDate) return null;
  const years = getYearsBetween(ctx, index);
  if (!years || years <= 0) return null;
  // Each component bought at equal weight; compute each component's return then average
  let totalReturn = 0;
  let count = 0;
  for (const lookup of ctx.riskOffLookups) {
    const sellPrice = lookup.get(sellDate);
    const buyPrice = lookup.get(buyDate);
    if (sellPrice == null || buyPrice == null || sellPrice <= 0 || buyPrice <= 0) continue;
    totalReturn += buyPrice / sellPrice;
    count++;
  }
  if (count === 0) return null;
  const avgNominalReturn = totalReturn / count;
  // Risk-off lookups are nominal — deflate once to convert to real.
  const inflationFactor = Math.pow(1 + ctx.annualizedInflation, years);
  return (avgNominalReturn / inflationFactor - 1) * 100;
}

export function getRiskOffRealCagr(ctx: SmaSegmentContext, index: number): number | null {
  const totalReturn = getRiskOffTotalRealReturn(ctx, index);
  const years = getYearsBetween(ctx, index);
  if (totalReturn == null || years == null || years <= 0) return null;
  const ratio = 1 + totalReturn / 100;
  if (ratio <= 0) return null;
  return (Math.pow(ratio, 1 / years) - 1) * 100;
}

/** Multiplier: real risk-off ending value / real ending value had we stayed risk-on. */
export function getRiskOffAdvantage(ctx: SmaSegmentContext, index: number): number | null {
  if (ctx.tradeRows[index]?.isEndLiquidation) return null;
  if (ctx.tradeRows[index]?.signalType !== "sell") return null;
  const riskOff = getRiskOffTotalRealReturn(ctx, index);
  const sellPrice = ctx.tradeRows[index]?.eventPrice;
  const buyPrice = ctx.tradeRows[index + 1]?.eventPrice ?? ctx.finalEtfPrice;
  if (
    riskOff == null ||
    sellPrice == null || buyPrice == null ||
    !Number.isFinite(sellPrice) || !Number.isFinite(buyPrice) ||
    sellPrice <= 0 || buyPrice <= 0
  ) {
    return null;
  }
  // Anchored-price ratio is already a real return.
  const realRiskOnRatio = buyPrice / sellPrice;
  if (realRiskOnRatio <= 0) return null;
  const realRiskOffRatio = 1 + riskOff / 100;
  return realRiskOffRatio / realRiskOnRatio;
}
