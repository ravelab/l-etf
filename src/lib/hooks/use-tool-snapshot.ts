import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { hasMeaningfulSearchParams, persistedToolStateMatchesUrl } from "@/lib/tools-route";
import { PAGE_CACHE_PREFIX } from "./use-page-cache";

type ToolSnapshotMetadata = {
  snapshotEndDate: string;
  sharedInputs: Record<string, unknown>;
};

type UseToolSnapshotParams<T> = {
  pageKey: string;
  shouldHydrate: boolean;
  onSnapshot: (state: T) => void;
  onMetadata?: (meta: ToolSnapshotMetadata) => void;
  /** Called when hydration completes but no data was found (no localStorage,
   *  no server snapshot). Pages can use this to trigger an autorun. */
  onNoData?: () => void;
  /** Predicate that decides whether a persisted localStorage blob has enough
   *  content to skip fetching the server-side snapshot. */
  hasPersistedResults?: (state: Record<string, unknown>) => boolean;
};

type ApiResponse<T> = {
  snapshotEndDate: string;
  sharedInputs: Record<string, unknown>;
  pageState?: T;
  error?: string;
};

export function useToolSnapshot<T = Record<string, unknown>>({
  pageKey,
  shouldHydrate,
  onSnapshot,
  onMetadata,
  onNoData,
  hasPersistedResults,
}: UseToolSnapshotParams<T>) {
  const appliedRef = useRef(false);
  const [metadata, setMetadata] = useState<ToolSnapshotMetadata | null>(null);
  const onSnapshotRef = useRef(onSnapshot);
  const onMetadataRef = useRef(onMetadata);
  const onNoDataRef = useRef(onNoData);
  const hasPersistedResultsRef = useRef(hasPersistedResults);

  useEffect(() => {
    // Update refs on every render so async snapshot paths always see latest callbacks
    onSnapshotRef.current = onSnapshot;
    onMetadataRef.current = onMetadata;
    onNoDataRef.current = onNoData;
    hasPersistedResultsRef.current = hasPersistedResults;
  });

  // Restore from localStorage synchronously so the first paint (and follow-up
  // autorun useEffects) see `hasCachedResults` before deciding to re-run.
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    if (appliedRef.current || !shouldHydrate) return;

    hasPersistedResultsRef.current = hasPersistedResults;

    const hasUrlParams = hasMeaningfulSearchParams(window.location.search);

    try {
      const raw = window.localStorage.getItem(PAGE_CACHE_PREFIX + pageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const predicate = hasPersistedResultsRef.current;
        const urlParams = new URLSearchParams(window.location.search);
        const looksGood =
          parsed &&
          typeof parsed === "object" &&
          (!predicate || predicate(parsed)) &&
          (!hasUrlParams || persistedToolStateMatchesUrl(parsed, urlParams));
        if (looksGood) {
          appliedRef.current = true;
          onSnapshot(parsed as T);
          return;
        }
      }
    } catch {
      // Fall through — server snapshot or autorun may run
    }
  }, [pageKey, shouldHydrate, onSnapshot, hasPersistedResults]);

  useEffect(() => {
    if (appliedRef.current || !shouldHydrate) return;

    const hasUrlParams =
      typeof window !== "undefined" && hasMeaningfulSearchParams(window.location.search);

    // With URL params we only restore from localStorage (layout effect above);
    // never fetch the server snapshot so shared links still autorun when cache is empty.
    if (hasUrlParams) {
      return;
    }

    appliedRef.current = true;

    const controller = new AbortController();
    fetch(`/api/tool-snapshots?pageKey=${pageKey}`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Snapshot API returned ${res.status}: ${res.statusText}`);
        }
        return res.json() as Promise<ApiResponse<T>>;
      })
      .then((payload) => {
        if (payload.error) {
          appliedRef.current = false; // Allow retry
          onNoDataRef.current?.();
          return;
        }
        if (!payload.pageState) {
          onNoDataRef.current?.();
          return;
        }
        if (payload.pageState) {
          const ps = payload.pageState as Record<string, unknown>;
          // Stamp the snapshot's shared inputs as runSummaryInputs so the Run
          // Summary keeps the snapshot's actual run dates across client-side
          // navigations (in-memory page cache drops the server-side `metadata`).
          const pageStateWithRunInputs = {
            ...ps,
            runSummaryInputs: payload.sharedInputs
              ? {
                  startDate: payload.sharedInputs.startDate,
                  endDate: payload.sharedInputs.endDate,
                  windowLength: payload.sharedInputs.windowLength as number | undefined,
                  smaSpPeriod: payload.sharedInputs.smaSpPeriod,
                  smaSpUpperBuffer: payload.sharedInputs.smaSpUpperBuffer,
                  smaSpLowerBuffer: payload.sharedInputs.smaSpLowerBuffer,
                  smaNqPeriod: payload.sharedInputs.smaNqPeriod,
                  smaNqUpperBuffer: payload.sharedInputs.smaNqUpperBuffer,
                  smaNqLowerBuffer: payload.sharedInputs.smaNqLowerBuffer,
                  letf: typeof payload.sharedInputs.preset === "string" ? payload.sharedInputs.preset : undefined,
                  riskOffAsset: typeof payload.sharedInputs.riskOffAsset === "string" ? payload.sharedInputs.riskOffAsset : undefined,
                }
              : undefined,
          } as T;
          onSnapshotRef.current(pageStateWithRunInputs);
        }
        const meta = {
          snapshotEndDate: payload.snapshotEndDate,
          sharedInputs: payload.sharedInputs,
        };
        setMetadata(meta);
        onMetadataRef.current?.(meta);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          appliedRef.current = false; // Allow retry
          onNoDataRef.current?.();
        }
      });

    return () => {
      // Don't abort - let the fetch complete even if component re-renders
    };
  }, [pageKey, shouldHydrate]);

  const clearMetadata = useCallback(() => {
    setMetadata(null);
  }, []);

  return { metadata, clearMetadata };
}
