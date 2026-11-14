// A sleeve's fixed inputs, derived once from its params (see `createSleeveContext`).

import { getRiskOffFetchTickers } from "@/lib/constants";
import { buildRateLookup } from "@/lib/simulation/borrowing-rate";
import { DEFAULT_LEVERAGE_TOLERANCE_PCT } from "@/lib/simulation/defaults";
import { smaRiskOffGates } from "@/lib/simulation/risk-off-gates";
import { generateSmaSignals } from "@/lib/simulation/sma";
import type { PricePoint } from "@/lib/simulation/types";
import { FuturesCashAccount } from "./futures-cash-account";
import { createFuturesCollateral } from "./futures-collateral";
import {
  buildRollDateMap,
  chooseContract,
  DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY,
  familyOfSymbol,
  type FuturesContractSymbol,
  getContractMultiplier,
  microFamilyOf,
  stripFuturesLedgerSuffix,
} from "./futures-contracts";
import {
  buildInflationDollarCostScaleLookup,
  FEE_SCHEDULE_ANCHOR_CPI,
  FEE_SCHEDULE_ANCHOR_DATE,
  getFuturesHalfSpreadPerContract,
  getTransactionSpreadCost,
  IBKR_FEE_PER_CONTRACT,
} from "./futures-costs";
import type { FuturesStrategyParams } from "./futures-types";

const DEFAULT_CASH_INTEREST_SPREAD_ANNUAL = 0.005; // 0.50%/yr haircut vs SOFR-like series

// ES/NQ do not roll at fair value: the roll's implied financing has run roughly
// +25 to +50bp over 3M OIS post-2010 (balance-sheet costs), NQ at or above ES.
// This is the futures analogue of the LETF swap spread — but a genuinely level
// premium, not one proportional to the rate. Charged on notional, so unlike the
// cash-sweep haircut (which only touches 1x collateral) it scales with leverage.
const DEFAULT_FUTURES_FUNDING_SPREAD_ANNUAL = 0.0035; // 0.35%/yr over the risk-free rate

const DEFAULT_CASH_INTEREST_FREE_CASH = 10_000;

const DIVIDEND_EMA_LOOKBACK_DAYS = 63;

export const MAX_ABS_DIVIDEND_DAILY = 0.05 / 252; // clamp inferred q to +/-5% annualized

// Coarse, stable approximation for margin. We use a fraction of notional to produce
// a meaningful "Excess Liquidity" series without pretending to be an exact broker.
const DEFAULT_MAINT_MARGIN_RATE = 0.08; // 8% of notional

/**
 * Everything about a sleeve that is fixed once it exists: its price window and SMA
 * regime, its cost, sizing and contract helpers, and the accounts it books into.
 * The per-day phases read it; only `SleeveState` changes as the sleeve steps.
 */
export function createSleeveContext(
  params: FuturesStrategyParams,
  sliced: PricePoint[],
  entryVgshWeight: number,
  sharedCashAccount: FuturesCashAccount | undefined,
  executeTreasuryTrade: (fn: () => void) => void,
) {
  const dates = sliced.map((p) => p.date);
  const closes = sliced.map((p) => p.close);
  const adjCloses = sliced.map((p) => p.adj_close);
  const smaInput = closes.map((v, i) => (Number.isFinite(v) ? v : (adjCloses[i] ?? v)));
  /** Index level for next-day-open futures fills (raw `open`; matches raw `close` scale). */
  const indexOpenPx = sliced.map((p, i) => {
    if (p.open != null && Number.isFinite(p.open) && p.open > 0) return p.open;
    return smaInput[i] as number;
  });

  // Run SMA over the FULL price series (including pre-startDate warm-up rows) so the
  // regime at startDate reflects the trailing trend. Slicing first would lose warm-up
  // data and force `generateSmaSignals` into its progressive-average bootstrap, which
  // defaults to risk-on regardless of the actual SMA position at startDate.
  const signalPrices = params.signalPrices ?? params.prices;
  const fullDates = signalPrices.map((p) => p.date);
  const fullClose = signalPrices.map((p) => p.close);
  const fullAdjClose = signalPrices.map((p) => p.adj_close);
  const fullSmaInput = fullClose.map((v, i) =>
    Number.isFinite(v) ? v : (fullAdjClose[i] ?? v)
  ) as number[];
  const fullSma = generateSmaSignals(
    fullDates,
    fullSmaInput,
    params.smaPeriod,
    { upper: params.smaUpperBuffer, lower: params.smaLowerBuffer },
    params.smaVolGate === true ? smaRiskOffGates(params.index) : {}
  );
  const fullInvestedByDate = new Map<string, boolean>();
  const fullAboveSmaByDate = new Map<string, boolean>();
  for (let i = 0; i < fullDates.length; i++) {
    fullInvestedByDate.set(fullDates[i], fullSma.invested[i] ?? true);
    fullAboveSmaByDate.set(fullDates[i], fullSmaInput[i] > fullSma.smaValues[i]);
  }
  const slicedInvested = dates.map((d) => fullInvestedByDate.get(d) ?? true);
  const slicedSmaValues = (() => {
    const fullSmaByDate = new Map<string, number>();
    for (let i = 0; i < fullDates.length; i++) {
      fullSmaByDate.set(fullDates[i], fullSma.smaValues[i] ?? Number.NaN);
    }
    return dates.map((d) => fullSmaByDate.get(d) ?? Number.NaN);
  })();
  const slicedSignals = fullSma.signals.filter(
    (s) => s.date >= params.startDate && s.date <= params.endDate
  );
  const sma = {
    signals: slicedSignals,
    smaValues: slicedSmaValues,
    invested: slicedInvested,
  };
  // Futures sim executes SMA regime trades on the *next session open*.
  // `generateSmaSignals` flips `invested` on the trigger day's close, so we must shift
  // by one day to avoid entering/exiting risk-off one day early vs the ETF SMA engine.
  const invested = (() => {
    const signalInvested = sma.invested;
    if (signalInvested.length <= 1) return signalInvested;
    const shifted = new Array<boolean>(signalInvested.length);
    // Seed the day-0 regime from the *previous* full-series row so warm-up state
    // carries forward to startDate (matches the next-session-open shift below).
    const firstSlicedDate = dates[0];
    const firstFullIdx = fullDates.indexOf(firstSlicedDate);
    const priorInvested =
      firstFullIdx > 0 ? fullSma.invested[firstFullIdx - 1] : signalInvested[0];
    shifted[0] = priorInvested ?? signalInvested[0] ?? true;
    for (let i = 1; i < signalInvested.length; i++) shifted[i] = signalInvested[i - 1] ?? shifted[i - 1] ?? true;
    return shifted;
  })();

  const rateLookup = buildRateLookup(params.rates);
  const spreadAnnual = params.cashInterestSpreadAnnual ?? DEFAULT_CASH_INTEREST_SPREAD_ANNUAL;
  const freeCash = params.cashInterestFreeCash ?? DEFAULT_CASH_INTEREST_FREE_CASH;
  const fundingSpreadAnnual = Math.max(
    0,
    params.futuresFundingSpreadAnnual ?? DEFAULT_FUTURES_FUNDING_SPREAD_ANNUAL
  );
  const maintMarginRate = params.maintenanceMarginRate ?? DEFAULT_MAINT_MARGIN_RATE;
  const maxLeverage = params.maxLeverage ?? Number.POSITIVE_INFINITY;
  const leverageTolerancePct = Math.max(
    0,
    params.leverageTolerancePct ?? DEFAULT_LEVERAGE_TOLERANCE_PCT
  );
  const feeDollarScaleForDate = buildInflationDollarCostScaleLookup(
    params.monthlyCpi,
    FEE_SCHEDULE_ANCHOR_DATE,
    FEE_SCHEDULE_ANCHOR_CPI,
  );
  // The un-swept cash buffer is a present-day broker threshold, so it lives in the
  // same dollars as the commission schedule and gets deflated the same way. Leaving
  // it nominal would wipe out most of the interest base in early history (a $10k
  // buffer against a 1962 account is a different animal than against a 2026 one).
  const freeCashAt = (date: string) => freeCash * feeDollarScaleForDate(date);
  // Bid/ask spreads scale with the contract's fill price so half a tick stays a constant
  // fraction of notional. Anchor to a reference price (typically today's market price or
  // latest available) so that historical backtests have consistent spreads regardless of
  // the simulation date range. If not provided, falls back to the latest price in the
  // series, but for long historical backtests, explicitly provide the anchor.
  // Commissions do NOT ride this scale: they are a fixed dollar schedule (IBKR's, quoted
  // in FEE_SCHEDULE_ANCHOR_DATE dollars) and are deflated by CPI instead — tying them to
  // the index level would have a 1988 fill pay ~4c a contract.
  const futuresPriceAnchor = (() => {
    if (Number.isFinite(params.futuresPriceAnchor) && (params.futuresPriceAnchor as number) > 0) {
      return params.futuresPriceAnchor as number;
    }
    for (let i = params.prices.length - 1; i >= 0; i--) {
      const c = params.prices[i]?.close;
      if (Number.isFinite(c) && (c as number) > 0) return c as number;
    }
    return NaN;
  })();
  const futuresPriceScale = (fillPrice: number): number => {
    if (!Number.isFinite(futuresPriceAnchor) || futuresPriceAnchor <= 0) return 1;
    if (!Number.isFinite(fillPrice) || fillPrice <= 0) return 1;
    return fillPrice / futuresPriceAnchor;
  };
  const feePerContractNominal =
    params.feePerContract ?? IBKR_FEE_PER_CONTRACT[chooseContract(params.index)];

  const fullFamily = chooseContract(params.index);
  const microMode = params.microFutures === true;
  /** Family the sleeve sizes in: micro units with micros on, full contracts otherwise. */
  const sizingFamily = microMode ? microFamilyOf(fullFamily) : fullFamily;
  const unitsPerFull = getContractMultiplier(fullFamily) / getContractMultiplier(sizingFamily);
  /** `lots` hold sizing units; a full contract is `unitsPerFull` of them. */
  const unitsPerContract = (symbol: string): number =>
    familyOfSymbol(stripFuturesLedgerSuffix(symbol)) === fullFamily ? unitsPerFull : 1;
  const feeNominalForFamily = (family: FuturesContractSymbol): number =>
    family === fullFamily
      ? feePerContractNominal
      : feePerContractNominal * (IBKR_FEE_PER_CONTRACT[family] / IBKR_FEE_PER_CONTRACT[fullFamily]);
  const feeForUnits = (symbol: string, units: number, date: string): number => {
    const family = familyOfSymbol(stripFuturesLedgerSuffix(symbol)) ?? fullFamily;
    return (Math.abs(units) / unitsPerContract(symbol)) * (feeNominalForFamily(family) * feeDollarScaleForDate(date));
  };
  const futuresSpreadCost = (p: Parameters<typeof getTransactionSpreadCost>[0]): number =>
    getTransactionSpreadCost(p.instrument === "futures" ? { ...p, qtyDelta: p.qtyDelta / unitsPerContract(p.symbol) } : p);
  /**
   * Micros only while one full contract is a bigger leverage step than the
   * tolerance band; past that, whole contracts alone keep the sleeve inside it.
   */
  const microsNeededFor = (equity: number, fillPrice: number): boolean =>
    microMode &&
    params.targetLeverage > 0 &&
    equity > 0 &&
    getContractMultiplier(fullFamily) * fillPrice > params.targetLeverage * equity * (leverageTolerancePct / 100);
  /**
   * A buy of `units`: one full contract per whole `unitsPerFull`, micros for the
   * remainder while they are needed (otherwise the remainder stays unbought).
   */
  const splitBuyUnits = (units: number, withMicros: boolean): Array<{ family: FuturesContractSymbol; units: number }> => {
    if (!microMode) return [{ family: fullFamily, units }];
    const fullUnits = Math.floor(units / unitsPerFull) * unitsPerFull;
    return [
      { family: fullFamily, units: fullUnits },
      { family: sizingFamily, units: withMicros ? units - fullUnits : 0 },
    ].filter((leg) => leg.units > 0);
  };
  /** Units a reduction takes from `symbol`: a full contract only whole, so it can overshoot. */
  const reductionTakeUnits = (symbol: string, held: number, wanted: number): number =>
    Math.min(held, Math.ceil(wanted / unitsPerContract(symbol)) * unitsPerContract(symbol));

  // `cash` is consolidated marked capital in this engine, including Treasury
  // holdings. Only their P&L/costs change it; purchases are an internal transfer.
  const collateral = params.treasuryCollateral ? createFuturesCollateral({
    close: params.riskOffCloseByTicker ?? {}, open: params.riskOffOpenByTicker ?? {},
    dollarScale: feeDollarScaleForDate,
  }) : null;
  collateral?.mark(0, dates[0], false);
  const cashAccount = params.treasuryCollateral ? sharedCashAccount ?? new FuturesCashAccount() : null;
  const riskOffTickers = getRiskOffFetchTickers(params.riskOffAsset);
  const heldTickers = params.riskOffHeldTickers ?? riskOffTickers;
  const ownSlots = riskOffTickers.map((t) => heldTickers.indexOf(t));
  const rollCalendarDaysBeforeExpiry = Math.max(
    1,
    Math.round(params.rollCalendarDaysBeforeExpiry ?? DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY)
  );
  const rollDateByQuarter = buildRollDateMap(dates, rollCalendarDaysBeforeExpiry);

  const capQtyForPostTradeMaintenance = (params: {
    desiredQty: number;
    currentQty: number;
    cashBefore: number;
    riskOffValueAtClose: number;
    contract: FuturesContractSymbol;
    symbol: string;
    fillPrice: number;
    tradeDate: string;
  }): number => {
    const nextQty = Math.max(0, Math.floor(params.desiredQty));
    // Only upsizing can worsen maintenance headroom.
    if (nextQty <= params.currentQty) return nextQty;
    const mult = getContractMultiplier(params.contract);
    const perContractMaint = mult * params.fillPrice * maintMarginRate;
    const perContractEntryCost =
      feeForUnits(params.symbol, 1, params.tradeDate) +
      (getFuturesHalfSpreadPerContract(params.symbol) / unitsPerContract(params.symbol)) * futuresPriceScale(params.fillPrice);
    const denom = perContractMaint + perContractEntryCost;
    if (!Number.isFinite(denom) || denom <= 0) return params.currentQty;
    // Solve projectedExcess(q) >= 0 in closed form:
    // projectedExcess(q) = cash+riskOff+currentQty*entryCost - q*(maint+entryCost)
    const numerator = params.cashBefore + params.riskOffValueAtClose + (params.currentQty * perContractEntryCost);
    const maxSafeQty = Math.floor(numerator / denom);
    if (!Number.isFinite(maxSafeQty)) return params.currentQty;
    if (maxSafeQty < params.currentQty) return params.currentQty;
    return Math.min(nextQty, Math.max(params.currentQty, maxSafeQty));
  };
  const divAlpha = 2 / (DIVIDEND_EMA_LOOKBACK_DAYS + 1);
  return {
    params,
    entryVgshWeight,
    dates,
    adjCloses,
    smaInput,
    indexOpenPx,
    fullAboveSmaByDate,
    sma,
    invested,
    rateLookup,
    spreadAnnual,
    freeCashAt,
    fundingSpreadAnnual,
    maintMarginRate,
    maxLeverage,
    leverageTolerancePct,
    feeDollarScaleForDate,
    futuresPriceScale,
    fullFamily,
    microMode,
    sizingFamily,
    unitsPerFull,
    unitsPerContract,
    feeForUnits,
    futuresSpreadCost,
    microsNeededFor,
    splitBuyUnits,
    reductionTakeUnits,
    capQtyForPostTradeMaintenance,
    collateral,
    cashAccount,
    sharedCashAccount,
    executeTreasuryTrade,
    riskOffTickers,
    heldTickers,
    ownSlots,
    rollDateByQuarter,
    divAlpha,
  };
}

export type SleeveContext = ReturnType<typeof createSleeveContext>;
