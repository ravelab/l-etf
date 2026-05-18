import type { SmaSignalResult } from "@/lib/sma-signals";

interface SignalCardProps {
  indexName: string;
  smaPeriod: number;
  result?: SmaSignalResult | null;
  loading?: boolean;
}

function SignalIcon({ signal, signalLabel }: { signal?: SmaSignalResult["signal"]; signalLabel?: string }) {
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
  // No data yet: grey. Hold: color based on last buffer crossing.
  const holdColor = signal === undefined
    ? "text-muted"
    : signalLabel === "Sell L-ETFs" ? "text-negative" : "text-positive";
  return (
    <svg className={`w-6 h-6 ${holdColor}`} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="10"/>
    </svg>
  );
}

export function SignalCard({ indexName, smaPeriod, result, loading = false }: SignalCardProps) {
  const placeholderSignal = "No Action";
  const placeholderPercent = "-00.00%";
  const placeholderDate = "Sep 30, 2026";

  const formatPercent = (num: number) => {
    const sign = num >= 0 ? "+" : "";
    return `${sign}${num.toFixed(2)}%`;
  };

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
    // Hold: color based on label (determined by last buffer crossing)
    if (result.signalLabel === "Sell L-ETFs") return "text-negative";
    return "text-positive";
  };

  const getSignalLabel = () => {
    if (!result) return "";
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

  const getPercentLabel = () => {
    if (!result) return "";
    if (result.percentDiff > 0) return formatPercent(result.percentDiff);
    if (result.percentDiff < 0) return `${Math.abs(result.percentDiff).toFixed(2)}% below SMA`;
    return "At SMA";
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
          <SignalIcon signal={result?.signal} signalLabel={result?.signalLabel} />
          <span>
            {result ? getSignalLabel() : loading ? <span className="invisible">{placeholderSignal}</span> : <span className="invisible">{placeholderSignal}</span>}
          </span>
          <span className="ml-auto tabular-nums text-sm leading-tight font-medium text-muted">
            <span className="mr-2">{smaPeriod} SMA</span>
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
      </div>
    </div>
  );
}
