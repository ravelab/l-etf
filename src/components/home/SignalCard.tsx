import type { SmaSignalResult } from "@/lib/sma-signals";
import { SMA_VOL_GATE } from "@/lib/simulation/vol-gate";
import { SMA_RSI_BRAKE } from "@/lib/simulation/rsi-brake";
import type { IndexKey } from "@/lib/simulation/types";

interface SignalCardProps {
  indexName: string;
  indexKey: IndexKey;
  smaPeriod: number;
  result?: SmaSignalResult | null;
  loading?: boolean;
}

function formatVolatility(volatility: number, threshold: number) {
  if (!Number.isFinite(volatility)) return "n/a";

  const percent = volatility * 100;
  const thresholdPercent = threshold * 100;
  const rounded = percent.toFixed(1);
  if (volatility === threshold || Number(rounded) !== thresholdPercent) return `${rounded}%`;

  const precise = percent.toFixed(2);
  if (Number(precise) !== thresholdPercent) return `${precise}%`;

  return `Just ${volatility < threshold ? "below" : "above"} ${thresholdPercent}%`;
}

function SignalIcon({ signal }: { signal?: SmaSignalResult["signal"] }) {
  if (signal === "buy") {
    return (
      <svg className="w-6 h-6 text-positive" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2L4 12h5v10h6V12h5L12 2z"/>
      </svg>
    );
  }
  if (signal === "sell") {
    return (
      <svg className="w-6 h-6 text-negative" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 22L4 12h5V2h6v10h5L12 22z"/>
      </svg>
    );
  }
  return (
    <svg className="w-6 h-6 text-muted" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="10"/>
    </svg>
  );
}

export function SignalCard({ indexName, indexKey, smaPeriod, result, loading = false }: SignalCardProps) {
  const gate = SMA_VOL_GATE[indexKey];
  const brake = SMA_RSI_BRAKE[indexKey];
  const placeholderSignal = "No Action";
  const placeholderPercent = "00.00% below SMA";
  const placeholderDate = "Sep 30, 2026";

  const formatDate = (dateStr: string) => {
    if (!dateStr) return "";
    const [year, month, day] = dateStr.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const getSignalColor = () => {
    if (!result) return "text-muted";
    if (result.signal === "buy") return "text-positive";
    if (result.signal === "sell") return "text-negative";
    return "text-muted";
  };

  const getSignalLabel = () => {
    if (!result) return "";
    if (result.signal === "hold" && (result.signalLabel === "Buy L-ETFs" || result.signalLabel === "Sell L-ETFs")) return "Hold";
    if (result.signalLabel === "Buy") return "Buy L-ETFs";
    if (result.signalLabel === "Sell") return "Sell L-ETFs";
    return result.signalLabel;
  };

  const getPercentColor = () => {
    if (!result) return "text-muted";
    if (result.percentDiff > 0) return "text-positive";
    if (result.percentDiff < 0) return "text-negative";
    return "text-muted";
  };

  // Inflation adjusted: the band compares the CPI-deflated index with its own SMA,
  // so the line and the gap are real, not the quoted index's.
  const smaName = result?.inflationAdjusted ? "real SMA" : "SMA";
  const getPercentLabel = () => {
    if (!result) return "";
    if (result.percentDiff > 0) return `${result.percentDiff.toFixed(2)}% above ${smaName}`;
    if (result.percentDiff < 0) return `${Math.abs(result.percentDiff).toFixed(2)}% below ${smaName}`;
    return `At ${smaName}`;
  };

  return (
    <div className="border border-card-border rounded-lg p-6 hover:border-accent/50 transition bg-card-bg/50">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-base font-bold leading-tight min-w-0">{indexName}</h3>
          <div className="text-sm font-semibold text-foreground/90 leading-tight tabular-nums text-right">
            {result ? result.indexValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : <span className="invisible">00000.00</span>}
          </div>
        </div>

        <div className={`flex items-center gap-1 text-sm font-semibold tabular-nums ${getSignalColor()}`}>
          <SignalIcon signal={result?.signal} />
          <span>
            {result ? getSignalLabel() : loading ? <span className="invisible">{placeholderSignal}</span> : <span className="invisible">{placeholderSignal}</span>}
          </span>
          <span className="ml-auto tabular-nums text-sm leading-tight font-medium text-muted">
            <span
              className="mr-2"
              title={result?.inflationAdjusted ? "SMA of the index divided by CPI, shown in today's dollars" : undefined}
            >
              {smaPeriod}d {result?.inflationAdjusted ? "Real SMA" : "SMA"}
            </span>
            <span className="text-foreground/80 font-semibold">
              {result ? result.smaValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : <span className="invisible">00000.00</span>}
            </span>
          </span>
        </div>

        <div className="flex items-center justify-between gap-4 text-sm">
          <span className="text-muted">
            {result ? formatDate(result.indexDate) : <span className="invisible">{placeholderDate}</span>}
          </span>
          <span className={`font-medium tabular-nums ${getPercentColor()}`}>
            {result ? getPercentLabel() : <span className="invisible">{placeholderPercent}</span>}
          </span>
        </div>

        {result?.volatility !== undefined && (
          <div data-testid="vol-gate-status" className="flex items-center justify-between gap-4 text-sm">
            <span className="text-muted">{gate.windowDays}d volatility</span>
            <span className={`font-medium tabular-nums ${result.volGateRiskOff ? "text-negative" : "text-muted"}`}>
              {formatVolatility(result.volatility, result.volGateRiskOff ? gate.reenterBelow : gate.exitAbove)}
              {result.volGateRiskOff
                ? ` · re-enter < ${Math.round(gate.reenterBelow * 100)}%`
                : ` · exit > ${Math.round(gate.exitAbove * 100)}%`}
            </span>
          </div>
        )}

        {result?.rsi !== undefined && (
          <div data-testid="rsi-brake-status" className="flex items-center justify-between gap-4 text-sm">
            <span className="text-muted">{brake.periodDays}d RSI</span>
            <span className={`font-medium tabular-nums ${result.rsiBrakeRiskOff ? "text-negative" : "text-muted"}`}>
              {Number.isFinite(result.rsi) ? result.rsi.toFixed(1) : "n/a"}
              {result.rsiBrakeRiskOff ? ` · re-enter > ${brake.reenterAbove}` : ` · exit < ${brake.exitBelow}`}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
