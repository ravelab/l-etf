// Futures trades at the open that come before routine sizing: the overnight mark,
// the exit to risk-off, and the margin / max-leverage trim.

import {
  contractSymbolsSortedForReduction,
  futuresCarryForHoldingPeriod,
  getContractMultiplier,
  reconcileLots,
  sumLots,
} from "./futures-contracts";
import {
  futuresLegLeverageDeltaPct,
  futuresPortfolioLeverageDeltaPctFromLots,
  totalFuturesNotionalAtMark,
} from "./futures-sizing";
import type { SleeveContext } from "./futures-sleeve-context";
import { takeSleeveInterestFields } from "./futures-sleeve-interest";
import { recordSleeveTransaction } from "./futures-sleeve-ledger";
import type { SleeveDay, SleeveState } from "./futures-sleeve-state";
import type { FuturesTransactionRow } from "./futures-types";

/** Prior close to today's open on held contracts, net of carry. */
export function realizeOvernightFuturesPnl(ctx: SleeveContext, st: SleeveState, today: SleeveDay): void {
  const { fundingSpreadAnnual } = ctx;
  const { prevSpot, idxOpen, gapCalendarDays, rateDaily, realizedDividend } = today;
  // Realize prior-close-to-current-open futures PnL before same-day open trades.
  // Charge futures carry to contracts held from the prior close, not contracts
  // opened today. Rate accrues per calendar day so weekend/holiday carry matches
  // cash sweep accrual. Fills/notional use estimated contract prices, but
  // portfolio economics stay on index moves plus explicit carry so financing is
  // not counted both in basis decay and collateral interest; netting the
  // realized dividend against the rate leaves a held position earning exactly
  // the index total return minus financing.
  if (st.contract && sumLots(st.lots) > 0) {
    const mult = getContractMultiplier(st.contract);
    const carryDaysSincePrevClose = Math.max(1, gapCalendarDays);
    const futuresCarrySincePrevClose = futuresCarryForHoldingPeriod({
      rateDaily,
      fundingSpreadAnnual,
      dividendForPeriod: realizedDividend,
      calendarDays: carryDaysSincePrevClose,
    });
    for (const [, q] of st.lots) {
      if (q <= 0) continue;
      const pnl = q * mult * (idxOpen - prevSpot - (prevSpot * futuresCarrySincePrevClose));
      st.cash += pnl;
      if (st.cashMember) st.cashMember.commoditiesCash += pnl;
    }
  }
}

/** Sells every contract at the open on the session a risk-off signal executes. */
export function flattenFuturesForRiskOff(ctx: SleeveContext, st: SleeveState, today: SleeveDay): void {
  const { params, futuresPriceScale, feeForUnits, futuresSpreadCost } = ctx;
  const { date, futuresFillAt } = today;
  const recordTransaction = (row: FuturesTransactionRow): void => recordSleeveTransaction(ctx, st, row);
  const takeCashInterestFieldsForAttribution = (amount: number) =>
    takeSleeveInterestFields(ctx, st, today.rateDaily, amount);
  // Flatten futures at index open, then buy risk-off legs at their opens (same-time book).
  if (sumLots(st.lots) > 0 && st.contract) {
    const totalBefore = sumLots(st.lots);
    let runningQty = totalBefore;
    let intRemainFlat = st.accruedInterestSinceLastTx;
    for (const sym of contractSymbolsSortedForReduction(st.lots, date)) {
      const qLeg = st.lots.get(sym) ?? 0;
      if (qLeg <= 0) continue;
      const delta = -qLeg;
      const fillPrice = futuresFillAt(sym);
      const fees = feeForUnits(sym, delta, date);
      const spread = futuresSpreadCost({
        instrument: "futures",
        symbol: sym,
        qtyDelta: delta,
        fillPrice,
        dollarScale: futuresPriceScale(fillPrice),
      });
      const levBefore = futuresLegLeverageDeltaPct({
        qty: runningQty,
        contract: st.contract,
        futuresMarkPrice: fillPrice,
        equity: st.cash,
        targetLeverage: params.targetLeverage,
      });
      st.cash -= (fees + spread);
      st.totalFees += fees;
      st.totalSpreadCosts += spread;
      runningQty -= qLeg;
      const levAfter = futuresLegLeverageDeltaPct({
        qty: runningQty,
        contract: runningQty > 0 ? st.contract : null,
        futuresMarkPrice: fillPrice,
        equity: st.cash,
        targetLeverage: params.targetLeverage,
      });
      const intAmt = intRemainFlat;
      if (intAmt > 0) intRemainFlat = 0;
      st.lots.set(sym, 0);
      recordTransaction({
        date,
        action: "sell",
        instrument: "futures",
        symbol: sym,
        qtyDelta: delta,
        qtyAfter: runningQty,
        fillPrice,
        fees,
        spread,
        cashInterestEarned: intAmt,
        ...takeCashInterestFieldsForAttribution(intAmt),
        excessLiquidity: 0,
        leverageDeltaPctBefore: levBefore,
        leverageDeltaPct: levAfter,
        // All-cash book after this fill (futures-only; risk-off not entered yet).
        equity: st.cash,
      });
    }
    reconcileLots(st.lots);
    st.contract = null;
    st.accruedInterestSinceLastTx = 0;
  }
}

/** Peels contracts at open fills while maintenance or max leverage is breached. */
export function trimFuturesAtOpen(ctx: SleeveContext, st: SleeveState, today: SleeveDay): void {
  const {
    params, invested, maintMarginRate, maxLeverage, leverageTolerancePct, futuresPriceScale, feeForUnits,
    futuresSpreadCost, reductionTakeUnits,
  } = ctx;
  const { i, date, futuresFillAt } = today;
  const recordTransaction = (row: FuturesTransactionRow): void => recordSleeveTransaction(ctx, st, row);
  const takeCashInterestFieldsForAttribution = (amount: number) =>
    takeSleeveInterestFields(ctx, st, today.rateDaily, amount);
  // Open-only risk trim: if maintenance or max leverage is already breached at **open** marks,
  // peel futures at open fills. We do not trade futures at the close for leverage or margin.
  // Leverage-only breach uses the same relative band as drift (`leverageTolerancePct`): peel
  // only when notional/equity exceeds maxLeverage * (1 + tolerance/100), so small overages
  // do not fight routine rebalance sizing (reduces 2↔3 contract toggling when max ≈ target).
  if (invested[i] && !(st.riskOffShares || st.riskOffCash) && st.contract != null && sumLots(st.lots) > 0) {
    const markOpen = (sym: string) => futuresFillAt(sym);
    let intRemainOpenTrim = st.accruedInterestSinceLastTx;
    const openLevTrimBreachThreshold =
      Number.isFinite(maxLeverage) && maxLeverage > 0
        ? maxLeverage * (1 + leverageTolerancePct / 100)
        : Number.POSITIVE_INFINITY;
    while (sumLots(st.lots) > 0 && st.contract != null) {
      const notionalO = totalFuturesNotionalAtMark({
        lots: st.lots,
        contract: st.contract,
        mark: markOpen,
      });
      const equityO = st.cash;
      const excessO = equityO - notionalO * maintMarginRate;
      const levO = equityO > 0 ? notionalO / equityO : Number.POSITIVE_INFINITY;
      const levBreaches =
        Number.isFinite(maxLeverage) && maxLeverage > 0 && levO > openLevTrimBreachThreshold;
      if (excessO > 0 && !levBreaches) break;

      const sym =
        contractSymbolsSortedForReduction(st.lots, date).find((s) => (st.lots.get(s) ?? 0) > 0) ?? null;
      if (sym == null) break;
      const q0 = st.lots.get(sym) ?? 0;
      if (q0 <= 0) break;

      const fillPrice = futuresFillAt(sym);
      const feePerContract = feeForUnits(sym, 1, date);
      const spreadPerContract = futuresSpreadCost({
        instrument: "futures",
        symbol: sym,
        qtyDelta: -1,
        fillPrice,
        dollarScale: futuresPriceScale(fillPrice),
      });
      const transactionCostPerContract = feePerContract + spreadPerContract;
      const notionalPerContract =
        st.contract != null ? getContractMultiplier(st.contract) * fillPrice : 0;

      let sellQty = 1;
      if (
        Number.isFinite(notionalPerContract) &&
        notionalPerContract > 0 &&
        Number.isFinite(transactionCostPerContract) &&
        transactionCostPerContract >= 0
      ) {
        const equityBeforeBatch = equityO;
        const maintenanceReliefPerContract =
          notionalPerContract * maintMarginRate - transactionCostPerContract;
        if (excessO <= 0 && maintenanceReliefPerContract > 0) {
          sellQty = Math.max(
            sellQty,
            Math.floor((-excessO) / maintenanceReliefPerContract) + 1
          );
        }
        if (levBreaches) {
          const leverageReliefPerContract =
            notionalPerContract - maxLeverage * transactionCostPerContract;
          const leverageExcess = notionalO - maxLeverage * equityBeforeBatch;
          if (leverageReliefPerContract > 0 && leverageExcess > 0) {
            sellQty = Math.max(sellQty, Math.ceil(leverageExcess / leverageReliefPerContract));
          } else if (leverageExcess > 0) {
            sellQty = q0;
          }
        }
      }
      sellQty = reductionTakeUnits(sym, q0, Math.max(1, Math.min(q0, Math.floor(sellQty))));

      const fees = feePerContract * sellQty;
      const spread =
        sellQty === 1
          ? spreadPerContract
          : futuresSpreadCost({
              instrument: "futures",
              symbol: sym,
              qtyDelta: -sellQty,
              fillPrice,
              dollarScale: futuresPriceScale(fillPrice),
            });
      const levBeforeTrim = futuresPortfolioLeverageDeltaPctFromLots({
        lots: st.lots,
        contract: st.contract,
        equity: st.cash,
        targetLeverage: params.targetLeverage,
        mark: markOpen,
      });
      st.cash -= fees + spread;
      st.totalFees += fees;
      st.totalSpreadCosts += spread;
      st.lots.set(sym, q0 - sellQty);
      reconcileLots(st.lots);
      const afterTotal = sumLots(st.lots);
      if (afterTotal === 0) {
        st.contract = null;
      }
      const levAfterTrim = futuresPortfolioLeverageDeltaPctFromLots({
        lots: st.lots,
        contract: afterTotal > 0 ? st.contract : null,
        equity: st.cash,
        targetLeverage: params.targetLeverage,
        mark: markOpen,
      });
      const intAmt = intRemainOpenTrim;
      if (intAmt > 0) intRemainOpenTrim = 0;
      const isMarginLiquidation = excessO <= 0;
      recordTransaction({
        date,
        action: "sell",
        instrument: "futures",
        symbol: isMarginLiquidation ? `${sym} (LIQUIDATE)` : sym,
        qtyDelta: -sellQty,
        qtyAfter: afterTotal,
        fillPrice,
        fees,
        spread,
        cashInterestEarned: intAmt,
        ...takeCashInterestFieldsForAttribution(intAmt),
        excessLiquidity: 0,
        leverageDeltaPctBefore: levBeforeTrim,
        leverageDeltaPct: levAfterTrim,
        equity: st.cash,
      });
      if (intAmt > 0) st.accruedInterestSinceLastTx = 0;
    }
  }
}
