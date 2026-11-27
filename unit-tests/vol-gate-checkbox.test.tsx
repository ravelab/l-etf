// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { VolGateCheckbox } from "@/components/tools/VolGateCheckbox";
import { SMA_RSI_BRAKE } from "@/lib/simulation/rsi-brake";
import { SMA_VOL_GATE } from "@/lib/simulation/vol-gate";

describe("VolGateCheckbox", () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  it("shows both indices' vol gates and the RSI brake parameters in the box", () => {
    render(<VolGateCheckbox checked onChange={() => {}} />);
    const box = screen.getByTestId("sma-vol-gate").closest("label")!;
    const gate = SMA_VOL_GATE.nasdaq100;
    expect(box.textContent).toContain(`${gate.windowDays}d`);
    const params = screen.getByTestId("sma-rsi-brake-params");
    expect(box.contains(params)).toBe(true);
    for (const [index, label] of [["sp500", "SPX"], ["nasdaq100", "NDX"]] as const) {
      const brake = SMA_RSI_BRAKE[index];
      expect(params.textContent).toContain(`${label} ${brake.periodDays}d <${brake.exitBelow} >${brake.reenterAbove}`);
    }
  });

  it("keeps the box at the standard input height at every width", () => {
    render(<VolGateCheckbox checked onChange={() => {}} />);
    const box = screen.getByTestId("sma-vol-gate").closest("label")!;
    const classes = box.className.split(/\s+/);
    expect(classes).toContain("h-[34px]");
    // No min-height or padding-y escape hatch that lets a narrow box grow.
    expect(classes.some((c) => /(^|:)(min-h-|py-)/.test(c))).toBe(false);
  });

  it("toggles both layers with one switch", () => {
    const onChange = vi.fn();
    render(<VolGateCheckbox checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("sma-vol-gate"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
