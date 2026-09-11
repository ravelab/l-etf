import { buildYearlyCpiInflation, sampleYearlyRealGrowth } from "@/lib/inflation";
import { findEtfResult } from "@/lib/simulation/result-lookup";
import type { BacktestResult, EtfConfig } from "@/lib/simulation/types";
import { shortBacktestAssetLabel, type StrategyYearlyGrowthSeries } from "@/lib/strategy-page-data";

interface YearlyGrowthInput {
  /** Column heading, already display-ready. */
  label: string;
  dates: string[];
  /** Daily values aligned 1:1 with `dates`. */
  values: number[];
}

/**
 * Year-by-year real growth for whatever series the caller is showing.
 *
 * The sibling in `strategy-page-data.ts` covers one fixed roster of reference
 * strategies; this one takes the caller's own configs, so the rows follow the
 * ETFs on the page. Series routinely start in different years — a 2x NDX LETF
 * has less history than a 3x SPX one, and a real-ticker overlay starts at its
 * launch — so rows are keyed by year label and padded with null where a series
 * has no data. Joining by position would shift every later year of the shorter
 * series onto the wrong row.
 */
export function buildBacktestYearlyGrowthSeries(params: {
  series: YearlyGrowthInput[];
  monthlyCpi: Array<{ date: string; value: number }>;
}): StrategyYearlyGrowthSeries | null {
  const cpiInflation = buildYearlyCpiInflation(params.monthlyCpi);
  const sampled = params.series.map((input) => ({
    label: input.label,
    ...sampleYearlyRealGrowth(input.dates, input.values, cpiInflation, params.monthlyCpi),
  }));

  const years = [...new Set(sampled.flatMap((entry) => entry.years))].sort();
  if (years.length === 0) return null;

  // Inflation is a property of the year, not of a series, so the first series
  // reaching a given year supplies it for every row.
  const inflationByYear = new Map<string, number>();
  for (const entry of sampled) {
    entry.years.forEach((year, idx) => {
      if (!inflationByYear.has(year)) inflationByYear.set(year, entry.inflation[idx]);
    });
  }

  return {
    years,
    series: sampled.map((entry) => {
      const valueByYear = new Map(entry.years.map((year, idx) => [year, entry.values[idx]]));
      return {
        label: entry.label,
        values: years.map((year) => valueByYear.get(year) ?? null),
      };
    }),
    inflation: years.map((year) => inflationByYear.get(year) ?? null),
  };
}

/**
 * The growth table's rows for a finished backtest, in the order they read best:
 * each configured ETF's SMA variant then its plain twin, grouped by index family,
 * with that family's underlying index closing the group.
 *
 * Results are resolved with `findEtfResult` rather than by position, because the
 * engine emits one result for configs that compute identically and maps the other
 * requested ids onto it.
 */
export function collectBacktestGrowthSeries(params: {
  configs: EtfConfig[];
  result: Pick<BacktestResult, "etfResults" | "etfResultIdAliases">;
  underlyingIndexSeries: Array<{ index: string; label: string; dates: string[]; values: number[] }>;
}): YearlyGrowthInput[] {
  const indexByFamily = new Map(params.underlyingIndexSeries.map((series) => [series.index, series]));
  const familyOrder: string[] = [];
  const rowsByFamily = new Map<string, YearlyGrowthInput[]>();
  const takenResultIds = new Set<string>();

  for (const config of params.configs) {
    const family = config.smaIndex;
    if (!rowsByFamily.has(family)) {
      familyOrder.push(family);
      rowsByFamily.set(family, []);
    }
    const rows = rowsByFamily.get(family)!;
    // `<id>` covers the SMA-off case, where configs are never split into variants.
    for (const id of [`${config.id}-sma`, `${config.id}-base`, config.id]) {
      const etf = findEtfResult(params.result, id);
      if (!etf || takenResultIds.has(etf.id)) continue;
      takenResultIds.add(etf.id);
      // Same shortening the results table uses, so both read "SSO SMA" rather
      // than the engine's "SSO (SMA, BRK.B + GLDM + VGSH)".
      rows.push({ label: shortBacktestAssetLabel(etf.name), dates: etf.dates, values: etf.dailyValues });
    }
  }

  return familyOrder.flatMap((family) => {
    const index = indexByFamily.get(family);
    return [...(rowsByFamily.get(family) ?? []), ...(index ? [{ label: index.label, dates: index.dates, values: index.values }] : [])];
  });
}
