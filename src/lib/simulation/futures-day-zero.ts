// A sleeve's first session establishes its book at the first close.

import { riskOffCloseMarkPrice } from "@/lib/simulation/risk-off";
import { futuresBasisFillPrice, getContractMultiplier, newTradesContractLabel } from "./futures-contracts";
import { getRiskOffCommission } from "./futures-costs";
import { enterSleevePooledRiskOff } from "./futures-riskoff-basket";
import {
  computeLeverageDeltaPct,
  enforceMinimumQty,
  futuresLegLeverageDeltaPct,
  maxQtyByLeverage,
  maxQtyByMaintenance,
  targetQty,
  totalFuturesNotionalAtMark,
} from "./futures-sizing";
import type { SleeveContext } from "./futures-sleeve-context";
import { recordSleeveTransaction } from "./futures-sleeve-ledger";
import type { SleeveState } from "./futures-sleeve-state";
import type { FuturesTransactionRow } from "./futures-types";

/** Day 0: the starting position at the first close, futures or the risk-off basket. */
export function establishSleeveDayZero(ctx: SleeveContext, st: SleeveState): void {
  const {
    params, dates, smaInput, invested, rateLookup, maintMarginRate, maxLeverage, feeDollarScaleForDate,
    futuresPriceScale, microMode, sizingFamily, feeForUnits, futuresSpreadCost, microsNeededFor,
    splitBuyUnits, capQtyForPostTradeMaintenance, collateral, cashAccount, sharedCashAccount,
    riskOffTickers, heldTickers, ownSlots, rollDateByQuarter,
  } = ctx;
  const recordTransaction = (row: FuturesTransactionRow): void => recordSleeveTransaction(ctx, st, row);
  const enterPooledRiskOff = (day: number, tradeDate: string, atOpen: boolean): void =>
    enterSleevePooledRiskOff(ctx, st, day, tradeDate, atOpen);
  st.dailyEquity[0] = st.cash;
  const firstDate = dates[0];
  const firstSpot = smaInput[0];
  // Day 0 establishes the starting position rather than executing a signal, so it
  // fills at the first close — the same bar `dailyEquity[0]` marks, and the same
  // convention `simulateSingleEtf` uses for its own day-0 value. Filling at the
  // open instead would size off one price and mark at another, silently dropping
  // (risk-on) or keeping (risk-off) that day's intraday move depending on regime.
  const startsRiskOn = Boolean(invested[0]);
  st.ledgerFuturesMark = (sym) => futuresBasisFillPrice({
    spotPrice: firstSpot,
    symbol: sym,
    tradeDate: firstDate,
    rateDaily: rateLookup.getRate(firstDate),
    dividendDaily: 0,
  });
  if (startsRiskOn && Number.isFinite(firstSpot) && firstSpot > 0) {
    const initialTargetNotional = Math.max(0, params.targetLeverage * st.cash);
    const initialContract = sizingFamily;
    const initialSymbol = newTradesContractLabel(initialContract, firstDate, rollDateByQuarter);
    const initialFillPrice = futuresBasisFillPrice({
      spotPrice: firstSpot,
      symbol: initialSymbol,
      tradeDate: firstDate,
      rateDaily: rateLookup.getRate(firstDate),
      dividendDaily: 0,
    });
    const rawInitialQty = targetQty({
      targetNotional: initialTargetNotional,
      close: initialFillPrice,
      contract: initialContract,
    });
    const initialQtyUncapped = enforceMinimumQty({
      qty: rawInitialQty,
      targetNotional: initialTargetNotional,
      contract: initialContract,
      close: initialFillPrice,
    });
    const initialMaxByMaintenance = maxQtyByMaintenance({
      equity: st.cash,
      close: initialFillPrice,
      contract: initialContract,
      maintenanceMarginRate: maintMarginRate,
    });
    const initialMaxByLeverage = maxQtyByLeverage({
      equity: st.cash,
      close: initialFillPrice,
      contract: initialContract,
      maxLeverage,
    });
    const initialQty = capQtyForPostTradeMaintenance({
      desiredQty: Math.min(initialQtyUncapped, initialMaxByMaintenance, initialMaxByLeverage),
      currentQty: 0,
      cashBefore: st.cash,
      riskOffValueAtClose: 0,
      contract: initialContract,
      symbol: initialSymbol,
      fillPrice: initialFillPrice,
      tradeDate: firstDate,
    });
    if (initialQty > 0) {
      st.contract = initialContract;
      let heldUnits = 0;
      let notional = 0;
      let equity = st.cash;
      let excessLiquidity = 0;
      let leverageDeltaPct = 0;
      for (const leg of splitBuyUnits(initialQty, microsNeededFor(st.cash, initialFillPrice))) {
        const legSymbol = microMode ? newTradesContractLabel(leg.family, firstDate, rollDateByQuarter) : initialSymbol;
        const fees = feeForUnits(legSymbol, leg.units, firstDate);
        const spread = futuresSpreadCost({
          instrument: "futures",
          symbol: legSymbol,
          qtyDelta: leg.units,
          fillPrice: initialFillPrice,
          dollarScale: futuresPriceScale(initialFillPrice),
        });
        const levBefore = futuresLegLeverageDeltaPct({
          qty: heldUnits,
          contract: heldUnits > 0 ? initialContract : null,
          futuresMarkPrice: initialFillPrice,
          equity: st.cash,
          targetLeverage: params.targetLeverage,
        });
        st.cash -= (fees + spread);
        st.totalFees += fees;
        st.totalSpreadCosts += spread;
        heldUnits += leg.units;
        st.lots.set(legSymbol, (st.lots.get(legSymbol) ?? 0) + leg.units);
        notional = heldUnits * getContractMultiplier(initialContract) * initialFillPrice;
        const maintenanceMarginUsed = notional * maintMarginRate;
        equity = st.cash;
        excessLiquidity = equity - maintenanceMarginUsed - (collateral?.value() ?? 0) * 0.25;
        const actualLeverage = equity > 0 ? notional / equity : 0;
        leverageDeltaPct = computeLeverageDeltaPct(actualLeverage, params.targetLeverage);
        recordTransaction({
          date: firstDate,
          action: "buy",
          instrument: "futures",
          symbol: legSymbol,
          qtyDelta: leg.units,
          qtyAfter: heldUnits,
          fillPrice: initialFillPrice,
          fees,
          spread,
          cashInterestEarned: 0,
          excessLiquidity,
          leverageDeltaPctBefore: levBefore,
          leverageDeltaPct,
          equity,
        });
      }
      st.dailyExcessLiquidity[0] = excessLiquidity;
      if (invested[0] && equity > 0) {
        const lev = notional / equity;
        if (Number.isFinite(lev)) {
          st.sumActualLeverageRiskOn += lev;
          st.riskOnLeverageDayCount += 1;
        }
        st.maxAbsLeverageDeltaRiskOnPct = Math.max(st.maxAbsLeverageDeltaRiskOnPct, Math.abs(leverageDeltaPct));
      }
    }
    st.dailyEquity[0] = st.cash;
    // No futures opened on day 0 leaves the whole balance free.
    if (initialQty <= 0) st.dailyExcessLiquidity[0] = st.cash;
  } else if (collateral && riskOffTickers.length > 0) {
    enterPooledRiskOff(0, firstDate, false);
    const basket = (st.riskOffShares as number[] | null)?.reduce((sum, qty, j) => sum + qty * (st.riskOffLastPrice?.[j] || 0), 0) ?? 0;
    st.dailyEquity[0] = st.cash + basket;
    st.dailyExcessLiquidity[0] = st.dailyEquity[0] - collateral.value() * 0.25;
  } else if (riskOffTickers.length > 0) {
    // Starts in risk-off: establish the basket at the first close (see above), so
    // day 0 books it at cost and the curve starts flat exactly like the LETF engine.
    const investable = st.cash;
    const valuePer = investable / riskOffTickers.length;
    st.riskOffShares = new Array(heldTickers.length).fill(0);
    st.riskOffCash = new Array(heldTickers.length).fill(0);
    st.riskOffLastPrice = new Array(heldTickers.length).fill(NaN);
    let day0RiskOffBookAtEntry = 0;
    for (const [k, t] of riskOffTickers.entries()) {
      const j = ownSlots[k];
      const closeArr = params.riskOffCloseByTicker?.[t];
      const openPx = riskOffCloseMarkPrice({ closeValues: closeArr, index: 0 });
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
          dollarScale: feeDollarScaleForDate(firstDate),
        });
        const netValue = Math.max(0, valuePer - spread - fees);
        const shares = netValue / (openPx as number);
        st.riskOffShares[j] = shares;
        st.riskOffLastPrice[j] = openPx as number;
        st.totalFees += fees;
        st.totalSpreadCosts += spread;
        day0RiskOffBookAtEntry += shares * (openPx as number);
        recordTransaction({
          date: firstDate,
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
          equity: day0RiskOffBookAtEntry,
        });
      } else {
        st.riskOffCash[j] = valuePer;
      }
    }
    st.cash = 0;

    // Mark at the first close (the entry bar): books the basket at cost.
    let day0Equity = 0;
    for (let j = 0; j < heldTickers.length; j++) {
      const t = heldTickers[j];
      const shares = st.riskOffShares?.[j] ?? 0;
      const closeArr = params.riskOffCloseByTicker?.[t];
      const closePx = riskOffCloseMarkPrice({ closeValues: closeArr, index: 0, lastPrice: st.riskOffLastPrice?.[j] });
      if (shares > 0 && Number.isFinite(closePx) && (closePx as number) > 0) {
        day0Equity += shares * (closePx as number);
        if (st.riskOffLastPrice) st.riskOffLastPrice[j] = closePx as number;
      } else if (shares > 0) {
        const last = st.riskOffLastPrice?.[j];
        const fallbackPrice =
          Number.isFinite(last ?? NaN) && (last as number) > 0 ? (last as number) : 0;
        day0Equity += fallbackPrice > 0 ? shares * fallbackPrice : 0;
      }
      const cashPiece = st.riskOffCash?.[j] ?? 0;
      if (Number.isFinite(cashPiece) && cashPiece > 0) day0Equity += cashPiece;
    }
    st.dailyEquity[0] = day0Equity > 0 ? day0Equity : 0;
    st.dailyExcessLiquidity[0] = st.dailyEquity[0];
  }

  /**
   * Wiped out: every remaining day is already zeroed, so no later day may run.
   * Stands in for the `break` this was before it became a per-day step.
   */
  if (collateral) {
    collateral.mark(0, dates[0], false);
    if (invested[0] && st.contract) {
      st.collateralMarginRequirement = totalFuturesNotionalAtMark({ lots: st.lots, contract: st.contract,
        mark: sym => futuresBasisFillPrice({ spotPrice: smaInput[0], symbol: sym,
          tradeDate: dates[0], rateDaily: rateLookup.getRate(dates[0]), dividendDaily: 0 }) }) * maintMarginRate;
      st.collateralRiskOnAtLastClose = true;
      st.dailyEquity[0] = st.cash;
      st.dailyExcessLiquidity[0] = st.cash - st.collateralMarginRequirement - collateral.value() * 0.25;
    }
    st.closeNotional = st.contract ? totalFuturesNotionalAtMark({ lots: st.lots, contract: st.contract,
      mark: sym => futuresBasisFillPrice({ spotPrice: smaInput[0], symbol: sym,
        tradeDate: dates[0], rateDaily: rateLookup.getRate(dates[0]), dividendDaily: 0 }) }) : 0;
    st.closeBasket = st.dailyEquity[0] - st.cash;
    st.closeMetricEquity = st.cash + st.closeBasket;
    st.closeCounted = invested[0] && st.closeNotional > 0;
    if (st.cashMember) st.cashMember.margin = st.collateralMarginRequirement;
    if (!sharedCashAccount) cashAccount?.close();
  }
}
