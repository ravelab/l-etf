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
    const brake = SMA_RSI_BRAKE.sp500;
    const params = screen.getByTestId("sma-rsi-brake-params");
    expect(box.contains(params)).toBe(true);
    expect(params.textContent).toContain(`RSI ${brake.periodDays}d`);
    expect(params.textContent).toContain(`<${brake.exitBelow} >${brake.reenterAbove}`);
  });

  it("toggles both layers with one switch", () => {
    const onChange = vi.fn();
    render(<VolGateCheckbox checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("sma-vol-gate"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
