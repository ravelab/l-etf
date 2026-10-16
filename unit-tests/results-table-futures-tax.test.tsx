// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ResultsTable } from "@/components/tools/backtest/ResultsTable";
import { DEFAULT_FUTURES_TAX_RATES } from "@/lib/simulation/futures-tax";
import type { BacktestResult, EtfResult } from "@/lib/simulation/types";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

const dates = ["2020-01-01", "2020-12-31", "2021-12-31"];
function row(id: string, values: number[], cagr: number): EtfResult {
  return {
    id, name: id, dates, dailyValues: values, finalValue: values[2], cagr,
    maxDrawdownPct: 0, maxDrawdownDollar: 0, longestDrawdownDays: 0,
    sourceIndex: "sp500", sharpeRatio: 0, bestMonth: 0, worstMonth: 0, totalTradingCostPct: 0,
    smaSignals: [], smaPrices: [],
  };
}
const result: BacktestResult = {
  dates, investedValues: [100, 100, 100], nonLeveragedValues: [100, 110, 121],
  etfResults: [
    row("a-futures-sma", [100, 120, 144], 20),
    row("b-futures-sma", [100, 110, 121], 10),
    row("upro-sma", [100, 110, 121], 10),
  ],
};

describe("futures after-tax table", () => {
  it("places the column after Real CAGR, updates with rates, and sorts numeric results with emulations last", () => {
    const props = { result, indexLabel: "VOO", annualizedInflation: 0, variant: "futures" as const };
    const { rerender } = render(<ResultsTable {...props} futuresTaxRates={DEFAULT_FUTURES_TAX_RATES} />);
    const headers = screen.getAllByRole("columnheader");
    expect(headers[3]).toHaveTextContent("Real CAGR");
    expect(headers[4]).toHaveTextContent("After-Tax Real CAGR");
    const firstTax = () => within(screen.getAllByRole("row")[1]).getAllByRole("cell")[4].textContent;
    const before = firstTax();
    rerender(<ResultsTable {...props} futuresTaxRates={{ ltcg: 0, stcg: 0, state: 0, medicare: 0 }} />);
    expect(firstTax()).not.toBe(before);
    fireEvent.click(screen.getByRole("button", { name: /After-Tax Real CAGR/ }));
    fireEvent.click(screen.getByRole("button", { name: /After-Tax Real CAGR/ }));
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("b-futures-sma");
    expect(rows[1]).toHaveTextContent("a-futures-sma");
    expect(within(rows[2]).getAllByRole("cell")[4]).toHaveTextContent("—");
  });

  it("keeps the backtest table's columns unchanged", () => {
    render(<ResultsTable result={result} indexLabel="VOO" annualizedInflation={0} />);
    expect(screen.queryByRole("button", { name: /After-Tax Real CAGR/ })).toBeNull();
  });
});
