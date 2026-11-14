// SMA timing expressed with index futures: one sleeve per run, stepped a session at
// a time. This file wires the sleeve together and runs its day; each phase of the
// day lives in its own module, all reading the sleeve's fixed `SleeveContext` and
// writing its `SleeveState`:
//
//   futures-sleeve-context   fixed inputs: prices, SMA regime, costs, sizing helpers
//   futures-sleeve-state     the mutable book carried between sessions
//   futures-day-zero         day 0: the starting position at the first close
//   futures-open-trades      overnight mark, exit to risk-off, margin/max-leverage trim
//   futures-riskoff-basket   buying, marking and selling the risk-off basket
//   futures-rebalance        routine sizing and its trades (with futures-rolls)
//   futures-day-close        the close: marks, Treasury maintenance, equity, ruin
//   futures-sleeve-finish    terminal liquidation and the strategy result
//   futures-sleeve-ledger / -interest / -cash-member   ledger rows, sweep interest, cash account seat

import { FuturesCashAccount } from "./futures-cash-account";
import { createAssetValueRecorder, sleeveCloseSnapshot } from "./futures-asset-values";
import { calendarDaysBetweenIso, futuresBasisFillPrice } from "./futures-contracts";
import { clampToFinite } from "./futures-sizing";
import { createSleeveContext, MAX_ABS_DIVIDEND_DAILY } from "./futures-sleeve-context";
import { createSleeveState, type SleeveDay } from "./futures-sleeve-state";
import { attachSleeveCashMember } from "./futures-sleeve-cash-member";
import { accrueSleeveSweepAcrossGap } from "./futures-sleeve-interest";
import { currentSleevePositions } from "./futures-sleeve-ledger";
import { establishSleeveDayZero } from "./futures-day-zero";
import { flattenFuturesForRiskOff, realizeOvernightFuturesPnl, trimFuturesAtOpen } from "./futures-open-trades";
import { enterRiskOffBasketAtOpen, exitRiskOffBasketAtOpen } from "./futures-riskoff-basket";
import { rebalanceFuturesAtOpen } from "./futures-rebalance";
import { closeSleeveDay } from "./futures-day-close";
import { emptyFuturesSleeve, finishSleeve } from "./futures-sleeve-finish";
import type {
  FuturesRunOptions,
  FuturesSleeve,
  FuturesStrategyParams,
  FuturesStrategyResult,
  SleeveHoldings,
} from "./futures-types";

export type {
  FuturesRunOptions,
  FuturesSleeve,
  FuturesStrategyParams,
  FuturesStrategyResult,
  FuturesTransactionRow,
  SleeveHoldings,
} from "./futures-types";
export {
  DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY,
  buildRollDateMap,
  futuresCarryForHoldingPeriod,
  futuresContractExpiryEpochMs,
  futuresListingMultiplier,
  getQuarterlyFuturesRollTradingDay,
} from "./futures-contracts";
export { buildInflationDollarCostScaleLookup, getFuturesHalfSpreadPerContract } from "./futures-costs";
export {
  buildEtfResult,
  futuresFrontBackQtyAfterEachTransaction,
  futuresFrontBackQtysFromLots,
} from "./futures-sizing";

export function createFuturesSleeve(
  params: FuturesStrategyParams,
  sharedCashAccount?: FuturesCashAccount,
  executeTreasuryTrade: (fn: () => void) => void = fn => fn(),
): FuturesSleeve {
  const entryVgshWeight = (params.riskOnEntryVgshPct ?? 100) / 100;
  if (!Number.isFinite(entryVgshWeight) || entryVgshWeight < 0 || entryVgshWeight > 1) {
    throw new Error("riskOnEntryVgshPct must be between 0 and 100");
  }
  const sliced = params.prices.filter((p) => p.date >= params.startDate && p.date <= params.endDate);
  if (sliced.length < 2) return emptyFuturesSleeve(params);

  const ctx = createSleeveContext(params, sliced, entryVgshWeight, sharedCashAccount, executeTreasuryTrade);
  const st = createSleeveState(ctx);
  const {
    dates, smaInput, indexOpenPx, adjCloses, invested, rateLookup, feeDollarScaleForDate,
    cashAccount, collateral, divAlpha,
  } = ctx;
  attachSleeveCashMember(ctx, st);
  establishSleeveDayZero(ctx, st);

  /** One trading day for this sleeve. Was the body of the day loop; `continue` is now `return`. */
  const stepDay = (i: number): void => {
    if (st.ruined) return;
    const date = dates[i];
    st.closeCounted = false;
    const prevSpot = smaInput[i - 1];
    const spot = smaInput[i];
    const idxOpen =
      Number.isFinite(indexOpenPx[i]) && indexOpenPx[i] > 0 ? indexOpenPx[i] : spot;
    if (!Number.isFinite(prevSpot) || !Number.isFinite(spot) || prevSpot <= 0 || spot <= 0) {
      // If data is bad, carry forward equity without changing positions.
      st.dailyEquity[i] = clampToFinite(st.dailyEquity[i - 1], st.cash);
      st.dailyExcessLiquidity[i] = st.dailyExcessLiquidity[i - 1] ?? 0;
      return;
    }

    // Sweep interest on non-trading calendar days (Sat/Sun/holidays) between index rows: same daily rate × gap,
    // balance frozen at prior session close (before today's overnight futures cash). Uses prior session SOFR.
    const gapCalendarDays = calendarDaysBetweenIso(dates[i - 1] as string, dates[i] as string);
    const extraSweepDays = Math.max(0, gapCalendarDays - 1);
    cashAccount?.beginSession(date, feeDollarScaleForDate(dates[i - 1]), rateLookup.getRate(dates[i - 1]), extraSweepDays);
    accrueSleeveSweepAcrossGap(ctx, st, i, date, extraSweepDays);

    if (collateral) st.cash += collateral.mark(i, date, true);

    // SMA uses prior close; regime trades execute next session shortly after the open (opens for fills).
    if (invested[i] !== invested[i - 1]) {
      if (invested[i]) {
        st.pendingExitRiskOff = true;
      } else {
        st.pendingEnterRiskOff = true;
      }
    }

    // Infer dividend carry (must run once per day before futures MTM and regime trades).
    const spotRet = spot / prevSpot - 1;
    const trPrev = adjCloses[i - 1];
    const trNow = adjCloses[i];
    const trRet =
      Number.isFinite(trPrev) && Number.isFinite(trNow) && trPrev > 0 && trNow > 0
        ? trNow / trPrev - 1
        : spotRet;
    // Realized payout for this row (covers weekend/holiday gaps in one number).
    // Drives the carry charged to held positions; the smoothed EMA below only
    // estimates *future* dividends for the basis baked into fill prices.
    const rawDividend = trRet - spotRet;
    const realizedDividend = Number.isFinite(rawDividend) ? rawDividend : 0;
    st.dividendEmaDaily = (st.dividendEmaDaily * (1 - divAlpha)) + (realizedDividend * divAlpha);
    const dividendDaily = Math.max(-MAX_ABS_DIVIDEND_DAILY, Math.min(MAX_ABS_DIVIDEND_DAILY, st.dividendEmaDaily));
    const rateDaily = rateLookup.getRate(date); // already /360

    const futuresFillAt = (symbol: string, spotPrice = idxOpen) => futuresBasisFillPrice({
      spotPrice,
      symbol,
      tradeDate: date,
      rateDaily,
      dividendDaily,
    });
    st.ledgerFuturesMark = futuresFillAt;
    const today: SleeveDay = {
      i, date, prevSpot, spot, idxOpen, gapCalendarDays, rateDaily, dividendDaily, realizedDividend, futuresFillAt,
    };

    realizeOvernightFuturesPnl(ctx, st, today);
    // Next-day-open: exit risk-off basket before enter-risk-off (mutually exclusive flags per day).
    exitRiskOffBasketAtOpen(ctx, st, today);
    if (st.pendingEnterRiskOff) {
      st.collateralMarginRequirement = 0;
      flattenFuturesForRiskOff(ctx, st, today);
      enterRiskOffBasketAtOpen(ctx, st, today);
      st.pendingEnterRiskOff = false;
    }
    trimFuturesAtOpen(ctx, st, today);
    const { wantsRiskOn, targetLev } = rebalanceFuturesAtOpen(ctx, st, today);
    closeSleeveDay(ctx, st, today, wantsRiskOn, targetLev);
  };

  return {
    dates,
    invested,
    equityAt: (i: number) => st.dailyEquity[i] ?? 0,
    excessLiquidityAt: (i: number) => st.dailyExcessLiquidity[i] ?? 0,
    stepDay,
    readHoldings: () => ({
      cash: st.cash,
      riskOffShares: st.riskOffShares ? [...st.riskOffShares] : null,
      riskOffCash: st.riskOffCash ? [...st.riskOffCash] : null,
      pendingCashInterest: st.pendingMonthlyCashInterest,
      ...(collateral ? { treasuryHoldings: collateral.readHoldings() } : {}),
      ...(st.cashMember ? { commoditiesCash: st.cashMember.commoditiesCash } : {}),
    }),
    writeHoldings: (holdings: SleeveHoldings, i: number, equity: number) => {
      st.cash = holdings.cash;
      if (st.cashMember) st.cashMember.commoditiesCash = holdings.commoditiesCash ?? 0;
      if (collateral && holdings.treasuryHoldings) collateral.writeHoldings(holdings.treasuryHoldings);
      st.riskOffShares = holdings.riskOffShares ? [...holdings.riskOffShares] : null;
      st.riskOffCash = holdings.riskOffCash ? [...holdings.riskOffCash] : null;
      st.pendingMonthlyCashInterest = holdings.pendingCashInterest;
      st.closeBasket = equity - st.cash - st.pendingMonthlyCashInterest;
      st.closeMetricEquity = equity - st.pendingMonthlyCashInterest;
      // Price memory is per sleeve, not a holding. A sleeve handed basket shares it
      // never held needs the array to exist so marking can fall back to the close.
      if (st.riskOffShares && !st.riskOffLastPrice) st.riskOffLastPrice = st.riskOffShares.map(() => NaN);
      st.dailyEquity[i] = equity;
      // Capital only ever moves between sleeves while both are risk-off, so there is
      // no futures position and nothing is encumbered: excess liquidity is the whole
      // balance. Leaving the old figure here would leave the day's ledger rows
      // claiming more free cash than the restated equity behind them.
      st.dailyExcessLiquidity[i] = equity - (collateral?.value() ?? 0) * 0.25;
    },
    positions: () => currentSleevePositions(ctx, st),
    transactionCount: () => st.transactions.length,
    finish: () => finishSleeve(ctx, st),
  };
}

/**
 * Drives one sleeve start to finish. The sleeve factory exists so a composite
 * fund can step several sleeves through the same calendar and move capital
 * between them; a lone strategy just runs the loop straight through.
 */
export function simulateFuturesSmaStrategy(
  params: FuturesStrategyParams,
  options: FuturesRunOptions = {},
): FuturesStrategyResult {
  const sleeve = createFuturesSleeve(params);
  // Sampled after each day is stepped and before `finish` liquidates the book.
  const recorder = options.recordAssetValues && sleeve.dates.length > 0 ? createAssetValueRecorder() : null;
  recorder?.record([sleeveCloseSnapshot(params.index, sleeve, 0)]);
  for (let i = 1; i < sleeve.dates.length; i++) {
    sleeve.stepDay(i);
    recorder?.record([sleeveCloseSnapshot(params.index, sleeve, i)]);
  }
  const result = sleeve.finish();
  return recorder ? { ...result, dailyAssetValues: recorder.values() } : result;
}
