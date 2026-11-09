// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import { ClientOnly } from "@/components/tools/ClientOnly";

// jsdom has a window during renderToString too, so the "server" is simulated by a flag.
let renderingOnServer = false;
function serverHtml(node: ReactNode): string {
  renderingOnServer = true;
  try {
    return renderToString(node);
  } finally {
    renderingOnServer = false;
  }
}

/** Reads browser-only state in render, as the tool forms do with localStorage. */
function ReadsBrowserState() {
  const value = renderingOnServer ? "server-default" : window.localStorage.getItem("probe") ?? "client";
  return <p data-testid="probe">{value}</p>;
}

describe("ClientOnly", () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it("renders nothing on the server", () => {
    expect(renderToString(<ClientOnly><p>tool</p></ClientOnly>)).toBe("");
  });

  it("hydrates server HTML without a mismatch, then shows browser-state content", async () => {
    window.localStorage.setItem("probe", "restored-from-storage");
    const container = document.createElement("div");
    container.innerHTML = serverHtml(<ClientOnly><ReadsBrowserState /></ClientOnly>);
    document.body.appendChild(container);
    const onRecoverableError = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const root = await act(async () =>
      hydrateRoot(container, <ClientOnly><ReadsBrowserState /></ClientOnly>, { onRecoverableError })
    );

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.map((call) => String(call[0]))).toEqual([]);
    expect(container.textContent).toBe("restored-from-storage");
    act(() => root.unmount());
    consoleError.mockRestore();
    container.remove();
    window.localStorage.removeItem("probe");
  });

  it("is what prevents the mismatch: the same content hydrated bare fails", async () => {
    window.localStorage.setItem("probe", "restored-from-storage");
    const container = document.createElement("div");
    container.innerHTML = serverHtml(<ReadsBrowserState />);
    document.body.appendChild(container);
    const onRecoverableError = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const root = await act(async () => hydrateRoot(container, <ReadsBrowserState />, { onRecoverableError }));

    expect(onRecoverableError).toHaveBeenCalled();
    act(() => root.unmount());
    consoleError.mockRestore();
    container.remove();
    window.localStorage.removeItem("probe");
  });

  it("renders at once on a client-side mount", () => {
    render(<ClientOnly><ReadsBrowserState /></ClientOnly>);
    expect(screen.getByTestId("probe").textContent).toBe("client");
  });
});
