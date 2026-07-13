"use client";

import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { buildToolsUrl } from "@/lib/tools-route";

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-6xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="text-center space-y-4 mb-12">
          <h1 className="text-5xl font-bold">L-ETF</h1>
          <p className="text-xl text-muted">
            Track live SMA signals, backtest leveraged ETF and futures strategies, and compare
            results after inflation
          </p>
        </div>

        <div>
          <h2 className="text-2xl font-bold mb-4">Explore</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Link href="/signals">
              <div className="border border-card-border rounded-lg p-6 hover:border-accent transition h-full flex flex-col">
                <h2 className="text-2xl font-bold mb-2">Signals</h2>
                <p className="text-muted mb-4 flex-1">
                  Check the current SPX and NDX SMA signals and enable Home Screen alerts
                </p>
                <Button className="w-full">Explore</Button>
              </div>
            </Link>

            <Link href={buildToolsUrl("strategies")}>
              <div className="border border-card-border rounded-lg p-6 hover:border-accent transition h-full flex flex-col">
                <h2 className="text-2xl font-bold mb-2">Strategies</h2>
                <p className="text-muted mb-4 flex-1">
                  Compare leveraged ETF strategies across rolling historical windows
                </p>
                <Button className="w-full">Explore</Button>
              </div>
            </Link>

            <Link href={buildToolsUrl("backtest")}>
              <div className="border border-card-border rounded-lg p-6 hover:border-accent transition h-full flex flex-col">
                <h2 className="text-2xl font-bold mb-2">Backtest</h2>
                <p className="text-muted mb-4 flex-1">
                  Run a historical backtest with charts, trades, drawdowns, and real returns
                </p>
                <Button className="w-full">Explore</Button>
              </div>
            </Link>

            <Link href={buildToolsUrl("futures")}>
              <div className="border border-card-border rounded-lg p-6 hover:border-accent transition h-full flex flex-col">
                <h2 className="text-2xl font-bold mb-2">Futures</h2>
                <p className="text-muted mb-4 flex-1">
                  Simulate futures SMA execution with margin scenarios, fees, spreads, and
                  transaction-level details
                </p>
                <Button className="w-full">Explore</Button>
              </div>
            </Link>

            <Link href={buildToolsUrl("statistics")}>
              <div className="border border-card-border rounded-lg p-6 hover:border-accent transition h-full flex flex-col">
                <h2 className="text-2xl font-bold mb-2">Holding Period</h2>
                <p className="text-muted mb-4 flex-1">
                  See how win rates and returns change as the holding period changes
                </p>
                <Button className="w-full">Explore</Button>
              </div>
            </Link>

            <Link href={buildToolsUrl("sma-buffer")}>
              <div className="border border-card-border rounded-lg p-6 hover:border-accent transition h-full flex flex-col">
                <h2 className="text-2xl font-bold mb-2">SMA Buffer</h2>
                <p className="text-muted mb-4 flex-1">
                  Test SMA buffer levels and compare returns, drawdowns, and trade frequency
                </p>
                <Button className="w-full">Explore</Button>
              </div>
            </Link>

            <Link href={buildToolsUrl("sma-period")}>
              <div className="border border-card-border rounded-lg p-6 hover:border-accent transition h-full flex flex-col">
                <h2 className="text-2xl font-bold mb-2">SMA Period</h2>
                <p className="text-muted mb-4 flex-1">
                  Test SMA lengths and compare faster versus slower trend rules
                </p>
                <Button className="w-full">Explore</Button>
              </div>
            </Link>

            <Link href={buildToolsUrl("riskoff")}>
              <div className="border border-card-border rounded-lg p-6 hover:border-accent transition h-full flex flex-col">
                <h2 className="text-2xl font-bold mb-2">SMA Risk-Off Assets</h2>
                <p className="text-muted mb-4 flex-1">
                  Compare defensive assets and equal-weight mixes for SMA strategies
                </p>
                <Button className="w-full">Explore</Button>
              </div>
            </Link>

            {process.env.NEXT_PUBLIC_DISPLAY_BOX_TRADES === "true" && (
              <Link href="/box-trades">
                <div className="border border-card-border rounded-lg p-6 hover:border-accent transition h-full flex flex-col">
                  <h2 className="text-2xl font-bold mb-2">Box Trades</h2>
                  <p className="text-muted mb-4 flex-1">
                    See current long-dated SPX box spread financing rates, converted to APY
                  </p>
                  <Button className="w-full">Explore</Button>
                </div>
              </Link>
            )}

            <Link href="/faq">
              <div className="border border-card-border rounded-lg p-6 hover:border-accent transition h-full flex flex-col">
                <h2 className="text-2xl font-bold mb-2">FAQ</h2>
                <p className="text-muted mb-4 flex-1">
                  Review the strategy thesis, assumptions, methodology, and data notes
                </p>
                <Button className="w-full">Explore</Button>
              </div>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
