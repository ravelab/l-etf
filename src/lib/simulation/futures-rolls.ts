// Quarterly rolls of the held ES/NQ (and MES/MNQ) listings.

import {
  advanceQuarterlySymbol,
  type FuturesContractSymbol,
  reconcileLots,
  rollSnapForSymbolFromMap,
  sumLots,
} from "./futures-contracts";
import { futuresPortfolioLeverageDeltaPctFromLots } from "./futures-sizing";
import type { SleeveContext } from "./futures-sleeve-context";
import { takeSleeveInterestFields } from "./futures-sleeve-interest";
import { recordSleeveTransaction } from "./futures-sleeve-ledger";
import type { SleeveDay, SleeveState } from "./futures-sleeve-state";
import type { FuturesTransactionRow } from "./futures-types";

/** Whether a held listing reaches its roll date today. */
export function sleeveQuarterlyRollAppliesToday(
  ctx: SleeveContext,
  st: SleeveState,
  today: SleeveDay,
  wantsRiskOn: boolean,
  nextContract: FuturesContractSymbol | null,
): boolean {
  const { rollDateByQuarter } = ctx;
  const { date } = today;
  if (!wantsRiskOn || st.contract == null || sumLots(st.lots) <= 0 || nextContract == null) return false;
  for (const [sym, rollQty] of st.lots.entries()) {
    if (rollQty <= 0) continue;
    const snap = rollSnapForSymbolFromMap(sym, date, rollDateByQuarter);
    if (snap !== date) continue;
    const nextSym = advanceQuarterlySymbol(sym, date);
    if (nextSym !== sym) return true;
  }
  return false;
}

/** Rolls each listing due today into the next quarter: a sell and a buy of the same size. */
export function executeSleeveQuarterlyRolls(
  ctx: SleeveContext,
  st: SleeveState,
  today: SleeveDay,
  wantsRiskOn: boolean,
  nextContract: FuturesContractSymbol | null,
): void {
  const { params, futuresPriceScale, feeForUnits, futuresSpreadCost, rollDateByQuarter } = ctx;
  const { date, futuresFillAt } = today;
  const recordTransaction = (row: FuturesTransactionRow): void => recordSleeveTransaction(ctx, st, row);
  const takeCashInterestFieldsForAttribution = (amount: number) =>
    takeSleeveInterestFields(ctx, st, today.rateDaily, amount);
  const markFuturesOpen = (sym: string) => futuresFillAt(sym);
  if (!wantsRiskOn || st.contract == null || sumLots(st.lots) <= 0 || nextContract == null) return;
  const legs = [...st.lots.entries()].filter(([, q]) => q > 0);
  for (const [sym, rollQty] of legs) {
    const snap = rollSnapForSymbolFromMap(sym, date, rollDateByQuarter);
    if (snap !== date) continue;
    const nextSym = advanceQuarterlySymbol(sym, date);
    if (nextSym === sym) continue;

    const sellFillPrice = futuresFillAt(sym);
    const buyFillPrice = futuresFillAt(nextSym);
    const sellFees = feeForUnits(sym, rollQty, date);
    const buyFees = feeForUnits(nextSym, rollQty, date);
    const sellSpread = futuresSpreadCost({
      instrument: "futures",
      symbol: sym,
      qtyDelta: -rollQty,
      fillPrice: sellFillPrice,
      dollarScale: futuresPriceScale(sellFillPrice),
    });
    const buySpread = futuresSpreadCost({
      instrument: "futures",
      symbol: nextSym,
      qtyDelta: rollQty,
      fillPrice: buyFillPrice,
      dollarScale: futuresPriceScale(buyFillPrice),
    });

    const rollLevBeforeSell = futuresPortfolioLeverageDeltaPctFromLots({
      lots: st.lots,
      contract: st.contract,
      equity: st.cash,
      targetLeverage: params.targetLeverage,
      mark: markFuturesOpen,
    });
    st.cash -= sellFees + sellSpread;
    st.totalFees += sellFees;
    st.totalSpreadCosts += sellSpread;
    st.lots.set(sym, (st.lots.get(sym) ?? 0) - rollQty);
    reconcileLots(st.lots);
    const rollLevAfterSell = futuresPortfolioLeverageDeltaPctFromLots({
      lots: st.lots,
      contract: st.contract,
      equity: st.cash,
      targetLeverage: params.targetLeverage,
      mark: markFuturesOpen,
    });
    const interestOnRollOpen = st.accruedInterestSinceLastTx;
    recordTransaction({
      date,
      action: "sell",
      instrument: "futures",
      symbol: `${sym} (ROLL)`,
      qtyDelta: -rollQty,
      qtyAfter: sumLots(st.lots),
      fillPrice: sellFillPrice,
      fees: sellFees,
      spread: sellSpread,
      cashInterestEarned: interestOnRollOpen,
      ...takeCashInterestFieldsForAttribution(interestOnRollOpen),
      excessLiquidity: 0,
      leverageDeltaPctBefore: rollLevBeforeSell,
      leverageDeltaPct: rollLevAfterSell,
      equity: st.cash,
    });
    st.accruedInterestSinceLastTx = 0;

    const rollLevBeforeBuy = rollLevAfterSell;
    st.cash -= buyFees + buySpread;
    st.totalFees += buyFees;
    st.totalSpreadCosts += buySpread;
    st.lots.set(nextSym, (st.lots.get(nextSym) ?? 0) + rollQty);
    reconcileLots(st.lots);
    const rollLevAfterBuy = futuresPortfolioLeverageDeltaPctFromLots({
      lots: st.lots,
      contract: st.contract,
      equity: st.cash,
      targetLeverage: params.targetLeverage,
      mark: markFuturesOpen,
    });
    recordTransaction({
      date,
      action: "buy",
      instrument: "futures",
      symbol: `${nextSym} (ROLL)`,
      qtyDelta: rollQty,
      qtyAfter: sumLots(st.lots),
      fillPrice: buyFillPrice,
      fees: buyFees,
      spread: buySpread,
      cashInterestEarned: 0,
      excessLiquidity: 0,
      leverageDeltaPctBefore: rollLevBeforeBuy,
      leverageDeltaPct: rollLevAfterBuy,
      equity: st.cash,
    });
  }
}
