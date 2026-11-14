// The risk-off basket: bought when the SMA rule exits, marked each close, sold at
// the open when it re-enters.

import { riskOffSharesPerSeriesUnit } from "@/lib/constants";
import { riskOffCloseMarkPrice, riskOffOpenTradePrice } from "@/lib/simulation/risk-off";
import { type CollateralTrade, isTreasuryTicker, MIN_TRADE_SHARES, planRiskOffPurchases } from "./futures-collateral";
import { calendarDaysBetweenIso } from "./futures-contracts";
import { getRiskOffCommission } from "./futures-costs";
import type { SleeveContext } from "./futures-sleeve-context";
import { bookSleeveCollateralTrades, recordSleeveTransaction } from "./futures-sleeve-ledger";
import type { SleeveDay, SleeveState } from "./futures-sleeve-state";
import type { FuturesTransactionRow } from "./futures-types";

/** Treasury-collateral mode: fund the risk-off basket, Treasury legs in kind from collateral. */
export function enterSleevePooledRiskOff(
  ctx: SleeveContext,
  st: SleeveState,
  i: number,
  date: string,
  atOpen: boolean,
): void {
  const {
    params, feeDollarScaleForDate, futuresSpreadCost, collateral, riskOffTickers, heldTickers, ownSlots,
  } = ctx;
  const recordTransaction = (row: FuturesTransactionRow): void => recordSleeveTransaction(ctx, st, row);
  const bookCollateralTrades = (trades: CollateralTrade[], tradeDate: string): void =>
    bookSleeveCollateralTrades(ctx, st, trades, tradeDate);
  if (!collateral || riskOffTickers.length === 0) return;
  const priceAt = (t: string): number | null | undefined => atOpen
    ? riskOffOpenTradePrice({ openValues: params.riskOffOpenByTicker?.[t], closeValues: params.riskOffCloseByTicker?.[t], index: i })
    : riskOffCloseMarkPrice({ closeValues: params.riskOffCloseByTicker?.[t], index: i });
  // As the live bot (~/futures `computeRiskOffBuyAllocation`): a leg whose share of the
  // basket buys fewer than MIN_TRADE_SHARES whole shares is dropped before any order
  // fires. Its share is not re-split over the other legs; it stays in Treasuries.
  const perLeg = st.cash / riskOffTickers.length;
  const dropped = riskOffTickers.filter((t) => {
    const px = priceAt(t);
    return !isTreasuryTicker(t) && px != null && Number.isFinite(px) && px > 0 &&
      Math.floor(perLeg / (px / riskOffSharesPerSeriesUnit(t))) < MIN_TRADE_SHARES;
  });
  const retainedWeight = (riskOffTickers.filter(isTreasuryTicker).length + dropped.length) / riskOffTickers.length;
  bookCollateralTrades(collateral.fundRiskOff(st.cash * retainedWeight, date), date);
  const targets = Object.fromEntries(riskOffTickers
    .filter((t) => !dropped.includes(t))
    .map(t => [t, st.cash / riskOffTickers.length]));
  const budgets = planRiskOffPurchases(targets, collateral.value(), st.cash - collateral.value());
  st.riskOffShares = new Array(heldTickers.length).fill(0);
  st.riskOffCash = new Array(heldTickers.length).fill(0);
  st.riskOffLastPrice = new Array(heldTickers.length).fill(NaN);
  for (const [k, t] of riskOffTickers.entries()) {
    const budget = budgets[t] ?? 0;
    if (!(budget > 0)) continue;
    if (isTreasuryTicker(t)) {
      bookCollateralTrades(collateral.buy(t, budget, date), date);
      continue;
    }
    const px = priceAt(t);
    if (!(px && Number.isFinite(px) && px > 0)) continue; // Unfilled budget stays cash.
    // Whole shares at the leg's share price, as the bot orders `floor(usd / price)`;
    // commission and spread come out of cash beside the order.
    const perShare = riskOffSharesPerSeriesUnit(t);
    const sharePrice = px / perShare;
    const shares = Math.floor(budget / sharePrice);
    if (shares < MIN_TRADE_SHARES) continue;
    const spread = futuresSpreadCost({ instrument: "riskoff", symbol: t, qtyDelta: shares, fillPrice: sharePrice });
    const fees = getRiskOffCommission({ qtyDelta: shares, fillPrice: sharePrice, dollarScale: feeDollarScaleForDate(date) });
    const j = ownSlots[k];
    // Held in series units, which the close marks against the series price.
    st.riskOffShares[j] = shares / perShare;
    st.riskOffLastPrice[j] = px;
    st.cash -= shares * sharePrice + fees + spread;
    st.totalFees += fees;
    st.totalSpreadCosts += spread;
    recordTransaction({ date, action: "buy", instrument: "riskoff", symbol: t,
      qtyDelta: shares, qtyAfter: shares, fillPrice: sharePrice, fees, spread,
      cashInterestEarned: 0, excessLiquidity: 0, leverageDeltaPct: 0,
      equity: st.cash + st.riskOffShares.reduce((sum, qty, slot) => sum + qty * (st.riskOffLastPrice?.[slot] || 0), 0) });
  }
  if (!st.riskOffShares.some(qty => qty > 0)) {
    st.riskOffShares = null;
    st.riskOffCash = null;
    st.riskOffLastPrice = null;
  }
}

/** Sells the risk-off basket at the open on the session a re-entry signal executes. */
export function exitRiskOffBasketAtOpen(ctx: SleeveContext, st: SleeveState, today: SleeveDay): void {
  const { params, feeDollarScaleForDate, futuresSpreadCost, collateral, heldTickers } = ctx;
  const { i, date } = today;
  const recordTransaction = (row: FuturesTransactionRow): void => recordSleeveTransaction(ctx, st, row);
  // Next-day-open: exit risk-off basket before enter-risk-off (mutually exclusive flags per day).
  // The flag is consumed unconditionally: with no basket held there is nothing to sell,
  // and leaving it set would latch and fire against an unrelated basket on a later day.
  const exitingRiskOff = st.pendingExitRiskOff && (st.riskOffShares != null || st.riskOffCash != null);
  st.pendingExitRiskOff = false;
  if (exitingRiskOff) {
    for (let j = 0; j < heldTickers.length; j++) {
      const t = heldTickers[j];
      const shares = st.riskOffShares?.[j] ?? 0;
      const openArr = params.riskOffOpenByTicker?.[t];
      const closeArr = params.riskOffCloseByTicker?.[t];
      const openPx = riskOffOpenTradePrice({
        openValues: openArr,
        closeValues: closeArr,
        index: i,
        lastPrice: st.riskOffLastPrice?.[j],
      });
      if (shares > 0 && Number.isFinite(openPx) && (openPx as number) > 0) {
        const gross = shares * (openPx as number);
        // The live account model trades real shares (BRK.B, not BRK-A); cash mode keeps series units.
        const perShare = collateral ? riskOffSharesPerSeriesUnit(t) : 1;
        const spread = futuresSpreadCost({
          instrument: "riskoff",
          symbol: t,
          qtyDelta: shares * perShare,
          fillPrice: (openPx as number) / perShare,
        });
        const fees = getRiskOffCommission({
          qtyDelta: shares * perShare,
          fillPrice: (openPx as number) / perShare,
          dollarScale: feeDollarScaleForDate(date),
        });
        st.cash += Math.max(0, gross - spread - fees);
        st.totalFees += fees;
        st.totalSpreadCosts += spread;
        // Sold before the row is stamped, so its holdings show only the legs still held.
        if (st.riskOffShares) st.riskOffShares[j] = 0;
        recordTransaction({
          date,
          action: "sell",
          instrument: "riskoff",
          symbol: t,
          qtyDelta: -shares * perShare,
          qtyAfter: 0,
          fillPrice: (openPx as number) / perShare,
          fees,
          spread,
          cashInterestEarned: 0,
          excessLiquidity: 0,
          leverageDeltaPct: 0,
          equity: st.cash,
        });
      }
      const cashPiece = st.riskOffCash?.[j] ?? 0;
      if (Number.isFinite(cashPiece) && cashPiece > 0) st.cash += cashPiece;
    }
    st.riskOffShares = null;
    st.riskOffCash = null;
    st.riskOffLastPrice = null;
  }
}

/** Buys the risk-off basket at the open once futures are flat. */
export function enterRiskOffBasketAtOpen(ctx: SleeveContext, st: SleeveState, today: SleeveDay): void {
  const {
    params, feeDollarScaleForDate, futuresSpreadCost, collateral, riskOffTickers, heldTickers, ownSlots,
  } = ctx;
  const { i, date } = today;
  const recordTransaction = (row: FuturesTransactionRow): void => recordSleeveTransaction(ctx, st, row);
  const enterPooledRiskOff = (day: number, tradeDate: string, atOpen: boolean): void =>
    enterSleevePooledRiskOff(ctx, st, day, tradeDate, atOpen);
  if (collateral) {
    enterPooledRiskOff(i, date, true);
  } else {
    // With no risk-off components configured there is nothing to allocate into, so stay
    // in cash — exactly what the day-0 risk-off path does. Booking an empty basket and
    // zeroing `cash` below would mark the account at 0 and trip the bankruptcy branch
    // for the rest of the run.
    const canEnterRiskOff = riskOffTickers.length > 0;
    const investable = st.cash;
    const valuePer = canEnterRiskOff ? investable / riskOffTickers.length : 0;
    const enteredShares = new Array<number>(heldTickers.length).fill(0);
    const enteredCash = new Array<number>(heldTickers.length).fill(0);
    const enteredLastPrice = new Array<number>(heldTickers.length).fill(NaN);
    st.riskOffShares = canEnterRiskOff ? enteredShares : null;
    st.riskOffCash = canEnterRiskOff ? enteredCash : null;
    st.riskOffLastPrice = canEnterRiskOff ? enteredLastPrice : null;
    let riskOffBookAtOpen = 0;
    for (const [k, t] of riskOffTickers.entries()) {
      const j = ownSlots[k];
      const openArr = params.riskOffOpenByTicker?.[t];
      const closeArr = params.riskOffCloseByTicker?.[t];
      const openPx = riskOffOpenTradePrice({ openValues: openArr, closeValues: closeArr, index: i });
      if (Number.isFinite(openPx) && (openPx as number) > 0) {
        const grossShares = valuePer / (openPx as number);
        const spread = futuresSpreadCost({
          instrument: "riskoff",
          symbol: t,
          qtyDelta: grossShares,
          fillPrice: openPx as number,
        });
        const fees = getRiskOffCommission({
          qtyDelta: grossShares,
          fillPrice: openPx as number,
          dollarScale: feeDollarScaleForDate(date),
        });
        const netValue = Math.max(0, valuePer - spread - fees);
        const shares = netValue / (openPx as number);
        enteredShares[j] = shares;
        enteredLastPrice[j] = openPx as number;
        st.totalFees += fees;
        st.totalSpreadCosts += spread;
        riskOffBookAtOpen += shares * (openPx as number);
        recordTransaction({
          date,
          action: "buy",
          instrument: "riskoff",
          symbol: t,
          qtyDelta: shares,
          qtyAfter: shares,
          fillPrice: openPx as number,
          fees,
          spread,
          cashInterestEarned: 0,
          excessLiquidity: 0,
          leverageDeltaPct: 0,
          equity: riskOffBookAtOpen,
        });
      } else {
        // If we can't price this component, keep it as cash.
        enteredCash[j] = valuePer;
      }
    }
    // When we enter risk-off, the portfolio is fully allocated to the risk-off basket.
    // Any unpriceable components are held as riskOffCash; do NOT also keep them in `cash`
    // or we'd double-count equity (cash + riskOffCash).
    if (canEnterRiskOff) st.cash = 0;
  }
}

/** Marks the basket at today's close, accruing its cash legs; returns its value. */
export function markRiskOffBasketAtClose(ctx: SleeveContext, st: SleeveState, today: SleeveDay): number {
  const { params, dates, heldTickers } = ctx;
  const { i, date, rateDaily } = today;
  let riskOffValueAtClose = 0;
  // Calendar days this row covers, so cash-like risk-off exposure accrues
  // across weekends/holidays the same way the futures cash sweep does.
  const riskOffCashAccrualDays =
    i > 0 ? Math.max(1, calendarDaysBetweenIso(dates[i - 1] as string, date)) : 1;
  if (st.riskOffShares || st.riskOffCash) {
    for (let j = 0; j < heldTickers.length; j++) {
      const t = heldTickers[j];
      const shares = st.riskOffShares?.[j] ?? 0;
      const closeArr = params.riskOffCloseByTicker?.[t];
      const px = riskOffCloseMarkPrice({ closeValues: closeArr, index: i, lastPrice: st.riskOffLastPrice?.[j] });
      if (shares > 0) {
        if (Number.isFinite(px) && (px as number) > 0) {
          riskOffValueAtClose += shares * (px as number);
          if (st.riskOffLastPrice) st.riskOffLastPrice[j] = px as number;
        } else {
          // Risk-off price missing (e.g. pre-launch). Convert to cash using last known price and compound.
          const last = st.riskOffLastPrice?.[j];
          const fallbackPrice = Number.isFinite(last ?? NaN) && (last as number) > 0 ? (last as number) : 0;
          const cashValue = fallbackPrice > 0 ? shares * fallbackPrice : 0;
          if (st.riskOffShares) st.riskOffShares[j] = 0;
          if (st.riskOffCash) st.riskOffCash[j] = (st.riskOffCash[j] ?? 0) + cashValue;
        }
      }
      const cashPiece = st.riskOffCash?.[j] ?? 0;
      if (Number.isFinite(cashPiece) && cashPiece > 0) {
        // Cash-like exposure earns the daily rate per *calendar* day, matching
        // the futures cash sweep above. Accruing once per trading row instead
        // would pay ~252 of the 360 days the `/360` daily rate is quoted on,
        // understating every risk-off cash stretch by ~30% of the rate.
        const fallbackReturn = rateDaily > 0 ? rateDaily * riskOffCashAccrualDays : 0;
        if (st.riskOffCash) st.riskOffCash[j] = cashPiece * (1 + fallbackReturn);
        riskOffValueAtClose += (st.riskOffCash ? st.riskOffCash[j] : cashPiece);
      }
    }
  }
  return riskOffValueAtClose;
}
