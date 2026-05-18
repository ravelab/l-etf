"use client";

import { useCallback, useRef } from "react";

export function useSearchSyncRunGuard() {
  const skipNextSearchSyncRunRef = useRef(false);

  const markNextSearchAsInternal = useCallback(() => {
    skipNextSearchSyncRunRef.current = true;
  }, []);

  const shouldAutoRunFromSearch = useCallback(() => {
    if (skipNextSearchSyncRunRef.current) {
      skipNextSearchSyncRunRef.current = false;
      return false;
    }
    return true;
  }, []);

  return { markNextSearchAsInternal, shouldAutoRunFromSearch };
}
