import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui/Card";
import {
  fetchSpxBoxtradesApyReport,
  type BoxtradesApyReport,
} from "@/lib/boxtrades";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

const BOX_TRADES_ENABLED = process.env.NEXT_PUBLIC_DISPLAY_BOX_TRADES === "true";

export const metadata: Metadata = pageMetadata({
  title: "SPX Box Spread Financing Rates (APY)",
  description:
    "Current long-dated SPX box spread financing rates from Boxtrades.com, converted to APY — a reference for comparing box-spread borrowing to margin loans.",
  path: "/box-trades",
});

function formatPercent(value: number | null): string {
  if (value === null) return "N/A";
  return `${value.toFixed(2)}%`;
}

function formatBps(value: number | null): string {
  if (value === null) return "N/A";
  return `+${value.toFixed(1)} bps`;
}

function formatAsOf(report: BoxtradesApyReport): string {
  if (report.asOf === null) return "current Boxtrades page data";
  return `Boxtrades data as of ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${report.asOf}T00:00:00.000Z`))}`;
}

async function getBoxtradesReport(): Promise<BoxtradesApyReport | null> {
  try {
    return await fetchSpxBoxtradesApyReport(365);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load Boxtrades rates";
    console.error("Box Trades page error:", message);
    return null;
  }
}

function BoxtradesRatesSection({
  report,
}: {
  report: BoxtradesApyReport | null;
}) {
  const sizeModel = report?.sizeModel ?? null;

  return (
    <Card id="current-boxtrades-rates" className="p-4 md:p-6 scroll-mt-24">
      {report === null ? (
        <p className="text-muted text-sm">
          Boxtrades rates are temporarily unavailable. Try the API directly at{" "}
          <code className="text-foreground">/api/boxtrades/spx-apy</code>.
        </p>
      ) : (
        <div className="text-muted text-sm">
          <p className="mb-6">
            This page has nothing to do with leveraged ETF strategies. It is
            just useful info.
          </p>
          <p className="mb-4">
            A short SPX box spread lets you borrow cash through options: receive
            cash today, repay a fixed amount at expiration. This page shows
            Boxtrades.com rates for SPX boxes expiring in more than 1 year,
            converted to APY.
          </p>
          <p className="mb-4">
            <a
              href="https://thefinancebuff.com/short-box-spread-vs-margin-loan-fidelity.html"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              The Finance Buff
            </a>{" "}
            explains the margin-loan comparison, Fidelity mechanics, and risks.
          </p>
          <p className="mb-4">
            Smaller trades may fill at worse rates. Size-adjusted estimates use
            recent SPX trades; current penalty is{" "}
            <strong className="text-foreground">
              {formatBps(sizeModel?.yieldPenaltyBpsPer10xSmallerNotional ?? null)}
            </strong>{" "}
            for each 10x smaller total trade size, using{" "}
            <strong className="text-foreground">
              {sizeModel?.observations.toLocaleString() ?? "N/A"}
            </strong>{" "}
            observations. $50K and $200K mean cash received today, and include
            estimated Fidelity four-leg SPX cost of{" "}
            <strong className="text-foreground">
              ${sizeModel?.fidelityFourLegCost.estimatedCost.toFixed(2) ?? "N/A"}
            </strong>
            .
          </p>
          <div className="overflow-x-auto rounded border border-card-border">
            <table className="w-full min-w-[640px] table-fixed">
              <thead className="bg-background text-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">SPX expiry</th>
                  <th className="px-3 py-2 text-right font-semibold whitespace-normal leading-tight">
                    Loan length
                  </th>
                  <th className="px-3 py-2 text-right font-semibold whitespace-normal leading-tight">
                    APY
                  </th>
                  <th className="px-3 py-2 text-right font-semibold whitespace-normal leading-tight">
                    Est. APY @ $50K
                  </th>
                  <th className="px-3 py-2 text-right font-semibold whitespace-normal leading-tight">
                    Est. APY @ $200K
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">
                    Days to expiry
                  </th>
                  <th className="px-3 py-2 text-right font-semibold whitespace-normal leading-tight">
                    Boxtrades yield
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-card-border">
                {report.contracts.map((contract) => (
                  <tr key={contract.expFormat}>
                    <td className="px-3 py-2 text-foreground whitespace-nowrap">
                      {contract.expiry}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-foreground">
                      {`${(contract.daysToExpiry / 365).toFixed(1)}y`}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-foreground">
                      {formatPercent(contract.apyPercent)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatPercent(
                        contract.fidelityAndSpreadAdjustedApyPercent["50000"] ?? null,
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatPercent(
                        contract.fidelityAndSpreadAdjustedApyPercent["200000"] ?? null,
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {contract.daysToExpiry}d
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatPercent(contract.boxtradesYieldPercent)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3">
            {formatAsOf(report)}.
          </p>
        </div>
      )}
    </Card>
  );
}

export default async function BoxTradesPage() {
  if (!BOX_TRADES_ENABLED) notFound();

  const boxtradesReport = await getBoxtradesReport();

  return (
    <div className="min-h-screen bg-background text-foreground p-3 md:p-6">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl md:text-4xl font-bold mb-8">
          Current{" "}
          <a
            href="https://www.boxtrades.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            BoxTrades.com
          </a>{" "}
          Rates
        </h1>

        <div className="space-y-4 md:space-y-6">
          <BoxtradesRatesSection report={boxtradesReport} />
        </div>
      </div>
    </div>
  );
}
