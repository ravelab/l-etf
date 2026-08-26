// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/Button";

describe("Button", () => {
  it("renders children and forwards clicks", () => {
    const onClick = vi.fn();
    render(
      <Button type="button" onClick={onClick}>
        Run
      </Button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("honors disabled", () => {
    const onClick = vi.fn();
    render(
      <Button type="button" disabled onClick={onClick}>
        Run
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Run" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
