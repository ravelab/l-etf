import { useEffect, useRef } from "react";
import { getIsoDate } from "@/lib/date";
import { hasMeaningfulSearchParams } from "@/lib/tools-route";

export function useRefreshEndDateOnInitialVisit(params: {
  active?: boolean;
  hasCachedResults: boolean;
  shouldHydrateSnapshot: boolean;
  endDate: string;
  setEndDate: (value: string) => void;
}) {
  const appliedRef = useRef(false);

  useEffect(() => {
    if (!params.active || appliedRef.current) return;
    if (typeof window === "undefined") return;
    if (hasMeaningfulSearchParams(window.location.search)) return;
    if (params.hasCachedResults) return;
    if (params.shouldHydrateSnapshot) return;

    appliedRef.current = true;
    const today = getIsoDate(new Date());
    if (params.endDate !== today) {
      params.setEndDate(today);
    }
  }, [params]);
}
