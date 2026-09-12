import { buildYearlyCpiInflation, sampleYearlyRealGrowth } from "@/lib/inflation";
import type { BacktestResult, EtfResult } from "@/lib/simulation/types";
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

/** SMA variants read first within a family, then the plain twin, then anything else. */
function variantRank(id: string): number {
  if (id.endsWith("-sma")) return 0;
  if (id.endsWith("-smaClose")) return 1;
  if (id.endsWith("-base")) return 2;
  return 3;
}

/**
 * The growth table's rows for a finished backtest, grouped by index family with
 * that family's underlying index closing the group.
 *
 * Read straight off the result rather than off the page's current configs. The two
 * disagree the moment someone changes the form without re-running, and selecting
 * rows by config while taking data from the result silently dropped whole columns:
 * switching the preset to an SPX-only LETF made the NDX columns vanish from a
 * result that still contained them.
 */
export function collectBacktestGrowthSeries(params: {
  result: Pick<BacktestResult, "etfResults">;
  underlyingIndexSeries: Array<{ index: string; label: string; dates: string[]; values: number[] }>;
}): YearlyGrowthInput[] {
  const indexByFamily = new Map(params.underlyingIndexSeries.map((series) => [series.index, series]));
  const familyOrder: string[] = [];
  const rowsByFamily = new Map<string, EtfResult[]>();

  for (const etf of params.result.etfResults) {
    const family = etf.sourceIndex;
    if (!rowsByFamily.has(family)) {
      familyOrder.push(family);
      rowsByFamily.set(family, []);
    }
    rowsByFamily.get(family)!.push(etf);
  }

  return familyOrder.flatMap((family) => {
    const ordered = [...(rowsByFamily.get(family) ?? [])].sort(
      (a, b) => variantRank(a.id) - variantRank(b.id)
    );
    const index = indexByFamily.get(family);
    return [
      // Same shortening the results table uses, so both read "SSO SMA" rather
      // than the engine's "SSO (SMA, BRK.B + GLDM + VGSH)".
      ...ordered.map((etf) => ({
        label: shortBacktestAssetLabel(etf.name),
        dates: etf.dates,
        values: etf.dailyValues,
      })),
      ...(index ? [{ label: index.label, dates: index.dates, values: index.values }] : []),
    ];
  });
}
