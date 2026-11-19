"use client";

import { useCallback, useMemo, useState } from "react";
import { LetfHoldingsChart, type HoldingsChartFocus } from "@/components/tools/backtest/LetfHoldingsChart";
import { buildSmaTradeTableRows, SmaTradesTable, type SmaTradeTableRow } from "@/components/tools/backtest/SmaTradesTable";
import { alignLetfComboSleeves, findLetfComboSleeves, LETF_FUND_RESULT_ID, type LetfComboRun } from "@/lib/simulation/letf-dual-sleeve";
import { letfComboFundHoldings } from "@/lib/simulation/letf-fund-holdings";
import { buildSmaTradeRows } from "@/lib/sma-trade-rows";
import { riskOffSharePct } from "@/lib/sma-trade-metrics";
import { shortBacktestAssetLabel } from "@/lib/strategy-page-data";
import type { BacktestResult, EtfConfig, PricePoint } from "@/lib/simulation/types";

type SeriesById = Record<string, number[]>;

export interface LetfFundDetailsProps {
  result: BacktestResult;
  run: LetfComboRun | null;
  etfConfigs: EtfConfig[];
  datesByEtfId: Record<string, string[]>;
  closePricesByEtfId: SeriesById;
  openPricesByEtfId: SeriesById;
  tradeClosePricesByEtfId: SeriesById;
  tradeOpenPricesByEtfId: SeriesById;
  syntheticPriceScaleByEtfId: Record<string, number>;
  annualizedInflation: number;
  riskOffPricesByTicker: Record<string, PricePoint[]>;
}

/** Arrays aligned to `fullDates`, cut to start at `startDate` (the fund's start). */
function sliceFrom<T>(values: T[] | undefined, fullDates: string[], startDate: string): T[] {
  if (!values) return [];
  const offset = Math.max(0, fullDates.indexOf(startDate));
  return values.slice(offset);
}

const executionDay = (entry: SmaTradeTableRow) => entry.row.tradingDay ?? entry.row.signalDate;

/**
 * The TQQQ/UPRO fund's details: what it holds at each close, then both sleeves'
 * trades in one table. Each sleeve's rows keep the metrics of their own sleeve; a
 * buy that re-opened the fund at 50/50 says so on its own row.
 */
export function LetfFundDetails(props: LetfFundDetailsProps) {
  const { result, run, etfConfigs, riskOffPricesByTicker, annualizedInflation } = props;

  const holdings = useMemo(
    () => letfComboFundHoldings(result, run, riskOffPricesByTicker),
    [result, run, riskOffPricesByTicker]
  );

  const sleeveTables = useMemo(() => {
    const found = findLetfComboSleeves(result, run);
    if (!found || !run) return [];
    const { sleeves, letfNames } = alignLetfComboSleeves({ ...found, ...run });
    return sleeves.map(({ result: sleeve }, s) => {
      const id = `etf${s + 1}-sma`;
      const config = etfConfigs.find((cfg) => cfg.id === `etf${s + 1}`);
      const fullDates = props.datesByEtfId[id] ?? found[s === 0 ? "spxSleeve" : "ndxSleeve"].dates;
      const start = sleeve.dates[0];
      const dates = sliceFrom(fullDates, fullDates, start);
      const closePrices = sliceFrom(props.closePricesByEtfId[id], fullDates, start);
      const tradeClosePrices = sliceFrom(props.tradeClosePricesByEtfId[id], fullDates, start);
      if (!config || closePrices.length === 0) return { name: letfNames[s], rows: [], riskOffPct: null };
      const tradeRows = buildSmaTradeRows({
        etf: sleeve,
        config,
        etfDates: dates,
        closePrices,
        openPrices: sliceFrom(props.openPricesByEtfId[id], fullDates, start),
        tradeClosePrices,
        tradeOpenPrices: sliceFrom(props.tradeOpenPricesByEtfId[id], fullDates, start),
        syntheticPriceScale: props.syntheticPriceScaleByEtfId[id] ?? 1,
        annualizedInflation,
      });
      const rows = buildSmaTradeTableRows({
        tradeRows,
        riskOffAsset: config.riskOffAsset,
        dates,
        riskOffPricesByTicker,
        annualizedInflation,
        finalEtfPrice: tradeClosePrices[tradeClosePrices.length - 1] ?? closePrices[closePrices.length - 1],
        sleeve: letfNames[s],
      });
      return { name: letfNames[s], rows, riskOffPct: riskOffSharePct(sleeve, dates) };
    });
  }, [result, run, etfConfigs, props.datesByEtfId, props.closePricesByEtfId, props.openPricesByEtfId,
    props.tradeClosePricesByEtfId, props.tradeOpenPricesByEtfId, props.syntheticPriceScaleByEtfId,
    annualizedInflation, riskOffPricesByTicker]);

  const tableRows = useMemo(() => {
    // A reset fires on the morning a sleeve re-enters while the other is still out,
    // which is that sleeve's buy execution day.
    const resets = new Set(holdings?.resetDates ?? []);
    return sleeveTables
      .flatMap((table) => table.rows)
      .map((entry, order) => ({ entry, order }))
      .sort((a, b) => executionDay(a.entry).localeCompare(executionDay(b.entry)) || a.order - b.order)
      .map(({ entry }) => entry.row.signalType === "buy" && !entry.row.isInitialEntry && resets.has(executionDay(entry))
        ? { ...entry, row: { ...entry.row, action: `${entry.row.action} (50/50)` } }
        : entry);
  }, [holdings, sleeveTables]);

  const [focus, setFocus] = useState<HoldingsChartFocus | null>(null);
  const focusDate = useCallback(
    (date: string, scroll: boolean) => setFocus((prev) => ({ date, scroll, key: (prev?.key ?? 0) + 1 })),
    []
  );

  if (!holdings) return null;
  const riskOffSummary = sleeveTables
    .filter((table) => table.riskOffPct !== null)
    .map((table) => `${table.name} ${table.riskOffPct!.toFixed(1)}% risk-off`)
    .join(" · ");

  return (
    <div>
      <h3 className="text-sm font-medium text-muted mb-3">Fund Holdings — {shortBacktestAssetLabel(result.etfResults.find((etf) => etf.id === LETF_FUND_RESULT_ID)?.name ?? "TQQQ/UPRO")}</h3>
      <LetfHoldingsChart
        holdings={holdings}
        testId="letf-fund-holdings-chart"
        focus={focus}
        caption={<>
          What the fund holds at each close: each sleeve&rsquo;s LETF while it is risk-on and its risk-off
          basket while it is out. The colored bands split the area under the fund&rsquo;s value in
          proportion to each holding, on both scales; on Log the dashed line is the best-fit constant
          growth rate over the range in view. Hover or click a trigger day below to show that close.
        </>}
      />
      <div className="mt-4">
        <h4 className="text-sm font-medium text-muted mb-2">
          {tableRows.length} Trade Days
          {riskOffSummary && <span className="ml-2 text-xs text-muted">({riskOffSummary})</span>}
        </h4>
        {tableRows.length === 0 ? (
          <p className="text-xs text-muted">No trades triggered for this run.</p>
        ) : (
          <SmaTradesTable rows={tableRows} actionLabel="Action (Inflation-Adjusted)" showSleeve onTriggerDayFocus={focusDate} />
        )}
      </div>
    </div>
  );
}
