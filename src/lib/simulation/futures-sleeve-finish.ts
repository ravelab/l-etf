// End of the run: terminal liquidation and the strategy result.

import { formatRiskOffLiquidationAbbrev } from "@/lib/constants";
import { riskOffCloseMarkPrice } from "@/lib/simulation/risk-off";
import type { EtfResult } from "@/lib/simulation/types";
import type { CollateralTrade } from "./futures-collateral";
import {
  contractSymbolsSortedForReduction,
  futuresBasisFillPrice,
  reconcileLots,
  sumLots,
} from "./futures-contracts";
import { getRiskOffCommission } from "./futures-costs";
import {
  buildEtfResult,
  clampToFinite,
  formatLeverageLabel,
  futuresLegLeverageDeltaPct,
  futuresPortfolioLeverageDeltaPctFromLots,
} from "./futures-sizing";
import { MAX_ABS_DIVIDEND_DAILY, type SleeveContext } from "./futures-sleeve-context";
import { creditSleevePendingCashInterest, sweepNetAnnualPctFromRateDaily } from "./futures-sleeve-interest";
import { bookSleeveCollateralTrades, recordSleeveTransaction } from "./futures-sleeve-ledger";
import type { SleeveState } from "./futures-sleeve-state";
import type {
  FuturesSleeve,
  FuturesStrategyParams,
  FuturesStrategyResult,
  FuturesTransactionRow,
} from "./futures-types";

function futuresStrategyName(params: FuturesStrategyParams, leverageLabel: string): string {
  const name = params.displayName ?? `${leverageLabel}x ${params.index === "sp500" ? "SPX" : "NDX"} SMA`;
  return params.smaVolGate ? name.replace(/ SMA$/, " SMA Vol RSI") : name;
}

/** A window with fewer than two sessions: nothing trades and the result is empty. */
export function emptyFuturesSleeve(params: FuturesStrategyParams): FuturesSleeve {
  const leverageLabel = formatLeverageLabel(params.targetLeverage);
  const empty: EtfResult = buildEtfResult({
    id: `${params.targetLeverage}x-${params.index}-futures-sma`,
    name: futuresStrategyName(params, leverageLabel),
    sourceIndex: params.index,
    dates: [],
    dailyValues: [],
    smaSignals: [],
    smaPrices: [],
    totalTradingCostPct: 0,
  });
  const emptyEquity = clampToFinite(params.initialEquity, 0);
  return {
    dates: [],
    invested: [],
    equityAt: () => emptyEquity,
    excessLiquidityAt: () => emptyEquity,
    stepDay: () => {},
    readHoldings: () => ({ cash: emptyEquity, riskOffShares: null, riskOffCash: null, pendingCashInterest: 0 }),
    writeHoldings: () => {},
    positions: () => ({}),
    transactionCount: () => 0,
    finish: () => ({
      etfResult: empty,
      targetLeverage: params.targetLeverage,
      index: params.index,
      transactions: [],
      initialEquity: emptyEquity,
      avgActualLeverageRiskOn: NaN,
      maxAbsLeverageDeltaRiskOnPct: NaN,
      riskOffSessionDayCount: 0,
      sessionDayCount: 0,
    }),
  };
}

/**
 * Closes the book at the window's end — liquidation rows and their costs are
 * deducted from the final value — and builds the strategy result.
 */
export function finishSleeve(ctx: SleeveContext, st: SleeveState): FuturesStrategyResult {
  const {
    params, dates, adjCloses, smaInput, indexOpenPx, sma, invested, rateLookup, spreadAnnual,
    feeDollarScaleForDate, futuresPriceScale, feeForUnits, futuresSpreadCost, collateral, heldTickers,
  } = ctx;
  const recordTransaction = (row: FuturesTransactionRow): void => recordSleeveTransaction(ctx, st, row);
  const bookCollateralTrades = (trades: CollateralTrade[], tradeDate: string): void =>
    bookSleeveCollateralTrades(ctx, st, trades, tradeDate);
  const creditPendingCashInterest = (): number => creditSleevePendingCashInterest(st);
  // Book-close row for the transaction ledger (same idea as backtest SMA tables).
  const lastIdx = dates.length - 1;
  if (lastIdx >= 0) {
    // Post the final month's sweep to cash for the ledger. No equity adjustment:
    // `dailyEquity` already carries the accrued balance day by day.
    creditPendingCashInterest();
  }
  if (collateral && lastIdx >= 0 && collateral.value() > 0) {
    const before = st.cash;
    const start = st.transactions.length;
    bookCollateralTrades(collateral.liquidate(dates[lastIdx]), dates[lastIdx]);
    for (let j = start; j < st.transactions.length; j++) st.transactions[j].isEndLiquidation = true;
    st.dailyEquity[lastIdx] += st.cash - before;
  }
  const windowFinalEquity = st.dailyEquity[lastIdx] ?? 0;
  if (st.transactions.length > 0 && lastIdx >= 0 && windowFinalEquity > 0) {
    const finalDate = dates[lastIdx]!;
    const endsRiskOn = Boolean(invested[lastIdx]);
    const hasOpenFutures = st.contract != null && sumLots(st.lots) > 0;

    // Helper to compute a basis-adjusted futures price at the window close.
    const finalRateDaily = rateLookup.getRate(finalDate);
    const finalSpot = smaInput[lastIdx] ?? 0;
    const finalOpen =
      Number.isFinite(indexOpenPx[lastIdx]) && (indexOpenPx[lastIdx] as number) > 0
        ? (indexOpenPx[lastIdx] as number)
        : finalSpot;
    const finalSpotRet = lastIdx >= 1 && (smaInput[lastIdx - 1] ?? 0) > 0
      ? (finalSpot / (smaInput[lastIdx - 1] as number)) - 1
      : 0;
    const finalTrPrev = adjCloses[Math.max(0, lastIdx - 1)];
    const finalTrNow = adjCloses[lastIdx];
    const finalTrRet =
      Number.isFinite(finalTrPrev) && Number.isFinite(finalTrNow) && (finalTrPrev ?? 0) > 0 && (finalTrNow ?? 0) > 0
        ? ((finalTrNow as number) / (finalTrPrev as number)) - 1
        : finalSpotRet;
    const finalDividendDailyRaw = finalTrRet - finalSpotRet;
    const finalDividendDaily = Number.isFinite(finalDividendDailyRaw)
      ? Math.max(-MAX_ABS_DIVIDEND_DAILY, Math.min(MAX_ABS_DIVIDEND_DAILY, finalDividendDailyRaw))
      : 0;
    const futuresFillAtFinal = (symbol: string, spotPrice = finalOpen) => futuresBasisFillPrice({
      spotPrice,
      symbol,
      tradeDate: finalDate,
      rateDaily: finalRateDaily,
      dividendDaily: finalDividendDaily,
    });

    if (endsRiskOn && hasOpenFutures && st.contract != null) {
      const markFinal = (sym: string) => futuresFillAtFinal(sym);
      const ordered = contractSymbolsSortedForReduction(st.lots, finalDate);
      let totalFeesTerm = 0;
      let totalSpreadTerm = 0;
      for (const sym of ordered) {
        const qLeg = st.lots.get(sym) ?? 0;
        if (qLeg <= 0) continue;
        const fp = futuresFillAtFinal(sym);
        totalFeesTerm += feeForUnits(sym, qLeg, finalDate);
        totalSpreadTerm += futuresSpreadCost({
          instrument: "futures",
          symbol: sym,
          qtyDelta: -qLeg,
          fillPrice: fp,
          dollarScale: futuresPriceScale(fp),
        });
      }
      const equityNet = Math.max(0, windowFinalEquity - totalFeesTerm - totalSpreadTerm);
      const levAfterTerm = futuresLegLeverageDeltaPct({
        qty: 0,
        contract: null,
        futuresMarkPrice: finalOpen,
        equity: equityNet,
        targetLeverage: params.targetLeverage,
      });
      st.dailyEquity[lastIdx] = equityNet;
      st.totalFees += totalFeesTerm;
      st.totalSpreadCosts += totalSpreadTerm;
      let runQty = sumLots(st.lots);
      const cFam = st.contract;
      let intRemainTerm = st.accruedInterestSinceLastTx;
      for (const sym of ordered) {
        const qLeg = st.lots.get(sym) ?? 0;
        if (qLeg <= 0) continue;
        const fillPrice = futuresFillAtFinal(sym);
        const fees = feeForUnits(sym, qLeg, finalDate);
        const spread = futuresSpreadCost({
          instrument: "futures",
          symbol: sym,
          qtyDelta: -qLeg,
          fillPrice,
          dollarScale: futuresPriceScale(fillPrice),
        });
        const levBefore = futuresPortfolioLeverageDeltaPctFromLots({
          lots: st.lots,
          contract: cFam,
          equity: windowFinalEquity,
          targetLeverage: params.targetLeverage,
          mark: markFinal,
        });
        runQty -= qLeg;
        st.lots.set(sym, 0);
        reconcileLots(st.lots);
        const levAfter =
          runQty === 0
            ? levAfterTerm
            : futuresPortfolioLeverageDeltaPctFromLots({
                lots: st.lots,
                contract: cFam,
                equity: equityNet,
                targetLeverage: params.targetLeverage,
                mark: markFinal,
              });
        const intAmt = intRemainTerm;
        if (intAmt > 0) intRemainTerm = 0;
        const sweepMeta =
          intAmt > 0
            ? {
                cashInterestTradingDays: Math.max(1, st.interestSweepSessionCount),
                cashInterestAnnualRatePct: sweepNetAnnualPctFromRateDaily(finalRateDaily, spreadAnnual),
              }
            : {};
        if (intAmt > 0) st.interestSweepSessionCount = 0;
        recordTransaction({
          date: finalDate,
          action: "sell",
          instrument: "futures",
          symbol: `${sym} (LIQUIDATE)`,
          qtyDelta: -qLeg,
          qtyAfter: runQty,
          fillPrice,
          fees,
          spread,
          cashInterestEarned: intAmt,
          ...sweepMeta,
          excessLiquidity: equityNet,
          leverageDeltaPctBefore: levBefore,
          leverageDeltaPct: levAfter,
          equity: equityNet,
          ...(runQty === 0 ? { isEndLiquidation: true as const } : {}),
        });
      }
      st.accruedInterestSinceLastTx = 0;
    } else if (!endsRiskOn && (st.riskOffShares || st.riskOffCash)) {
      // For risk-off, keep a single terminal ledger row (no per-leg liquidation).
      let totalRiskOffExitFees = 0;
      let totalRiskOffExitSpread = 0;
      const soldValueByTicker: Record<string, number> = {};
      for (let j = 0; j < heldTickers.length; j++) {
        const t = heldTickers[j];
        const shares = st.riskOffShares?.[j] ?? 0;
        if (!(Number.isFinite(shares) && shares > 0)) continue;
        const closeArr = params.riskOffCloseByTicker?.[t];
        const px = riskOffCloseMarkPrice({
          closeValues: closeArr,
          index: lastIdx,
          lastPrice: st.riskOffLastPrice?.[j],
        });
        if (!Number.isFinite(px) || (px as number) <= 0) continue;
        const fillPrice = px as number;
        soldValueByTicker[t] = -shares * fillPrice;
        totalRiskOffExitFees += getRiskOffCommission({
          qtyDelta: shares,
          fillPrice,
          dollarScale: feeDollarScaleForDate(finalDate),
        });
        totalRiskOffExitSpread += futuresSpreadCost({
          instrument: "riskoff",
          symbol: t,
          qtyDelta: shares,
          fillPrice,
        });
      }
      const riskOffEquityNet = Math.max(0, windowFinalEquity - totalRiskOffExitFees - totalRiskOffExitSpread);
      // Make the strategy's reported end value reflect closing costs.
      st.dailyEquity[lastIdx] = riskOffEquityNet;
      st.totalFees += totalRiskOffExitFees;
      st.totalSpreadCosts += totalRiskOffExitSpread;
      // The basket is closed out, so the row is stamped with nothing left in it.
      st.riskOffShares = null;
      st.riskOffCash = null;
      st.riskOffLastPrice = null;
      recordTransaction({
        date: finalDate,
        action: "sell",
        instrument: "riskoff",
        symbol: `${formatRiskOffLiquidationAbbrev(params.riskOffAsset)} (LIQUIDATE)`,
        qtyDelta: 0,
        qtyAfter: 0,
        fillPrice: 0,
        fees: totalRiskOffExitFees,
        spread: totalRiskOffExitSpread,
        cashInterestEarned: 0,
        excessLiquidity: riskOffEquityNet,
        leverageDeltaPct: 0,
        equity: riskOffEquityNet,
        isEndLiquidation: true as const,
        legValues: soldValueByTicker,
      });
    }
  }

  // Total trading cost expressed as a percent of ending equity.
  const finalEquity = st.dailyEquity[st.dailyEquity.length - 1] ?? 0;
  const totalTradingCostPct = finalEquity > 0 ? ((st.totalFees + st.totalSpreadCosts) / finalEquity) * 100 : 0;

  const leverageLabel = formatLeverageLabel(params.targetLeverage);
  const name = futuresStrategyName(params, leverageLabel);
  const id = `${params.targetLeverage}x-${params.index}-futures-sma`;
  const etfResult = buildEtfResult({
    id,
    name,
    sourceIndex: params.index,
    dates,
    dailyValues: st.dailyEquity,
    smaSignals: sma.signals,
    smaPrices: sma.smaValues,
    totalTradingCostPct,
  });

  let riskOffSessionDayCount = 0;
  for (let i = 0; i < invested.length; i++) {
    if (!invested[i]) riskOffSessionDayCount += 1;
  }
  const avgActualLeverageRiskOn =
    st.riskOnLeverageDayCount > 0 ? st.sumActualLeverageRiskOn / st.riskOnLeverageDayCount : NaN;

  return {
    etfResult,
    targetLeverage: params.targetLeverage,
    index: params.index,
    transactions: st.transactions,
    initialEquity: clampToFinite(params.initialEquity, 0),
    avgActualLeverageRiskOn,
    maxAbsLeverageDeltaRiskOnPct: st.maxAbsLeverageDeltaRiskOnPct,
    riskOffSessionDayCount,
    sessionDayCount: invested.length,
  };
}
