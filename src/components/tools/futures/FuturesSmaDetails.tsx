"use client";

import { memo, useMemo, useState } from "react";
import {
  type FuturesStrategyResult,
  buildRollDateMap,
  futuresFrontBackQtyAfterEachTransaction,
  DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY,
} from "@/lib/simulation/futures";
import { Card } from "@/components/ui/Card";
import { formatDate, formatCurrency, formatCurrencySigFigs, formatPercentPointsSigFigs } from "@/lib/format";
import { useMaxPageButtons } from "@/lib/hooks/use-max-page-buttons";
import { cpiIndexRatioEndOverStart } from "@/lib/inflation";

const PAGE_SIZE = 10;

function formatQty(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString(undefined, {
    maximumFractionDigits: 0,
  });
}

function formatOneDecimalPercent(value: number): string {
  if (!Number.isFinite(value)) return "0.0%";
  const formatted = value.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${value > 0 ? "+" : ""}${formatted}%`;
}

function formatMultiple(value: number): string {
  if (!Number.isFinite(value)) return "0.00x";
  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}x`;
}

function formatIndexLikePrice(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatInterestEarnedCell(row: {
  cashInterestEarned: number;
  cashInterestTradingDays?: number;
  cashInterestAnnualRatePct?: number;
}): string {
  const amt = row.cashInterestEarned;
  if (!Number.isFinite(amt) || amt === 0) return formatCurrency(amt);
  const days = row.cashInterestTradingDays;
  const pct = row.cashInterestAnnualRatePct;
  if (
    days != null &&
    Number.isFinite(days) &&
    days > 0 &&
    pct != null &&
    Number.isFinite(pct)
  ) {
    const pctStr = formatPercentPointsSigFigs(pct, 2);
    return `${formatCurrency(amt)} (${Math.round(days)}d, ${pctStr}%)`;
  }
  return formatCurrency(amt);
}

function FuturesSmaDetailsImpl({
  strategy,
  annualizedInflation,
  monthlyCpi,
}: {
  strategy: FuturesStrategyResult;
  annualizedInflation: number;
  monthlyCpi: Array<{ date: string; value: number }>;
}) {
  const [page, setPage] = useState(0);
  const maxButtons = useMaxPageButtons();
  type DisplayRow = FuturesStrategyResult["transactions"][number] & {
    displayAction?: string;
    displaySymbol?: string;
    hideNumericDetails?: boolean;
    isEndLiquidation?: boolean;
    /** Merged sell+buy roll: Qty Δ shows contracts rolled (|qtyΔ|); fill shows old → new prices. */
    mergedRoll?: boolean;
    rollSellFill?: number;
    rollBuyFill?: number;
    /** Calendar front-strip vs deferred quarterly lots after this row (futures only). */
    frontQtyAfter?: number;
    backQtyAfter?: number;
  };

  const frontBackAfterEachTx = useMemo(
    () =>
      futuresFrontBackQtyAfterEachTransaction({
        index: strategy.index,
        transactions: strategy.transactions,
        rollDateByQuarter: buildRollDateMap(
          strategy.etfResult.dates,
          DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY
        ),
      }),
    [strategy.transactions, strategy.index, strategy.etfResult.dates]
  );

  const rows = useMemo<DisplayRow[]>(() => {
    const source = strategy.transactions;
    const merged: DisplayRow[] = [];
    let i = 0;
    while (i < source.length) {
      const current = source[i];

      // Merge a quarterly futures roll pair (sell old contract, buy new) into one ROLL row.
      const next = source[i + 1];
      const currentIsRoll = current.symbol.includes("(ROLL)");
      const nextIsRoll = next?.symbol.includes("(ROLL)");
      if (
        next &&
        current.instrument === "futures" &&
        next.instrument === "futures" &&
        current.date === next.date &&
        current.action === "sell" &&
        next.action === "buy" &&
        currentIsRoll &&
        nextIsRoll
      ) {
        const fromSymbol = current.symbol.replace(" (ROLL)", "");
        const toSymbol = next.symbol.replace(" (ROLL)", "");
        const fbMerged = frontBackAfterEachTx[i + 1];
        merged.push({
          ...next,
          fees: current.fees + next.fees,
          spread: current.spread + next.spread,
          cashInterestEarned: current.cashInterestEarned + next.cashInterestEarned,
          ...(current.cashInterestEarned > 0
            ? {
                cashInterestTradingDays: current.cashInterestTradingDays,
                cashInterestAnnualRatePct: current.cashInterestAnnualRatePct,
              }
            : next.cashInterestEarned > 0
              ? {
                  cashInterestTradingDays: next.cashInterestTradingDays,
                  cashInterestAnnualRatePct: next.cashInterestAnnualRatePct,
                }
              : {}),
          displayAction: "ROLL",
          displaySymbol: `${fromSymbol} → ${toSymbol}`,
          leverageDeltaPctBefore: current.leverageDeltaPctBefore,
          leverageDeltaPct: next.leverageDeltaPct,
          mergedRoll: true,
          rollSellFill: current.fillPrice,
          rollBuyFill: next.fillPrice,
          ...(fbMerged != null
            ? { frontQtyAfter: fbMerged.frontQty, backQtyAfter: fbMerged.backQty }
            : {}),
        });
        i += 2;
        continue;
      }

      // Merge repeated same-day futures sells caused by an EOD max-leverage trim.
      // The simulator emits one contract at a time so the cap loop is exact; the
      // ledger is easier to read as one combined SELL row.
      if (
        current.instrument === "futures" &&
        current.action === "sell" &&
        !current.symbol.includes("(ROLL)") &&
        !current.symbol.includes("(LIQUIDATE)") &&
        !current.isEndLiquidation
      ) {
        let j = i + 1;
        while (
          j < source.length &&
          source[j].instrument === "futures" &&
          source[j].action === "sell" &&
          source[j].date === current.date &&
          source[j].symbol === current.symbol &&
          source[j].fillPrice === current.fillPrice &&
          !source[j].symbol.includes("(ROLL)") &&
          !source[j].symbol.includes("(LIQUIDATE)") &&
          !source[j].isEndLiquidation
        ) {
          j += 1;
        }
        const groupSize = j - i;
        if (groupSize > 1) {
          const group = source.slice(i, j);
          const lastLeg = group[group.length - 1];
          const totalQtyDelta = group.reduce((sum, r) => sum + r.qtyDelta, 0);
          const totalFees = group.reduce((sum, r) => sum + r.fees, 0);
          const totalSpread = group.reduce((sum, r) => sum + r.spread, 0);
          const totalInterest = group.reduce((sum, r) => sum + r.cashInterestEarned, 0);
          const metaSource = group.find(
            (r) =>
              r.cashInterestEarned > 0 &&
              r.cashInterestTradingDays != null &&
              r.cashInterestAnnualRatePct != null
          );
          const fbMerged = frontBackAfterEachTx[j - 1];
          merged.push({
            ...lastLeg,
            qtyDelta: totalQtyDelta,
            fees: totalFees,
            spread: totalSpread,
            cashInterestEarned: totalInterest,
            ...(metaSource
              ? {
                  cashInterestTradingDays: metaSource.cashInterestTradingDays,
                  cashInterestAnnualRatePct: metaSource.cashInterestAnnualRatePct,
                }
              : {}),
            leverageDeltaPctBefore: current.leverageDeltaPctBefore,
            leverageDeltaPct: lastLeg.leverageDeltaPct,
            ...(fbMerged != null
              ? { frontQtyAfter: fbMerged.frontQty, backQtyAfter: fbMerged.backQty }
              : {}),
          });
          i = j;
          continue;
        }
      }

      // Merge a basket of risk-off legs that execute together (same date + action) into one row.
      if (current.instrument === "riskoff" && !current.isEndLiquidation) {
        let j = i + 1;
        while (
          j < source.length &&
          source[j].instrument === "riskoff" &&
          source[j].date === current.date &&
          source[j].action === current.action &&
          !source[j].isEndLiquidation
        ) {
          j += 1;
        }
        const groupSize = j - i;
        if (groupSize > 1) {
          const group = source.slice(i, j);
          const totalFees = group.reduce((sum, r) => sum + r.fees, 0);
          const totalSpread = group.reduce((sum, r) => sum + r.spread, 0);
          const totalInterest = group.reduce((sum, r) => sum + r.cashInterestEarned, 0);
          const metaSource = group.find(
            (r) =>
              r.cashInterestEarned > 0 &&
              r.cashInterestTradingDays != null &&
              r.cashInterestAnnualRatePct != null
          );
          const shortSymbol = group.map((r) => r.symbol.charAt(0).toUpperCase()).join("+");
          const lastLeg = group[group.length - 1];
          merged.push({
            ...current,
            fees: totalFees,
            spread: totalSpread,
            cashInterestEarned: totalInterest,
            ...(metaSource
              ? {
                  cashInterestTradingDays: metaSource.cashInterestTradingDays,
                  cashInterestAnnualRatePct: metaSource.cashInterestAnnualRatePct,
                }
              : {}),
            // Per-leg rows carry cumulative book at open; merged row shows basket after final leg.
            equity: lastLeg.equity,
            displaySymbol: shortSymbol,
            hideNumericDetails: true,
          });
          i = j;
          continue;
        }
      }

      const fb = frontBackAfterEachTx[i];
      merged.push(
        current.instrument === "futures" && fb != null
          ? { ...current, frontQtyAfter: fb.frontQty, backQtyAfter: fb.backQty }
          : current
      );
      i += 1;
    }
    // Same calendar date: show sells before buys (e.g. liquidate B+G+V then BUY ESM when going risk-on).
    // EOD liquidations (margin/leverage cap, terminal close-out) must come AFTER any intraday
    // buy on the same date — they execute at close, after the regular trading flow.
    const intradayRank = (r: DisplayRow): number => {
      const isLiquidation = r.isEndLiquidation === true || /\(LIQUIDATE\)/.test(r.symbol);
      if (isLiquidation) return 3;
      if (r.displayAction === "ROLL") return 1; // after pure sells, before opening buys
      if (r.action === "sell") return 0;
      return 2;
    };
    merged.sort((a, b) => {
      const byDate = a.date.localeCompare(b.date);
      if (byDate !== 0) return byDate;
      return intradayRank(a) - intradayRank(b);
    });

    // Fold same-day same-contract intraday futures activity into a same-day LIQUIDATE
    // row. Avoids showing a tiny rebalance (e.g. BUY +1) on the same date as the
    // EOD risk-cap or terminal close-out — the net effect is what matters.
    const stripLiquidateSuffix = (sym: string) =>
      sym.replace(/\s*\(LIQUIDATE\)\s*$/i, "").trim();
    const consolidated: DisplayRow[] = [];
    for (const row of merged) {
      const isLiquidation =
        row.instrument === "futures" &&
        (row.isEndLiquidation === true || /\(LIQUIDATE\)/.test(row.symbol));
      if (isLiquidation && consolidated.length > 0) {
        const baseSymbol = stripLiquidateSuffix(row.symbol);
        let totalQtyDelta = row.qtyDelta;
        let totalFees = row.fees;
        let totalSpread = row.spread;
        let totalInterest = row.cashInterestEarned;
        let leverageBefore = row.leverageDeltaPctBefore;
        let interestMeta:
          | { cashInterestTradingDays?: number; cashInterestAnnualRatePct?: number }
          | undefined =
          row.cashInterestTradingDays != null && row.cashInterestAnnualRatePct != null
            ? {
                cashInterestTradingDays: row.cashInterestTradingDays,
                cashInterestAnnualRatePct: row.cashInterestAnnualRatePct,
              }
            : undefined;
        while (consolidated.length > 0) {
          const prev = consolidated[consolidated.length - 1];
          if (prev.date !== row.date) break;
          if (prev.instrument !== "futures") break;
          if (stripLiquidateSuffix(prev.symbol) !== baseSymbol) break;
          if (prev.displayAction === "ROLL") break;
          consolidated.pop();
          totalQtyDelta += prev.qtyDelta;
          totalFees += prev.fees;
          totalSpread += prev.spread;
          totalInterest += prev.cashInterestEarned;
          if (prev.leverageDeltaPctBefore != null) leverageBefore = prev.leverageDeltaPctBefore;
          if (
            interestMeta == null &&
            prev.cashInterestTradingDays != null &&
            prev.cashInterestAnnualRatePct != null
          ) {
            interestMeta = {
              cashInterestTradingDays: prev.cashInterestTradingDays,
              cashInterestAnnualRatePct: prev.cashInterestAnnualRatePct,
            };
          }
        }
        consolidated.push({
          ...row,
          qtyDelta: totalQtyDelta,
          fees: totalFees,
          spread: totalSpread,
          cashInterestEarned: totalInterest,
          leverageDeltaPctBefore: leverageBefore,
          ...(interestMeta ?? {}),
        });
      } else {
        consolidated.push(row);
      }
    }
    return consolidated;
  }, [strategy.transactions, frontBackAfterEachTx]);

  const startDate = strategy.etfResult.dates[0] ?? "";
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages - 1);
  const paged = rows.slice(pageSafe * PAGE_SIZE, (pageSafe + 1) * PAGE_SIZE);
  const contractsTraded = strategy.transactions
    .filter((row) => row.instrument === "futures")
    .reduce((sum, row) => sum + Math.abs(row.qtyDelta), 0);
  const tradeDays = new Set(
    strategy.transactions.filter((row) => !row.isEndLiquidation).map((row) => row.date)
  ).size;
  const sessionCount = strategy.sessionDayCount ?? strategy.etfResult.dates.length;
  const sessionDays = sessionCount > 0 ? sessionCount : 1;
  const riskOffDays = strategy.riskOffSessionDayCount ?? 0;
  const riskOffPct = (riskOffDays / sessionDays) * 100;
  /** Starting funded balance — not day-0 ending equity after fees (see futures simulation). */
  const initialEquity = strategy.initialEquity;

  const dailyEquityByDate = useMemo(() => {
    const dates = strategy.etfResult.dates;
    const values = strategy.etfResult.dailyValues;
    const m = new Map<string, number>();
    for (let i = 0; i < dates.length && i < values.length; i++) {
      m.set(dates[i]!, values[i] as number);
    }
    return m;
  }, [strategy.etfResult.dates, strategy.etfResult.dailyValues]);

  /** Prefer post-trade `equity` from the sim; fall back to end-of-day curve when missing (legacy rows). */
  const ledgerPortfolioEquity = (row: FuturesStrategyResult["transactions"][number]): number => {
    if (Number.isFinite(row.equity) && row.equity > 0) return row.equity;
    const fromDaily = dailyEquityByDate.get(row.date);
    if (Number.isFinite(fromDaily)) return fromDaily as number;
    return Number.isFinite(row.equity) ? row.equity : NaN;
  };

  const realEquityForRow = (date: string, equity: number): number => {
    if (!startDate) return equity;
    if (monthlyCpi.length >= 2) {
      const ratio = cpiIndexRatioEndOverStart(monthlyCpi, startDate, date);
      return ratio > 0 ? equity / ratio : equity;
    }
    const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
    const years = (new Date(date).getTime() - new Date(startDate).getTime()) / msPerYear;
    const factor = years > 0 ? Math.pow(1 + annualizedInflation, years) : 1;
    return factor > 0 ? equity / factor : equity;
  };

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="min-w-0 text-xs text-muted space-y-1">
          <div>
            {formatQty(tradeDays)} trade days ({riskOffPct.toFixed(1)}% risk-off) · {formatQty(contractsTraded)}{" "}
            contracts traded
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="text-xs text-muted">No transactions for this SMA run.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-card-border text-left text-muted">
                <th className="pb-2 pr-4 font-medium whitespace-nowrap">Date</th>
                <th className="pb-2 pr-4 font-medium whitespace-nowrap">Action</th>
                <th className="pb-2 pr-4 font-medium whitespace-nowrap">Symbol</th>
                <th className="pb-2 pr-4 font-medium whitespace-nowrap text-right">Qty Δ</th>
                <th className="pb-2 pr-4 font-medium whitespace-nowrap text-right">Front</th>
                <th className="pb-2 pr-4 font-medium whitespace-nowrap text-right">Deferred</th>
                <th className="pb-2 pr-4 font-medium whitespace-nowrap text-right">Fill</th>
                <th className="pb-2 pr-4 font-medium whitespace-nowrap text-right">Fees</th>
                <th className="pb-2 pr-4 font-medium whitespace-nowrap text-right">Spread</th>
                <th className="pb-2 pr-4 font-medium whitespace-nowrap text-right">Interest Earned</th>
                <th className="pb-2 pr-4 font-medium whitespace-nowrap text-right">Excess Liquidity</th>
                <th className="pb-2 pr-4 font-medium whitespace-nowrap text-right">Leverage Δ</th>
                <th className="pb-2 pr-4 font-medium whitespace-nowrap text-right">Value</th>
                <th className="pb-2 font-medium whitespace-nowrap text-right">Real Value</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((row, idx) => {
                const isTerminalBookClose = row.isEndLiquidation === true;
                const symbolRaw = row.displaySymbol ?? row.symbol;
                const isLiquidation =
                  isTerminalBookClose || symbolRaw.includes("(LIQUIDATE)");
                const symbolDisplay = symbolRaw.replace(/\s*\(LIQUIDATE\)\s*$/i, "").trim();
                const actionText = isLiquidation
                  ? "LIQUIDATE"
                  : (row.displayAction ?? row.action.toUpperCase());
                const tone = row.displayAction === "ROLL"
                  ? "text-amber-300"
                  : isLiquidation
                    ? "text-negative"
                  : (row.action === "buy" ? "text-positive" : "text-negative");
                const levDelta = row.leverageDeltaPct;
                const levBefore = row.leverageDeltaPctBefore;
                const pctTone = (v: number) => (v < 0 ? "text-negative" : "text-positive");
                const isRoll = row.displayAction === "ROLL" || symbolRaw.includes("(ROLL)");
                const isMergedRoll = row.mergedRoll === true;
                const showLeverageDelta = row.instrument === "futures";
                const dashDetail =
                  row.hideNumericDetails || (isTerminalBookClose && row.instrument === "riskoff");
                const portfolioEq = ledgerPortfolioEquity(row);
                const realValue = realEquityForRow(row.date, portfolioEq);
                const realMultiple = initialEquity > 0 ? realValue / initialEquity : 0;
                return (
                  <tr key={`${row.date}-${symbolRaw}-${row.qtyDelta}-${idx}-${isTerminalBookClose ? "eol" : ""}`} className="border-b border-card-border/50">
                    <td className="py-2.5 pr-4 whitespace-nowrap">{formatDate(row.date)}</td>
                    <td className={`py-2.5 pr-4 whitespace-nowrap ${tone}`}>
                      {actionText}
                    </td>
                    <td className={`py-2.5 pr-4 ${isRoll ? "whitespace-normal break-words text-amber-300 font-medium" : "whitespace-nowrap"}`}>{symbolDisplay}</td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-right tabular-nums">
                      {dashDetail
                        ? "—"
                        : isMergedRoll
                          ? formatQty(Math.abs(row.qtyDelta))
                          : row.qtyDelta >= 0
                            ? `+${formatQty(row.qtyDelta)}`
                            : formatQty(row.qtyDelta)}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-right tabular-nums text-muted">
                      {row.instrument === "futures" &&
                      row.frontQtyAfter != null &&
                      row.backQtyAfter != null
                        ? formatQty(row.frontQtyAfter)
                        : "—"}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-right tabular-nums text-muted">
                      {row.instrument === "futures" &&
                      row.frontQtyAfter != null &&
                      row.backQtyAfter != null
                        ? formatQty(row.backQtyAfter)
                        : "—"}
                    </td>
                    <td className="py-2.5 pr-4 min-w-0 whitespace-normal break-words text-right tabular-nums">
                      {dashDetail
                        ? "—"
                        : isMergedRoll &&
                            Number.isFinite(row.rollSellFill ?? NaN) &&
                            Number.isFinite(row.rollBuyFill ?? NaN)
                          ? `${formatIndexLikePrice(row.rollSellFill as number)} → ${formatIndexLikePrice(row.rollBuyFill as number)}`
                          : row.fillPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-right tabular-nums text-muted">
                      {formatCurrencySigFigs(row.fees, 2)}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-right tabular-nums text-muted">
                      {formatCurrencySigFigs(row.spread, 2)}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-right tabular-nums">
                      {dashDetail ? "—" : formatInterestEarnedCell(row)}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-right tabular-nums">
                      {dashDetail ? "—" : formatCurrency(row.excessLiquidity)}
                    </td>
                    <td className="py-2.5 pr-4 min-w-0 whitespace-normal break-words text-right tabular-nums">
                      {showLeverageDelta
                        ? Number.isFinite(levBefore ?? NaN)
                          ? (
                            <>
                              <span className={pctTone(levBefore as number)}>
                                {formatOneDecimalPercent(levBefore as number)}
                              </span>
                              <span className="text-muted"> → </span>
                              <span className={pctTone(levDelta)}>{formatOneDecimalPercent(levDelta)}</span>
                            </>
                          )
                          : <span className={pctTone(levDelta)}>{formatOneDecimalPercent(levDelta)}</span>
                        : "—"}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-right tabular-nums font-medium">
                      {Number.isFinite(portfolioEq) ? formatCurrency(portfolioEq) : "—"}
                    </td>
                    <td className="py-2.5 whitespace-nowrap text-right tabular-nums font-medium text-blue-400">
                      {Number.isFinite(portfolioEq) ? formatMultiple(realMultiple) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="mt-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs text-muted">
          <span>
            {pageSafe * PAGE_SIZE + 1}&ndash;{Math.min((pageSafe + 1) * PAGE_SIZE, rows.length)} of {rows.length}
          </span>
          <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0">
            <button
              type="button"
              disabled={pageSafe === 0}
              onClick={() => setPage((p) => p - 1)}
              className="rounded px-2 py-1 hover:bg-card-border/30 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Prev
            </button>
            {(() => {
              const pages = [];
              if (totalPages <= maxButtons) {
                for (let i = 0; i < totalPages; i++) {
                  pages.push(
                    <button
                      key={i}
                      type="button"
                      onClick={() => setPage(i)}
                      className={`rounded px-2 py-1 ${pageSafe === i ? "bg-accent text-accent-contrast" : "hover:bg-card-border/30"}`}
                    >
                      {i + 1}
                    </button>
                  );
                }
              } else {
                const range = 2;
                const start = Math.max(0, pageSafe - range);
                const end = Math.min(totalPages - 1, pageSafe + range);

                if (start > 0) {
                  pages.push(
                    <button
                      key={0}
                      type="button"
                      onClick={() => setPage(0)}
                      className="rounded px-2 py-1 hover:bg-card-border/30"
                    >
                      1
                    </button>
                  );
                  if (start > 1) pages.push(<span key="start-dots" className="px-1">...</span>);
                }

                for (let i = start; i <= end; i++) {
                  pages.push(
                    <button
                      key={i}
                      type="button"
                      onClick={() => setPage(i)}
                      className={`rounded px-2 py-1 ${pageSafe === i ? "bg-accent text-accent-contrast" : "hover:bg-card-border/30"}`}
                    >
                      {i + 1}
                    </button>
                  );
                }

                if (end < totalPages - 1) {
                  if (end < totalPages - 2) pages.push(<span key="end-dots" className="px-1">...</span>);
                  pages.push(
                    <button
                      key={totalPages - 1}
                      type="button"
                      onClick={() => setPage(totalPages - 1)}
                      className="rounded px-2 py-1 hover:bg-card-border/30"
                    >
                      {totalPages}
                    </button>
                  );
                }
              }
              return pages;
            })()}
            <button
              type="button"
              disabled={pageSafe === totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="rounded px-2 py-1 hover:bg-card-border/30 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

export const FuturesSmaDetails = memo(FuturesSmaDetailsImpl);
