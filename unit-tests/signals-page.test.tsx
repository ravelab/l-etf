// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getDefaultSmaPeriod } from "@/lib/simulation/defaults";
import cagrPresets from "@/lib/tool-snapshots/sma-cagr-presets.json";

const persist = vi.fn();
const inputs = {
  smaSpPeriod: 222,
  smaSpUpperBuffer: 7,
  smaSpLowerBuffer: 8,
  smaSpEnabled: true,
  smaNqPeriod: 111,
  smaNqUpperBuffer: 9,
  smaNqLowerBuffer: 10,
  smaNqEnabled: true,
};

vi.mock("@/lib/hooks/use-shared-inputs", () => ({
  getSharedInputs: () => ({ inputs, persist }),
}));
vi.mock("@/components/home/SignalCard", () => ({ SignalCard: () => null }));
vi.mock("@/components/home/SmaPushAlertsCard", () => ({
  SmaPushAlertsCard: ({ useCalibratedDefaults, calibration }: { useCalibratedDefaults: boolean; calibration: unknown }) => (
    <div data-testid="calibrated-alerts">{String(useCalibratedDefaults)}:{String(Boolean(calibration))}</div>
  ),
}));

const { default: SignalsPage } = await import("@/app/signals/page");

describe("Signals page SMA inputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    window.localStorage.clear();
    window.localStorage.setItem("signals-use-calibrated-defaults", "true");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
  });

  it("keeps shared inputs when the saved calibrated-alert preference and calibration load", async () => {
    render(<SignalsPage />);

    await waitFor(() => expect(screen.getByTestId("calibrated-alerts")).toHaveTextContent("true:true"));
    expect(screen.getByLabelText("SPX SMA Period")).toHaveValue("222");
    expect(screen.getByLabelText("NDX SMA Period")).toHaveValue("111");
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining(inputs));

    fireEvent.click(screen.getByRole("button", { name: "Set default" }));
    expect(screen.getByLabelText("SPX SMA Period")).toHaveValue(String(getDefaultSmaPeriod("sp500")));
    expect(screen.getByLabelText("NDX SMA Period")).toHaveValue(String(getDefaultSmaPeriod("nasdaq100")));
  });

  it("applies all six inputs from each multi-era-ranked preset and displays compact real returns", () => {
    render(<SignalsPage />);
    cagrPresets.presets.forEach((preset, index) => {
      const button = screen.getByRole("button", { name: preset.isCalibratedDefault ? "Set default" : `Set alternative ${cagrPresets.presets.slice(0, index + 1).filter((row) => !row.isCalibratedDefault).length}` });
      const row = button.closest("[data-sma-preset]")!;
      for (const indexKey of ["sp500", "nasdaq100"] as const) {
        const details = row.querySelector(`[data-index-cagrs="${indexKey}"]`)!;
        expect(details).toHaveTextContent(`Real CAGR: ${preset[indexKey].realCagr.toFixed(2)}%`);
        expect(details).not.toHaveTextContent("score");
        for (const [eraKey, era] of Object.entries(preset[indexKey].eraCagrs)) {
          expect(details).toHaveTextContent(`${eraKey === "proto" ? "Proto" : "Proxy"}: ${era.realCagr.toFixed(2)}%`);
        }
        if (indexKey === "nasdaq100") expect(details).not.toHaveTextContent("Proxy");
        else expect(details.textContent!.indexOf("Proxy:")).toBeLessThan(details.textContent!.indexOf("Proto:"));
      }
      expect(screen.queryByText(/50\/50/)).not.toBeInTheDocument();
      fireEvent.click(button);
      expect(screen.getByLabelText("SPX SMA Period")).toHaveValue(String(preset.sp500.smaPeriod));
      expect(screen.getByLabelText("SPX SMA Buffer lower")).toHaveValue(String(preset.sp500.smaLowerBuffer));
      expect(screen.getByLabelText("SPX SMA Buffer upper")).toHaveValue(String(preset.sp500.smaUpperBuffer));
      expect(screen.getByLabelText("NDX SMA Period")).toHaveValue(String(preset.nasdaq100.smaPeriod));
      expect(screen.getByLabelText("NDX SMA Buffer lower")).toHaveValue(String(preset.nasdaq100.smaLowerBuffer));
      expect(screen.getByLabelText("NDX SMA Buffer upper")).toHaveValue(String(preset.nasdaq100.smaUpperBuffer));
      expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({
        smaSpPeriod: preset.sp500.smaPeriod, smaSpLowerBuffer: preset.sp500.smaLowerBuffer, smaSpUpperBuffer: preset.sp500.smaUpperBuffer,
        smaNqPeriod: preset.nasdaq100.smaPeriod, smaNqLowerBuffer: preset.nasdaq100.smaLowerBuffer, smaNqUpperBuffer: preset.nasdaq100.smaUpperBuffer,
      }));
    });
  });
});
