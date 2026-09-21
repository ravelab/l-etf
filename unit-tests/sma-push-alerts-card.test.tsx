// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PushSmaConfig } from "@/lib/push/types";
import type { SmaCalibrationResult } from "@/lib/sma-calibration";

const subscribeToPushAlerts = vi.fn(async (key: string, config: PushSmaConfig) => {
  void key;
  void config;
  return { endpoint: "https://example.test/sub" };
});
const getStoredPushAlertConfig = vi.fn<() => PushSmaConfig | null>(() => null);
const getCurrentPushSubscription = vi.fn(async () => null);

vi.mock("@/lib/push/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/push/client")>()),
  clearStoredPushAlertConfig: vi.fn(),
  fetchPushPublicKey: vi.fn(async () => "test-public-key"),
  getCurrentPushSubscription: () => getCurrentPushSubscription(),
  getStoredPushAlertConfig: () => getStoredPushAlertConfig(),
  isIosDevice: () => false,
  isPushSupported: () => true,
  isStandaloneApp: () => false,
  setStoredPushAlertConfig: vi.fn(),
  subscribeToPushAlerts: (key: string, config: PushSmaConfig) => subscribeToPushAlerts(key, config),
  unsubscribeFromPushAlerts: vi.fn(async () => undefined),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// jsdom ships no matchMedia; InstallGuide watches the standalone display mode.
window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { SmaPushAlertsCard } = await import("@/components/home/SmaPushAlertsCard");

// The page inputs differ from the monthly calibration to prove alerts use the
// calibration snapshot when the toggle is enabled.
const PAGE_CONFIG: PushSmaConfig = {
  smaSpPeriod: 200,
  smaSpUpperBuffer: 1,
  smaSpLowerBuffer: 1,
  smaSpEnabled: true,
  smaNqPeriod: 50,
  smaNqUpperBuffer: 2,
  smaNqLowerBuffer: 2,
  smaNqEnabled: true,
  notifyEveryClose: false,
  useCalibratedDefaults: true,
};

const CALIBRATION: SmaCalibrationResult = {
  generatedAt: "2026-09-01T00:00:00.000Z", endDate: "2026-08-31", windowLength: 10,
  sp500: { startDate: "1988-01-04", smaPeriod: 174, smaUpperBuffer: 3.5, smaLowerBuffer: 3.6, score: 1, avgReturn: 1, worstReturn: 1, avgMaxDrawdown: 1, avgTrades: 1 },
  nasdaq100: { startDate: "1985-01-31", smaPeriod: 127, smaUpperBuffer: 19.3, smaLowerBuffer: 17.8, score: 1, avgReturn: 1, worstReturn: 1, avgMaxDrawdown: 1, avgTrades: 1 },
};

function renderCard(props: Partial<Parameters<typeof SmaPushAlertsCard>[0]> = {}) {
  return render(
    <SmaPushAlertsCard
      smaConfig={PAGE_CONFIG}
      calibration={CALIBRATION}
      useCalibratedDefaults
      onUseCalibratedDefaultsChange={vi.fn()}
      onConfigChange={vi.fn()}
      {...props}
    />
  );
}

describe("SmaPushAlertsCard defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStoredPushAlertConfig.mockReturnValue(null);
    getCurrentPushSubscription.mockResolvedValue(null);
  });

  it("subscribes with the calibrated band", async () => {
    renderCard();

    const button = await screen.findByRole("button", { name: /Enable SPX SMA alerts/ });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    await waitFor(() => expect(subscribeToPushAlerts).toHaveBeenCalled());
    expect(subscribeToPushAlerts.mock.calls[0][1]).toMatchObject({
      smaSpPeriod: 174,
      smaSpUpperBuffer: 3.5,
      smaSpLowerBuffer: 3.6,
      smaNqPeriod: 127,
      smaNqUpperBuffer: 19.3,
      smaNqLowerBuffer: 17.8,
    });
  });

  it("subscribes with the page's inputs when the toggle is off", async () => {
    renderCard({ useCalibratedDefaults: false, smaConfig: { ...PAGE_CONFIG, useCalibratedDefaults: false } });

    const button = await screen.findByRole("button", { name: /Enable SPX SMA alerts/ });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    await waitFor(() => expect(subscribeToPushAlerts).toHaveBeenCalled());
    expect(subscribeToPushAlerts.mock.calls[0][1]).toMatchObject({
      smaSpPeriod: 200,
      smaSpUpperBuffer: 1,
      smaSpLowerBuffer: 1,
    });
  });

  it("does not ask to update an already-calibrated subscription when the inputs differ", async () => {
    getCurrentPushSubscription.mockResolvedValue({ endpoint: "https://example.test/sub" } as never);
    getStoredPushAlertConfig.mockReturnValue({
      ...PAGE_CONFIG,
      smaSpPeriod: 174,
      smaSpUpperBuffer: 3.5,
      smaSpLowerBuffer: 3.6,
      smaNqPeriod: 127,
      smaNqUpperBuffer: 19.3,
      smaNqLowerBuffer: 17.8,
    });

    renderCard();

    expect(await screen.findByRole("button", { name: /Disable SPX SMA alerts/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Update SPX SMA alerts/ })).toBeNull();
  });

  it("names the band the alerts actually run on", async () => {
    renderCard();
    expect(await screen.findByText(/Alerts use the calibrated band/)).toBeInTheDocument();
  });
});
