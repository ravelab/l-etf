// Price point consumed by simulations.
// adj_close = total-return adjusted close (for portfolio return simulation)
// close = raw index level (SPX/NDX, for SMA signal generation)
// open = raw open price (matches `close` scale; used by futures next-day-open fills)
// adj_open = TR-adjusted open (matches `adj_close` scale; used by ETF flows in TR space)
export interface PricePoint {
  date: string;
  /** Retained so comparisons can exclude provisional closing prices. */
  source?: string;
  adj_open?: number;
  open?: number;
  adj_close: number;
  close: number;
}

export interface RatePoint {
  date: string;
  rateType: string;
  rateValue: number;
}

export interface EtfConfig {
  id: string;
  name: string;
  leverage: number;
  expenseRatio: number;
  simulated: boolean;
  displayStartDate?: string;
  smaEnabled: boolean;
  smaPeriod: number;
  // Upper = above-SMA threshold (price > SMA * (1 + upper/100)) — re-entry signal.
  // Lower = below-SMA threshold (price < SMA * (1 - lower/100)) — exit signal.
  smaUpperBuffer: number;
  smaLowerBuffer: number;
  smaIndex: "sp500" | "nasdaq100";
  /**
   * The gate switch: also hold risk-off while the volatility gate (`vol-gate.ts`)
   * or the RSI crash brake (`rsi-brake.ts`) is tripped. Resolve it per index
   * through `smaRiskOffGates`.
   */
  smaVolGate?: boolean;
  /** Use the alternate volatility gate and RSI brake when enabled. */
  smaAlternateGates?: boolean;
  /** Run the SMA band on the CPI-deflated index (`generateSmaSignals`' `inflationAdjusted`). */
  smaInflationAdjusted?: boolean;
  /**
   * Id of a plug-in timing rule (`signal-rules.ts`) that replaces the SMA band.
   * The SMA fields and `smaVolGate` are then unused except `smaPeriod`, which
   * sizes the data warm-up.
   */
  signalRule?: string;
  smaExecutionMode?: "trigger-day-close" | "next-day-close" | "next-day-open";
  riskOffAsset: "SGOV" | "VGSH" | "GLDM" | "BRK.B" | "VOO" | "QQQ" | "BRK.B+GLDM" | "VGSH+GLDM" | "BRK.B+VGSH" | "BRK.B+GLDM+VGSH";
}

export type IndexKey = "sp500" | "nasdaq100";
export type RiskOffAsset = EtfConfig["riskOffAsset"];

export interface SmaSignal {
  date: string;
  type: "buy" | "sell";
  price: number;
  /**
   * What moved the position, set only on gated runs: "sma" when the SMA band was
   * crossed that close, "vol" when the volatility gate tripped or released, "rsi"
   * when the RSI crash brake did, "shock" when the volatility-shock gate did.
   */
  trigger?: "sma" | "vol" | "rsi" | "shock" | "rate";
}

export interface EtfResult {
  id: string;
  name: string;
  sourceIndex: "sp500" | "nasdaq100";
  /** Timing rule for a completed Extra Strategies sleeve. */
  signalRule?: string;
  dates: string[];
  dailyValues: number[];
  finalValue: number;
  cagr: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  maxDrawdownDollar: number;
  maxDrawdownDates?: { start: string; end: string };
  longestDrawdownDays: number;
  longestDrawdownDates?: { start: string; end: string };
  bestMonth: number;
  bestMonthDates?: { start: string; end: string };
  worstMonth: number;
  worstMonthDates?: { start: string; end: string };
  smaSignals: SmaSignal[];
  smaPrices: number[];
  /** SMA regime in effect on dates[0] (true = risk-on/invested). Undefined when SMA is disabled. */
  smaStartInvested?: boolean;
  totalTradingCostPct: number;
  /** Set on simulated LETF rows that show an after-tax estimate (`letf-tax.ts`). */
  taxSchedule?: LetfTaxSchedule;
}

/**
 * When an LETF strategy trades, independent of tax rates, so an estimate can be
 * re-priced as the rates change. One sleeve for a single LETF, two for the
 * UPRO/TQQQ fund. Values are the simulation's dollars; only ratios matter, so
 * scaling the result leaves the schedule valid.
 */
export interface LetfTaxSchedule {
  /** What the strategy opened with, before its entry spread: the sleeves' cost basis, split evenly. */
  initialInvestment: number;
  startDate: string;
  endDate: string;
  /** Each sleeve's opening value, net of its entry spread. */
  startValues: number[];
  /** Each sleeve's own simulated value on the first day (see {@link LetfTaxEvent.prices}). */
  startPrices: number[];
  /** Per sleeve, the share of its last value it keeps after its closing trade. */
  exitFractions: number[];
  /** In date order; the last one is the final session. */
  events: LetfTaxEvent[];
}

export interface LetfTaxEvent {
  date: string;
  /**
   * Each sleeve's own simulated value here: the price of whatever it holds, since a
   * sleeve holds one asset at a time and its own path runs straight through resets.
   * A trade executes at the open; the prior close stands in for its price.
   */
  prices: number[];
  /** Sleeves that sold their whole position here and bought the other side. */
  switched?: boolean[];
  /**
   * A two-sleeve fund resets to 50/50 here, between the switching sleeves' sales
   * and buys. `staying` is the sleeve that keeps its basket (-1 when both re-enter),
   * and `costFraction` the share of the fund its basket trade costs.
   */
  reset?: { staying: number; costFraction: number };
  /** The last session of a calendar year: that year's tax is known at this close. */
  yearEnd?: boolean;
  /** Estimated-tax due dates (`safe-harbor.ts`) this session's close is the first on or after. */
  taxDue?: string[];
}

export interface BacktestResult {
  dates: string[];
  nonLeveragedValues: number[];
  investedValues: number[];
  etfResults: EtfResult[];
  /**
   * Requested config id -> the id of the result that actually carries its
   * series. Configs that are computationally identical (most often the no-SMA
   * `<id>-base` twins of several SMA configs on one LETF) are simulated once and
   * emitted once, so `etfResults` holds no entry under the other requested ids.
   * Resolve lookups with `findEtfResult` rather than a bare
   * `etfResults.find(r => r.id === wanted)`, which would return undefined.
   */
  etfResultIdAliases?: Record<string, string>;
}

export interface SimulationSummary {
  startDate: string;
  endDate: string;
  finalValue: number;
  nonLeveragedFinalValue: number;
  maxDrawdownPct: number;
  nonLeveragedMaxDrawdownPct: number;
  cagr: number;
  usedHistoryWrap?: boolean;
}

export interface ParallelBacktestResult {
  totalSimulations: number;
  avgEndValue: number;
  medianEndValue: number;
  bestEndValue: number;
  worstEndValue: number;
  avgMaxDrawdown: number;
  biggestMaxDrawdown: number;
  avgDrawdownDuration: number;
  winRate: number;
  simulations: SimulationSummary[];
  leveragedValues: number[];
  nonLeveragedValues: number[];
  bestDates?: { start: string; end: string };
  worstDates?: { start: string; end: string };
  biggestMaxDrawdownDates?: { start: string; end: string };
}

export interface SmaComparisonRow {
  parameterValue: number;
  avgFinalRealValue: number;
  avgCagr?: number;
  avgReturn: number;
  bestReturn: number;
  worstReturn: number;
  avgMaxDrawdown: number;
  biggestMaxDrawdown: number;
  avgTrades: number;
  /** Average share of each window's trading days held risk-off, in percent. */
  avgRiskOffPct?: number;
  avgTradingCostPct: number;
  avgWindowYears?: number;
  historyWrapApplied?: boolean;
  bestReturnDates?: { start: string; end: string };
  worstReturnDates?: { start: string; end: string };
  biggestMaxDrawdownDates?: { start: string; end: string };
  earliestStartDate?: string;
  winRate?: number;
  /**
   * Set when the windows were taxed: `avgReturn` before tax. Every other field is
   * then after-tax.
   */
  avgPreTaxReturn?: number;
}
