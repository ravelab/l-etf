// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { SweepComparisonTable } from "@/components/tools/compare/SweepComparisonTable";
import type { SmaComparisonRow } from "@/lib/simulation/types";

function row(parameterValue: number, score: number): SmaComparisonRow {
  return {
    parameterValue,
    avgFinalRealValue: 100_000,
    avgReturn: Math.pow(score, 1 / 2.9),
    bestReturn: 0,
    worstReturn: 0,
    avgMaxDrawdown: 0,
    biggestMaxDrawdown: 0,
    // Keep frequency at the preferred rate so this isolates numeric sorting.
    avgTrades: 0.5,
    avgWindowYears: 1,
    avgTradingCostPct: 0,
  };
}

describe("SweepComparisonTable score ranking", () => {
  it("places 20273.33 above 20011.02", () => {
    render(
      <SweepComparisonTable
        rows={[row(1, 20_011.02), row(2, 20_273.33)]}
        inflationPct={0}
        firstColumnLabel="Buffer"
        formatFirstColumn={(item) => String(item.parameterValue)}
        getBacktestUrl={() => null}
        pagination={false}
      />
    );

    const cells = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(cells.map((item) => item.lastElementChild?.textContent)).toEqual(["20273.33", "20011.02"]);
  });
});
