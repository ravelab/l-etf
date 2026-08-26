// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SortButton } from "@/components/ui/SortButton";

describe("SortButton", () => {
  it("renders the label and fires onClick", () => {
    const onClick = vi.fn();
    render(<SortButton label="Score" active dir="desc" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: /Score/i }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
