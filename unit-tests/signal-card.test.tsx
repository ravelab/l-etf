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
  [0.319626, false, "31.96% · exit > 32%"],
  [0.31999, false, "Just below 32% · exit > 32%"],
  [0.32, false, "32.0% · exit > 32%"],
  [0.2204, true, "22.04% · re-enter < 22%"],
  [0.265315, false, "26.5% · exit > 32%"],
])("displays volatility %s with gate state %s", (volatility, volGateRiskOff, label) => {
  render(<SignalCard indexName="S&P 500" indexKey="sp500" smaPeriod={239} result={{
    signal: "hold", signalLabel: "Hold", signalEmoji: "⏸️", indexValue: 102, indexDate: "2026-11-23",
    smaValue: 100, percentDiff: 2, volatility, volGateRiskOff,
  }} />);
  expect(screen.getByTestId("vol-gate-status")).toHaveTextContent(label);
});
