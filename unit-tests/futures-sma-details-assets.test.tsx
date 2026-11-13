// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { FuturesSmaDetails } from "@/components/tools/futures/FuturesSmaDetails";
import type { FuturesStrategyResult, FuturesTransactionRow } from "@/lib/simulation/futures";
import type { EtfResult } from "@/lib/simulation/types";

const dates = ["1988-06-01", "1988-06-02", "1988-06-03"];
const etfResult: EtfResult = {
  id: "fund", name: "fund", dates, dailyValues: [100_000, 101_000, 102_000], finalValue: 102_000, cagr: 0,
  maxDrawdownPct: 0, maxDrawdownDollar: 0, longestDrawdownDays: 0, sourceIndex: "sp500",
  sortinoRatio: 0, bestMonth: 0, worstMonth: 0, totalTradingCostPct: 0, smaSignals: [], smaPrices: [],
};

function tx(row: Partial<FuturesTransactionRow> & Pick<FuturesTransactionRow, "date" | "symbol" | "action" | "instrument">): FuturesTransactionRow {
  return {
    qtyDelta: 1, qtyAfter: 1, fillPrice: 100, fees: 1, spread: 1, cashInterestEarned: 0,
    excessLiquidity: 50_000, leverageDeltaPct: 0, equity: 100_000, ...row,
  };
}

function strategy(transactions: FuturesTransactionRow[]): FuturesStrategyResult {
  return {
    etfResult, targetLeverage: 3, index: "sp500", transactions, initialEquity: 100_000,
    avgActualLeverageRiskOn: 3, maxAbsLeverageDeltaRiskOnPct: 0, riskOffSessionDayCount: 0, sessionDayCount: 3,
  };
}

function cell(rowIndex: number, header: string): HTMLElement {
  const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
  return within(screen.getAllByRole("row")[rowIndex + 1]).getAllByRole("cell")[headers.indexOf(header)];
}
const assetsCell = (rowIndex: number) => cell(rowIndex, "Assets");

describe("futures ledger Assets column", () => {
  it("replaces Interest Earned and lists every holding's dollar value, and what each row traded", () => {
    render(
      <FuturesSmaDetails
        annualizedInflation={0}
        monthlyCpi={[]}
        strategy={strategy([
          // ES is $50 a point and NQ $20, so these fills are exactly the stamped notional.
          tx({ date: dates[0], action: "buy", instrument: "futures", symbol: "ESM88", qtyDelta: 12, qtyAfter: 12,
            fillPrice: 2_600.67, holdingsAfter: { ESM88: 1_560_400 } }),
          tx({ date: dates[0], action: "buy", instrument: "futures", symbol: "NQM88", qtyDelta: 3, qtyAfter: 3,
            fillPrice: 183, holdingsAfter: { ESM88: 1_560_400, NQM88: 10_980, VGSH: 50_120 } }),
          // Same-day basket legs merge into one B+G row; its cell shows the basket after both.
          tx({ date: dates[1], action: "sell", instrument: "futures", symbol: "ESM88", qtyDelta: -12, qtyAfter: 0,
            fillPrice: 2_600.67, holdingsAfter: { NQM88: 10_980, VGSH: 50_120 } }),
          tx({ date: dates[1], action: "buy", instrument: "riskoff", symbol: "BRK.B", qtyDelta: 7, qtyAfter: 7,
            fillPrice: 3_572.86, holdingsAfter: { NQM88: 10_980, VGSH: 50_120, "BRK.B": 25_010 } }),
          tx({ date: dates[1], action: "buy", instrument: "riskoff", symbol: "GLDM", qtyDelta: 3410, qtyAfter: 3410,
            fillPrice: 7.328, holdingsAfter: { NQM88: 10_980, VGSH: 50_120, "BRK.B": 25_010, GLDM: 24_990 } }),
          tx({ date: dates[2], action: "sell", instrument: "riskoff", symbol: "VGSH (COLLATERAL)", qtyDelta: -500,
            fillPrice: 20, holdingsAfter: { NQM88: 10_980, VGSH: 40_120, "BRK.B": 25_010, GLDM: 24_990 } }),
          // The close-out sells several tickers in one row, so it carries per-ticker legs.
          tx({ date: dates[2], action: "sell", instrument: "riskoff", symbol: "B+G (LIQUIDATE)", qtyDelta: 0,
            fillPrice: 0, isEndLiquidation: true, legValues: { "BRK.B": -25_010, GLDM: -24_990 },
            holdingsAfter: { NQM88: 10_980, VGSH: 40_120 } }),
        ])}
      />
    );
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toContain("Assets");
    expect(headers).not.toContain("Interest Earned");

    expect(assetsCell(0)).toHaveTextContent(/^ESM88 \$1\.56M \(\+\$1\.56M\)$/);
    const both = assetsCell(1);
    expect(both.firstElementChild?.children).toHaveLength(2);
    expect(both).toHaveTextContent("ESM88 $1.56M · NQM88 $11K (+$11K)");
    expect(both).toHaveTextContent("V $50.1K");
    // A closed listing stays on its row with the sale and no value left.
    expect(assetsCell(2)).toHaveTextContent(/^ESM88 \(−\$1\.56M\) · NQM88 \$11KV \$50\.1K$/);
    expect(assetsCell(3)).toHaveTextContent("NQM88 $11K");
    expect(assetsCell(3)).toHaveTextContent("B $25K (+$25K) · G $25K (+$25K) · V $50.1K");
    expect(assetsCell(4)).toHaveTextContent("B $25K · G $25K · V $40.1K (−$10K)");
    expect(assetsCell(5)).toHaveTextContent("B (−$25K) · G (−$25K) · V $40.1K");
  });

  it("reads large numbers with K/M/B so late rows fit, and collateral rows by ticker", () => {
    render(
      <FuturesSmaDetails
        annualizedInflation={0}
        monthlyCpi={[]}
        strategy={strategy([
          tx({ date: dates[0], action: "buy", instrument: "futures", symbol: "ESM88", qtyDelta: 48, qtyAfter: 48,
            fillPrice: 182.37, equity: 100_637, excessLiquidity: 74_129 }),
          tx({ date: dates[1], action: "sell", instrument: "riskoff", symbol: "VGSH (COLLATERAL)", qtyDelta: -17_625_263,
            fillPrice: 7_660.28, fees: 134_032, spread: 1_245_142, equity: 23_285_805_216,
            excessLiquidity: 9_750_000_000 }),
        ])}
      />
    );
    expect(cell(0, "Qty Δ")).toHaveTextContent(/^\+48$/);
    expect(cell(0, "Fill")).toHaveTextContent(/^182\.37$/);
    expect(cell(0, "Excess Liquidity")).toHaveTextContent(/^\$74\.1K$/);
    expect(cell(0, "Value")).toHaveTextContent(/^\$101K$/);
    expect(cell(0, "Real Value")).toHaveTextContent(/^1\.01x$/);

    expect(cell(1, "Symbol")).toHaveTextContent(/^VGSH$/);
    expect(cell(1, "Qty Δ")).toHaveTextContent(/^-17\.6M$/);
    expect(cell(1, "Fill")).toHaveTextContent(/^7\.66K$/);
    expect(cell(1, "Fees")).toHaveTextContent(/^\$134K$/);
    expect(cell(1, "Spread")).toHaveTextContent(/^\$1\.25M$/);
    expect(cell(1, "Value")).toHaveTextContent(/^\$23\.3B$/);
    expect(cell(1, "Real Value")).toHaveTextContent(/^233Kx$/);
  });

  it("shows a dash for ledgers built before rows carried holdings", () => {
    render(
      <FuturesSmaDetails
        annualizedInflation={0}
        monthlyCpi={[]}
        strategy={strategy([tx({ date: dates[0], action: "buy", instrument: "futures", symbol: "ESM88" })])}
      />
    );
    expect(assetsCell(0)).toHaveTextContent("—");
  });
});

describe("futures ledger Front/Deferred columns", () => {
  it("shows a micro leg as a tenth of a full contract instead of rounding it away", () => {
    render(
      <FuturesSmaDetails
        annualizedInflation={0}
        monthlyCpi={[]}
        strategy={{
          ...strategy([
            tx({ date: dates[0], action: "buy", instrument: "futures", symbol: "NQM88", qtyDelta: 4, qtyAfter: 4, fillPrice: 183 }),
            tx({ date: dates[0], action: "buy", instrument: "futures", symbol: "MNQM88", qtyDelta: 8, qtyAfter: 4.8, fillPrice: 183 }),
          ]),
          index: "nasdaq100",
        }}
      />,
    );
    expect(cell(0, "Front").textContent).toBe("4");
    expect(cell(1, "Front").textContent).toBe("4.8");
    expect(cell(1, "Qty Δ").textContent).toBe("+8");
  });
});
