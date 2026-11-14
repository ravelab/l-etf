// The day's routine futures sizing and its trades.

import {
  contractSymbolsSortedForReduction,
  familyOfSymbol,
  getContractMultiplier,
  newTradesContractLabel,
  reconcileLots,
  sumLots,
} from "./futures-contracts";
import { executeSleeveQuarterlyRolls, sleeveQuarterlyRollAppliesToday } from "./futures-rolls";
import {
  computeLeverageDeltaPct,
  enforceMinimumQty,
  futuresPortfolioLeverageDeltaPctFromLots,
  maxQtyByLeverage,
  maxQtyByMaintenance,
  targetQty,
  totalFuturesNotionalAtMark,
} from "./futures-sizing";
import type { SleeveContext } from "./futures-sleeve-context";
import { takeSleeveInterestFields } from "./futures-sleeve-interest";
import { recordSleeveTransaction } from "./futures-sleeve-ledger";
import type { SleeveDay, SleeveState } from "./futures-sleeve-state";
import type { FuturesTransactionRow } from "./futures-types";

/**
 * Routine sizing at the open: target contracts from equity, the tolerance band and
 * the maintenance / max-leverage caps, then the trades and today's rolls.
 */
export function rebalanceFuturesAtOpen(
  ctx: SleeveContext,
  st: SleeveState,
  today: SleeveDay,
): { wantsRiskOn: boolean; targetLev: number } {
  const {
    params, invested, maintMarginRate, maxLeverage, leverageTolerancePct, futuresPriceScale, microMode,
    sizingFamily, feeForUnits, futuresSpreadCost, microsNeededFor, splitBuyUnits, reductionTakeUnits,
    capQtyForPostTradeMaintenance, rollDateByQuarter,
  } = ctx;
  const { i, date, idxOpen, futuresFillAt } = today;
  const recordTransaction = (row: FuturesTransactionRow): void => recordSleeveTransaction(ctx, st, row);
  const takeCashInterestFieldsForAttribution = (amount: number) =>
    takeSleeveInterestFields(ctx, st, today.rateDaily, amount);
  // Futures equity available at the open, before any roll/routine sizing.
  const equityBeforeTrade: number = st.cash;
  // Only allow futures positions when we are in risk-on AND have no risk-off holdings.
  // This enforces "sell risk-off first to free collateral cash".
  const hasRiskOffHoldings = Boolean(st.riskOffShares || st.riskOffCash);
  const wantsRiskOn = Boolean(invested[i]) && !hasRiskOffHoldings;
  const targetLev = wantsRiskOn ? params.targetLeverage : 0;

  let targetNotional = wantsRiskOn ? params.targetLeverage * equityBeforeTrade : 0;
  targetNotional = Math.max(0, targetNotional);

  const nextContract = wantsRiskOn ? sizingFamily : null;
  const markFuturesOpen = (sym: string) => futuresFillAt(sym);

  const quarterlyRollAppliesToday = (): boolean =>
    sleeveQuarterlyRollAppliesToday(ctx, st, today, wantsRiskOn, nextContract);
  const executeQuarterlyRolls = (): void =>
    executeSleeveQuarterlyRolls(ctx, st, today, wantsRiskOn, nextContract);

  let currentQtyAfterRolls = sumLots(st.lots);

  // If contract family changes we fully close and reopen for clarity.
  const needsContractSwitch =
    wantsRiskOn &&
    st.contract != null &&
    nextContract != null &&
    st.contract !== nextContract &&
    currentQtyAfterRolls > 0;

  const nextContractLabel =
    wantsRiskOn && nextContract != null
      ? newTradesContractLabel(nextContract, date, rollDateByQuarter)
      : null;
  const nextContractOpenPrice = nextContractLabel ? futuresFillAt(nextContractLabel) : idxOpen;

  const maxQtyMaint =
    wantsRiskOn && nextContract != null
      ? maxQtyByMaintenance({
          equity: equityBeforeTrade,
          close: nextContractOpenPrice,
          contract: nextContract,
          maintenanceMarginRate: maintMarginRate,
        })
      : Number.POSITIVE_INFINITY;
  const maxQtyLev =
    wantsRiskOn && nextContract != null
      ? maxQtyByLeverage({
          equity: equityBeforeTrade,
          close: nextContractOpenPrice,
          contract: nextContract,
          maxLeverage,
        })
      : Number.POSITIVE_INFINITY;
  const targetQtyPreCost =
    wantsRiskOn && nextContract != null
      ? Math.min(
          enforceMinimumQty({
            qty: targetQty({ targetNotional, close: nextContractOpenPrice, contract: nextContract }),
            targetNotional,
            contract: nextContract,
            close: nextContractOpenPrice,
          }),
          maxQtyMaint,
          maxQtyLev
        )
      : 0;
  const desiredTargetQty =
    wantsRiskOn && nextContract != null
      ? capQtyForPostTradeMaintenance({
          desiredQty: targetQtyPreCost,
          currentQty: currentQtyAfterRolls,
          cashBefore: st.cash,
          riskOffValueAtClose: 0,
          contract: nextContract,
          symbol: nextContractLabel ?? nextContract,
          fillPrice: nextContractOpenPrice,
          tradeDate: date,
        })
      : 0;

  const currentNotional =
    st.contract != null && currentQtyAfterRolls > 0
      ? totalFuturesNotionalAtMark({
          lots: st.lots,
          contract: st.contract,
          mark: markFuturesOpen,
        })
      : 0;
  const currentLeverage = equityBeforeTrade > 0 ? currentNotional / equityBeforeTrade : 0;
  const currentLeverageDeltaPct = computeLeverageDeltaPct(currentLeverage, targetLev);
  const isMaintenanceBreach = wantsRiskOn && currentQtyAfterRolls > maxQtyMaint;
  const driftBreachesTolerance =
    wantsRiskOn &&
    currentQtyAfterRolls > 0 &&
    st.contract === nextContract &&
    Math.abs(currentLeverageDeltaPct) > leverageTolerancePct;
  const shouldRebalance =
    wantsRiskOn &&
    (currentQtyAfterRolls === 0 ||
      st.contract !== nextContract ||
      isMaintenanceBreach ||
      driftBreachesTolerance);
  let targetQtyValue = shouldRebalance ? desiredTargetQty : currentQtyAfterRolls;

  const rebalanceOnlyDrift =
    wantsRiskOn &&
    nextContract != null &&
    currentQtyAfterRolls > 0 &&
    st.contract === nextContract &&
    !isMaintenanceBreach &&
    driftBreachesTolerance &&
    shouldRebalance;
  if (rebalanceOnlyDrift && desiredTargetQty !== currentQtyAfterRolls) {
    const tradeSymbol = newTradesContractLabel(nextContract, date, rollDateByQuarter);
    const probeFillPrice = futuresFillAt(tradeSymbol);
    const deltaProbe = desiredTargetQty - currentQtyAfterRolls;
    const feesProbe = feeForUnits(tradeSymbol, deltaProbe, date);
    const spreadProbe = futuresSpreadCost({
      instrument: "futures",
      symbol: tradeSymbol,
      qtyDelta: deltaProbe,
      fillPrice: probeFillPrice,
      dollarScale: futuresPriceScale(probeFillPrice),
    });
    const cashAfterProbe = st.cash - feesProbe - spreadProbe;
    const nextLotsProbe = new Map(st.lots);
    if (deltaProbe > 0) {
      nextLotsProbe.set(tradeSymbol, (nextLotsProbe.get(tradeSymbol) ?? 0) + deltaProbe);
    } else {
      let rem = -deltaProbe;
      for (const sym of contractSymbolsSortedForReduction(nextLotsProbe, date)) {
        if (rem <= 0) break;
        const q = nextLotsProbe.get(sym) ?? 0;
        if (q <= 0) continue;
        const take = reductionTakeUnits(sym, q, rem);
        nextLotsProbe.set(sym, q - take);
        rem -= take;
      }
      reconcileLots(nextLotsProbe);
    }
    const markAfterProbe = (sym: string) =>
      sym === tradeSymbol && deltaProbe !== 0 ? probeFillPrice : futuresFillAt(sym);
    const projectedDelta = futuresPortfolioLeverageDeltaPctFromLots({
      lots: nextLotsProbe,
      contract: nextContract,
      equity: cashAfterProbe,
      targetLeverage: params.targetLeverage,
      mark: markAfterProbe,
    });
    const improvement = Math.abs(currentLeverageDeltaPct) - Math.abs(projectedDelta);
    if (improvement < leverageTolerancePct) {
      targetQtyValue = currentQtyAfterRolls;
    }
  }

  // Roll **before** rebalance only when we need more contracts same day (buy adds to the new
  // front month). Otherwise roll **after** rebalance so trims hit the expiring symbol (e.g. sell
  // NQM06, then roll NQM06→NQU06) and front/deferred columns stay consistent in the ledger.
  const rollToday = quarterlyRollAppliesToday();
  const wantNetAdd = wantsRiskOn && nextContract != null && targetQtyValue > currentQtyAfterRolls;
  let rolledEarlyForNetAdd = false;
  if (rollToday && wantNetAdd) {
    executeQuarterlyRolls();
    rolledEarlyForNetAdd = true;
    currentQtyAfterRolls = sumLots(st.lots);
  }

  const shouldTrade =
    needsContractSwitch ||
    (!wantsRiskOn && currentQtyAfterRolls > 0) ||
    (wantsRiskOn &&
      nextContract != null &&
      (currentQtyAfterRolls !== targetQtyValue || st.contract !== nextContract));

  if (shouldTrade) {
    const mustCloseAll =
      currentQtyAfterRolls > 0 &&
      st.contract != null &&
      (!wantsRiskOn || needsContractSwitch || (nextContract != null && st.contract !== nextContract));
    if (mustCloseAll) {
      let runningQty = currentQtyAfterRolls;
      let intRemainMust = st.accruedInterestSinceLastTx;
      for (const sym of contractSymbolsSortedForReduction(st.lots, date)) {
        const qLeg = st.lots.get(sym) ?? 0;
        if (qLeg <= 0) continue;
        const delta = -qLeg;
        const fillPrice = futuresFillAt(sym);
        const fees = feeForUnits(sym, delta, date);
        const levBeforeClose = futuresPortfolioLeverageDeltaPctFromLots({
          lots: st.lots,
          contract: st.contract,
          equity: st.cash,
          targetLeverage: params.targetLeverage,
          mark: markFuturesOpen,
        });
        const spread = futuresSpreadCost({
          instrument: "futures",
          symbol: sym,
          qtyDelta: delta,
          fillPrice,
          dollarScale: futuresPriceScale(fillPrice),
        });
        st.cash -= fees + spread;
        st.totalFees += fees;
        st.totalSpreadCosts += spread;
        runningQty -= qLeg;
        st.lots.set(sym, 0);
        reconcileLots(st.lots);
        const levAfterClose = futuresPortfolioLeverageDeltaPctFromLots({
          lots: st.lots,
          contract: runningQty > 0 ? st.contract : null,
          equity: st.cash,
          targetLeverage: params.targetLeverage,
          mark: markFuturesOpen,
        });
        const intAmt = intRemainMust;
        if (intAmt > 0) intRemainMust = 0;
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
          leverageDeltaPctBefore: levBeforeClose,
          leverageDeltaPct: levAfterClose,
          equity: st.cash,
        });
      }
      st.contract = null;
      st.accruedInterestSinceLastTx = 0;
    }

    if (wantsRiskOn && nextContract != null) {
      const afterCloseQty = sumLots(st.lots);
      const delta = targetQtyValue - afterCloseQty;
      if (delta !== 0) {
        if (delta > 0) {
          for (const leg of splitBuyUnits(delta, microsNeededFor(equityBeforeTrade, nextContractOpenPrice))) {
          const tradeSymbol = newTradesContractLabel(microMode ? leg.family : nextContract, date, rollDateByQuarter);
          const fillPrice = futuresFillAt(tradeSymbol);
          const heldBefore = sumLots(st.lots);
          const fees = feeForUnits(tradeSymbol, leg.units, date);
          const levBefore = futuresPortfolioLeverageDeltaPctFromLots({
            lots: st.lots,
            contract: heldBefore > 0 ? st.contract : null,
            equity: st.cash,
            targetLeverage: params.targetLeverage,
            mark: markFuturesOpen,
          });
          const spread = futuresSpreadCost({
            instrument: "futures",
            symbol: tradeSymbol,
            qtyDelta: leg.units,
            fillPrice,
            dollarScale: futuresPriceScale(fillPrice),
          });
          st.cash -= fees + spread;
          st.totalFees += fees;
          st.totalSpreadCosts += spread;
          st.lots.set(tradeSymbol, (st.lots.get(tradeSymbol) ?? 0) + leg.units);
          reconcileLots(st.lots);
          st.contract = nextContract;
          const newTotal = sumLots(st.lots);
          const levAfter = futuresPortfolioLeverageDeltaPctFromLots({
            lots: st.lots,
            contract: st.contract,
            equity: st.cash,
            targetLeverage: params.targetLeverage,
            mark: markFuturesOpen,
          });
          const intOnBuy = st.accruedInterestSinceLastTx;
          recordTransaction({
            date,
            action: "buy",
            instrument: "futures",
            symbol: tradeSymbol,
            qtyDelta: leg.units,
            qtyAfter: newTotal,
            fillPrice,
            fees,
            spread,
            cashInterestEarned: intOnBuy,
            ...takeCashInterestFieldsForAttribution(intOnBuy),
            excessLiquidity: 0,
            leverageDeltaPctBefore: levBefore,
            leverageDeltaPct: levAfter,
            equity: st.cash,
          });
          st.accruedInterestSinceLastTx = 0;
          }
        } else {
          let toSell = -delta;
          // Unneeded micros are never sold on their own; a rebalance sell takes them
          // first, and takes all of them when the book stays inside the band without.
          if (microMode && !microsNeededFor(equityBeforeTrade, nextContractOpenPrice)) {
            const microUnits = [...st.lots.entries()]
              .filter(([sym, q]) => q > 0 && familyOfSymbol(sym) === sizingFamily)
              .reduce((sum, [, q]) => sum + q, 0);
            const unitNotional = getContractMultiplier(sizingFamily) * nextContractOpenPrice;
            const floorUnits = unitNotional > 0
              ? Math.ceil((params.targetLeverage * (1 - leverageTolerancePct / 100) * equityBeforeTrade) / unitNotional - 1e-9)
              : Number.POSITIVE_INFINITY;
            if (microUnits > toSell && afterCloseQty - microUnits >= floorUnits) toSell = microUnits;
          }
          let runningAfter = afterCloseQty;
          let intRemainPartial = st.accruedInterestSinceLastTx;
          for (const sym of contractSymbolsSortedForReduction(st.lots, date)) {
            if (toSell <= 0) break;
            const qLeg = st.lots.get(sym) ?? 0;
            if (qLeg <= 0) continue;
            const take = reductionTakeUnits(sym, qLeg, toSell);
            const legDelta = -take;
            const fillPrice = futuresFillAt(sym);
            const legFees = feeForUnits(sym, legDelta, date);
            const levBefore = futuresPortfolioLeverageDeltaPctFromLots({
              lots: st.lots,
              contract: st.contract,
              equity: st.cash,
              targetLeverage: params.targetLeverage,
              mark: markFuturesOpen,
            });
            const spread = futuresSpreadCost({
              instrument: "futures",
              symbol: sym,
              qtyDelta: legDelta,
              fillPrice,
              dollarScale: futuresPriceScale(fillPrice),
            });
            st.cash -= legFees + spread;
            st.totalFees += legFees;
            st.totalSpreadCosts += spread;
            runningAfter -= take;
            toSell -= take;
            st.lots.set(sym, qLeg - take);
            reconcileLots(st.lots);
            const levAfter = futuresPortfolioLeverageDeltaPctFromLots({
              lots: st.lots,
              contract: runningAfter > 0 ? nextContract : null,
              equity: st.cash,
              targetLeverage: params.targetLeverage,
              mark: markFuturesOpen,
            });
            const intAmt = intRemainPartial;
            if (intAmt > 0) intRemainPartial = 0;
            recordTransaction({
              date,
              action: "sell",
              instrument: "futures",
              symbol: sym,
              qtyDelta: legDelta,
              qtyAfter: runningAfter,
              fillPrice,
              fees: legFees,
              spread,
              cashInterestEarned: intAmt,
              ...takeCashInterestFieldsForAttribution(intAmt),
              excessLiquidity: 0,
              leverageDeltaPctBefore: levBefore,
              leverageDeltaPct: levAfter,
              equity: st.cash,
            });
            if (intAmt > 0) st.accruedInterestSinceLastTx = 0;
          }
          if (sumLots(st.lots) === 0) {
            st.contract = null;
          } else {
            st.contract = nextContract;
          }
        }
      }
    }
  }

  if (rollToday && !rolledEarlyForNetAdd) {
    executeQuarterlyRolls();
  }

  return { wantsRiskOn, targetLev };
}
