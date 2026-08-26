// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Toggle } from "@/components/ui/Toggle";

describe("Toggle", () => {
  it("shows the label and notifies on change", () => {
    const onChange = vi.fn();
    render(<Toggle label="Hate Drawdown" checked={false} onChange={onChange} />);
    expect(screen.getByText("Hate Drawdown")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Hate Drawdown").previousElementSibling as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
