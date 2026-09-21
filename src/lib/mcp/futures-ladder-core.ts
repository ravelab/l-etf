// `compare_futures_ladder` orchestration: run the whole futures ladder the
// /futures-tool page runs, including the two-sleeve fund.
//
// The ladder and its rungs come from `buildFuturesLadderPlan` rather than being
// restated here — that file exists because a duplicated ladder drifted from its
// LETF twins and rode 1973-74 down 91.5% where the twins stopped at 65.9%.
// Execution goes through `runParallelFuturesStrategies`, whose main-thread
// fallback is the server path, so this is the page's own code end to end.

import { CONSTANT_SP500_SHORTCUT_DATE } from "@/lib/constants";
import { alignRiskOffPriceSeries, getMarketDataWarmUpStartDate } from "@/lib/fetch-market-data";
import { buildFuturesLadderPlan, type SmaBand, type SmaBandsByIndex } from "@/lib/simulation/futures-plan";
import { runParallelFuturesStrategies } from "@/lib/simulation/futures-parallel";
import { buildFuturesRunPlans } from "@/lib/simulation/futures-run-plan";
import { getDefaultSmaLowerBuffer, getDefaultSmaPeriod, getDefaultSmaUpperBuffer, DEFAULT_FUTURES_AMOUNT, DEFAULT_RISK_OFF_ASSET } from "@/lib/simulation/defaults";
import { DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY } from "@/lib/simulation/futures";
import type { EtfConfig, IndexKey, PricePoint } from "@/lib/simulation/types";
import {
  loadBorrowRates,
  loadIndexPrices,
  loadInflation,
  loadRiskOffRawSeriesForAssets,
} from "@/lib/mcp/server-data";
import { McpToolError } from "@/lib/mcp/tool-result";
import { throwIfAborted } from "@/lib/abort";

type RiskOffAsset = EtfConfig["riskOffAsset"];

interface LadderRungResult {
  name: string;
  index: IndexKey;
  targetLeverage: number;
  /** True for the two-sleeve fund, which runs one index per sleeve. */
  dualSleeve: boolean;
  finalEquity: number;
  cagrPct: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  totalTradingCostPct: number;
  avgActualLeverageRiskOn: number;
  maxAbsLeverageDeltaRiskOnPct: number;
  numSignals: number;
  futuresTransactions: number;
}

interface FuturesLadderResult {
  startDate: string;
  endDate: string;
  initialEquity: number;
  riskOffAsset: string;
  emulationMode: boolean;
  bands: SmaBandsByIndex;
  rungs: LadderRungResult[];
  best: LadderRungResult;
}

function bandFor(index: IndexKey, override?: Partial<SmaBand>): SmaBand {
  return {
    period: override?.period ?? getDefaultSmaPeriod(index),
    upperBuffer: override?.upperBuffer ?? getDefaultSmaUpperBuffer(index),
    lowerBuffer: override?.lowerBuffer ?? getDefaultSmaLowerBuffer(index),
  };
}

export async function runFuturesLadder(params: {
  showEmulations: boolean;
  startDate?: string;
  endDate?: string;
  initialEquity?: number;
  riskOffAsset?: RiskOffAsset;
  bands?: { sp500?: Partial<SmaBand>; nasdaq100?: Partial<SmaBand> };
  onProgress?: (completed: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<FuturesLadderResult> {
  // Defaults to the page's own default rather than the S&P's 1885 start: the
  // ladder spans both index families, and a start predating Nasdaq data drops
  // every NDX rung (see `hasNasdaqData` below), which is not what a caller
  // asking for "the ladder" wants by default.
  const startDate = params.startDate ?? CONSTANT_SP500_SHORTCUT_DATE;
  const endDate = params.endDate ?? new Date().toISOString().slice(0, 10);
  if (startDate >= endDate) throw new McpToolError("`startDate` must be before `endDate`.");

  const initialEquity = params.initialEquity ?? DEFAULT_FUTURES_AMOUNT;
  const riskOffAsset = params.riskOffAsset ?? DEFAULT_RISK_OFF_ASSET;
  const bands: SmaBandsByIndex = {
    sp500: bandFor("sp500", params.bands?.sp500),
    nasdaq100: bandFor("nasdaq100", params.bands?.nasdaq100),
  };

  const warmUpDays = Math.max(bands.sp500.period, bands.nasdaq100.period);
  const warmUpStart = getMarketDataWarmUpStartDate(startDate, warmUpDays);

  const [spPrices, nqPrices, rates, monthlyCpi, rawRiskOff] = await Promise.all([
    loadIndexPrices("sp500", warmUpStart, endDate),
    loadIndexPrices("nasdaq100", warmUpStart, endDate),
    loadBorrowRates(warmUpStart, endDate),
    loadInflation(warmUpStart, endDate),
    loadRiskOffRawSeriesForAssets([riskOffAsset], warmUpStart, endDate),
  ]);
  throwIfAborted(params.signal);
  if (spPrices.length < 2) {
    throw new McpToolError(`Not enough S&P 500 data in ${startDate}..${endDate}.`);
  }

  // Risk-off series are aligned per index, since each sleeve indexes them
  // against its own trading calendar.
  const spRiskOff = alignRiskOffPriceSeries(spPrices, rawRiskOff);
  const nqRiskOff = alignRiskOffPriceSeries(nqPrices, rawRiskOff);

  // A Nasdaq rung needs data covering the WHOLE range, not merely somewhere in
  // it. The two-sleeve fund walks the union of its sleeves' trading days and
  // steps a sleeve only on days it has, so an NDX sleeve starting in 1971
  // inside an 1885 run would sit frozen at half the fund's equity for 86 years
  // while the SPX sleeve compounded — a "4.5x SPX 3x NDX" result that was half
  // dead capital and numerically indistinguishable from the plain SPX rung.
  // Dropping the rung is the honest answer; the plain SPX rungs still run.
  const hasNasdaqData =
    nqPrices.length > bands.nasdaq100.period && (nqPrices[0]?.date ?? "9999") <= startDate;
  const yearSpan =
    (Date.parse(endDate) - Date.parse(startDate)) / (1000 * 60 * 60 * 24 * 365.25);

  const steps = buildFuturesLadderPlan({
    showEmulations: params.showEmulations,
    hasNasdaqData,
    yearSpan,
    bands,
  });
  if (steps.length === 0) throw new McpToolError("The futures ladder is empty for this range.");

  /** Everything a sleeve needs that does not depend on which rung asked for it. */
  const sleeveParams = (
    index: IndexKey,
    leverage: number,
    maxLeverage: number | undefined,
    sma: SmaBand,
  ) => ({
    index,
    prices: (index === "sp500" ? spPrices : nqPrices) as PricePoint[],
    rates,
    startDate,
    endDate,
    targetLeverage: leverage,
    maxLeverage,
    smaPeriod: sma.period,
    smaUpperBuffer: sma.upperBuffer,
    smaLowerBuffer: sma.lowerBuffer,
    riskOffAsset,
    riskOffCloseByTicker: (index === "sp500" ? spRiskOff.closeValuesByAsset : nqRiskOff.closeValuesByAsset) as Record<string, number[]>,
    riskOffOpenByTicker: (index === "sp500" ? spRiskOff.openValuesByAsset : nqRiskOff.openValuesByAsset) as Record<string, number[]>,
    rollCalendarDaysBeforeExpiry: DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY,
    monthlyCpi,
  });

  const plans = buildFuturesRunPlans({ steps, initialEquity, sleeveParams });

  const runs = await runParallelFuturesStrategies({
    plans,
    onProgress: params.onProgress,
    signal: params.signal,
  });

  const rungs: LadderRungResult[] = runs.map((run, i) => {
    const etf = run.etfResult;
    return {
      name: etf.name,
      index: run.index,
      targetLeverage: run.targetLeverage,
      dualSleeve: plans[i].kind === "dual",
      finalEquity: etf.finalValue,
      cagrPct: etf.cagr,
      sharpeRatio: etf.sharpeRatio,
      maxDrawdownPct: etf.maxDrawdownPct,
      totalTradingCostPct: etf.totalTradingCostPct,
      avgActualLeverageRiskOn: run.avgActualLeverageRiskOn,
      maxAbsLeverageDeltaRiskOnPct: run.maxAbsLeverageDeltaRiskOnPct,
      numSignals: etf.smaSignals.length,
      futuresTransactions: run.transactions.length,
    };
  });

  if (rungs.length === 0) throw new McpToolError("No futures rung produced a result.");

  return {
    startDate,
    endDate,
    initialEquity,
    riskOffAsset,
    emulationMode: params.showEmulations,
    bands,
    rungs,
    best: rungs.reduce((a, b) => (b.cagrPct > a.cagrPct ? b : a)),
  };
}
