import { DEFAULT_SMA_EXECUTION_MODE } from "@/lib/input-normalization";
import { formatRiskOffLiquidationAbbrev } from "@/lib/constants";
import type { EtfConfig, EtfResult } from "@/lib/simulation/types";

export interface SmaTradeRow {
  signalDate: string;
  tradingDay: string | null;
  signalType: "buy" | "sell";
  action: string;
  eventPrice: number | null;
  triggerClose: number | null;
  triggerSmaPctDiff: number | null;
  actionToneClass: string;
  isInitialEntry?: boolean;
  isEndLiquidation?: boolean;
}

export interface BuildSmaTradeRowsParams {
  etf: Pick<EtfResult, "smaSignals" | "smaPrices" | "smaStartInvested">;
  config: Pick<EtfConfig, "name" | "riskOffAsset" | "smaExecutionMode">;
  etfDates: string[];
  /** Index close prices (synthetic scale) driving the SMA signal. */
  closePrices: number[];
  openPrices: number[];
  /** ETF trade prices used for the Action column and per-segment returns. */
  tradeClosePrices: number[];
  tradeOpenPrices: number[];
  syntheticPriceScale: number;
  annualizedInflation: number;
}

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Build the SMA card's "Trade Days" rows: one synthetic entry row on the window
 * start date, one row per executed SMA crossing, and one synthetic terminal
 * liquidation row on the window end date. Prices are anchored to end-of-window
 * real dollars via `annualizedInflation`.
 */
export function buildSmaTradeRows({
  etf,
  config,
  etfDates,
  closePrices,
  openPrices,
  tradeClosePrices,
  tradeOpenPrices,
  syntheticPriceScale,
  annualizedInflation,
}: BuildSmaTradeRowsParams): SmaTradeRow[] {
  if (etfDates.length < 2) return [];

  const executionMode = config.smaExecutionMode ?? DEFAULT_SMA_EXECUTION_MODE;
  const anchorDate = etfDates[etfDates.length - 1] ?? null;
  const dateToIndex = new Map(etfDates.map((date, idx) => [date, idx]));

  const toAnchoredRealPrice = (price: number, date: string): number => {
    if (!Number.isFinite(price) || price <= 0) return price;
    if (!anchorDate || !Number.isFinite(annualizedInflation)) return price;
    const dateMs = new Date(`${date}T00:00:00Z`).getTime();
    const anchorMs = new Date(`${anchorDate}T00:00:00Z`).getTime();
    if (!Number.isFinite(dateMs) || !Number.isFinite(anchorMs)) return price;
    const yearsToAnchor = (anchorMs - dateMs) / MS_PER_YEAR;
    const inflationFactor = Math.pow(1 + annualizedInflation, yearsToAnchor);
    if (!Number.isFinite(inflationFactor) || inflationFactor <= 0) return price;
    return price * inflationFactor;
  };

  const toDisplayPrice = (price: number | undefined, date: string | null): number | null => {
    if (price == null || !Number.isFinite(price) || price <= 0 || !date) return null;
    const anchored = toAnchoredRealPrice(price, date);
    return Number.isFinite(anchored) && anchored > 0 ? anchored : null;
  };

  const needsNextDay = executionMode === "next-day-open" || executionMode === "next-day-close";
  const lastIdx = etfDates.length - 1;
  const baseRows = etf.smaSignals.flatMap((signal): SmaTradeRow[] => {
    const signalIdx = dateToIndex.get(signal.date);
    // Hide signals whose next-day execution hasn't happened yet (no data beyond the signal day).
    if (needsNextDay && typeof signalIdx === "number" && signalIdx >= lastIdx) return [];
    const triggerClose = signalIdx != null ? closePrices[signalIdx] : undefined;
    const triggerSma = signalIdx != null ? etf.smaPrices[signalIdx] : undefined;
    const triggerSmaPctDiff =
      triggerClose != null && triggerSma != null && Number.isFinite(triggerClose) && Number.isFinite(triggerSma) && triggerSma !== 0
        ? ((triggerClose / syntheticPriceScale - triggerSma) / triggerSma) * 100
        : null;
    const executionIdx =
      typeof signalIdx === "number"
        ? needsNextDay
          ? signalIdx + 1
          : signalIdx
        : null;
    const tradingDay = executionIdx === null ? null : etfDates[executionIdx];
    const effectiveDate = tradingDay ?? signal.date;
    const closePriceAtExecution = executionIdx !== null ? (tradeClosePrices[executionIdx] ?? closePrices[executionIdx]) : undefined;
    const openPriceAtExecution = executionIdx !== null ? (tradeOpenPrices[executionIdx] ?? openPrices[executionIdx]) : undefined;
    const etfPrice = executionMode === "next-day-open"
      ? openPriceAtExecution ?? closePriceAtExecution ?? signal.price
      : closePriceAtExecution ?? signal.price;
    const displayPrice = toDisplayPrice(etfPrice, effectiveDate);
    const priceStr = displayPrice ? ` (${formatSignedNumber(displayPrice, "$")})` : "";
    const displayClose =
      triggerClose != null && Number.isFinite(triggerClose)
        ? triggerClose / syntheticPriceScale
        : null;
    const isBuy = signal.type === "buy";
    return [{
      signalDate: signal.date,
      tradingDay,
      signalType: signal.type,
      eventPrice: displayPrice,
      triggerClose: displayClose,
      triggerSmaPctDiff,
      actionToneClass: isBuy ? "text-positive" : "text-negative",
      action: `${isBuy ? "Buy" : "Sell"} ${config.name}${priceStr}`,
    }];
  });

  // Synthetic entry row: the simulation opens a position on the first window day
  // (risk-on → the ETF, risk-off → the risk-off basket carried in from warm-up).
  // Fall back to inferring the start regime from the first in-window signal.
  const firstSignal = etf.smaSignals[0];
  const startInvested =
    etf.smaStartInvested ?? (firstSignal ? firstSignal.type === "sell" : true);
  const firstDay = etfDates[0];
  const entryEtfPrice = tradeClosePrices[0] ?? closePrices[0];
  const displayEntryPrice = toDisplayPrice(entryEtfPrice, firstDay);
  const entryPriceStr = displayEntryPrice ? ` (${formatSignedNumber(displayEntryPrice, "$")})` : "";
  const entryTriggerCloseRaw = closePrices[0];
  const entryTriggerSma = etf.smaPrices[0];
  const initialRow: SmaTradeRow = {
    signalDate: firstDay,
    tradingDay: firstDay,
    signalType: startInvested ? "buy" : "sell",
    // Risk-off starts still carry the ETF's start price so the
    // "Risk-Off / If Risk-On" comparison has its hypothetical baseline.
    eventPrice: displayEntryPrice,
    triggerClose:
      entryTriggerCloseRaw != null && Number.isFinite(entryTriggerCloseRaw)
        ? entryTriggerCloseRaw / syntheticPriceScale
        : null,
    triggerSmaPctDiff:
      entryTriggerCloseRaw != null && entryTriggerSma != null &&
      Number.isFinite(entryTriggerCloseRaw) && Number.isFinite(entryTriggerSma) && entryTriggerSma !== 0
        ? ((entryTriggerCloseRaw / syntheticPriceScale - entryTriggerSma) / entryTriggerSma) * 100
        : null,
    actionToneClass: startInvested ? "text-positive" : "text-negative",
    action: startInvested
      ? `Buy ${config.name}${entryPriceStr}`
      : `Buy ${formatRiskOffLiquidationAbbrev(config.riskOffAsset)}`,
    isInitialEntry: true,
  };

  const rows = [initialRow, ...baseRows];

  const lastDay = etfDates[lastIdx] ?? "";
  const closeAtLast = tradeClosePrices[lastIdx] ?? closePrices[lastIdx];
  const openAtLast = tradeOpenPrices[lastIdx] ?? openPrices[lastIdx];
  const etfPriceAtLiquidation =
    executionMode === "next-day-open" ? openAtLast ?? closeAtLast : closeAtLast;
  const displayLiquidationPrice = toDisplayPrice(etfPriceAtLiquidation, lastDay);

  const sortedByExecution = [...rows].sort((a, b) => {
    const da = a.tradingDay ?? a.signalDate;
    const db = b.tradingDay ?? b.signalDate;
    return da.localeCompare(db);
  });
  const lastExecuted = sortedByExecution[sortedByExecution.length - 1];
  const endsRiskOn = lastExecuted?.signalType === "buy";

  const liqPriceStr = displayLiquidationPrice
    ? ` (${formatSignedNumber(displayLiquidationPrice, "$")})`
    : "";
  const liquidationLabel = endsRiskOn
    ? `LIQUIDATE ${config.name}${liqPriceStr}`
    : `LIQUIDATE ${formatRiskOffLiquidationAbbrev(config.riskOffAsset)}`;

  const terminalRow: SmaTradeRow = {
    signalDate: lastDay,
    tradingDay: lastDay,
    signalType: "sell",
    eventPrice: displayLiquidationPrice,
    triggerClose: null,
    triggerSmaPctDiff: null,
    actionToneClass: "text-negative",
    action: liquidationLabel,
    isEndLiquidation: true,
  };

  return [...rows, terminalRow];
}

export function formatSignedNumber(value: number, prefix = "", suffix = ""): string {
  const sign = value >= 0 ? "+" : "-";
  const abs = Math.abs(value);

  let formatted: string;
  if (abs >= 1) {
    formatted = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } else if (abs >= 0.01) {
    formatted = abs.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 4 });
  } else {
    formatted = abs.toLocaleString(undefined, { minimumSignificantDigits: 3, maximumSignificantDigits: 4 });
  }

  if (prefix === "$") {
    return `${prefix}${sign === "-" ? "-" : ""}${formatted}${suffix}`;
  }
  return `${sign}${formatted}${suffix}`;
}
