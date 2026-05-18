"use client";

import { useState, useCallback } from "react";
import { getSharedInputs } from "@/lib/hooks/use-shared-inputs";

/**
 * Shared state for the "Show After-Hours Variants" toggle.
 * Persists to localStorage and is shared across all tool pages.
 */
export function useTradeAfterHours() {
  const { inputs } = getSharedInputs();
  const [tradeAfterHours, setTradeAfterHoursState] = useState(inputs.tradeAfterHours);

  // Stable callback — re-fetch persist at call time so the identity never
  // changes across renders (otherwise effects depending on it loop).
  const setTradeAfterHours = useCallback((val: boolean) => {
    setTradeAfterHoursState(val);
    getSharedInputs().persist({ tradeAfterHours: val });
  }, []);

  return { tradeAfterHours, setTradeAfterHours };
}
