"use client";

import { useState, useCallback } from "react";
import { Toggle } from "@/components/ui/Toggle";
import { InfoPopoverButton } from "@/components/ui/InfoPopoverButton";
import { getSharedInputs } from "@/lib/hooks/use-shared-inputs";

/**
 * Shared state + UI for the "Hate Drawdown" score toggle. Pages render `toggle`
 * next to their section header and pass `hateDrawdown` into any `SweepComparisonTable`.
 */
export function useHateDrawdown() {
  const { inputs, persist } = getSharedInputs();
  const [hateDrawdown, setHateDrawdownState] = useState(inputs.hateDrawdown);

  const setHateDrawdown = useCallback((val: boolean) => {
    setHateDrawdownState(val);
    persist({ hateDrawdown: val });
  }, [persist]);

  const toggle = (
    <div className="flex items-center gap-1.5">
      <Toggle label="Hate Drawdown" checked={hateDrawdown} onChange={setHateDrawdown} />
      <InfoPopoverButton label="Hate Drawdown">
        Increases the penalty exponent applied to average max drawdown when computing the Score.
        Use this to favor strategies that keep drawdowns smaller, even at the cost of some return.
        Scores and sort order update instantly.
      </InfoPopoverButton>
    </div>
  );
  return { hateDrawdown, toggle };
}
