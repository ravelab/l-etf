import { useEffect, useState } from "react";

type EtfSymbol = "UPRO" | "TQQQ" | "SSO" | "QLD";
type EtfLaunchDateMap = Partial<Record<EtfSymbol, string>>;

function toEtfSymbol(name: string): EtfSymbol | null {
  const normalized = name.replace(/-real$/, "").toUpperCase();
  if (normalized === "UPRO" || normalized === "TQQQ" || normalized === "SSO" || normalized === "QLD") {
    return normalized;
  }
  return null;
}

export function getLaunchDateForPresetName(name: string, launchDates: EtfLaunchDateMap): string {
  const symbol = toEtfSymbol(name);
  if (!symbol) return "";
  return launchDates[symbol] ?? "";
}

export function useEtfLaunchDates() {
  const [launchDates, setLaunchDates] = useState<EtfLaunchDateMap>({});

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      const response = await fetch("/api/etf-launch-dates", { signal: controller.signal });
      if (!response.ok) return;
      const payload = (await response.json()) as EtfLaunchDateMap;
      setLaunchDates(payload);
    };

    load().catch((error) => {
      if (error instanceof Error && error.name === "AbortError") return;
      console.error("Failed to load ETF launch dates:", error);
    });

    return () => controller.abort();
  }, []);

  return launchDates;
}
