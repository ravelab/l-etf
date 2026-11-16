// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ResultsTable } from "@/components/tools/backtest/ResultsTable";
import { DEFAULT_FUTURES_TAX_RATES } from "@/lib/simulation/futures-tax";
import { buildLetfTaxSchedule, estimateLetfAfterTaxCagr } from "@/lib/simulation/letf-tax";
import { formatPercent } from "@/lib/format";
import { annualizedInflationForRange } from "@/lib/inflation";
import { calcCagr } from "@/lib/simulation/metrics";
import { CONSTANT_INITIAL_INVESTMENT as C } from "@/lib/constants";
import type { BacktestResult, EtfResult } from "@/lib/simulation/types";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

const dates = ["2020-01-01", "2020-12-31", "2021-12-31"];
function row(id: string, values: number[], cagr: number): EtfResult {
  return {
    id, name: id, dates, dailyValues: values, finalValue: values[2], cagr,
    maxDrawdownPct: 0, maxDrawdownDollar: 0, longestDrawdownDays: 0,
    sourceIndex: "sp500", sharpeRatio: 0, sortinoRatio: 0, bestMonth: 0, worstMonth: 0, totalTradingCostPct: 0,
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

  it("taxes a leveraged ETF row on its sales, not as futures", () => {
    // The engine's dollars, which the schedule's cost basis is measured in.
    const engineRow = row("upro-sma", [C, 1.2 * C, 1.44 * C], 20);
    const letf = { ...engineRow, taxSchedule: buildLetfTaxSchedule(engineRow) };
    expect(estimateLetfAfterTaxCagr(letf.taxSchedule!, { ltcg: 0, stcg: 0, state: 0, medicare: 0 })).toBeCloseTo(calcCagr(C, 1.44 * C, dates[0], dates[2]), 9);
    const props = {
      result: { ...result, etfResults: [letf] }, indexLabel: "VOO", annualizedInflation: 0, variant: "futures" as const,
    };
    const { rerender } = render(<ResultsTable {...props} futuresTaxRates={DEFAULT_FUTURES_TAX_RATES} />);
    const taxCell = () => within(screen.getAllByRole("row")[1]).getAllByRole("cell")[4].textContent;
    const expected = estimateLetfAfterTaxCagr(letf.taxSchedule!, DEFAULT_FUTURES_TAX_RATES)!;
    expect(taxCell()).toBe(formatPercent(expected));
    // Held throughout and sold after more than a year: long-term only, unlike the 60/40 futures blend.
    rerender(<ResultsTable {...props} futuresTaxRates={{ ...DEFAULT_FUTURES_TAX_RATES, stcg: 90 }} />);
    expect(taxCell()).toBe(formatPercent(expected));
  });

  it("divides inflation out of both real CAGR columns rather than subtracting it", () => {
    // 20% nominal at ~10% CPI growth a year: about 9.1% real, where subtraction says about 10%.
    const monthlyCpi = [{ date: "2020-01-01", value: 100 }, { date: "2021-01-01", value: 110 }];
    const inflation = annualizedInflationForRange(monthlyCpi, dates[0], dates[2]);
    const expected = formatPercent((1.2 / (1 + inflation) - 1) * 100);
    expect(expected).not.toBe(formatPercent(20 - inflation * 100));
    const futures = row("a-futures-sma", [100, 120, 144], 20);
    render(
      <ResultsTable
        result={{ ...result, etfResults: [futures] }} indexLabel="VOO" annualizedInflation={0}
        monthlyCpi={monthlyCpi} variant="futures" futuresTaxRates={{ ltcg: 0, stcg: 0, state: 0, medicare: 0 }}
      />
    );
    const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
    expect(cells[3]).toHaveTextContent(expected);
    // With no tax the after-tax CAGR is the path's own nominal CAGR, deflated the same way.
    const untaxed = calcCagr(100, 144, dates[0], dates[2]);
    expect(cells[4]).toHaveTextContent(formatPercent(((1 + untaxed / 100) / (1 + inflation) - 1) * 100));
  });

  it("keeps the backtest table's columns unchanged", () => {
    render(<ResultsTable result={result} indexLabel="VOO" annualizedInflation={0} />);
    expect(screen.queryByRole("button", { name: /After-Tax Real CAGR/ })).toBeNull();
  });
});
