// The sleeve's seat in the futures cash account (`futures-cash-account.ts`).

import { type CollateralTrade, isTreasuryTicker } from "./futures-collateral";
import { computeLeverageDeltaPct } from "./futures-sizing";
import type { SleeveContext } from "./futures-sleeve-context";
import { accrueSleeveCollateralInterest } from "./futures-sleeve-interest";
import { bookSleeveCollateralTrades } from "./futures-sleeve-ledger";
import type { SleeveState } from "./futures-sleeve-state";

/**
 * Registers the sleeve with the (possibly shared) Treasury cash account, which
 * reads its balances and books maintenance trades through these callbacks.
 */
export function attachSleeveCashMember(ctx: SleeveContext, st: SleeveState): void {
  const {
    params, entryVgshWeight, dates, invested, rateLookup, feeDollarScaleForDate, collateral, cashAccount,
    executeTreasuryTrade, riskOffTickers,
  } = ctx;
  const bookCollateralTrades = (trades: CollateralTrade[], tradeDate: string): void =>
    bookSleeveCollateralTrades(ctx, st, trades, tradeDate);
  const accrueCollateralInterest = (amount: number, days: number): void =>
    accrueSleeveCollateralInterest(st, amount, days);
  if (collateral && cashAccount) {
    st.cashMember = {
      commoditiesCash: 0, margin: 0,
      equity: () => st.cash + st.closeBasket + st.pendingMonthlyCashInterest,
      securitiesCash: () => st.cash - collateral.value() - st.cashMember!.commoditiesCash,
      treasuries: () => collateral.readHoldings(),
      assignTreasuries: holdings => collateral.writeHoldings(holdings),
      canBuyTreasuries: () => !st.ruined && (Boolean(invested[st.closeIndex]) || riskOffTickers.some(isTreasuryTicker)),
      preferVgsh: () => st.maintenanceVgsh,
      sgovBufferEnabled: () => (params.treasuryBuyPreference ?? "sgov-buffer") === "sgov-buffer",
      riskOnEntry: () => st.entryClose && Boolean(invested[st.closeIndex]),
      execute: executeTreasuryTrade,
      rateDaily: () => rateLookup.getRate(dates[st.closeIndex]),
      dollarScale: () => feeDollarScaleForDate(dates[st.closeIndex]),
      buy: (budget, preferVgsh, selectedTickerOnly) => bookCollateralTrades(selectedTickerOnly
        ? collateral.buy(preferVgsh ? "VGSH" : "SGOV", budget, dates[st.closeIndex])
        : collateral.rebalance(collateral.value() + budget, 0, dates[st.closeIndex], preferVgsh,
          st.entryClose ? entryVgshWeight : undefined), dates[st.closeIndex]),
      sell: (ticker, budget) => {
        const trades = collateral.sell(ticker, budget, dates[st.closeIndex]);
        bookCollateralTrades(trades, dates[st.closeIndex]);
        return trades;
      },
      accrueInterest: accrueCollateralInterest,
      refresh: () => {
        const equity = st.cash + st.closeBasket;
        if (st.closeCounted && invested[st.closeIndex] && st.closeNotional > 0 && equity > 0 && st.closeMetricEquity > 0) {
          st.sumActualLeverageRiskOn += st.closeNotional / equity - st.closeNotional / st.closeMetricEquity;
          st.maxAbsLeverageDeltaRiskOnPct = Math.max(st.maxAbsLeverageDeltaRiskOnPct,
            Math.abs(computeLeverageDeltaPct(st.closeNotional / equity, params.targetLeverage)));
        }
        st.closeMetricEquity = equity;
        st.dailyEquity[st.closeIndex] = equity + st.pendingMonthlyCashInterest;
        const excess = equity - st.collateralMarginRequirement - collateral.value() * 0.25;
        st.dailyExcessLiquidity[st.closeIndex] = excess;
        for (let t = st.transactions.length - 1; t >= 0 && st.transactions[t].date === dates[st.closeIndex]; t--) {
          st.transactions[t].excessLiquidity = excess;
          if (st.transactions[t].instrument !== "futures") st.transactions[t].leverageDeltaPct =
            computeLeverageDeltaPct(equity > 0 ? st.closeNotional / equity : 0, params.targetLeverage);
        }
      },
    };
    cashAccount.add(st.cashMember);
  }
}
