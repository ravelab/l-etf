// End of a sleeve's trading day.

import { getContractMultiplier, sumLots } from "./futures-contracts";
import { markRiskOffBasketAtClose } from "./futures-riskoff-basket";
import { clampToFinite, computeLeverageDeltaPct, totalFuturesNotionalAtMark } from "./futures-sizing";
import type { SleeveContext } from "./futures-sleeve-context";
import { accrueSleeveCashInterest } from "./futures-sleeve-interest";
import type { SleeveDay, SleeveState } from "./futures-sleeve-state";

/**
 * The close: mark futures and the basket, run Treasury maintenance, record the
 * day's equity and leverage. A wipe-out zeroes the rest of the run (`ruined`).
 */
export function closeSleeveDay(
  ctx: SleeveContext,
  st: SleeveState,
  today: SleeveDay,
  wantsRiskOn: boolean,
  targetLev: number,
): void {
  const {
    params, dates, fullAboveSmaByDate, invested, spreadAnnual, freeCashAt, maintMarginRate, collateral,
    cashAccount, sharedCashAccount,
  } = ctx;
  const { i, date, spot, idxOpen, rateDaily, futuresFillAt } = today;
  const accrueCashInterest = (amount: number, days: number): void => accrueSleeveCashInterest(st, amount, days);
  // Mark-to-market remaining open-to-close futures PnL after open trades.
  // Daily carry was already attributed to positions held from the prior close.
  const markFuturesClose = (sym: string) => futuresFillAt(sym, spot);
  st.ledgerFuturesMark = markFuturesClose;
  if (st.contract != null && sumLots(st.lots) > 0) {
    const mult = getContractMultiplier(st.contract);
    for (const [, q] of st.lots) {
      if (q <= 0) continue;
      const pnl = q * mult * (spot - idxOpen);
      st.cash += pnl;
      if (st.cashMember) st.cashMember.commoditiesCash += pnl;
    }
  }

  if (collateral) {
    st.cash += collateral.mark(i, date, false);
    st.collateralMarginRequirement = st.contract && sumLots(st.lots) > 0
      ? totalFuturesNotionalAtMark({ lots: st.lots, contract: st.contract, mark: markFuturesClose }) * maintMarginRate : 0;
    st.entryClose = !st.collateralRiskOnAtLastClose;
    if (wantsRiskOn) {
      st.maintenanceVgsh = st.entryClose || params.treasuryBuyPreference === "vgsh-only" ||
        ((params.treasuryBuyPreference ?? "ndx-vgsh") === "ndx-vgsh" && params.index === "nasdaq100") ||
        (params.treasuryBuyPreference === "vgsh-above-sma" && fullAboveSmaByDate.get(date) === true);
    }
    st.collateralRiskOnAtLastClose = wantsRiskOn;
  } else {
    // Legacy analytical cash-sweep mode for callers that do not request the
    // Treasury account model. This is not IBKR commodities cash eligibility.
    const cashYieldBase = Math.max(0, st.cash - freeCashAt(date));
    const spreadDaily = spreadAnnual / 360;
    const cashRateDaily = Math.max(0, rateDaily - spreadDaily);
    accrueCashInterest(cashYieldBase * cashRateDaily, 1);
  }

  // Total equity includes any risk-off holdings marked to today's close.
  const riskOffValueAtClose = markRiskOffBasketAtClose(ctx, st, today);

  st.closeIndex = i;
  st.closeBasket = riskOffValueAtClose;
  if (st.cashMember) st.cashMember.margin = st.collateralMarginRequirement;
  if (!sharedCashAccount) cashAccount?.close();

  // Post-trade: compute equity and risk metrics for that close.
  const notional =
    st.contract != null && sumLots(st.lots) > 0
      ? totalFuturesNotionalAtMark({
          lots: st.lots,
          contract: st.contract,
          mark: markFuturesClose,
        })
      : 0;
  const maintenanceMarginUsed = notional * maintMarginRate;
  st.closeNotional = notional;
  const equity = st.cash + riskOffValueAtClose;
  const excessLiquidity = equity - maintenanceMarginUsed - (collateral?.value() ?? 0) * 0.25;
  const actualLeverage = equity > 0 ? notional / equity : 0;
  const leverageDeltaPct = computeLeverageDeltaPct(actualLeverage, targetLev);
  if (
    invested[i] &&
    st.contract != null &&
    sumLots(st.lots) > 0 &&
    equity > 0
  ) {
    st.maxAbsLeverageDeltaRiskOnPct = Math.max(
      st.maxAbsLeverageDeltaRiskOnPct,
      Math.abs(leverageDeltaPct)
    );
  }
  const endEquity = equity;
  const endNotional = notional;
  const endLeverageDeltaPct = leverageDeltaPct;
  const endExcessLiquidity = excessLiquidity;
  st.dailyExcessLiquidity[i] = endExcessLiquidity;

  // Fill EOD columns for all transactions on this date (if any). Do not overwrite `equity`:
  // each row carries post-trade book value for the ledger Value column; stamping it with
  // `endEquity` would make every intraday line on the same date identical.
  for (let t = st.transactions.length - 1; t >= 0; t--) {
    if (st.transactions[t].date !== date) break;
    st.transactions[t].excessLiquidity = endExcessLiquidity;
    if (st.transactions[t].instrument !== "futures") {
      st.transactions[t].leverageDeltaPct = endLeverageDeltaPct;
    }
  }

  // Do NOT treat cash==0 as bankruptcy: when in risk-off we may be fully invested
  // in risk-off holdings with zero free cash.
  if (endEquity <= 0) {
    st.cash = 0;
    if (st.cashMember) { st.cashMember.commoditiesCash = 0; st.cashMember.margin = 0; }
    collateral?.writeHoldings({ SGOV: 0, VGSH: 0 });
    st.closeBasket = 0;
    st.closeNotional = 0;
    st.collateralMarginRequirement = 0;
    st.pendingMonthlyCashInterest = 0;
    st.lots.clear();
    st.contract = null;
    st.riskOffShares = null;
    st.riskOffCash = null;
    st.riskOffLastPrice = null;
    st.dailyEquity[i] = 0;
    for (let j = i + 1; j < dates.length; j++) st.dailyEquity[j] = 0;
    st.ruined = true;
    return;
  }

  // If we are in risk-off, equity should reflect marked-to-close risk-off value too.
  // Sweep interest posts to cash monthly, but it is the account's money from the
  // day it accrues — carrying the unposted balance here keeps the equity curve
  // smooth instead of stepping up ~1% of equity on every month's first session
  // (at 1981 rates). Trading and margin still size off posted `cash` only.
  st.dailyEquity[i] = clampToFinite(endEquity + st.pendingMonthlyCashInterest, st.dailyEquity[i - 1]);
  st.closeMetricEquity = endEquity;
  st.closeCounted = true;

  if (invested[i] && sumLots(st.lots) > 0 && st.contract !== null && endEquity > 0) {
    const lev = endNotional / endEquity;
    if (Number.isFinite(lev)) {
      st.sumActualLeverageRiskOn += lev;
      st.riskOnLeverageDayCount += 1;
    }
  }
}
