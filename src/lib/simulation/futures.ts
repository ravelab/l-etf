import {
  createFuturesCollateral,
  type CollateralTrade,
  isTreasuryTicker,
  planRiskOffPurchases,
  type TreasuryHoldings,
} from "./futures-collateral";
import { FuturesCashAccount, type FuturesCashMember } from "./futures-cash-account";
import { createAssetValueRecorder, type DailyAssetValues } from "./futures-asset-values";
import type { PricePoint, RatePoint, IndexKey, EtfResult, RiskOffAsset } from "@/lib/simulation/types";
import { buildRateLookup } from "@/lib/simulation/borrowing-rate";
import { generateSmaSignals } from "@/lib/simulation/sma";
import { smaRiskOffGates } from "@/lib/simulation/risk-off-gates";
import { riskOffCloseMarkPrice, riskOffOpenTradePrice } from "@/lib/simulation/risk-off";
import { formatRiskOffLiquidationAbbrev, getRiskOffFetchTickers } from "@/lib/constants";
import { DEFAULT_LEVERAGE_TOLERANCE_PCT } from "@/lib/simulation/defaults";
import {
  DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY,
  type FuturesContractSymbol,
  addCalendarDaysIso,
  advanceQuarterlySymbol,
  buildRollDateMap,
  calendarDaysBetweenIso,
  chooseContract,
  contractSymbolsSortedForReduction,
  familyOfSymbol,
  futuresBasisFillPrice,
  futuresCarryForHoldingPeriod,
  getContractMultiplier,
  microFamilyOf,
  newTradesContractLabel,
  reconcileLots,
  rollSnapForSymbolFromMap,
  stripFuturesLedgerSuffix,
  sumLots,
} from "./futures-contracts";
import {
  FEE_SCHEDULE_ANCHOR_CPI,
  FEE_SCHEDULE_ANCHOR_DATE,
  IBKR_FEE_PER_CONTRACT,
  buildInflationDollarCostScaleLookup,
  getFuturesHalfSpreadPerContract,
  getRiskOffCommission,
  getTransactionSpreadCost,
} from "./futures-costs";
import {
  buildEtfResult,
  clampToFinite,
  computeLeverageDeltaPct,
  enforceMinimumQty,
  formatLeverageLabel,
  futuresLegLeverageDeltaPct,
  futuresPortfolioLeverageDeltaPctFromLots,
  maxQtyByLeverage,
  maxQtyByMaintenance,
  targetQty,
  totalFuturesNotionalAtMark,
} from "./futures-sizing";
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

export type FuturesTransactionRow = {
  date: string;
  action: "buy" | "sell";
  instrument: "futures" | "riskoff";
  symbol: string;
  qtyDelta: number;
  qtyAfter: number;
  fillPrice: number;
  fees: number;
  spread: number;
  cashInterestEarned: number;
  /** Days of positive sweep accrual since last attribution: trading-session EOD hits plus calendar gap days (weekends/holidays). */
  cashInterestTradingDays?: number;
  /** Net annualized sweep rate at attribution date, percent (e.g. 4.2). */
  cashInterestAnnualRatePct?: number;
  excessLiquidity: number;
  /** Leverage vs target (%) immediately before this futures leg executes. */
  leverageDeltaPctBefore?: number;
  leverageDeltaPct: number;
  equity: number;
  /** SPX sleeve equity for a dual-sleeve fund, used to show its share of total value. */
  spxEquity?: number;
  /** Synthetic closing row at window end (not an additional trade in PnL). */
  isEndLiquidation?: boolean;
  /**
   * Dollar value of every position held once this row executed, by symbol: futures
   * notional per listing (at the fill or close mark of the moment), risk-off shares
   * and Treasury collateral at market. A two-sleeve fund's rows hold the whole fund's
   * positions. Absent on ledgers produced before it existed.
   */
  holdingsAfter?: Record<string, number>;
  /**
   * Signed dollars traded per ticker, for a row that trades several tickers at
   * once and so has no single `qtyDelta` × `fillPrice` (the terminal risk-off close-out).
   */
  legValues?: Record<string, number>;
};

export type FuturesStrategyResult = {
  etfResult: EtfResult;
  targetLeverage: number;
  index: IndexKey;
  transactions: FuturesTransactionRow[];
  initialEquity: number;
  /** Mean end-of-day futures notional / equity on days in risk-on with an open position. */
  avgActualLeverageRiskOn: number;
  /** Max |actual/target − 1| in percent points at end of day while risk-on with futures, before emergency margin peels. */
  maxAbsLeverageDeltaRiskOnPct: number;
  /** Per-sleeve leverage metrics for a multi-sleeve fund result. */
  sleeveLeverageMetrics?: {
    primary: {
      avgActualLeverageRiskOn: number;
      maxAbsLeverageDeltaRiskOnPct: number;
    };
    secondary: {
      avgActualLeverageRiskOn: number;
      maxAbsLeverageDeltaRiskOnPct: number;
    };
  };
  /** Days in the window (`invested === false` after SMA shift). */
  riskOffSessionDayCount: number;
  sessionDayCount: number;
  /** Per-asset end-of-day dollars on `etfResult.dates`; only when the run asked to record them. */
  dailyAssetValues?: DailyAssetValues;
};

/** What a run records beyond its result; the engine's own path is unchanged either way. */
export type FuturesRunOptions = {
  /** Sample every asset's end-of-day dollar value into `dailyAssetValues`. */
  recordAssetValues?: boolean;
};

/**
 * What one sleeve owns outside its futures position. Sleeves of one fund share
 * one held-ticker list in the same order, so these are directly exchangeable.
 */
export type SleeveHoldings = {
  cash: number;
  riskOffShares: number[] | null;
  riskOffCash: number[] | null;
  /** Swept interest already earned but not yet posted to cash; equity counts it. */
  pendingCashInterest: number;
  /** Marked Treasury pool, already included in cash; transfers are in kind. */
  treasuryHoldings?: TreasuryHoldings;
  /** Cash held in the commodities segment, included in consolidated `cash`. */
  commoditiesCash?: number;
};

/**
 * A futures strategy that can be advanced one trading day at a time.
 *
 * `simulateFuturesSmaStrategy` runs it straight through. A composite fund steps
 * several sleeves along their own calendars so it can move capital between them
 * on the days its rebalance rule fires — which is only possible if no sleeve has
 * already consumed its whole price history.
 */
export type FuturesSleeve = {
  readonly dates: string[];
  /** SMA regime per day, already shifted for execution; true = risk-on. */
  readonly invested: boolean[];
  /** Equity at the close of day `i`; meaningful once that day has been stepped. */
  equityAt: (i: number) => number;
  /** End-of-day excess liquidity at day `i`, for summing across a fund's sleeves. */
  excessLiquidityAt: (i: number) => number;
  stepDay: (i: number) => void;
  readHoldings: () => SleeveHoldings;
  /** Replaces holdings and restates day `i`'s equity. Books no trade: see futures-dual-sleeve.ts. */
  writeHoldings: (holdings: SleeveHoldings, i: number, equity: number) => void;
  /** Dollar value of the positions held right now, in the shape of a ledger row's `holdingsAfter`. */
  positions: () => Record<string, number>;
  /** Ledger rows booked so far; `finish` returns them in this order. */
  transactionCount: () => number;
  finish: () => FuturesStrategyResult;
};

const DEFAULT_CASH_INTEREST_SPREAD_ANNUAL = 0.005; // 0.50%/yr haircut vs SOFR-like series

// ES/NQ do not roll at fair value: the roll's implied financing has run roughly
// +25 to +50bp over 3M OIS post-2010 (balance-sheet costs), NQ at or above ES.
// This is the futures analogue of the LETF swap spread — but a genuinely level
// premium, not one proportional to the rate. Charged on notional, so unlike the
// cash-sweep haircut (which only touches 1x collateral) it scales with leverage.
const DEFAULT_FUTURES_FUNDING_SPREAD_ANNUAL = 0.0035; // 0.35%/yr over the risk-free rate

const DEFAULT_CASH_INTEREST_FREE_CASH = 10_000;

const DIVIDEND_EMA_LOOKBACK_DAYS = 63;

const MAX_ABS_DIVIDEND_DAILY = 0.05 / 252; // clamp inferred q to +/-5% annualized

// Coarse, stable approximation for margin. We use a fraction of notional to produce
// a meaningful "Excess Liquidity" series without pretending to be an exact broker.
const DEFAULT_MAINT_MARGIN_RATE = 0.08; // 8% of notional

/** Net annual cash-sweep yield (percent points) implied by daily borrow minus broker spread (/360). */
function sweepNetAnnualPctFromRateDaily(rateDaily: number, spreadAnnual: number): number {
  return Math.max(0, rateDaily - spreadAnnual / 360) * 360 * 100;
}

export type FuturesStrategyParams = {
  index: IndexKey;
  prices: PricePoint[];
  /**
   * Optional alternative price series for SMA signal generation. When provided,
   * SMA signals are derived from this series instead of `prices`. The trading
   * series (`prices`) is unaffected. Used for cross-index signals, e.g. trading
   * NDX futures with an SPX SMA gate.
   */
  signalPrices?: PricePoint[];
  rates: RatePoint[];
  startDate: string;
  endDate: string;
  initialEquity: number;
  targetLeverage: number;
  maxLeverage?: number;
  displayName?: string;
  smaPeriod: number;
  smaUpperBuffer: number;
  smaLowerBuffer: number;
  /** Also hold risk-off while the volatility gate or RSI crash brake is tripped (`risk-off-gates.ts`). */
  smaVolGate?: boolean;
  riskOffAsset: RiskOffAsset;
  /**
   * Every ticker this sleeve may hold, a superset of `riskOffAsset`'s. A two-sleeve
   * fund whose sleeves use different baskets hands basket shares between them,
   * so each must be able to mark and sell the other's tickers; it only ever buys
   * its own. Both price maps must cover all of them.
   */
  riskOffHeldTickers?: string[];
  riskOffCloseByTicker?: Record<string, number[]>;
  riskOffOpenByTicker?: Record<string, number[]>;
  /** Enable the standalone Treasury collateral model; requires SGOV/VGSH price arrays. */
  treasuryCollateral?: boolean;
  /** Default sgov-buffer: buy SGOV below 200 shares OR 20% of Treasury holdings;
   * otherwise VGSH. The other preferences retain historical comparison policies. */
  treasuryBuyPreference?: "sgov-buffer" | "ndx-vgsh" | "vgsh-only" | "vgsh-above-sma" | "entry-only";
  /** Percentage of a risk-on entry purchase routed to VGSH; default 100. Scenario analysis only unless specified. */
  riskOnEntryVgshPct?: number;
  cashInterestSpreadAnnual?: number;
  cashInterestFreeCash?: number;
  /**
   * Annual premium the contract's embedded financing carries over the risk-free
   * rate, charged on notional. Set 0 to price rolls at fair value.
   * @default {@link DEFAULT_FUTURES_FUNDING_SPREAD_ANNUAL}
   */
  futuresFundingSpreadAnnual?: number;
  maintenanceMarginRate?: number;
  /**
   * Quarterly ES/NQ: roll and **front-month symbol** both use the same snap: the latest trading day
   * in the series on or before `(3rd Friday of expiry month) − N` calendar days (`buildRollDateMap`).
   * Must be ≥ 1.
   * @default {@link DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY}
   */
  rollCalendarDaysBeforeExpiry?: number;
  /**
   * Skip rebalance trades while |leverageDeltaPct| stays within ±this %.
   * Initial open, contract switches, risk-off transitions, and maintenance-cap
   * breaches still trade unconditionally.
   *
   * When `maxLeverage` is finite, the open max-leverage peel uses the same band:
   * trimming for leverage only starts if open notional/equity exceeds
   * `maxLeverage * (1 + this/100)`; sell sizing still targets ≤ `maxLeverage`.
   * That reduces buy/sell churn when target and cap are equal or close.
   */
  leverageTolerancePct?: number;
  /**
   * All-in cost per contract, per side, in FEE_SCHEDULE_ANCHOR_DATE dollars.
   * Defaults to the IBKR schedule for the run's contract.
   */
  feePerContract?: number;
  /**
   * Carry the part of the sleeve a whole ES/NQ cannot express in MES/MNQ (one
   * tenth the size). Sizing runs in micro units; buys take one full contract per
   * whole ten units and micros for the rest, reductions take micros first, and no
   * trade ever swaps one size for the other. Micros are bought only while one full
   * contract is a bigger leverage step than the tolerance band; held ones then go
   * with the next rebalance sell, never on their own. Off by default.
   */
  microFutures?: boolean;
  /** CPI series used to scale fixed-dollar commissions into historical dollars. */
  monthlyCpi?: Array<{ date: string; value: number }>;
  /**
   * Reference price for scaling bid/ask spreads. When not provided, uses the latest price
   * in the supplied series. For historical backtests, you typically want to pass today's
   * price (or latest available) to keep fees consistent across different backtest periods.
   * @default latest price in params.prices
   */
  futuresPriceAnchor?: number;
};

function futuresStrategyName(params: FuturesStrategyParams, leverageLabel: string): string {
  const name = params.displayName ?? `${leverageLabel}x ${params.index === "sp500" ? "SPX" : "NDX"} SMA`;
  return params.smaVolGate ? name.replace(/ SMA$/, " SMA Vol RSI") : name;
}

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
  if (sliced.length < 2) {
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

  let sumActualLeverageRiskOn = 0;
  let riskOnLeverageDayCount = 0;
  let maxAbsLeverageDeltaRiskOnPct = 0;

  const dailyEquity = new Array<number>(dates.length);
  /** End-of-day excess liquidity, so a composite fund can add its sleeves' together. */
  const dailyExcessLiquidity = new Array<number>(dates.length).fill(0);
  const transactions: FuturesTransactionRow[] = [];

  let cash = clampToFinite(params.initialEquity, 0);
  const lots = new Map<string, number>();
  let contract: FuturesContractSymbol | null = null;
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
  let accruedInterestSinceLastTx = 0;
  /** Count of credited sweep-interest days since last attribution row. */
  let interestSweepSessionCount = 0;
  let pendingMonthlyCashInterest = 0;
  let pendingMonthlyCashInterestDays = 0;
  let totalFees = 0;
  let totalSpreadCosts = 0;

  // `cash` is consolidated marked capital in this engine, including Treasury
  // holdings. Only their P&L/costs change it; purchases are an internal transfer.
  const collateral = params.treasuryCollateral ? createFuturesCollateral({
    close: params.riskOffCloseByTicker ?? {}, open: params.riskOffOpenByTicker ?? {},
    dollarScale: feeDollarScaleForDate,
  }) : null;
  collateral?.mark(0, dates[0], false);
  let collateralMarginRequirement = 0;
  const cashAccount = params.treasuryCollateral ? sharedCashAccount ?? new FuturesCashAccount() : null;
  let cashMember: FuturesCashMember | undefined;
  // Whether the last close ran risk-on maintenance, so the next risk-on close after a
  // risk-off stretch (or the run's first) is flagged as the entry that rebuilds the pool.
  let collateralRiskOnAtLastClose = false;
  const bookCollateralTrades = (trades: CollateralTrade[], date: string) => {
    for (const tx of trades) {
      cash -= tx.fees + tx.spread;
      totalFees += tx.fees;
      totalSpreadCosts += tx.spread;
      recordTransaction({ date, action: tx.quantity > 0 ? "buy" : "sell", instrument: "riskoff",
        symbol: `${tx.symbol} (COLLATERAL)`, qtyDelta: tx.quantity, qtyAfter: tx.quantityAfter,
        fillPrice: tx.price, fees: tx.fees, spread: tx.spread, cashInterestEarned: 0,
        excessLiquidity: cash - collateralMarginRequirement, leverageDeltaPct: 0, equity: cash });
    }
  };
  const riskOffTickers = getRiskOffFetchTickers(params.riskOffAsset);
  const heldTickers = params.riskOffHeldTickers ?? riskOffTickers;
  const ownSlots = riskOffTickers.map((t) => heldTickers.indexOf(t));
  let riskOffShares: number[] | null = null;
  let riskOffCash: number[] | null = null;
  let riskOffLastPrice: number[] | null = null;

  /**
   * Price the ledger values each futures listing at: the open fill while the day's
   * open trades execute, the close mark once the day is marked. The same prices the
   * trades fill at, so a fresh position's value equals what was paid for it.
   */
  let ledgerFuturesMark: ((symbol: string) => number) | null = null;
  /**
   * Dollar value of every position held at this instant, for the ledger's Assets
   * column: futures notional by listing, risk-off shares at their last price, and
   * Treasury collateral at its marked value. Cash is not a position.
   */
  const currentPositions = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [sym, q] of lots) {
      const mark = ledgerFuturesMark?.(sym) ?? Number.NaN;
      if (q > 0 && familyOfSymbol(sym) && mark > 0) {
        out[sym] = q * getContractMultiplier(sizingFamily) * mark;
      }
    }
    for (const [j, shares] of (riskOffShares ?? []).entries()) {
      const t = heldTickers[j];
      const px = riskOffLastPrice?.[j] ?? Number.NaN;
      if (shares > 0 && t && px > 0) out[t] = (out[t] ?? 0) + shares * px;
    }
    for (const [t, value] of Object.entries(collateral?.readHoldings() ?? {})) {
      if (value > 0) out[t] = (out[t] ?? 0) + value;
    }
    return out;
  };
  /** Appends a ledger row stamped with the positions held once it has executed. */
  function recordTransaction(row: FuturesTransactionRow): void {
    if (cashMember && row.instrument === "futures") {
      cashMember.commoditiesCash -= row.fees + row.spread;
    }
    // The engine counts in sizing units; the ledger shows whole contracts of each
    // listing and the position after as full-contract equivalents.
    const contractsRow = microMode && row.instrument === "futures"
      ? { ...row, qtyDelta: row.qtyDelta / unitsPerContract(row.symbol), qtyAfter: row.qtyAfter / unitsPerFull }
      : row;
    transactions.push({ ...contractsRow, holdingsAfter: currentPositions() });
  }
  let pendingEnterRiskOff = false;
  let pendingExitRiskOff = false;
  const rollCalendarDaysBeforeExpiry = Math.max(
    1,
    Math.round(params.rollCalendarDaysBeforeExpiry ?? DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY)
  );
  const rollDateByQuarter = buildRollDateMap(dates, rollCalendarDaysBeforeExpiry);
  const accrueCashInterest = (amount: number, days: number) => {
    if (!Number.isFinite(amount) || amount <= 0 || days <= 0) return;
    pendingMonthlyCashInterest += amount;
    pendingMonthlyCashInterestDays += days;
  };
  const accrueCollateralInterest = (amount: number, days: number) => {
    if (amount >= 0) accrueCashInterest(amount, days);
    else cash += amount; // Debit interest reduces available equity; never earns interest itself.
  };
  const creditPendingCashInterest = () => {
    if (!Number.isFinite(pendingMonthlyCashInterest) || pendingMonthlyCashInterest <= 0) return 0;
    const amount = pendingMonthlyCashInterest;
    cash += amount;
    accruedInterestSinceLastTx += amount;
    interestSweepSessionCount += Math.max(1, pendingMonthlyCashInterestDays);
    pendingMonthlyCashInterest = 0;
    pendingMonthlyCashInterestDays = 0;
    return amount;
  };

  const enterPooledRiskOff = (i: number, date: string, atOpen: boolean) => {
    if (!collateral || riskOffTickers.length === 0) return;
    const treasuryWeight = riskOffTickers.filter(isTreasuryTicker).length / riskOffTickers.length;
    bookCollateralTrades(collateral.fundRiskOff(cash * treasuryWeight, date), date);
    const targets = Object.fromEntries(riskOffTickers.map(t => [t, cash / riskOffTickers.length]));
    const budgets = planRiskOffPurchases(targets, collateral.value(), cash - collateral.value());
    riskOffShares = new Array(heldTickers.length).fill(0);
    riskOffCash = new Array(heldTickers.length).fill(0);
    riskOffLastPrice = new Array(heldTickers.length).fill(NaN);
    for (const [k, t] of riskOffTickers.entries()) {
      const budget = budgets[t] ?? 0;
      if (!(budget > 0)) continue;
      if (isTreasuryTicker(t)) {
        bookCollateralTrades(collateral.buy(t, budget, date), date);
        continue;
      }
      const px = atOpen
        ? riskOffOpenTradePrice({ openValues: params.riskOffOpenByTicker?.[t], closeValues: params.riskOffCloseByTicker?.[t], index: i })
        : riskOffCloseMarkPrice({ closeValues: params.riskOffCloseByTicker?.[t], index: i });
      if (!(px && Number.isFinite(px) && px > 0)) continue; // Unfilled budget stays cash.
      const spread = futuresSpreadCost({ instrument: "riskoff", symbol: t, qtyDelta: budget / px, fillPrice: px });
      const fees = getRiskOffCommission({ qtyDelta: budget / px, fillPrice: px, dollarScale: feeDollarScaleForDate(date) });
      const shares = Math.max(0, budget - spread - fees) / px;
      const j = ownSlots[k];
      riskOffShares[j] = shares;
      riskOffLastPrice[j] = px;
      cash -= budget;
      totalFees += fees;
      totalSpreadCosts += spread;
      recordTransaction({ date, action: "buy", instrument: "riskoff", symbol: t,
        qtyDelta: shares, qtyAfter: shares, fillPrice: px, fees, spread,
        cashInterestEarned: 0, excessLiquidity: 0, leverageDeltaPct: 0,
        equity: cash + riskOffShares.reduce((sum, qty, slot) => sum + qty * (riskOffLastPrice?.[slot] || 0), 0) });
    }
    if (!riskOffShares.some(qty => qty > 0)) {
      riskOffShares = null;
      riskOffCash = null;
      riskOffLastPrice = null;
    }
  };

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
  let dividendEmaDaily = 0;

  let closeIndex = 0;
  let closeBasket = 0;
  let closeNotional = 0;
  let closeMetricEquity = 0;
  let closeCounted = false;
  let maintenanceVgsh = true;
  let entryClose = true;
  let ruined = false;
  if (collateral && cashAccount) {
    cashMember = {
      commoditiesCash: 0, margin: 0,
      equity: () => cash + closeBasket + pendingMonthlyCashInterest,
      securitiesCash: () => cash - collateral.value() - cashMember!.commoditiesCash,
      treasuries: () => collateral.readHoldings(),
      assignTreasuries: holdings => collateral.writeHoldings(holdings),
      canBuyTreasuries: () => !ruined && (Boolean(invested[closeIndex]) || riskOffTickers.some(isTreasuryTicker)),
      preferVgsh: () => maintenanceVgsh,
      sgovBufferEnabled: () => (params.treasuryBuyPreference ?? "sgov-buffer") === "sgov-buffer",
      riskOnEntry: () => entryClose && Boolean(invested[closeIndex]),
      execute: executeTreasuryTrade,
      rateDaily: () => rateLookup.getRate(dates[closeIndex]),
      dollarScale: () => feeDollarScaleForDate(dates[closeIndex]),
      buy: (budget, preferVgsh, selectedTickerOnly) => bookCollateralTrades(selectedTickerOnly
        ? collateral.buy(preferVgsh ? "VGSH" : "SGOV", budget, dates[closeIndex])
        : collateral.rebalance(collateral.value() + budget, 0, dates[closeIndex], preferVgsh,
          entryClose ? entryVgshWeight : undefined), dates[closeIndex]),
      sell: (ticker, budget) => {
        const trades = collateral.sell(ticker, budget, dates[closeIndex]);
        bookCollateralTrades(trades, dates[closeIndex]);
        return trades;
      },
      accrueInterest: accrueCollateralInterest,
      refresh: () => {
        const equity = cash + closeBasket;
        if (closeCounted && invested[closeIndex] && closeNotional > 0 && equity > 0 && closeMetricEquity > 0) {
          sumActualLeverageRiskOn += closeNotional / equity - closeNotional / closeMetricEquity;
          maxAbsLeverageDeltaRiskOnPct = Math.max(maxAbsLeverageDeltaRiskOnPct,
            Math.abs(computeLeverageDeltaPct(closeNotional / equity, params.targetLeverage)));
        }
        closeMetricEquity = equity;
        dailyEquity[closeIndex] = equity + pendingMonthlyCashInterest;
        const excess = equity - collateralMarginRequirement - collateral.value() * 0.25;
        dailyExcessLiquidity[closeIndex] = excess;
        for (let t = transactions.length - 1; t >= 0 && transactions[t].date === dates[closeIndex]; t--) {
          transactions[t].excessLiquidity = excess;
          if (transactions[t].instrument !== "futures") transactions[t].leverageDeltaPct =
            computeLeverageDeltaPct(equity > 0 ? closeNotional / equity : 0, params.targetLeverage);
        }
      },
    };
    cashAccount.add(cashMember);
  }

  dailyEquity[0] = cash;
  const firstDate = dates[0];
  const firstSpot = smaInput[0];
  // Day 0 establishes the starting position rather than executing a signal, so it
  // fills at the first close — the same bar `dailyEquity[0]` marks, and the same
  // convention `simulateSingleEtf` uses for its own day-0 value. Filling at the
  // open instead would size off one price and mark at another, silently dropping
  // (risk-on) or keeping (risk-off) that day's intraday move depending on regime.
  const startsRiskOn = Boolean(invested[0]);
  ledgerFuturesMark = (sym) => futuresBasisFillPrice({
    spotPrice: firstSpot,
    symbol: sym,
    tradeDate: firstDate,
    rateDaily: rateLookup.getRate(firstDate),
    dividendDaily: 0,
  });
  if (startsRiskOn && Number.isFinite(firstSpot) && firstSpot > 0) {
    const initialTargetNotional = Math.max(0, params.targetLeverage * cash);
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
      equity: cash,
      close: initialFillPrice,
      contract: initialContract,
      maintenanceMarginRate: maintMarginRate,
    });
    const initialMaxByLeverage = maxQtyByLeverage({
      equity: cash,
      close: initialFillPrice,
      contract: initialContract,
      maxLeverage,
    });
    const initialQty = capQtyForPostTradeMaintenance({
      desiredQty: Math.min(initialQtyUncapped, initialMaxByMaintenance, initialMaxByLeverage),
      currentQty: 0,
      cashBefore: cash,
      riskOffValueAtClose: 0,
      contract: initialContract,
      symbol: initialSymbol,
      fillPrice: initialFillPrice,
      tradeDate: firstDate,
    });
    if (initialQty > 0) {
      contract = initialContract;
      let heldUnits = 0;
      let notional = 0;
      let equity = cash;
      let excessLiquidity = 0;
      let leverageDeltaPct = 0;
      for (const leg of splitBuyUnits(initialQty, microsNeededFor(cash, initialFillPrice))) {
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
          equity: cash,
          targetLeverage: params.targetLeverage,
        });
        cash -= (fees + spread);
        totalFees += fees;
        totalSpreadCosts += spread;
        heldUnits += leg.units;
        lots.set(legSymbol, (lots.get(legSymbol) ?? 0) + leg.units);
        notional = heldUnits * getContractMultiplier(initialContract) * initialFillPrice;
        const maintenanceMarginUsed = notional * maintMarginRate;
        equity = cash;
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
      dailyExcessLiquidity[0] = excessLiquidity;
      if (invested[0] && equity > 0) {
        const lev = notional / equity;
        if (Number.isFinite(lev)) {
          sumActualLeverageRiskOn += lev;
          riskOnLeverageDayCount += 1;
        }
        maxAbsLeverageDeltaRiskOnPct = Math.max(maxAbsLeverageDeltaRiskOnPct, Math.abs(leverageDeltaPct));
      }
    }
    dailyEquity[0] = cash;
    // No futures opened on day 0 leaves the whole balance free.
    if (initialQty <= 0) dailyExcessLiquidity[0] = cash;
  } else if (collateral && riskOffTickers.length > 0) {
    enterPooledRiskOff(0, firstDate, false);
    const basket = (riskOffShares as number[] | null)?.reduce((sum, qty, j) => sum + qty * (riskOffLastPrice?.[j] || 0), 0) ?? 0;
    dailyEquity[0] = cash + basket;
    dailyExcessLiquidity[0] = dailyEquity[0] - collateral.value() * 0.25;
  } else if (riskOffTickers.length > 0) {
    // Starts in risk-off: establish the basket at the first close (see above), so
    // day 0 books it at cost and the curve starts flat exactly like the LETF engine.
    const investable = cash;
    const valuePer = investable / riskOffTickers.length;
    riskOffShares = new Array(heldTickers.length).fill(0);
    riskOffCash = new Array(heldTickers.length).fill(0);
    riskOffLastPrice = new Array(heldTickers.length).fill(NaN);
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
        riskOffShares[j] = shares;
        riskOffLastPrice[j] = openPx as number;
        totalFees += fees;
        totalSpreadCosts += spread;
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
        riskOffCash[j] = valuePer;
      }
    }
    cash = 0;

    // Mark at the first close (the entry bar): books the basket at cost.
    let day0Equity = 0;
    for (let j = 0; j < heldTickers.length; j++) {
      const t = heldTickers[j];
      const shares = riskOffShares?.[j] ?? 0;
      const closeArr = params.riskOffCloseByTicker?.[t];
      const closePx = riskOffCloseMarkPrice({ closeValues: closeArr, index: 0, lastPrice: riskOffLastPrice?.[j] });
      if (shares > 0 && Number.isFinite(closePx) && (closePx as number) > 0) {
        day0Equity += shares * (closePx as number);
        if (riskOffLastPrice) riskOffLastPrice[j] = closePx as number;
      } else if (shares > 0) {
        const last = riskOffLastPrice?.[j];
        const fallbackPrice =
          Number.isFinite(last ?? NaN) && (last as number) > 0 ? (last as number) : 0;
        day0Equity += fallbackPrice > 0 ? shares * fallbackPrice : 0;
      }
      const cashPiece = riskOffCash?.[j] ?? 0;
      if (Number.isFinite(cashPiece) && cashPiece > 0) day0Equity += cashPiece;
    }
    dailyEquity[0] = day0Equity > 0 ? day0Equity : 0;
    dailyExcessLiquidity[0] = dailyEquity[0];
  }

  /**
   * Wiped out: every remaining day is already zeroed, so no later day may run.
   * Stands in for the `break` this was before it became a per-day step.
   */
  if (collateral) {
    collateral.mark(0, dates[0], false);
    if (invested[0] && contract) {
      collateralMarginRequirement = totalFuturesNotionalAtMark({ lots, contract,
        mark: sym => futuresBasisFillPrice({ spotPrice: smaInput[0], symbol: sym,
          tradeDate: dates[0], rateDaily: rateLookup.getRate(dates[0]), dividendDaily: 0 }) }) * maintMarginRate;
      collateralRiskOnAtLastClose = true;
      dailyEquity[0] = cash;
      dailyExcessLiquidity[0] = cash - collateralMarginRequirement - collateral.value() * 0.25;
    }
    closeNotional = contract ? totalFuturesNotionalAtMark({ lots, contract,
      mark: sym => futuresBasisFillPrice({ spotPrice: smaInput[0], symbol: sym,
        tradeDate: dates[0], rateDaily: rateLookup.getRate(dates[0]), dividendDaily: 0 }) }) : 0;
    closeBasket = dailyEquity[0] - cash;
    closeMetricEquity = cash + closeBasket;
    closeCounted = invested[0] && closeNotional > 0;
    if (cashMember) cashMember.margin = collateralMarginRequirement;
    if (!sharedCashAccount) cashAccount?.close();
  }

  /** One trading day for this sleeve. Was the body of the day loop; `continue` is now `return`. */
  const stepDay = (i: number): void => {
    if (ruined) return;
    const date = dates[i];
    closeCounted = false;
    const prevSpot = smaInput[i - 1];
    const spot = smaInput[i];
    const idxOpen =
      Number.isFinite(indexOpenPx[i]) && indexOpenPx[i] > 0 ? indexOpenPx[i] : spot;
    if (!Number.isFinite(prevSpot) || !Number.isFinite(spot) || prevSpot <= 0 || spot <= 0) {
      // If data is bad, carry forward equity without changing positions.
      dailyEquity[i] = clampToFinite(dailyEquity[i - 1], cash);
      dailyExcessLiquidity[i] = dailyExcessLiquidity[i - 1] ?? 0;
      return;
    }

    // Sweep interest on non-trading calendar days (Sat/Sun/holidays) between index rows: same daily rate × gap,
    // balance frozen at prior session close (before today's overnight futures cash). Uses prior session SOFR.
    const gapCalendarDays = calendarDaysBetweenIso(dates[i - 1] as string, dates[i] as string);
    const extraSweepDays = Math.max(0, gapCalendarDays - 1);
    cashAccount?.beginSession(date, feeDollarScaleForDate(dates[i - 1]), rateLookup.getRate(dates[i - 1]), extraSweepDays);
    if (!collateral && extraSweepDays > 0) {
      const ratePrev = rateLookup.getRate(dates[i - 1] as string);
      const spreadDailyGap = spreadAnnual / 360;
      const cashRateGap = Math.max(0, ratePrev - spreadDailyGap);
      const cashYieldGap = Math.max(0, cash - freeCashAt(dates[i - 1] as string));
      let accrualMonth = (dates[i - 1] as string).slice(0, 7);
      for (let gapDay = 1; gapDay <= extraSweepDays; gapDay++) {
        const gapDate = addCalendarDaysIso(dates[i - 1] as string, gapDay);
        const gapMonth = gapDate.slice(0, 7);
        if (gapMonth !== accrualMonth) {
          creditPendingCashInterest();
          accrualMonth = gapMonth;
        }
        accrueCashInterest(cashYieldGap * cashRateGap, 1);
      }
      if (date.slice(0, 7) !== accrualMonth) {
        creditPendingCashInterest();
      }
    } else if (date.slice(0, 7) !== (dates[i - 1] as string).slice(0, 7)) {
      // First trading row of a new month: prior-month sweep is now posted cash.
      creditPendingCashInterest();
    }

    if (collateral) cash += collateral.mark(i, date, true);

    // SMA uses prior close; regime trades execute next session shortly after the open (opens for fills).
    if (invested[i] !== invested[i - 1]) {
      if (invested[i]) {
        pendingExitRiskOff = true;
      } else {
        pendingEnterRiskOff = true;
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
    dividendEmaDaily = (dividendEmaDaily * (1 - divAlpha)) + (realizedDividend * divAlpha);
    const dividendDaily = Math.max(-MAX_ABS_DIVIDEND_DAILY, Math.min(MAX_ABS_DIVIDEND_DAILY, dividendEmaDaily));
    const rateDaily = rateLookup.getRate(date); // already /360

    const takeCashInterestFieldsForAttribution = (amount: number) => {
      if (!Number.isFinite(amount) || amount <= 0) return {};
      const fields = {
        cashInterestTradingDays: Math.max(1, interestSweepSessionCount),
        cashInterestAnnualRatePct: sweepNetAnnualPctFromRateDaily(rateDaily, spreadAnnual),
      };
      interestSweepSessionCount = 0;
      return fields;
    };
    const futuresFillAt = (symbol: string, spotPrice = idxOpen) => futuresBasisFillPrice({
      spotPrice,
      symbol,
      tradeDate: date,
      rateDaily,
      dividendDaily,
    });
    ledgerFuturesMark = futuresFillAt;

    // Realize prior-close-to-current-open futures PnL before same-day open trades.
    // Charge futures carry to contracts held from the prior close, not contracts
    // opened today. Rate accrues per calendar day so weekend/holiday carry matches
    // cash sweep accrual. Fills/notional use estimated contract prices, but
    // portfolio economics stay on index moves plus explicit carry so financing is
    // not counted both in basis decay and collateral interest; netting the
    // realized dividend against the rate leaves a held position earning exactly
    // the index total return minus financing.
    if (contract && sumLots(lots) > 0) {
      const mult = getContractMultiplier(contract);
      const carryDaysSincePrevClose = Math.max(1, gapCalendarDays);
      const futuresCarrySincePrevClose = futuresCarryForHoldingPeriod({
        rateDaily,
        fundingSpreadAnnual,
        dividendForPeriod: realizedDividend,
        calendarDays: carryDaysSincePrevClose,
      });
      for (const [, q] of lots) {
        if (q <= 0) continue;
        const pnl = q * mult * (idxOpen - prevSpot - (prevSpot * futuresCarrySincePrevClose));
        cash += pnl;
        if (cashMember) cashMember.commoditiesCash += pnl;
      }
    }

    // Next-day-open: exit risk-off basket before enter-risk-off (mutually exclusive flags per day).
    // The flag is consumed unconditionally: with no basket held there is nothing to sell,
    // and leaving it set would latch and fire against an unrelated basket on a later day.
    const exitingRiskOff = pendingExitRiskOff && (riskOffShares != null || riskOffCash != null);
    pendingExitRiskOff = false;
    if (exitingRiskOff) {
      for (let j = 0; j < heldTickers.length; j++) {
        const t = heldTickers[j];
        const shares = riskOffShares?.[j] ?? 0;
        const openArr = params.riskOffOpenByTicker?.[t];
        const closeArr = params.riskOffCloseByTicker?.[t];
        const openPx = riskOffOpenTradePrice({
          openValues: openArr,
          closeValues: closeArr,
          index: i,
          lastPrice: riskOffLastPrice?.[j],
        });
        if (shares > 0 && Number.isFinite(openPx) && (openPx as number) > 0) {
          const gross = shares * (openPx as number);
          const spread = futuresSpreadCost({
            instrument: "riskoff",
            symbol: t,
            qtyDelta: shares,
            fillPrice: openPx as number,
          });
          const fees = getRiskOffCommission({
            qtyDelta: shares,
            fillPrice: openPx as number,
            dollarScale: feeDollarScaleForDate(date),
          });
          cash += Math.max(0, gross - spread - fees);
          totalFees += fees;
          totalSpreadCosts += spread;
          // Sold before the row is stamped, so its holdings show only the legs still held.
          if (riskOffShares) riskOffShares[j] = 0;
          recordTransaction({
            date,
            action: "sell",
            instrument: "riskoff",
            symbol: t,
            qtyDelta: -shares,
            qtyAfter: 0,
            fillPrice: openPx as number,
            fees,
            spread,
            cashInterestEarned: 0,
            excessLiquidity: 0,
            leverageDeltaPct: 0,
            equity: cash,
          });
        }
        const cashPiece = riskOffCash?.[j] ?? 0;
        if (Number.isFinite(cashPiece) && cashPiece > 0) cash += cashPiece;
      }
      riskOffShares = null;
      riskOffCash = null;
      riskOffLastPrice = null;
    }

    if (pendingEnterRiskOff) {
      collateralMarginRequirement = 0;
      // Flatten futures at index open, then buy risk-off legs at their opens (same-time book).
      if (sumLots(lots) > 0 && contract) {
        const totalBefore = sumLots(lots);
        let runningQty = totalBefore;
        let intRemainFlat = accruedInterestSinceLastTx;
        for (const sym of contractSymbolsSortedForReduction(lots, date)) {
          const qLeg = lots.get(sym) ?? 0;
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
            contract,
            futuresMarkPrice: fillPrice,
            equity: cash,
            targetLeverage: params.targetLeverage,
          });
          cash -= (fees + spread);
          totalFees += fees;
          totalSpreadCosts += spread;
          runningQty -= qLeg;
          const levAfter = futuresLegLeverageDeltaPct({
            qty: runningQty,
            contract: runningQty > 0 ? contract : null,
            futuresMarkPrice: fillPrice,
            equity: cash,
            targetLeverage: params.targetLeverage,
          });
          const intAmt = intRemainFlat;
          if (intAmt > 0) intRemainFlat = 0;
          lots.set(sym, 0);
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
            equity: cash,
          });
        }
        reconcileLots(lots);
        contract = null;
        accruedInterestSinceLastTx = 0;
      }

      if (collateral) {
        enterPooledRiskOff(i, date, true);
      } else {
      // With no risk-off components configured there is nothing to allocate into, so stay
      // in cash — exactly what the day-0 risk-off path does. Booking an empty basket and
      // zeroing `cash` below would mark the account at 0 and trip the bankruptcy branch
      // for the rest of the run.
      const canEnterRiskOff = riskOffTickers.length > 0;
      const investable = cash;
      const valuePer = canEnterRiskOff ? investable / riskOffTickers.length : 0;
      const enteredShares = new Array<number>(heldTickers.length).fill(0);
      const enteredCash = new Array<number>(heldTickers.length).fill(0);
      const enteredLastPrice = new Array<number>(heldTickers.length).fill(NaN);
      riskOffShares = canEnterRiskOff ? enteredShares : null;
      riskOffCash = canEnterRiskOff ? enteredCash : null;
      riskOffLastPrice = canEnterRiskOff ? enteredLastPrice : null;
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
          totalFees += fees;
          totalSpreadCosts += spread;
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
      if (canEnterRiskOff) cash = 0;
      }
      pendingEnterRiskOff = false;
    }

    // Open-only risk trim: if maintenance or max leverage is already breached at **open** marks,
    // peel futures at open fills. We do not trade futures at the close for leverage or margin.
    // Leverage-only breach uses the same relative band as drift (`leverageTolerancePct`): peel
    // only when notional/equity exceeds maxLeverage * (1 + tolerance/100), so small overages
    // do not fight routine rebalance sizing (reduces 2↔3 contract toggling when max ≈ target).
    if (invested[i] && !(riskOffShares || riskOffCash) && contract != null && sumLots(lots) > 0) {
      const markOpen = (sym: string) => futuresFillAt(sym);
      let intRemainOpenTrim = accruedInterestSinceLastTx;
      const openLevTrimBreachThreshold =
        Number.isFinite(maxLeverage) && maxLeverage > 0
          ? maxLeverage * (1 + leverageTolerancePct / 100)
          : Number.POSITIVE_INFINITY;
      while (sumLots(lots) > 0 && contract != null) {
        const notionalO = totalFuturesNotionalAtMark({
          lots,
          contract,
          mark: markOpen,
        });
        const equityO = cash;
        const excessO = equityO - notionalO * maintMarginRate;
        const levO = equityO > 0 ? notionalO / equityO : Number.POSITIVE_INFINITY;
        const levBreaches =
          Number.isFinite(maxLeverage) && maxLeverage > 0 && levO > openLevTrimBreachThreshold;
        if (excessO > 0 && !levBreaches) break;

        const sym =
          contractSymbolsSortedForReduction(lots, date).find((s) => (lots.get(s) ?? 0) > 0) ?? null;
        if (sym == null) break;
        const q0 = lots.get(sym) ?? 0;
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
          contract != null ? getContractMultiplier(contract) * fillPrice : 0;

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
          lots,
          contract,
          equity: cash,
          targetLeverage: params.targetLeverage,
          mark: markOpen,
        });
        cash -= fees + spread;
        totalFees += fees;
        totalSpreadCosts += spread;
        lots.set(sym, q0 - sellQty);
        reconcileLots(lots);
        const afterTotal = sumLots(lots);
        if (afterTotal === 0) {
          contract = null;
        }
        const levAfterTrim = futuresPortfolioLeverageDeltaPctFromLots({
          lots,
          contract: afterTotal > 0 ? contract : null,
          equity: cash,
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
          equity: cash,
        });
        if (intAmt > 0) accruedInterestSinceLastTx = 0;
      }
    }

    // Futures equity available at the open, before any roll/routine sizing.
    const equityBeforeTrade: number = cash;
    // Only allow futures positions when we are in risk-on AND have no risk-off holdings.
    // This enforces "sell risk-off first to free collateral cash".
    const hasRiskOffHoldings = Boolean(riskOffShares || riskOffCash);
    const wantsRiskOn = Boolean(invested[i]) && !hasRiskOffHoldings;
    const targetLev = wantsRiskOn ? params.targetLeverage : 0;

    let targetNotional = wantsRiskOn ? params.targetLeverage * equityBeforeTrade : 0;
    targetNotional = Math.max(0, targetNotional);

    const nextContract = wantsRiskOn ? sizingFamily : null;
    const markFuturesOpen = (sym: string) => futuresFillAt(sym);

    const quarterlyRollAppliesToday = (): boolean => {
      if (!wantsRiskOn || contract == null || sumLots(lots) <= 0 || nextContract == null) return false;
      for (const [sym, rollQty] of lots.entries()) {
        if (rollQty <= 0) continue;
        const snap = rollSnapForSymbolFromMap(sym, date, rollDateByQuarter);
        if (snap !== date) continue;
        const nextSym = advanceQuarterlySymbol(sym, date);
        if (nextSym !== sym) return true;
      }
      return false;
    };

    const executeQuarterlyRolls = () => {
      if (!wantsRiskOn || contract == null || sumLots(lots) <= 0 || nextContract == null) return;
      const legs = [...lots.entries()].filter(([, q]) => q > 0);
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
          lots,
          contract,
          equity: cash,
          targetLeverage: params.targetLeverage,
          mark: markFuturesOpen,
        });
        cash -= sellFees + sellSpread;
        totalFees += sellFees;
        totalSpreadCosts += sellSpread;
        lots.set(sym, (lots.get(sym) ?? 0) - rollQty);
        reconcileLots(lots);
        const rollLevAfterSell = futuresPortfolioLeverageDeltaPctFromLots({
          lots,
          contract,
          equity: cash,
          targetLeverage: params.targetLeverage,
          mark: markFuturesOpen,
        });
        const interestOnRollOpen = accruedInterestSinceLastTx;
        recordTransaction({
          date,
          action: "sell",
          instrument: "futures",
          symbol: `${sym} (ROLL)`,
          qtyDelta: -rollQty,
          qtyAfter: sumLots(lots),
          fillPrice: sellFillPrice,
          fees: sellFees,
          spread: sellSpread,
          cashInterestEarned: interestOnRollOpen,
          ...takeCashInterestFieldsForAttribution(interestOnRollOpen),
          excessLiquidity: 0,
          leverageDeltaPctBefore: rollLevBeforeSell,
          leverageDeltaPct: rollLevAfterSell,
          equity: cash,
        });
        accruedInterestSinceLastTx = 0;

        const rollLevBeforeBuy = rollLevAfterSell;
        cash -= buyFees + buySpread;
        totalFees += buyFees;
        totalSpreadCosts += buySpread;
        lots.set(nextSym, (lots.get(nextSym) ?? 0) + rollQty);
        reconcileLots(lots);
        const rollLevAfterBuy = futuresPortfolioLeverageDeltaPctFromLots({
          lots,
          contract,
          equity: cash,
          targetLeverage: params.targetLeverage,
          mark: markFuturesOpen,
        });
        recordTransaction({
          date,
          action: "buy",
          instrument: "futures",
          symbol: `${nextSym} (ROLL)`,
          qtyDelta: rollQty,
          qtyAfter: sumLots(lots),
          fillPrice: buyFillPrice,
          fees: buyFees,
          spread: buySpread,
          cashInterestEarned: 0,
          excessLiquidity: 0,
          leverageDeltaPctBefore: rollLevBeforeBuy,
          leverageDeltaPct: rollLevAfterBuy,
          equity: cash,
        });
      }
    };

    let currentQtyAfterRolls = sumLots(lots);

    // If contract family changes we fully close and reopen for clarity.
    const needsContractSwitch =
      wantsRiskOn &&
      contract != null &&
      nextContract != null &&
      contract !== nextContract &&
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
            cashBefore: cash,
            riskOffValueAtClose: 0,
            contract: nextContract,
            symbol: nextContractLabel ?? nextContract,
            fillPrice: nextContractOpenPrice,
            tradeDate: date,
          })
        : 0;

    const currentNotional =
      contract != null && currentQtyAfterRolls > 0
        ? totalFuturesNotionalAtMark({
            lots,
            contract,
            mark: markFuturesOpen,
          })
        : 0;
    const currentLeverage = equityBeforeTrade > 0 ? currentNotional / equityBeforeTrade : 0;
    const currentLeverageDeltaPct = computeLeverageDeltaPct(currentLeverage, targetLev);
    const isMaintenanceBreach = wantsRiskOn && currentQtyAfterRolls > maxQtyMaint;
    const driftBreachesTolerance =
      wantsRiskOn &&
      currentQtyAfterRolls > 0 &&
      contract === nextContract &&
      Math.abs(currentLeverageDeltaPct) > leverageTolerancePct;
    const shouldRebalance =
      wantsRiskOn &&
      (currentQtyAfterRolls === 0 ||
        contract !== nextContract ||
        isMaintenanceBreach ||
        driftBreachesTolerance);
    let targetQtyValue = shouldRebalance ? desiredTargetQty : currentQtyAfterRolls;

    const rebalanceOnlyDrift =
      wantsRiskOn &&
      nextContract != null &&
      currentQtyAfterRolls > 0 &&
      contract === nextContract &&
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
      const cashAfterProbe = cash - feesProbe - spreadProbe;
      const nextLotsProbe = new Map(lots);
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
      currentQtyAfterRolls = sumLots(lots);
    }

    const shouldTrade =
      needsContractSwitch ||
      (!wantsRiskOn && currentQtyAfterRolls > 0) ||
      (wantsRiskOn &&
        nextContract != null &&
        (currentQtyAfterRolls !== targetQtyValue || contract !== nextContract));

    if (shouldTrade) {
      const mustCloseAll =
        currentQtyAfterRolls > 0 &&
        contract != null &&
        (!wantsRiskOn || needsContractSwitch || (nextContract != null && contract !== nextContract));
      if (mustCloseAll) {
        let runningQty = currentQtyAfterRolls;
        let intRemainMust = accruedInterestSinceLastTx;
        for (const sym of contractSymbolsSortedForReduction(lots, date)) {
          const qLeg = lots.get(sym) ?? 0;
          if (qLeg <= 0) continue;
          const delta = -qLeg;
          const fillPrice = futuresFillAt(sym);
          const fees = feeForUnits(sym, delta, date);
          const levBeforeClose = futuresPortfolioLeverageDeltaPctFromLots({
            lots,
            contract,
            equity: cash,
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
          cash -= fees + spread;
          totalFees += fees;
          totalSpreadCosts += spread;
          runningQty -= qLeg;
          lots.set(sym, 0);
          reconcileLots(lots);
          const levAfterClose = futuresPortfolioLeverageDeltaPctFromLots({
            lots,
            contract: runningQty > 0 ? contract : null,
            equity: cash,
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
            equity: cash,
          });
        }
        contract = null;
        accruedInterestSinceLastTx = 0;
      }

      if (wantsRiskOn && nextContract != null) {
        const afterCloseQty = sumLots(lots);
        const delta = targetQtyValue - afterCloseQty;
        if (delta !== 0) {
          if (delta > 0) {
            for (const leg of splitBuyUnits(delta, microsNeededFor(equityBeforeTrade, nextContractOpenPrice))) {
            const tradeSymbol = newTradesContractLabel(microMode ? leg.family : nextContract, date, rollDateByQuarter);
            const fillPrice = futuresFillAt(tradeSymbol);
            const heldBefore = sumLots(lots);
            const fees = feeForUnits(tradeSymbol, leg.units, date);
            const levBefore = futuresPortfolioLeverageDeltaPctFromLots({
              lots,
              contract: heldBefore > 0 ? contract : null,
              equity: cash,
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
            cash -= fees + spread;
            totalFees += fees;
            totalSpreadCosts += spread;
            lots.set(tradeSymbol, (lots.get(tradeSymbol) ?? 0) + leg.units);
            reconcileLots(lots);
            contract = nextContract;
            const newTotal = sumLots(lots);
            const levAfter = futuresPortfolioLeverageDeltaPctFromLots({
              lots,
              contract,
              equity: cash,
              targetLeverage: params.targetLeverage,
              mark: markFuturesOpen,
            });
            const intOnBuy = accruedInterestSinceLastTx;
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
              equity: cash,
            });
            accruedInterestSinceLastTx = 0;
            }
          } else {
            let toSell = -delta;
            // Unneeded micros are never sold on their own; a rebalance sell takes them
            // first, and takes all of them when the book stays inside the band without.
            if (microMode && !microsNeededFor(equityBeforeTrade, nextContractOpenPrice)) {
              const microUnits = [...lots.entries()]
                .filter(([sym, q]) => q > 0 && familyOfSymbol(sym) === sizingFamily)
                .reduce((sum, [, q]) => sum + q, 0);
              const unitNotional = getContractMultiplier(sizingFamily) * nextContractOpenPrice;
              const floorUnits = unitNotional > 0
                ? Math.ceil((params.targetLeverage * (1 - leverageTolerancePct / 100) * equityBeforeTrade) / unitNotional - 1e-9)
                : Number.POSITIVE_INFINITY;
              if (microUnits > toSell && afterCloseQty - microUnits >= floorUnits) toSell = microUnits;
            }
            let runningAfter = afterCloseQty;
            let intRemainPartial = accruedInterestSinceLastTx;
            for (const sym of contractSymbolsSortedForReduction(lots, date)) {
              if (toSell <= 0) break;
              const qLeg = lots.get(sym) ?? 0;
              if (qLeg <= 0) continue;
              const take = reductionTakeUnits(sym, qLeg, toSell);
              const legDelta = -take;
              const fillPrice = futuresFillAt(sym);
              const legFees = feeForUnits(sym, legDelta, date);
              const levBefore = futuresPortfolioLeverageDeltaPctFromLots({
                lots,
                contract,
                equity: cash,
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
              cash -= legFees + spread;
              totalFees += legFees;
              totalSpreadCosts += spread;
              runningAfter -= take;
              toSell -= take;
              lots.set(sym, qLeg - take);
              reconcileLots(lots);
              const levAfter = futuresPortfolioLeverageDeltaPctFromLots({
                lots,
                contract: runningAfter > 0 ? nextContract : null,
                equity: cash,
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
                equity: cash,
              });
              if (intAmt > 0) accruedInterestSinceLastTx = 0;
            }
            if (sumLots(lots) === 0) {
              contract = null;
            } else {
              contract = nextContract;
            }
          }
        }
      }
    }

    if (rollToday && !rolledEarlyForNetAdd) {
      executeQuarterlyRolls();
    }

    // Mark-to-market remaining open-to-close futures PnL after open trades.
    // Daily carry was already attributed to positions held from the prior close.
    const markFuturesClose = (sym: string) => futuresFillAt(sym, spot);
    ledgerFuturesMark = markFuturesClose;
    if (contract != null && sumLots(lots) > 0) {
      const mult = getContractMultiplier(contract);
      for (const [, q] of lots) {
        if (q <= 0) continue;
        const pnl = q * mult * (spot - idxOpen);
        cash += pnl;
        if (cashMember) cashMember.commoditiesCash += pnl;
      }
    }

    if (collateral) {
      cash += collateral.mark(i, date, false);
      collateralMarginRequirement = contract && sumLots(lots) > 0
        ? totalFuturesNotionalAtMark({ lots, contract, mark: markFuturesClose }) * maintMarginRate : 0;
      entryClose = !collateralRiskOnAtLastClose;
      if (wantsRiskOn) {
        maintenanceVgsh = entryClose || params.treasuryBuyPreference === "vgsh-only" ||
          ((params.treasuryBuyPreference ?? "ndx-vgsh") === "ndx-vgsh" && params.index === "nasdaq100") ||
          (params.treasuryBuyPreference === "vgsh-above-sma" && fullAboveSmaByDate.get(date) === true);
      }
      collateralRiskOnAtLastClose = wantsRiskOn;
    } else {
      // Legacy analytical cash-sweep mode for callers that do not request the
      // Treasury account model. This is not IBKR commodities cash eligibility.
      const cashYieldBase = Math.max(0, cash - freeCashAt(date));
      const spreadDaily = spreadAnnual / 360;
      const cashRateDaily = Math.max(0, rateDaily - spreadDaily);
      accrueCashInterest(cashYieldBase * cashRateDaily, 1);
    }

    // Total equity includes any risk-off holdings marked to today's close.
    let riskOffValueAtClose = 0;
    // Calendar days this row covers, so cash-like risk-off exposure accrues
    // across weekends/holidays the same way the futures cash sweep does.
    const riskOffCashAccrualDays =
      i > 0 ? Math.max(1, calendarDaysBetweenIso(dates[i - 1] as string, date)) : 1;
    if (riskOffShares || riskOffCash) {
      for (let j = 0; j < heldTickers.length; j++) {
        const t = heldTickers[j];
        const shares = riskOffShares?.[j] ?? 0;
        const closeArr = params.riskOffCloseByTicker?.[t];
        const px = riskOffCloseMarkPrice({ closeValues: closeArr, index: i, lastPrice: riskOffLastPrice?.[j] });
        if (shares > 0) {
          if (Number.isFinite(px) && (px as number) > 0) {
            riskOffValueAtClose += shares * (px as number);
            if (riskOffLastPrice) riskOffLastPrice[j] = px as number;
          } else {
            // Risk-off price missing (e.g. pre-launch). Convert to cash using last known price and compound.
            const last = riskOffLastPrice?.[j];
            const fallbackPrice = Number.isFinite(last ?? NaN) && (last as number) > 0 ? (last as number) : 0;
            const cashValue = fallbackPrice > 0 ? shares * fallbackPrice : 0;
            if (riskOffShares) riskOffShares[j] = 0;
            if (riskOffCash) riskOffCash[j] = (riskOffCash[j] ?? 0) + cashValue;
          }
        }
        const cashPiece = riskOffCash?.[j] ?? 0;
        if (Number.isFinite(cashPiece) && cashPiece > 0) {
          // Cash-like exposure earns the daily rate per *calendar* day, matching
          // the futures cash sweep above. Accruing once per trading row instead
          // would pay ~252 of the 360 days the `/360` daily rate is quoted on,
          // understating every risk-off cash stretch by ~30% of the rate.
          const fallbackReturn = rateDaily > 0 ? rateDaily * riskOffCashAccrualDays : 0;
          if (riskOffCash) riskOffCash[j] = cashPiece * (1 + fallbackReturn);
          riskOffValueAtClose += (riskOffCash ? riskOffCash[j] : cashPiece);
        }
      }
    }

    closeIndex = i;
    closeBasket = riskOffValueAtClose;
    if (cashMember) cashMember.margin = collateralMarginRequirement;
    if (!sharedCashAccount) cashAccount?.close();

    // Post-trade: compute equity and risk metrics for that close.
    const notional =
      contract != null && sumLots(lots) > 0
        ? totalFuturesNotionalAtMark({
            lots,
            contract,
            mark: markFuturesClose,
          })
        : 0;
    const maintenanceMarginUsed = notional * maintMarginRate;
    closeNotional = notional;
    const equity = cash + riskOffValueAtClose;
    const excessLiquidity = equity - maintenanceMarginUsed - (collateral?.value() ?? 0) * 0.25;
    const actualLeverage = equity > 0 ? notional / equity : 0;
    const leverageDeltaPct = computeLeverageDeltaPct(actualLeverage, targetLev);
    if (
      invested[i] &&
      contract != null &&
      sumLots(lots) > 0 &&
      equity > 0
    ) {
      maxAbsLeverageDeltaRiskOnPct = Math.max(
        maxAbsLeverageDeltaRiskOnPct,
        Math.abs(leverageDeltaPct)
      );
    }
    const endEquity = equity;
    const endNotional = notional;
    const endLeverageDeltaPct = leverageDeltaPct;
    const endExcessLiquidity = excessLiquidity;
    dailyExcessLiquidity[i] = endExcessLiquidity;

    // Fill EOD columns for all transactions on this date (if any). Do not overwrite `equity`:
    // each row carries post-trade book value for the ledger Value column; stamping it with
    // `endEquity` would make every intraday line on the same date identical.
    for (let t = transactions.length - 1; t >= 0; t--) {
      if (transactions[t].date !== date) break;
      transactions[t].excessLiquidity = endExcessLiquidity;
      if (transactions[t].instrument !== "futures") {
        transactions[t].leverageDeltaPct = endLeverageDeltaPct;
      }
    }

    // Do NOT treat cash==0 as bankruptcy: when in risk-off we may be fully invested
    // in risk-off holdings with zero free cash.
    if (endEquity <= 0) {
      cash = 0;
      if (cashMember) { cashMember.commoditiesCash = 0; cashMember.margin = 0; }
      collateral?.writeHoldings({ SGOV: 0, VGSH: 0 });
      closeBasket = 0;
      closeNotional = 0;
      collateralMarginRequirement = 0;
      pendingMonthlyCashInterest = 0;
      lots.clear();
      contract = null;
      riskOffShares = null;
      riskOffCash = null;
      riskOffLastPrice = null;
      dailyEquity[i] = 0;
      for (let j = i + 1; j < dates.length; j++) dailyEquity[j] = 0;
      ruined = true;
      return;
    }

    // If we are in risk-off, equity should reflect marked-to-close risk-off value too.
    // Sweep interest posts to cash monthly, but it is the account's money from the
    // day it accrues — carrying the unposted balance here keeps the equity curve
    // smooth instead of stepping up ~1% of equity on every month's first session
    // (at 1981 rates). Trading and margin still size off posted `cash` only.
    dailyEquity[i] = clampToFinite(endEquity + pendingMonthlyCashInterest, dailyEquity[i - 1]);
    closeMetricEquity = endEquity;
    closeCounted = true;

    if (invested[i] && sumLots(lots) > 0 && contract !== null && endEquity > 0) {
      const lev = endNotional / endEquity;
      if (Number.isFinite(lev)) {
        sumActualLeverageRiskOn += lev;
        riskOnLeverageDayCount += 1;
      }
    }

  };
  const finish = (): FuturesStrategyResult => {

  // Book-close row for the transaction ledger (same idea as backtest SMA tables).
  const lastIdx = dates.length - 1;
  if (lastIdx >= 0) {
    // Post the final month's sweep to cash for the ledger. No equity adjustment:
    // `dailyEquity` already carries the accrued balance day by day.
    creditPendingCashInterest();
  }
  if (collateral && lastIdx >= 0 && collateral.value() > 0) {
    const before = cash;
    const start = transactions.length;
    bookCollateralTrades(collateral.liquidate(dates[lastIdx]), dates[lastIdx]);
    for (let j = start; j < transactions.length; j++) transactions[j].isEndLiquidation = true;
    dailyEquity[lastIdx] += cash - before;
  }
  const windowFinalEquity = dailyEquity[lastIdx] ?? 0;
  if (transactions.length > 0 && lastIdx >= 0 && windowFinalEquity > 0) {
    const finalDate = dates[lastIdx]!;
    const endsRiskOn = Boolean(invested[lastIdx]);
    const hasOpenFutures = contract != null && sumLots(lots) > 0;

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

    if (endsRiskOn && hasOpenFutures && contract != null) {
      const markFinal = (sym: string) => futuresFillAtFinal(sym);
      const ordered = contractSymbolsSortedForReduction(lots, finalDate);
      let totalFeesTerm = 0;
      let totalSpreadTerm = 0;
      for (const sym of ordered) {
        const qLeg = lots.get(sym) ?? 0;
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
      dailyEquity[lastIdx] = equityNet;
      totalFees += totalFeesTerm;
      totalSpreadCosts += totalSpreadTerm;
      let runQty = sumLots(lots);
      const cFam = contract;
      let intRemainTerm = accruedInterestSinceLastTx;
      for (const sym of ordered) {
        const qLeg = lots.get(sym) ?? 0;
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
          lots,
          contract: cFam,
          equity: windowFinalEquity,
          targetLeverage: params.targetLeverage,
          mark: markFinal,
        });
        runQty -= qLeg;
        lots.set(sym, 0);
        reconcileLots(lots);
        const levAfter =
          runQty === 0
            ? levAfterTerm
            : futuresPortfolioLeverageDeltaPctFromLots({
                lots,
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
                cashInterestTradingDays: Math.max(1, interestSweepSessionCount),
                cashInterestAnnualRatePct: sweepNetAnnualPctFromRateDaily(finalRateDaily, spreadAnnual),
              }
            : {};
        if (intAmt > 0) interestSweepSessionCount = 0;
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
      accruedInterestSinceLastTx = 0;
    } else if (!endsRiskOn && (riskOffShares || riskOffCash)) {
      // For risk-off, keep a single terminal ledger row (no per-leg liquidation).
      let totalRiskOffExitFees = 0;
      let totalRiskOffExitSpread = 0;
      const soldValueByTicker: Record<string, number> = {};
      for (let j = 0; j < heldTickers.length; j++) {
        const t = heldTickers[j];
        const shares = riskOffShares?.[j] ?? 0;
        if (!(Number.isFinite(shares) && shares > 0)) continue;
        const closeArr = params.riskOffCloseByTicker?.[t];
        const px = riskOffCloseMarkPrice({
          closeValues: closeArr,
          index: lastIdx,
          lastPrice: riskOffLastPrice?.[j],
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
      dailyEquity[lastIdx] = riskOffEquityNet;
      totalFees += totalRiskOffExitFees;
      totalSpreadCosts += totalRiskOffExitSpread;
      // The basket is closed out, so the row is stamped with nothing left in it.
      riskOffShares = null;
      riskOffCash = null;
      riskOffLastPrice = null;
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
  const finalEquity = dailyEquity[dailyEquity.length - 1] ?? 0;
  const totalTradingCostPct = finalEquity > 0 ? ((totalFees + totalSpreadCosts) / finalEquity) * 100 : 0;

  const leverageLabel = formatLeverageLabel(params.targetLeverage);
  const name = futuresStrategyName(params, leverageLabel);
  const id = `${params.targetLeverage}x-${params.index}-futures-sma`;
  const etfResult = buildEtfResult({
    id,
    name,
    sourceIndex: params.index,
    dates,
    dailyValues: dailyEquity,
    smaSignals: sma.signals,
    smaPrices: sma.smaValues,
    totalTradingCostPct,
  });

  let riskOffSessionDayCount = 0;
  for (let i = 0; i < invested.length; i++) {
    if (!invested[i]) riskOffSessionDayCount += 1;
  }
  const avgActualLeverageRiskOn =
    riskOnLeverageDayCount > 0 ? sumActualLeverageRiskOn / riskOnLeverageDayCount : NaN;

  return {
    etfResult,
    targetLeverage: params.targetLeverage,
    index: params.index,
    transactions,
    initialEquity: clampToFinite(params.initialEquity, 0),
    avgActualLeverageRiskOn,
    maxAbsLeverageDeltaRiskOnPct,
    riskOffSessionDayCount,
    sessionDayCount: invested.length,
  };
  };

  return {
    dates,
    invested,
    equityAt: (i: number) => dailyEquity[i] ?? 0,
    excessLiquidityAt: (i: number) => dailyExcessLiquidity[i] ?? 0,
    stepDay,
    readHoldings: () => ({
      cash,
      riskOffShares: riskOffShares ? [...riskOffShares] : null,
      riskOffCash: riskOffCash ? [...riskOffCash] : null,
      pendingCashInterest: pendingMonthlyCashInterest,
      ...(collateral ? { treasuryHoldings: collateral.readHoldings() } : {}),
      ...(cashMember ? { commoditiesCash: cashMember.commoditiesCash } : {}),
    }),
    writeHoldings: (holdings: SleeveHoldings, i: number, equity: number) => {
      cash = holdings.cash;
      if (cashMember) cashMember.commoditiesCash = holdings.commoditiesCash ?? 0;
      if (collateral && holdings.treasuryHoldings) collateral.writeHoldings(holdings.treasuryHoldings);
      riskOffShares = holdings.riskOffShares ? [...holdings.riskOffShares] : null;
      riskOffCash = holdings.riskOffCash ? [...holdings.riskOffCash] : null;
      pendingMonthlyCashInterest = holdings.pendingCashInterest;
      closeBasket = equity - cash - pendingMonthlyCashInterest;
      closeMetricEquity = equity - pendingMonthlyCashInterest;
      // Price memory is per sleeve, not a holding. A sleeve handed basket shares it
      // never held needs the array to exist so marking can fall back to the close.
      if (riskOffShares && !riskOffLastPrice) riskOffLastPrice = riskOffShares.map(() => NaN);
      dailyEquity[i] = equity;
      // Capital only ever moves between sleeves while both are risk-off, so there is
      // no futures position and nothing is encumbered: excess liquidity is the whole
      // balance. Leaving the old figure here would leave the day's ledger rows
      // claiming more free cash than the restated equity behind them.
      dailyExcessLiquidity[i] = equity - (collateral?.value() ?? 0) * 0.25;
    },
    positions: currentPositions,
    transactionCount: () => transactions.length,
    finish,
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
  recorder?.record(sleeve.positions());
  for (let i = 1; i < sleeve.dates.length; i++) {
    sleeve.stepDay(i);
    recorder?.record(sleeve.positions());
  }
  const result = sleeve.finish();
  return recorder ? { ...result, dailyAssetValues: recorder.values() } : result;
}
