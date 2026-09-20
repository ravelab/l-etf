// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useToolForm } from "@/lib/hooks/use-tool-form";

// `letf` is restored from the SHARED input store while `index` is page-local and
// unpersisted. When the two disagreed on the first mount, the compare pages ran a
// non-SPX preset over SPX prices and labelled the result with the preset's name —
// e.g. a first TQQQ sweep that was really 3x SPX, which only corrected itself once
// the run's own router.push fed `letf` back through the URL-param effect.
describe("useToolForm initial index", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  const seedSharedLetf = (letf: string) => {
    window.localStorage.setItem("shared-inputs", JSON.stringify({ letf }));
  };

  it("seeds the index from a restored Nasdaq preset", () => {
    seedSharedLetf("TQQQ");
    const { result } = renderHook(() => useToolForm("test-index-nq", {}));

    expect(result.current.letf).toBe("TQQQ");
    expect(result.current.index).toBe("nasdaq100");
  });

  it("seeds the index from a restored S&P preset", () => {
    seedSharedLetf("UPRO");
    const { result } = renderHook(() => useToolForm("test-index-sp", {}));

    expect(result.current.letf).toBe("UPRO");
    expect(result.current.index).toBe("sp500");
  });

  it("leaves a combo preset on the default index (its legs carry their own)", () => {
    seedSharedLetf("UPRO+TQQQ");
    const { result } = renderHook(() => useToolForm("test-index-combo", {}));

    expect(result.current.isCombo).toBe(true);
    expect(result.current.index).toBe("sp500");
  });
});
