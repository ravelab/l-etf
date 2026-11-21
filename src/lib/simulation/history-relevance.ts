import { CONSTANT_SP500_PROXY_START_DATE } from "@/lib/constants";
import { annualizedInflationForRange, realCagrPct } from "@/lib/inflation";
import { PER_INDEX_START_DATES } from "@/lib/per-index-start";
import { calcCagr } from "./metrics";
import type { EtfResult, IndexKey } from "./types";

const ANNUAL_CUTOFFS = ["03-19", "06-19", "09-19", "11-19"];
const MIN_PAIRS = 3;
type Era = "Real index" | "Proxy" | "SPX pre-1926";
export const HISTORY_RELEVANCE_WEIGHTS = {
  realCagr: 0.70,
  volatility: 0.30,
} as const;
const METRICS = ["realCagr", "volatility"] as const;
export type HistoryRelevanceIndex = IndexKey | "combo";
type MonthlyCpi = { date: string; value: number }[];
type Metric = typeof METRICS[number];
type AnnualWindow = Record<Metric, number> & { year: number; era: Era };

export type HistoryRelevancePoint = Record<Metric, number | null> & {
  lag: number;
  composite: number | null;
  minPairs: number;
  maxPairs: number;
  olderSources: Era[];
};

export interface HistoryRelevanceSeries {
  startDate: string;
  throughDate: string;
  points: HistoryRelevancePoint[];
}

function sourceEra(date: string, index: HistoryRelevanceIndex): Era {
  if (date >= PER_INDEX_START_DATES[index === "combo" ? "sp500" : index]) return "Real index";
  return date >= CONSTANT_SP500_PROXY_START_DATE ? "Proxy" : "SPX pre-1926";
}

type StrategyPath = Pick<EtfResult, "dates" | "dailyValues">;

function buildAnnualWindows(
  path: StrategyPath,
  cpi: MonthlyCpi,
  index: HistoryRelevanceIndex,
  throughDate: string,
  cutoff: string,
): Map<number, AnnualWindow> {
  const { dates, dailyValues } = path;
  const windows = new Map<number, AnnualWindow>();
  let first = 0;
  let last = 0;
  const startYear = Number(dates[0].slice(0, 4));
  for (let year = startYear; `${year}-${cutoff}` <= throughDate; year++) {
    const end = `${year}-${cutoff}`;
    while (last + 1 < dates.length && dates[last + 1] <= end) last++;
    const start = first;
    first = last;
    if (dates[start] > `${year - 1}-${cutoff}` || last - start < 180) continue;
    const era = sourceEra(dates[start], index);
    if (era !== sourceEra(dates[last], index)) continue;
    // The two sleeves can cross their proxy-to-real boundaries on different dates.
    if (index === "combo" && sourceEra(dates[start], "nasdaq100") !== sourceEra(dates[last], "nasdaq100")) continue;
    const values = dailyValues.slice(start, last + 1);
    if (values.some(value => !Number.isFinite(value) || value <= 0)) continue;
    const cagr = calcCagr(values[0], values[values.length - 1], dates[start], dates[last]);

    let sum = 0;
    let sumSquares = 0;
    for (let day = 1; day < values.length; day++) {
      const dailyReturn = values[day] / values[day - 1] - 1;
      sum += dailyReturn;
      sumSquares += dailyReturn ** 2;
    }
    const days = values.length - 1;
    const variance = (sumSquares - sum ** 2 / days) / (days - 1);
    const inflation = annualizedInflationForRange(cpi, dates[start], dates[last]);
    const realCagr = realCagrPct(cagr, inflation * 100);
    windows.set(year, {
      year, era, realCagr,
      volatility: Math.sqrt(252 * Math.max(0, variance)),
    });
  }
  return windows;
}

function correlation(pairs: [AnnualWindow, AnnualWindow][], metric: Metric): number | null {
  if (pairs.length < MIN_PAIRS) return null;
  const meanOlder = pairs.reduce((sum, [older]) => sum + older[metric], 0) / pairs.length;
  const meanNewer = pairs.reduce((sum, [, newer]) => sum + newer[metric], 0) / pairs.length;
  let cross = 0;
  let olderSquares = 0;
  let newerSquares = 0;
  for (const [older, newer] of pairs) {
    const x = older[metric] - meanOlder;
    const y = newer[metric] - meanNewer;
    cross += x * y;
    olderSquares += x * x;
    newerSquares += y * y;
  }
  const denominator = Math.sqrt(olderSquares * newerSquares);
  return denominator > 0 ? Math.max(-1, Math.min(1, cross / denominator)) : null;
}

function median(values: (number | null)[]): number | null {
  const sorted = values.filter(value => value !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}

export function buildHistoryRelevance(
  path: StrategyPath,
  cpi: MonthlyCpi,
  index: HistoryRelevanceIndex,
): HistoryRelevanceSeries | null {
  const { dates, dailyValues } = path;
  const startDate = dates[0];
  const endDate = dates.at(-1);
  if (!startDate || !endDate || dates.length !== dailyValues.length || cpi.length < 2) return null;
  const latestCpiMonth = cpi[cpi.length - 1].date.slice(0, 7);
  const throughDate = dates.findLast(date => date.slice(0, 7) <= latestCpiMonth);
  if (!throughDate) return null;
  const years = Number(endDate.slice(0, 4)) - Number(startDate.slice(0, 4))
    - Number(endDate.slice(5) < startDate.slice(5));
  const alignments = ANNUAL_CUTOFFS.map(cutoff => buildAnnualWindows(path, cpi, index, throughDate, cutoff));

  const points = Array.from({ length: years + 1 }, (_, lag): HistoryRelevancePoint => {
    const olderSources = new Set<Era>();
    const pairsByCutoff = alignments.map(windows => {
      const pairs: [AnnualWindow, AnnualWindow][] = [];
      for (const newer of windows.values()) {
        const older = windows.get(newer.year - lag);
        if (!older) continue;
        pairs.push([older, newer]);
        olderSources.add(older.era);
      }
      return pairs;
    });
    const counts = pairsByCutoff.map(pairs => pairs.length);
    const [realCagr, volatility] = METRICS.map(metric =>
      median(pairsByCutoff.map(pairs => correlation(pairs, metric)))
    );
    const weights = HISTORY_RELEVANCE_WEIGHTS;
    const composite = realCagr === null || volatility === null
      ? null
      : weights.realCagr * realCagr + weights.volatility * volatility;
    return {
      lag, composite, realCagr, volatility,
      minPairs: Math.min(...counts), maxPairs: Math.max(...counts), olderSources: [...olderSources],
    };
  });
  return { startDate, throughDate, points };
}
