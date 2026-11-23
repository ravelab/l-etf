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
