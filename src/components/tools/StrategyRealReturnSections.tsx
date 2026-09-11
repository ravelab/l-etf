"use client";

import { RealYearlyGrowthTable } from "@/components/tools/RealYearlyGrowthTable";
import { ForwardReturnVsSmaGapChart } from "@/components/tools/compare/ForwardReturnVsSmaGapChart";
import type { StrategyYearlyGrowthSeries } from "@/lib/strategy-page-data";
import type { StrategyReferenceData } from "@/lib/hooks/use-strategy-reference-data";
import type { EtfConfig } from "@/lib/simulation/types";

interface StrategyRealReturnSectionsProps {
  /** Year-by-year real growth of the series on the page, or null before a run. */
  growthSeries: StrategyYearlyGrowthSeries | null;
  /** Annualized CPI over the growth table's range, shown beside its title. */
  growthInflationPct: number;
  /** Index history behind the forward-return chart; null until it has loaded. */
  referenceData: StrategyReferenceData | null;
  /** SMA strategy to plot on each index family's side of the forward chart. */
  spxConfig: EtfConfig | null;
  ndxConfig: EtfConfig | null;
}

/** Column list for the growth table's description, read off its own series. */
function describeGrowthColumns(series: StrategyYearlyGrowthSeries | null): string {
  const labels = series?.series.map((entry) => entry.label) ?? [];
  const listed = labels.length > 1 ? `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}` : labels[0] ?? "";
  return `Year-over-year nominal return minus that year's CPI inflation across ${listed}.`;
}

/**
 * The two sections describing long-run real returns for the ETFs configured on the
 * page: the year-by-year real growth table and the 1-year forward real return by
 * SMA gap.
 *
 * Neither depends on a rolling window, which is why they sit on the backtest page
 * rather than the window-oriented Strategies page. Both follow the page's own ETF
 * configs. The forward chart plots one SMA strategy per index family, since its
 * raincloud has exactly two sides; with several LETFs on one index the caller
 * picks which one represents it.
 */
export function StrategyRealReturnSections({
  growthSeries,
  growthInflationPct,
  referenceData,
  spxConfig,
  ndxConfig,
}: StrategyRealReturnSectionsProps) {
  const showForwardChart = referenceData !== null && (spxConfig !== null || ndxConfig !== null);

  return (
    <>
      {growthSeries && (
        <RealYearlyGrowthTable
          yearlyGrowthSeries={growthSeries}
          description={describeGrowthColumns(growthSeries)}
          title="Real Yearly Growth Rate"
          inflationPct={growthInflationPct}
        />
      )}

      {showForwardChart && (
        <ForwardReturnVsSmaGapChart
          spxPrices={referenceData.spxPrices}
          ndxPrices={referenceData.ndxPrices}
          rates={referenceData.rates}
          monthlyCpi={referenceData.monthlyCpi}
          spxConfig={spxConfig}
          ndxConfig={ndxConfig}
          spxRiskOffValues={referenceData.spxRiskOffValues}
          spxRiskOffOpenValues={referenceData.spxRiskOffOpenValues}
          ndxRiskOffValues={referenceData.ndxRiskOffValues}
          ndxRiskOffOpenValues={referenceData.ndxRiskOffOpenValues}
          startDateSp={referenceData.effectiveStartSp}
          startDateNq={referenceData.effectiveStartNq}
          endDate={referenceData.endDate}
        />
      )}
    </>
  );
}
