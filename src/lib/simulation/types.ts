// Price point consumed by simulations.
// adj_close = total-return adjusted close (for portfolio return simulation)
// close = raw index level (SPX/NDX, for SMA signal generation)
// open = raw open price (matches `close` scale; used by futures next-day-open fills)
// adj_open = TR-adjusted open (matches `adj_close` scale; used by ETF flows in TR space)
export interface PricePoint {
  date: string;
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
  smaExecutionMode?: "trigger-day-close" | "next-day-close" | "next-day-open";
  riskOffAsset: "SGOV" | "VGSH" | "GLDM" | "BRK.B" | "VOO" | "QQQ" | "BRK.B+GLDM" | "VGSH+GLDM" | "BRK.B+VGSH" | "BRK.B+GLDM+VGSH";
}

export type IndexKey = "sp500" | "nasdaq100";
export type RiskOffAsset = EtfConfig["riskOffAsset"];

export interface SmaSignal {
  date: string;
  type: "buy" | "sell";
  price: number;
}

export interface EtfResult {
  id: string;
  name: string;
  sourceIndex: "sp500" | "nasdaq100";
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
  totalTradingCostPct: number;
}

export interface BacktestResult {
  dates: string[];
  nonLeveragedValues: number[];
  investedValues: number[];
  etfResults: EtfResult[];
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
  avgTradingCostPct: number;
  avgWindowYears?: number;
  historyWrapApplied?: boolean;
  bestReturnDates?: { start: string; end: string };
  worstReturnDates?: { start: string; end: string };
  biggestMaxDrawdownDates?: { start: string; end: string };
  earliestStartDate?: string;
  winRate?: number;
}
