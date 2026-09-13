import { type EtfPreset } from "./simulation/presets";
import type { EtfConfig } from "./simulation/types";
import { buildToolsUrl } from "./tools-route";
import { SMA_BUFFER_URL_KEYS } from "./sma-buffer-url-params";

export function buildPresetBacktestUrl(p: {
  preset: EtfPreset;
  startDate: string;
  endDate: string;
  smaPeriod: number;
  smaUpperBuffer: number;
  smaLowerBuffer: number;
  riskOffAsset: EtfConfig["riskOffAsset"];
}): string {
  const params = new URLSearchParams();
  params.set("letf", p.preset.name);
  params.set("sd", p.startDate);
  params.set("ed", p.endDate);
  if (p.preset.index === "nasdaq100") {
    if (p.smaPeriod) params.set("smaPnq", String(p.smaPeriod));
    if (p.smaUpperBuffer != null) params.set(SMA_BUFFER_URL_KEYS.nqUpper, String(p.smaUpperBuffer));
    if (p.smaLowerBuffer != null) params.set(SMA_BUFFER_URL_KEYS.nqLower, String(p.smaLowerBuffer));
  } else {
    if (p.smaPeriod) params.set("smaPsp", String(p.smaPeriod));
    if (p.smaUpperBuffer != null) params.set(SMA_BUFFER_URL_KEYS.spUpper, String(p.smaUpperBuffer));
    if (p.smaLowerBuffer != null) params.set(SMA_BUFFER_URL_KEYS.spLower, String(p.smaLowerBuffer));
  }
  if (p.riskOffAsset) params.set("ro", p.riskOffAsset);
  return buildToolsUrl("backtest", params, { autorun: true });
}
