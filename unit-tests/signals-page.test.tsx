// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getDefaultSmaPeriod } from "@/lib/simulation/defaults";

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
});
