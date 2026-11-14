// Public shapes of the futures engine: its inputs, ledger rows, results and the
// steppable sleeve a two-sleeve fund drives. Re-exported from `futures.ts`.

import type { EtfResult, IndexKey, PricePoint, RatePoint, RiskOffAsset } from "@/lib/simulation/types";
import type { DailyAssetValues } from "./futures-asset-values";
import type { TreasuryHoldings } from "./futures-collateral";

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
