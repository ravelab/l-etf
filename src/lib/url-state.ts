import type { EtfConfig } from "./simulation/types";
import { ETF_PRESETS } from "./simulation/presets";

/**
 * Encode backtest parameters into URL search params for sharing.
 * Note: simulated flag and leverage are inferred from the preset name.
 */
/**
 * Decode URL search params back into backtest parameters.
 * Note: simulated flag and leverage are inferred from the preset name.
 */
export function decodeBacktestParams(search: string): {
  index?: string;
  startDate?: string;
  endDate?: string;
  smaSpPeriod?: number;
  smaNqPeriod?: number;
  smaSpBuffer?: number;
  smaNqBuffer?: number;
  riskOffAsset?: string;
  etfConfigs?: Partial<EtfConfig>[];
} | null {
  const params = new URLSearchParams(search);
  const hasAny =
    params.has("sd") ||
    params.has("ed") ||
    params.has("e0_n");
  if (!hasAny) return null;

  const etfConfigs: Partial<EtfConfig>[] = [];
  for (let i = 0; i < 8; i++) {
    const prefix = `e${i}`;
    const name = params.get(`${prefix}_n`);
    if (!name) break;

    // Infer simulated flag and leverage from the canonical preset name
    const matchedPreset = Object.values(ETF_PRESETS).find(
      (p) => p.name === name
    );

    etfConfigs.push({
      id: String(i),
      name,
      leverage: matchedPreset?.leverage ?? 1,
      expenseRatio: matchedPreset?.expenseRatio ?? 0,
      simulated: matchedPreset?.simulated ?? true,
      smaIndex: matchedPreset?.index ?? "sp500",
      smaEnabled: true,
    });
  }

  return {
    index: params.get("idx") || undefined,
    startDate: params.get("sd") || undefined,
    endDate: params.get("ed") || undefined,
    smaSpPeriod: (() => { const r = params.get("smaPsp"); if (!r) return undefined; const v = Number(r); return Number.isFinite(v) ? v : undefined; })(),
    smaNqPeriod: (() => { const r = params.get("smaPnq"); if (!r) return undefined; const v = Number(r); return Number.isFinite(v) ? v : undefined; })(),
    smaSpBuffer: (() => { const r = params.get("smatsp"); if (!r) return undefined; const v = Number(r); return Number.isFinite(v) ? v : undefined; })(),
    smaNqBuffer: (() => { const r = params.get("smatnq"); if (!r) return undefined; const v = Number(r); return Number.isFinite(v) ? v : undefined; })(),
    riskOffAsset: params.get("ro") || undefined,
    etfConfigs: etfConfigs.length > 0 ? etfConfigs : undefined,
  };
}
