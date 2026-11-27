// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { SignalCard } from "@/components/home/SignalCard";

it.each(["Buy L-ETFs", "Sell L-ETFs", "Hold"])("displays a neutral Hold for %s", (signalLabel) => {
  render(<SignalCard indexName="S&P 500" indexKey="sp500" smaPeriod={200} result={{
    signal: "hold", signalLabel, signalEmoji: "⏸️", indexValue: 102, indexDate: "2026-11-20",
    smaValue: 100, percentDiff: 2,
  }} />);
  expect(screen.getByText("Hold").parentElement).toHaveClass("text-muted");
  expect(screen.queryByText(/^(Buy|Sell) L-ETFs$/)).not.toBeInTheDocument();
});

it.each([
  [0.259626, false, "25.96% · exit > 26%"],
  [0.25999, false, "Just below 26% · exit > 26%"],
  [0.26, false, "26.0% · exit > 26%"],
  [0.2304, true, "23.04% · re-enter < 23%"],
  [0.265315, false, "26.5% · exit > 26%"],
])("displays volatility %s with gate state %s", (volatility, volGateRiskOff, label) => {
  render(<SignalCard indexName="S&P 500" indexKey="sp500" smaPeriod={239} result={{
    signal: "hold", signalLabel: "Hold", signalEmoji: "⏸️", indexValue: 102, indexDate: "2026-11-23",
    smaValue: 100, percentDiff: 2, volatility, volGateRiskOff,
  }} />);
  expect(screen.getByTestId("vol-gate-status")).toHaveTextContent(label);
});
