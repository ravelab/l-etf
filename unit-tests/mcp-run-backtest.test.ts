import test from "node:test";
import assert from "node:assert/strict";
import { runBacktestCore } from "@/lib/mcp/tools/run-backtest";
import { resolveBacktest } from "@/lib/mcp/backtest-config";
import { formatBacktest } from "@/lib/mcp/format";
import { loadBorrowRates, loadIndexPrices } from "@/lib/mcp/server-data";
import { getMarketDataWarmUpStartDate } from "@/lib/fetch-market-data";
import { simulateWithWarmUp } from "@/lib/simulation/engine";

const START = "2015-01-02";
const END = "2016-01-04";

test("run_backtest core produces sane metrics for a no-SMA UPRO backtest", async () => {
  const out = await runBacktestCore({ preset: "UPRO", startDate: START, endDate: END, smaEnabled: false });
  assert.ok(out.finalMultiple > 0, "final multiple positive");
  assert.ok(Number.isFinite(out.cagrPct), "cagr finite");
  assert.ok(out.benchmark.finalMultiple > 0, "benchmark present");
  assert.equal(out.numTrades, 0, "no trades without SMA");
  assert.equal(out.trades.length, 0);
  assert.equal(out.index, "sp500");
});

test("formatted metrics faithfully mirror the engine's EtfResult", async () => {
  // Re-derive the engine result independently and confirm the tool's formatter
  // copies the headline fields verbatim (pins the field mapping).
  const { config, index, startDate, endDate, warmUpDays } = resolveBacktest({
    preset: "UPRO",
    startDate: START,
    endDate: END,
  });
  const warmUpStart = getMarketDataWarmUpStartDate(startDate, warmUpDays);
  const [prices, rates] = await Promise.all([
    loadIndexPrices(index, warmUpStart, endDate),
    loadBorrowRates(warmUpStart, endDate),
  ]);
  const result = simulateWithWarmUp(prices, rates, [config], startDate, warmUpDays, { endDate });
  const etf = result.etfResults[0];
  const expected = formatBacktest(result, etf);

  const out = await runBacktestCore({ preset: "UPRO", startDate: START, endDate: END });
  assert.equal(out.cagrPct, expected.cagrPct);
  assert.equal(out.finalMultiple, expected.finalMultiple);
  assert.equal(out.maxDrawdownPct, expected.maxDrawdownPct);
  assert.equal(out.sharpeRatio, expected.sharpeRatio);
});

test("SMA-enabled backtest engages the timing rule through the GFC", async () => {
  // A 3x buy-and-hold is nearly wiped out over 2007-2010; the SMA strategy must
  // exit and end well above the no-SMA baseline, proving the timing + risk-off
  // path is wired (not the expanded no-SMA baseline result).
  const out = await runBacktestCore({
    preset: "UPRO",
    startDate: "2007-01-03",
    endDate: "2010-01-04",
    smaEnabled: true,
  });
  assert.ok(out.numTrades > 0, "SMA should trade through the GFC");
  assert.equal(out.numTrades, out.trades.length);
  assert.equal(typeof out.smaStartInvested, "boolean");
  assert.ok(out.noSmaComparison, "no-SMA baseline attached");
  assert.ok(
    out.finalMultiple > (out.noSmaComparison?.finalMultiple ?? Infinity),
    "SMA beats buy-and-hold through the crash",
  );
  for (const trade of out.trades) {
    assert.ok(trade.type === "buy" || trade.type === "sell");
    assert.ok(trade.date >= "2007-01-03" && trade.date <= "2010-01-04");
  }
});
