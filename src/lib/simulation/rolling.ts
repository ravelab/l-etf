import { annualizedInflationForRange } from "../inflation";
import { buildRateLookup } from "./borrowing-rate";
import { CONSTANT_HISTORY_WRAP_ENABLED, CONSTANT_STEP_MONTHS } from "../constants";
import { adjustedOpenFromPricePoint } from "../utils";
import type {
  EtfConfig,
  ParallelBacktestResult,
  PricePoint,
  RatePoint,
  SimulationSummary,
  SmaComparisonRow,
} from "./types";

export interface RollingSimulationPoint extends SimulationSummary {
  totalReturnPct: number;
  tradeCount: number;
  totalTradingCostPct: number;
}

export interface RollingWindow {
  startIdx: number;
  endIdx: number;
  startDate: string;
  endDate: string;
  lastRealEndDate: string;
  usesSyntheticTail: boolean;
  wrapSourceStartIdx?: number;
}

interface MaterializedRollingWindow {
  prices: PricePoint[];
  rates: RatePoint[];
  riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  warmUpOffset: number;
}


function sliceRiskOffValuesByAsset(
  riskOffValuesByAsset: Partial<Record<EtfConfig["riskOffAsset"], number[]>> | undefined,
  startIdx: number,
  endIdxInclusive: number
): Partial<Record<EtfConfig["riskOffAsset"], number[]>> | undefined {
  if (!riskOffValuesByAsset) return undefined;
  const out: Partial<Record<EtfConfig["riskOffAsset"], number[]>> = {};
  for (const asset of Object.keys(riskOffValuesByAsset) as EtfConfig["riskOffAsset"][]) {
    const src = riskOffValuesByAsset[asset];
    if (!src) continue;
    out[asset] = src.slice(startIdx, endIdxInclusive + 1);
  }
  return out;
}

function addDaysIso(isoDate: string, days: number): string {
  const date = toUtcDate(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

function dayDiffIso(startIso: string, endIso: string): number {
  const start = toUtcDate(startIso).getTime();
  const end = toUtcDate(endIso).getTime();
  return Math.max(1, Math.round((end - start) / 86400000));
}

function daySpanIso(startIso: string, endIso: string): number {
  const start = toUtcDate(startIso).getTime();
  const end = toUtcDate(endIso).getTime();
  return Math.max(0, Math.round((end - start) / 86400000));
}

function buildSyntheticRiskOffSegment(
  sourceValues: number[] | undefined,
  anchorValue: number,
  pointsNeeded: number,
  sourceStartIdx: number,
  sourceEndIdx: number,
): number[] {
  if (!sourceValues || pointsNeeded <= 0) return [];
  const sourceSegment = sourceValues.slice(sourceStartIdx, sourceEndIdx + 1);
  if (sourceSegment.length < 2 || !isFinite(anchorValue) || anchorValue <= 0) return [];

  const synthetic: number[] = [];
  let cycleAnchor = anchorValue;
  let sourceCursor = 1;
  const sourceBase = sourceSegment[0];
  if (!isFinite(sourceBase) || sourceBase <= 0) return [];

  while (synthetic.length < pointsNeeded) {
    const value = sourceSegment[sourceCursor];
    synthetic.push(cycleAnchor * (value / sourceBase));
    sourceCursor++;
    if (sourceCursor >= sourceSegment.length) {
      cycleAnchor = synthetic[synthetic.length - 1] ?? cycleAnchor;
      sourceCursor = 1;
    }
  }

  return synthetic;
}

export function materializeRollingWindow({
  prices,
  rates,
  window,
  warmUpDays = 0,
  riskOffValuesByAsset,
  riskOffOpenValuesByAsset,
}: {
  prices: PricePoint[];
  rates: RatePoint[];
  window: RollingWindow;
  warmUpDays?: number;
  riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
}): MaterializedRollingWindow {
  const extendedStartIdx = Math.max(0, window.startIdx - warmUpDays);
  const warmUpOffset = window.startIdx - extendedStartIdx;
  const materializedPrices = prices.slice(extendedStartIdx, window.endIdx + 1);
  const rateStartDate = prices[extendedStartIdx].date;
  const rateEndDate = prices[window.endIdx].date;
  const inRangeRates = rates.filter((r) => r.date >= rateStartDate && r.date <= rateEndDate);
  const carryInRate = [...rates].reverse().find((r) => r.date <= rateStartDate);
  const materializedRates =
    !carryInRate || inRangeRates[0]?.date === carryInRate.date
      ? inRangeRates
      : [carryInRate, ...inRangeRates];
  const materializedRiskOffValuesByAsset = sliceRiskOffValuesByAsset(
    riskOffValuesByAsset,
    extendedStartIdx,
    window.endIdx
  );
  const materializedRiskOffOpenValuesByAsset = sliceRiskOffValuesByAsset(
    riskOffOpenValuesByAsset,
    extendedStartIdx,
    window.endIdx
  );

  if (!window.usesSyntheticTail || window.wrapSourceStartIdx == null) {
    return {
      prices: materializedPrices,
      rates: materializedRates,
      riskOffValuesByAsset: materializedRiskOffValuesByAsset,
      riskOffOpenValuesByAsset: materializedRiskOffOpenValuesByAsset,
      warmUpOffset,
    };
  }

  const logicalEndDate = toUtcDate(window.endDate);
  const lastRealDate = materializedPrices[materializedPrices.length - 1]?.date;
  if (!lastRealDate || toUtcDate(lastRealDate) >= logicalEndDate) {
    return {
      prices: materializedPrices,
      rates: materializedRates,
      riskOffValuesByAsset: materializedRiskOffValuesByAsset,
      riskOffOpenValuesByAsset: materializedRiskOffOpenValuesByAsset,
      warmUpOffset,
    };
  }

  const sourceStartIdx = window.wrapSourceStartIdx;
  const sourceEndIdx = window.endIdx;
  const sourceSegment = prices.slice(sourceStartIdx, sourceEndIdx + 1);
  if (sourceSegment.length < 2) {
    return {
      prices: materializedPrices,
      rates: materializedRates,
      riskOffValuesByAsset: materializedRiskOffValuesByAsset,
      riskOffOpenValuesByAsset: materializedRiskOffOpenValuesByAsset,
      warmUpOffset,
    };
  }

  const rateLookup = buildRateLookup(rates);
  const sourceBasePrice = sourceSegment[0].adj_close;
  const sourceBaseClose = sourceSegment[0].close;
  const syntheticPrices: PricePoint[] = [];
  const syntheticRates: RatePoint[] = [];
  let prevSyntheticDate = lastRealDate;
  let cycleAnchorClose = materializedPrices[materializedPrices.length - 1].adj_close;
  let cycleAnchorRawClose = materializedPrices[materializedPrices.length - 1].close;
  let sourceCursor = 1;

  while (true) {
    const priorSource = sourceSegment[sourceCursor - 1];
    const nextSource = sourceSegment[sourceCursor];
    const gapDays = dayDiffIso(priorSource.date, nextSource.date);
    const nextDate = addDaysIso(prevSyntheticDate, gapDays);
    if (nextDate > window.endDate) break;

    const nextClose = cycleAnchorClose * (nextSource.adj_close / sourceBasePrice);
    const nextOpenSource = adjustedOpenFromPricePoint(nextSource);
    const nextOpen = cycleAnchorClose * (nextOpenSource / sourceBasePrice);
    const nextRawCloseSource = nextSource.close;
    const nextRawClose = cycleAnchorRawClose * (nextRawCloseSource / sourceBaseClose);
    syntheticPrices.push({
      date: nextDate,
      adj_open: nextOpen,
      adj_close: nextClose,
      close: nextRawClose,
    });
    syntheticRates.push({
      date: nextDate,
      rateType: "wrapped",
      rateValue: rateLookup.getRate(nextSource.date),
    });
    prevSyntheticDate = nextDate;
    sourceCursor++;
    if (sourceCursor >= sourceSegment.length) {
      cycleAnchorClose = nextClose;
      cycleAnchorRawClose = nextRawClose;
      sourceCursor = 1;
    }
  }

  if (syntheticPrices.length === 0) {
    return {
      prices: materializedPrices,
      rates: materializedRates,
      riskOffValuesByAsset: materializedRiskOffValuesByAsset,
      warmUpOffset,
    };
  }

  const syntheticRiskOffValuesByAsset = materializedRiskOffValuesByAsset
    ? Object.fromEntries(
        Object.entries(materializedRiskOffValuesByAsset).map(([asset, values]) => {
          const anchorValue = values?.[values.length - 1] ?? NaN;
          return [
            asset,
            [
              ...(values ?? []),
              ...buildSyntheticRiskOffSegment(
                riskOffValuesByAsset?.[asset as EtfConfig["riskOffAsset"]],
                anchorValue,
                syntheticPrices.length,
                sourceStartIdx,
                sourceEndIdx,
              ),
            ],
          ];
        })
      ) as Partial<Record<EtfConfig["riskOffAsset"], number[]>>
    : undefined;
  const syntheticRiskOffOpenValuesByAsset = materializedRiskOffOpenValuesByAsset
    ? Object.fromEntries(
        Object.entries(materializedRiskOffOpenValuesByAsset).map(([asset, values]) => {
          const anchorValue = values?.[values.length - 1] ?? NaN;
          return [
            asset,
            [
              ...(values ?? []),
              ...buildSyntheticRiskOffSegment(
                riskOffOpenValuesByAsset?.[asset as EtfConfig["riskOffAsset"]],
                anchorValue,
                syntheticPrices.length,
                sourceStartIdx,
                sourceEndIdx,
              ),
            ],
          ];
        })
      ) as Partial<Record<EtfConfig["riskOffAsset"], number[]>>
    : undefined;

  return {
    prices: [...materializedPrices, ...syntheticPrices],
    rates: [...materializedRates, ...syntheticRates],
    riskOffValuesByAsset: syntheticRiskOffValuesByAsset,
    riskOffOpenValuesByAsset: syntheticRiskOffOpenValuesByAsset,
    warmUpOffset,
  };
}


function subtractOneDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - 1));
}

/**
 * Build rolling windows. Returned startIdx/endIdx are indices into the full
 * `prices` array (not a filtered copy), so callers can look backward for
 * SMA warm-up data.
 */
export function buildRollingWindows({
  prices,
  windowLength,
  startDateConstraint,
  endDateConstraint,
  historyWrap = CONSTANT_HISTORY_WRAP_ENABLED,
}: {
  prices: PricePoint[];
  windowLength: number;
  startDateConstraint?: string;
  endDateConstraint?: string;
  historyWrap?: boolean;
}): RollingWindow[] {
  if (windowLength <= 0 || CONSTANT_STEP_MONTHS <= 0 || prices.length < 2) return [];

  // Find the valid range within the full prices array
  let rangeStart = 0;
  let rangeEnd = prices.length - 1;
  if (startDateConstraint) {
    while (rangeStart < prices.length && prices[rangeStart].date < startDateConstraint) rangeStart++;
  }
  if (endDateConstraint) {
    while (rangeEnd >= 0 && prices[rangeEnd].date > endDateConstraint) rangeEnd--;
  }

  if (rangeEnd - rangeStart < 1) {
    return [];
  }

  // Short-circuit: when the requested window covers the entire available range,
  // emit exactly one full-range window. This matches the backtest tool's
  // single-run behavior and avoids rejecting the only valid window via the
  // length-validation branch below (which would otherwise discard it because
  // the target end extends past the real end of data).
  const rangeStartMs = toUtcDate(prices[rangeStart].date).getTime();
  const rangeEndMs = toUtcDate(prices[rangeEnd].date).getTime();
  const rangeYears = (rangeEndMs - rangeStartMs) / (365.25 * 24 * 60 * 60 * 1000);
  if (windowLength >= rangeYears) {
    return [
      {
        startIdx: rangeStart,
        endIdx: rangeEnd,
        startDate: prices[rangeStart].date,
        endDate: prices[rangeEnd].date,
        lastRealEndDate: prices[rangeEnd].date,
        usesSyntheticTail: false,
        wrapSourceStartIdx: rangeStart,
      },
    ];
  }

  const windows: RollingWindow[] = [];

  // Generate windows starting on the 1st of each month (stepped by stepMonths).
  // The engine handles non-trading-day starts by snapping to the next trading day.
  // If the user's start falls mid-month, prepend one extra window anchored on that
  // exact date so the leading partial month isn't discarded. Subsequent windows
  // stay on the regular monthly cadence.
  const firstDate = toUtcDate(prices[rangeStart].date);
  const partialLeading = firstDate.getUTCDate() > 1;
  let monthCursor = new Date(Date.UTC(
    firstDate.getUTCFullYear(),
    firstDate.getUTCMonth() + (partialLeading ? 1 : 0),
    1,
  ));
  let cursor = partialLeading ? firstDate : monthCursor;
  let isPartialIteration = partialLeading;

  const advanceCursor = () => {
    if (isPartialIteration) {
      cursor = monthCursor;
      isPartialIteration = false;
    } else {
      monthCursor = new Date(Date.UTC(
        monthCursor.getUTCFullYear(),
        monthCursor.getUTCMonth() + CONSTANT_STEP_MONTHS,
        1,
      ));
      cursor = monthCursor;
    }
  };

  while (true) {
    const startIso = toIsoDate(cursor);

    // Stop if the start date is past the constrained end date
    if (startIso > prices[rangeEnd].date) break;

    const targetEndDate = addYears(cursor, windowLength);
    const targetEndIso = toIsoDate(targetEndDate);

    // Find the first trading day on/after the 1st of the month
    const startIdx = findFirstDateGte(prices, startIso, rangeStart, rangeEnd);
    if (startIdx === -1) break;

    const constrainedRealEndIso = prices[rangeEnd].date;
    const usesSyntheticTail = historyWrap && targetEndIso > constrainedRealEndIso;
    const syntheticEndIso = toIsoDate(subtractOneDay(targetEndDate));
    const endIdx = usesSyntheticTail
      ? rangeEnd
      : findLastDateLt(prices, targetEndIso, startIdx + 1, rangeEnd);

    if (endIdx === -1 || endIdx <= startIdx) {
      // No valid end date found for this window — try next month
      advanceCursor();
      continue;
    }

    // VALIDATION: Non-wrapped windows should still be essentially full-length.
    // Allow a partial final month, but reject materially truncated windows.
    const startDateObj = toUtcDate(prices[startIdx].date);
    const endDateObj = toUtcDate(usesSyntheticTail ? syntheticEndIso : prices[endIdx].date);
    const actualMonths = (endDateObj.getUTCFullYear() - startDateObj.getUTCFullYear()) * 12
                       + (endDateObj.getUTCMonth() - startDateObj.getUTCMonth());
    const targetMonths = windowLength * 12;
    const minMonths = targetMonths - 1; // Allow 1 month tolerance for trading day constraints

    const expectedEndIso = syntheticEndIso;
    const missingDays = usesSyntheticTail ? 0 : daySpanIso(prices[endIdx].date, expectedEndIso);
    const maxMissingDays = 31;

    if (!usesSyntheticTail && actualMonths < minMonths && missingDays > maxMissingDays) {
      // Window is materially too short - skip it instead of including a truncated tail.
      advanceCursor();
      continue;
    }

    const wrapSourceStartIdx = startDateConstraint
      ? findFirstDateGte(prices, startDateConstraint, rangeStart, endIdx)
      : rangeStart;

    windows.push({
      startIdx,
      endIdx,
      startDate: prices[startIdx].date,
      endDate: usesSyntheticTail ? syntheticEndIso : prices[endIdx].date,
      lastRealEndDate: prices[endIdx].date,
      usesSyntheticTail,
      wrapSourceStartIdx: wrapSourceStartIdx === -1 ? rangeStart : wrapSourceStartIdx,
    });

    // Advance cursor by stepMonths (or from partial-leading to month-aligned)
    advanceCursor();
  }

  return windows;
}

export function summarizeParallelResult(
  simulations: RollingSimulationPoint[]
): ParallelBacktestResult {
  if (simulations.length === 0) {
    return {
      totalSimulations: 0,
      avgEndValue: 0,
      medianEndValue: 0,
      bestEndValue: 0,
      worstEndValue: 0,
      avgMaxDrawdown: 0,
      biggestMaxDrawdown: 0,
      avgDrawdownDuration: 0,
      winRate: 0,
      simulations: [],
      leveragedValues: [],
      nonLeveragedValues: [],
    };
  }

  const leveragedValues = simulations.map((s) => s.finalValue);
  const nonLeveragedValues = simulations.map((s) => s.nonLeveragedFinalValue);
  const maxDrawdowns = simulations.map((s) => s.maxDrawdownPct);
  const wins = simulations.filter(
    (s) => s.finalValue > s.nonLeveragedFinalValue
  ).length;

  let bestIdx = 0;
  let worstIdx = 0;
  let biggestDdIdx = 0;
  for (let i = 1; i < leveragedValues.length; i++) {
    if (leveragedValues[i] > leveragedValues[bestIdx]) bestIdx = i;
    if (leveragedValues[i] < leveragedValues[worstIdx]) worstIdx = i;
    if (maxDrawdowns[i] > maxDrawdowns[biggestDdIdx]) biggestDdIdx = i;
  }

  return {
    totalSimulations: simulations.length,
    avgEndValue: average(leveragedValues),
    medianEndValue: median(leveragedValues),
    bestEndValue: Math.max(...leveragedValues),
    worstEndValue: Math.min(...leveragedValues),
    avgMaxDrawdown: average(maxDrawdowns),
    biggestMaxDrawdown: Math.max(...maxDrawdowns),
    avgDrawdownDuration: 0,
    winRate: (wins / simulations.length) * 100,
    simulations,
    leveragedValues,
    nonLeveragedValues,
    bestDates: { start: simulations[bestIdx].startDate, end: simulations[bestIdx].endDate },
    worstDates: { start: simulations[worstIdx].startDate, end: simulations[worstIdx].endDate },
    biggestMaxDrawdownDates: { start: simulations[biggestDdIdx].startDate, end: simulations[biggestDdIdx].endDate },
  };
}

export function summarizeSmaRow(
  parameterValue: number,
  simulations: RollingSimulationPoint[],
  monthlyCpi?: Array<{ date: string; value: number }>,
): SmaComparisonRow {
  if (simulations.length === 0) {
    return {
      parameterValue,
      avgFinalRealValue: 0,
      avgCagr: 0,
      avgReturn: 0,
      bestReturn: 0,
      worstReturn: 0,
      avgMaxDrawdown: 0,
      biggestMaxDrawdown: 0,
      avgTrades: 0,
      avgTradingCostPct: 0,
      historyWrapApplied: false,
    };
  }

  // Use individual CAGRs. When monthlyCpi is provided, compute per-window
  // real CAGRs so that avg/best/worst reflect window-specific inflation
  // rather than a single global average.
  const nominalCagrs = simulations.map((s) => s.cagr);
  const cagrs = monthlyCpi && monthlyCpi.length >= 2
    ? simulations.map((s) => {
        const windowInflation = annualizedInflationForRange(monthlyCpi, s.startDate, s.endDate);
        return s.cagr - windowInflation * 100;
      })
    : simulations.map((s) => s.cagr);
  const drawdowns = simulations.map((s) => s.maxDrawdownPct);
  const trades = simulations.map((s) => s.tradeCount);
  const tradingCosts = simulations.map((s) => s.totalTradingCostPct);
  const windowYearsPerSim = simulations.map((s) => {
    const startMs = new Date(`${s.startDate}T00:00:00Z`).getTime();
    const endMs = new Date(`${s.endDate}T00:00:00Z`).getTime();
    return Math.max(0, (endMs - startMs) / (365.25 * 24 * 60 * 60 * 1000));
  });
  const realFinalValues = monthlyCpi && monthlyCpi.length >= 2
    ? simulations.map((s) => {
        const windowInflation = annualizedInflationForRange(monthlyCpi, s.startDate, s.endDate);
        const years = (new Date(`${s.endDate}T00:00:00Z`).getTime() - new Date(`${s.startDate}T00:00:00Z`).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
        return s.finalValue / Math.pow(1 + windowInflation, Math.max(0, years));
      })
    : simulations.map((s) => s.finalValue);
  const wrappedSimulationCount = simulations.filter((s) => Boolean(s.usedHistoryWrap)).length;

  // Use epsilon for float comparison to ensure deterministic tie-breaking
  const EPS = 1e-9;

  let bestIdx = 0;
  let worstIdx = 0;
  let biggestDdIdx = 0;
  for (let i = 1; i < cagrs.length; i++) {
    if (
      cagrs[i] > cagrs[bestIdx] + EPS ||
      (Math.abs(cagrs[i] - cagrs[bestIdx]) <= EPS && compareSimulationWindow(simulations[i], simulations[bestIdx]) < 0)
    ) {
      bestIdx = i;
    }
    if (
      cagrs[i] < cagrs[worstIdx] - EPS ||
      (Math.abs(cagrs[i] - cagrs[worstIdx]) <= EPS && compareSimulationWindow(simulations[i], simulations[worstIdx]) < 0)
    ) {
      worstIdx = i;
    }
    if (
      drawdowns[i] > drawdowns[biggestDdIdx] + EPS ||
      (Math.abs(drawdowns[i] - drawdowns[biggestDdIdx]) <= EPS &&
        compareSimulationWindow(simulations[i], simulations[biggestDdIdx]) < 0)
    ) {
      biggestDdIdx = i;
    }
  }

  return {
    parameterValue,
    avgFinalRealValue: average(realFinalValues),
    avgCagr: average(nominalCagrs),
    avgReturn: average(cagrs),
    bestReturn: Math.max(...cagrs),
    worstReturn: Math.min(...cagrs),
    avgMaxDrawdown: average(drawdowns),
    biggestMaxDrawdown: Math.max(...drawdowns),
    avgTrades: average(trades),
    avgTradingCostPct: average(tradingCosts),
    avgWindowYears: average(windowYearsPerSim),
    historyWrapApplied: wrappedSimulationCount > 0,
    bestReturnDates: { start: simulations[bestIdx].startDate, end: simulations[bestIdx].endDate },
    worstReturnDates: { start: simulations[worstIdx].startDate, end: simulations[worstIdx].endDate },
    biggestMaxDrawdownDates: { start: simulations[biggestDdIdx].startDate, end: simulations[biggestDdIdx].endDate },
    earliestStartDate: simulations.reduce(
      (earliest, s) => (s.startDate < earliest ? s.startDate : earliest),
      simulations[0].startDate
    ),
  };
}

function compareSimulationWindow(
  left: Pick<RollingSimulationPoint, "startDate" | "endDate">,
  right: Pick<RollingSimulationPoint, "startDate" | "endDate">
): number {
  const byStart = left.startDate.localeCompare(right.startDate);
  if (byStart !== 0) return byStart;
  return left.endDate.localeCompare(right.endDate);
}

function average(values: number[]): number {
  const finite = values.filter(isFinite);
  if (finite.length === 0) return 0;
  return finite.reduce((sum, v) => sum + v, 0) / finite.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function toUtcDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`);
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addYears(date: Date, years: number): Date {
  const d = new Date(date.getTime());
  const months = Math.round(years * 12);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/** Find the last index where prices[idx].date < targetDate (exclusive upper bound). */
function findLastDateLt(
  prices: PricePoint[],
  targetDate: string,
  startIdx: number,
  endIdx: number
): number {
  let lo = startIdx;
  let hi = endIdx;
  let found = -1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (prices[mid].date < targetDate) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return found;
}

/** Find the first index where prices[idx].date >= targetDate. */
function findFirstDateGte(
  prices: PricePoint[],
  targetDate: string,
  startIdx: number,
  endIdx: number
): number {
  let lo = startIdx;
  let hi = endIdx;
  let found = -1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (prices[mid].date >= targetDate) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return found;
}
