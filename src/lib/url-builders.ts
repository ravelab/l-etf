import { type EtfPreset } from "./simulation/presets";
import type { EtfConfig } from "./simulation/types";
import { buildToolsUrl } from "./tools-route";

export function buildPresetBacktestUrl(p: {
  preset: EtfPreset;
  startDate: string;
  endDate: string;
  smaPeriod: number;
  smaBuffer: number;
  riskOffAsset: EtfConfig["riskOffAsset"];
}): string {
  const params = new URLSearchParams();
  params.set("letf", p.preset.name);
  params.set("sd", p.startDate);
  params.set("ed", p.endDate);
  if (p.preset.index === "nasdaq100") {
    if (p.smaPeriod) params.set("smaPnq", String(p.smaPeriod));
    if (p.smaBuffer) params.set("smatnq", String(p.smaBuffer));
  } else {
    if (p.smaPeriod) params.set("smaPsp", String(p.smaPeriod));
    if (p.smaBuffer) params.set("smatsp", String(p.smaBuffer));
  }
  if (p.riskOffAsset) params.set("ro", p.riskOffAsset);
  return buildToolsUrl("backtest", params, { autorun: true });
}
