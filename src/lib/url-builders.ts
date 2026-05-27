import { type EtfPreset } from "./simulation/presets";
import type { EtfConfig } from "./simulation/types";
import { buildToolsUrl } from "./tools-route";

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
    if (p.smaUpperBuffer != null) params.set("smatnqU", String(p.smaUpperBuffer));
    if (p.smaLowerBuffer != null) params.set("smatnqL", String(p.smaLowerBuffer));
  } else {
    if (p.smaPeriod) params.set("smaPsp", String(p.smaPeriod));
    if (p.smaUpperBuffer != null) params.set("smatspU", String(p.smaUpperBuffer));
    if (p.smaLowerBuffer != null) params.set("smatspL", String(p.smaLowerBuffer));
  }
  if (p.riskOffAsset) params.set("ro", p.riskOffAsset);
  return buildToolsUrl("backtest", params, { autorun: true });
}
