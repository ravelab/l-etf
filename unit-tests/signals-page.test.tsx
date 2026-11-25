// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getDefaultSmaPeriod } from "@/lib/simulation/defaults";
import type { SmaSignalResult } from "@/lib/sma-signals";
import cagrPresets from "@/lib/tool-snapshots/sma-cagr-presets.json";
import inflationCagrPresets from "@/lib/tool-snapshots/sma-cagr-presets-inflation.json";

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

  it("shows which regime each index holds inside its SMA band", async () => {
    const hold = {
      signal: "hold",
      signalLabel: "Hold",
      signalEmoji: "⏸️",
      indexValue: 7201.09,
      indexDate: "2026-11-24",
      smaValue: 7419.16,
      percentDiff: -2.94,
    } satisfies SmaSignalResult;
    vi.mocked(fetch).mockImplementation(async (url) => Response.json(
      String(url).startsWith("/api/sma-signals?") ? {
        sp500: { ...hold, regime: "risk-off" },
        nasdaq100: { ...hold, regime: "risk-on" },
      } : {},
    ));

    render(<SignalsPage />);

    expect(await screen.findByText("Hold Risk-Off")).toBeVisible();
    expect(screen.getByText("Hold Risk-On")).toBeVisible();
  });

  it("keeps shared inputs when the saved calibrated-alert preference and calibration load", async () => {
    render(<SignalsPage />);

    await waitFor(() => expect(screen.getByTestId("calibrated-alerts")).toHaveTextContent("true:true"));
    expect(screen.getByLabelText("SPX SMA Period")).toHaveValue("222");
    expect(screen.getByLabelText("NDX SMA Period")).toHaveValue("111");
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining(inputs));

    fireEvent.click(screen.getByRole("button", { name: "SPX Set default" }));
    expect(screen.getByLabelText("SPX SMA Period")).toHaveValue(String(getDefaultSmaPeriod("sp500")));
    expect(screen.getByLabelText("NDX SMA Period")).toHaveValue("111");
    fireEvent.click(screen.getByRole("button", { name: "NDX Set default" }));
    expect(screen.getByLabelText("NDX SMA Period")).toHaveValue(String(getDefaultSmaPeriod("nasdaq100")));
  });

  it("applies each index independently from every multi-era-ranked preset and displays compact real returns", () => {
    render(<SignalsPage />);
    const expected = { ...inputs };
    cagrPresets.presets.forEach((preset, index) => {
      const label = preset.isCalibratedDefault ? "Set default" : `Set alternative ${index}`;
      for (const indexKey of ["sp500", "nasdaq100"] as const) {
        const button = screen.getByRole("button", { name: `${indexKey === "sp500" ? "SPX" : "NDX"} ${label}` });
        const row = button.closest("[data-sma-preset]")!;
        const details = row.querySelector(`[data-index-cagrs="${indexKey}"]`)!;
        expect(details).toHaveTextContent(`Real CAGR: ${preset[indexKey].realCagr.toFixed(2)}%`);
        expect(details).not.toHaveTextContent("score");
        expect(details).toHaveTextContent(`${indexKey === "nasdaq100" ? preset.nasdaq100.switchHistory.count : preset.sp500.trades} switches`);
        for (const [eraKey, era] of Object.entries(preset[indexKey].eraCagrs)) {
          expect(details).toHaveTextContent(`${eraKey === "proto" ? "Proto" : "Proxy"}: ${era.realCagr.toFixed(2)}%`);
        }
        if (indexKey === "nasdaq100") expect(details).not.toHaveTextContent("Proto");
        else expect(details.textContent!.indexOf("Proxy:")).toBeLessThan(details.textContent!.indexOf("Proto:"));
        expect(screen.queryByText(/50\/50/)).not.toBeInTheDocument();
        fireEvent.click(button);
        const prefix = indexKey === "sp500" ? "smaSp" : "smaNq";
        expected[`${prefix}Period`] = preset[indexKey].smaPeriod;
        expected[`${prefix}LowerBuffer`] = preset[indexKey].smaLowerBuffer;
        expected[`${prefix}UpperBuffer`] = preset[indexKey].smaUpperBuffer;
        for (const [name, inputPrefix] of [["SPX", "smaSp"], ["NDX", "smaNq"]] as const) {
          expect(screen.getByLabelText(`${name} SMA Period`)).toHaveValue(String(expected[`${inputPrefix}Period`]));
          expect(screen.getByLabelText(`${name} SMA Buffer lower`)).toHaveValue(String(expected[`${inputPrefix}LowerBuffer`]));
          expect(screen.getByLabelText(`${name} SMA Buffer upper`)).toHaveValue(String(expected[`${inputPrefix}UpperBuffer`]));
        }
        expect(persist).toHaveBeenLastCalledWith(expect.objectContaining(expected));
      }
    });
  });

  it("starts inflation adjusted; nominal presets clear the checkbox and inflation-adjusted presets set it", () => {
    render(<SignalsPage />);
    const checkbox = screen.getByTestId("sma-inflation-adjusted");
    expect(checkbox).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "SPX Set default" }));
    expect(checkbox).not.toBeChecked();
    expect(screen.getByLabelText("SPX SMA Period")).toHaveValue(String(getDefaultSmaPeriod("sp500")));
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ smaInflationAdjusted: false }));

    const alternative = inflationCagrPresets.presets.findIndex((preset) => !preset.isCalibratedDefault);
    const rule = inflationCagrPresets.presets[alternative].nasdaq100;
    fireEvent.click(screen.getByRole("button", { name: "NDX Set alternative 1 (inflation adjusted)" }));
    expect(checkbox).toBeChecked();
    expect(screen.getByLabelText("NDX SMA Period")).toHaveValue(String(rule.smaPeriod));
    expect(screen.getByLabelText("NDX SMA Buffer lower")).toHaveValue(String(rule.smaLowerBuffer));
    expect(screen.getByLabelText("NDX SMA Buffer upper")).toHaveValue(String(rule.smaUpperBuffer));
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ smaInflationAdjusted: true }));

    fireEvent.click(screen.getByRole("button", { name: "SPX Set default (inflation adjusted)" }));
    expect(screen.getByLabelText("SPX SMA Period")).toHaveValue(String(inflationCagrPresets.presets.find((p) => p.isCalibratedDefault)!.sp500.smaPeriod));
    expect(checkbox).toBeChecked();
  });

  it("asks the signal API for the nominal SMA when unchecked, since an absent flag means the default (on)", async () => {
    const fetchMock = vi.mocked(fetch);
    const signalFlags = () => fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith("/api/sma-signals?"))
      .map((url) => new URLSearchParams(url.split("?")[1]).get("smaInflationAdjusted"));

    render(<SignalsPage />);
    await waitFor(() => expect(signalFlags()).toContain("1"), { timeout: 2000 });

    fireEvent.click(screen.getByTestId("sma-inflation-adjusted"));
    await waitFor(() => expect(signalFlags().at(-1)).toBe("0"), { timeout: 2000 });
  });
});
