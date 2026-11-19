"use client";

import { useMemo } from "react";
import { LetfFundHoldingsChart } from "@/components/tools/backtest/LetfFundHoldingsChart";
import { buildSmaTradeTableRows, SmaTradesTable, type SmaTradeTableRow } from "@/components/tools/backtest/SmaTradesTable";
import { alignLetfComboSleeves, findLetfComboSleeves, LETF_FUND_RESULT_ID, type LetfComboRun } from "@/lib/simulation/letf-dual-sleeve";
import { letfComboFundHoldings } from "@/lib/simulation/letf-fund-holdings";
import { buildSmaTradeRows, type SmaTradeRow } from "@/lib/sma-trade-rows";
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

function resetRow(date: string): SmaTradeTableRow {
  const row: SmaTradeRow = {
    signalDate: date,
    tradingDay: date,
    signalType: "buy",
    action: "Rebalance to 50/50",
    eventPrice: null,
    triggerClose: null,
    triggerSmaPctDiff: null,
    actionToneClass: "text-muted",
  };
  return {
    key: `reset|${date}`,
    row,
    riskOffReturn: null,
    riskOffAdvantage: null,
    riskOnReturn: null,
    daysTillNextEvent: null,
  };
}

const executionDay = (entry: SmaTradeTableRow) => entry.row.tradingDay ?? entry.row.signalDate;

/**
 * The TQQQ/UPRO fund's details: what it holds at each close, then both sleeves'
 * trades in one table. Each sleeve's rows keep the metrics of their own sleeve; the
 * fund's 50/50 resets sit at the top of their day.
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
    const resets = (holdings?.resetDates ?? []).map(resetRow);
    // Stable sort: a day's sleeve trades in fund order, then the reset they caused.
    return [...sleeveTables.flatMap((table) => table.rows), ...resets]
      .map((entry, order) => ({ entry, order }))
      .sort((a, b) => executionDay(a.entry).localeCompare(executionDay(b.entry)) || a.order - b.order)
      .map(({ entry }) => entry);
  }, [holdings, sleeveTables]);

  if (!holdings) return null;
  const riskOffSummary = sleeveTables
    .filter((table) => table.riskOffPct !== null)
    .map((table) => `${table.name} ${table.riskOffPct!.toFixed(1)}% risk-off`)
    .join(" · ");

  return (
    <div>
      <h3 className="text-sm font-medium text-muted mb-3">Fund Holdings — {shortBacktestAssetLabel(result.etfResults.find((etf) => etf.id === LETF_FUND_RESULT_ID)?.name ?? "TQQQ/UPRO")}</h3>
      <LetfFundHoldingsChart holdings={holdings} />
      <div className="mt-4">
        <h4 className="text-sm font-medium text-muted mb-2">
          {tableRows.length} Trade Days
          {riskOffSummary && <span className="ml-2 text-xs text-muted">({riskOffSummary})</span>}
        </h4>
        {tableRows.length === 0 ? (
          <p className="text-xs text-muted">No trades triggered for this run.</p>
        ) : (
          <SmaTradesTable rows={tableRows} actionLabel="Action (Inflation-Adjusted)" showSleeve />
        )}
      </div>
    </div>
  );
}
