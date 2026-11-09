// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ExtraStrategiesSelect } from "@/components/tools/ExtraStrategiesSelect";

const RULES = [
  { id: "a", title: "Rule A", description: "First.", sourceUrl: "https://example.com/a" },
  { id: "b", title: "Rule B", description: "Second." },
];

function open() {
  fireEvent.click(screen.getByTestId("extra-strategies"));
  return screen.getByRole("group", { name: "Extra strategies" });
}

describe("ExtraStrategiesSelect", () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  it("reads None with nothing ticked, and lists every rule unticked", () => {
    render(<ExtraStrategiesSelect rules={RULES} selected={[]} onChange={() => {}} />);
    expect(screen.getByTestId("extra-strategies").textContent).toContain("None");
    const panel = open();
    const boxes = panel.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect(boxes).toHaveLength(2);
    expect([...boxes].every((box) => !box.checked)).toBe(true);
  });

  it("ticking returns the selection in the rules' order", () => {
    const onChange = vi.fn();
    render(<ExtraStrategiesSelect rules={RULES} selected={["b"]} onChange={onChange} />);
    expect(screen.getByTestId("extra-strategies").textContent).toContain("Rule B");
    open();
    fireEvent.click(screen.getByLabelText("Rule A"));
    expect(onChange).toHaveBeenLastCalledWith(["a", "b"]);
    fireEvent.click(screen.getByLabelText("Rule B"));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("links a rule's source in a new tab, outside its checkbox label", () => {
    render(<ExtraStrategiesSelect rules={RULES} selected={[]} onChange={() => {}} />);
    open();
    const link = screen.getByRole("link", { name: "Rule A source" });
    expect(link.getAttribute("href")).toBe("https://example.com/a");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.closest("label")).toBeNull();
    expect(screen.queryByRole("link", { name: "Rule B source" })).toBeNull();
  });

  it("closes on Escape and on a click outside", () => {
    render(<ExtraStrategiesSelect rules={RULES} selected={[]} onChange={() => {}} />);
    open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Extra strategies" })).toBeNull();
    open();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("group", { name: "Extra strategies" })).toBeNull();
  });
});
