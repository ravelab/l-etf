"use client";

import { Card } from "@/components/ui/Card";
import type { RunSummary } from "@/lib/run-summary";

function formatRiskOffAsset(asset: string): string {
  const parts = asset.split("+").filter(Boolean);
  if (parts.length <= 1) return asset;
  const initials = parts.map((p) => {
    const upper = p.toUpperCase();
    if (upper.startsWith("BRK")) return "B";
    if (upper.startsWith("GLD")) return "G";
    if (upper.startsWith("VGS")) return "V";
    return upper[0] ?? "";
  });
  const compact = initials.filter(Boolean).join("+");
  return compact.length > 0 ? compact : asset;
}

type DisplayFlags = {
  label?: string;
  showLetf?: boolean;
  showWindow?: boolean;
  showRiskOffAsset?: boolean;
  showSmaSpPeriod?: boolean;
  showSmaSpBuffer?: boolean;
  showSmaNqPeriod?: boolean;
  showSmaNqBuffer?: boolean;
};

export function SimulationRunSummary({
  summary,
  label = "Run Summary",
  showLetf = true,
  showWindow = true,
  showRiskOffAsset = true,
  showSmaSpPeriod,
  showSmaSpBuffer,
  showSmaNqPeriod,
  showSmaNqBuffer,
}: { summary: RunSummary } & DisplayFlags) {
  const showPeriodSp = showSmaSpPeriod ?? true;
  const showBufferSp = showSmaSpBuffer ?? true;
  const showPeriodNq = showSmaNqPeriod ?? true;
  const showBufferNq = showSmaNqBuffer ?? true;

  return (
    <Card className="p-4" data-testid="simulation-run-summary">
      <div className="grid grid-cols-3 gap-x-2 gap-y-1.5 text-[0.792rem] md:flex md:flex-wrap md:items-center md:gap-4">
        <span className="font-semibold min-w-0">{label}</span>
        <span className="text-muted min-w-0">
          Start: <span className="text-foreground">{summary.startDate}</span>
        </span>
        <span className="text-muted min-w-0">
          End: <span className="text-foreground">{summary.endDate}</span>
        </span>
        {showLetf && (
          <span className="text-muted min-w-0">
            LETF: <span className="text-foreground">{summary.letf}</span>
          </span>
        )}
        {showWindow && (
          <span className="text-muted min-w-0">
            Window: <span className="text-foreground">{summary.windowLength}y</span>
          </span>
        )}
        {showPeriodSp && (
          <span className="text-muted min-w-0">
            SPX Period: <span className="text-foreground">{summary.smaSpPeriod}d</span>
          </span>
        )}
        {showBufferSp && (
          <span className="text-muted min-w-0">
            SPX Buffer: <span className="text-foreground">{summary.smaSpBuffer}%</span>
          </span>
        )}
        {showPeriodNq && (
          <span className="text-muted min-w-0">
            NDX Period: <span className="text-foreground">{summary.smaNqPeriod}d</span>
          </span>
        )}
        {showBufferNq && (
          <span className="text-muted min-w-0">
            NDX Buffer: <span className="text-foreground">{summary.smaNqBuffer}%</span>
          </span>
        )}
        {showRiskOffAsset && (
          <span className="text-muted min-w-0">
            Risk-Off: <span className="text-foreground">{formatRiskOffAsset(summary.riskOffAsset)}</span>
          </span>
        )}
        {typeof summary.amount === "number" && Number.isFinite(summary.amount) && (
          <span className="text-muted min-w-0">
            Amount: <span className="text-foreground">${Math.round(summary.amount).toLocaleString()}</span>
          </span>
        )}
        {summary.leverageTolerance && (
          <span className="text-muted min-w-0">
            Leverage Tolerance: <span className="text-foreground">{summary.leverageTolerance}</span>
          </span>
        )}
      </div>
    </Card>
  );
}
