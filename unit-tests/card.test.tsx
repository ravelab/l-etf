// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card } from "@/components/ui/Card";

describe("Card", () => {
  it("renders children", () => {
    render(<Card>Summary</Card>);
    expect(screen.getByText("Summary")).toBeInTheDocument();
  });
});
