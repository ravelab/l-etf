"use client";

import { useState } from "react";
import { TablePagination } from "@/components/ui/TablePagination";
import { SmaTriggerBadge } from "@/components/tools/SmaTriggerBadge";
import { formatDate } from "@/lib/format";
import { formatSignedNumber, type SmaTradeRow } from "@/lib/sma-trade-rows";
import {
  buildRiskOffLookups,
  getDaysTillNextEvent,
  getRiskOffAdvantage,
  getRiskOffRealCagr,
  getRiskOnRealCagr,
  type SmaSegmentContext,
} from "@/lib/sma-trade-metrics";
import type { PricePoint } from "@/lib/simulation/types";

const TRADES_PAGE_SIZE = 10;

/** One table row with its segment metrics already computed against its own line. */
export type SmaTradeTableRow = {
  key: string;
  row: SmaTradeRow;
  /** The fund's sleeve the row belongs to; set only in a merged fund table. */
  sleeve?: string;
  riskOffReturn: number | null;
  riskOffAdvantage: number | null;
  riskOnReturn: number | null;
  daysTillNextEvent: number | null;
};

/**
 * Metrics for one line's trade rows. Each row's segment runs to the line's own
 * next row, so a fund table builds these per sleeve before merging them.
 */
export function buildSmaTradeTableRows(params: {
  tradeRows: SmaTradeRow[];
  riskOffAsset: string | undefined;
  dates: string[];
  riskOffPricesByTicker: Record<string, PricePoint[]> | undefined;
  annualizedInflation: number;
  finalEtfPrice: number;
  sleeve?: string;
}): SmaTradeTableRow[] {
  const { tradeRows, dates, sleeve } = params;
  const ctx: SmaSegmentContext = {
    tradeRows,
    endDate: dates[dates.length - 1],
    finalEtfPrice: params.finalEtfPrice,
    annualizedInflation: params.annualizedInflation,
    riskOffLookups: buildRiskOffLookups(params.riskOffAsset, dates, params.riskOffPricesByTicker),
  };
  return tradeRows.map((row, i) => {
    const isTerminal = row.isEndLiquidation === true;
    const kind = isTerminal ? "liq" : row.isInitialEntry ? "init" : "sig";
    return {
      key: `${sleeve ?? ""}|${row.signalDate}-${row.action}-${kind}`,
      row,
      ...(sleeve ? { sleeve } : {}),
      riskOffReturn: isTerminal ? null : getRiskOffRealCagr(ctx, i),
      riskOffAdvantage: getRiskOffAdvantage(ctx, i),
      riskOnReturn: getRiskOnRealCagr(ctx, i),
      daysTillNextEvent: getDaysTillNextEvent(ctx, i),
    };
  });
}

function toneOf(value: number | null, threshold: number): string {
  if (value == null) return "";
  return value >= threshold ? "text-positive" : "text-negative";
}

export function SmaTradesTable({
  rows,
  actionLabel,
  showSleeve = false,
}: {
  rows: SmaTradeTableRow[];
  actionLabel: string;
  showSleeve?: boolean;
}) {
  const [page, setPage] = useState(0);
  const pageSafe = Math.min(page, Math.max(0, Math.ceil(rows.length / TRADES_PAGE_SIZE) - 1));
  const paged = rows.slice(pageSafe * TRADES_PAGE_SIZE, (pageSafe + 1) * TRADES_PAGE_SIZE);

  return (
    <>
      <TablePagination page={page} pageSize={TRADES_PAGE_SIZE} totalItems={rows.length} onPageChange={setPage} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-card-border text-left text-muted">
              <th className="pb-2 pr-4 font-medium">Trigger Day</th>
              {showSleeve && <th className="pb-2 pr-4 font-medium">Sleeve</th>}
              <th className="pb-2 pr-4 font-medium">{actionLabel}</th>
              <th className="pb-2 pr-4 font-medium text-right">Risk-Off Real CAGR</th>
              <th className="pb-2 pr-4 font-medium text-right">Risk-Off / If Risk-On</th>
              <th className="pb-2 pr-4 font-medium text-right">Risk-On Real CAGR</th>
              <th className="pb-2 font-medium text-right">Till Next Event</th>
            </tr>
          </thead>
          <tbody>
            {paged.map(({ key, row, sleeve, riskOffReturn, riskOffAdvantage, riskOnReturn, daysTillNextEvent }) => (
              <tr key={key} className="border-b border-card-border/50">
                <td className="py-2.5 pr-4">
                  {formatDate(row.signalDate)}
                  {row.triggerClose != null && (
                    <span className="text-muted text-xs block md:inline md:ml-1">
                      ({row.triggerClose.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      {row.triggerSmaPctDiff != null && (
                        <span className={row.triggerSmaPctDiff >= 0 ? "text-positive" : "text-negative"}>
                          {" "}{row.triggerSmaPctDiff >= 0 ? "+" : ""}{row.triggerSmaPctDiff.toFixed(1)}%
                        </span>
                      )})
                    </span>
                  )}
                </td>
                {showSleeve && <td className="py-2.5 pr-4 text-muted">{sleeve ?? "Fund"}</td>}
                <td className={`py-2.5 pr-4 ${row.actionToneClass}`}>
                  {row.action}
                  {row.trigger && <SmaTriggerBadge trigger={row.trigger} vol={row.triggerVol} rsi={row.triggerRsi} shock={row.triggerShock} />}
                </td>
                <td className={`py-2.5 pr-4 text-right ${toneOf(riskOffReturn, 0)}`}>
                  {riskOffReturn == null ? "—" : formatSignedNumber(riskOffReturn, "", "%")}
                </td>
                <td className={`py-2.5 pr-4 text-right ${toneOf(riskOffAdvantage, 1)}`}>
                  {riskOffAdvantage == null ? "—" : `${riskOffAdvantage.toFixed(2)}X`}
                </td>
                <td className={`py-2.5 pr-4 text-right ${toneOf(riskOnReturn, 0)}`}>
                  {riskOnReturn == null ? "—" : formatSignedNumber(riskOnReturn, "", "%")}
                </td>
                <td className="py-2.5 text-right">
                  {daysTillNextEvent === null ? "—" : `${(daysTillNextEvent / 365.25).toFixed(2)}y`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
