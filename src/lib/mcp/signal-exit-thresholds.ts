import { SMA_VOL_GATE } from "@/lib/simulation/vol-gate";
import { SMA_RSI_BRAKE, computeWilderAverages, rsiFromAverages, type RsiBrakeParams } from "@/lib/simulation/rsi-brake";
import type { IndexKey } from "@/lib/simulation/types";

/** Deterministic boundaries, not forecasts. All returns are signed percentages. */
export function signalExitThresholds(input: {
  index: IndexKey;
  prices: ReadonlyArray<{ date: string; close?: number }>;
  smaPeriod: number;
  smaLowerBuffer: number;
  volEnabled: boolean;
  volGateRiskOff: boolean;
  rsiBrakeEnabled: boolean;
  rsiBrakeRiskOff: boolean;
}) {
  const { prices, smaPeriod, smaLowerBuffer } = input;
  const closes = prices.map(p => p.close ?? NaN);
  const last = closes.at(-1);
  const gate = SMA_VOL_GATE[input.index];
  const valid = (values: number[]) => values.every(v => Number.isFinite(v) && v > 0);
  const smaTail = closes.slice(-(smaPeriod - 1));
  const multiplier = 1 - smaLowerBuffer / 100;
  const nextSmaExitClose = last != null && valid([last]) && smaTail.length === smaPeriod - 1 && valid(smaTail)
    ? multiplier * smaTail.reduce((sum, value) => sum + value, 0) / (smaPeriod - multiplier)
    : null;
  const volTail = closes.slice(-gate.windowDays);
  const status = !input.volEnabled ? "disabled" as const
    : input.volGateRiskOff ? "already-risk-off" as const
    : volTail.length < gate.windowDays || !valid(volTail) ? "insufficient-data" as const
    : "available" as const;
  const scenarios: Array<{ tradingDays: number; dailyReturnPctAtHorizon: number; dailyReturnPctByHorizon: number }> = [];
  let nextVolExitRisePct: number | null = null;
  if (status === "available") {
    const returns = volTail.slice(1).map((value, i) => Math.log(value / volTail[i]));
    let byHorizon = -Infinity;
    for (let days = 1; days <= 7; days++) {
      const n = gate.windowDays;
      const retained = returns.slice(-(n - days));
      const sum = retained.reduce((s, r) => s + r, 0);
      const sumSq = retained.reduce((s, r) => s + r * r, 0);
      // Sample variance of retained returns plus `days` identical log returns.
      const a = days - days * days / n;
      const b = -2 * sum * days / n;
      const c = sumSq - sum * sum / n - (n - 1) * gate.exitAbove ** 2 / 252;
      const root = Math.sqrt(Math.max(0, b * b - 4 * a * c));
      const negative = c >= 0 ? 0 : (-b - root) / (2 * a);
      const dailyReturnPctAtHorizon = Math.expm1(negative) * 100;
      byHorizon = Math.max(byHorizon, dailyReturnPctAtHorizon);
      scenarios.push({ tradingDays: days, dailyReturnPctAtHorizon, dailyReturnPctByHorizon: byHorizon });
      if (days === 1) nextVolExitRisePct = Math.expm1(c >= 0 ? 0 : (-b + root) / (2 * a)) * 100;
    }
  }
  const rsiBrake = rsiBrakeThreshold(closes, SMA_RSI_BRAKE[input.index], input.rsiBrakeEnabled, input.rsiBrakeRiskOff);
  return {
    asOf: prices.at(-1)?.date ?? null,
    nextSmaExitClose,
    nextSmaExitReturnPct: nextSmaExitClose != null && last != null ? (nextSmaExitClose / last - 1) * 100 : null,
    volatility: {
      status,
      windowDays: gate.windowDays,
      exitAbovePct: gate.exitAbove * 100,
      reenterBelowPct: gate.reenterBelow * 100,
      nextVolExitRisePct,
      constantDeclineScenarios: scenarios,
    },
    rsiBrake,
    note: "Boundaries, not probabilities. Signed close-to-close returns; each scenario repeats the same percentage return every day. AtHorizon measures volatility on that close; ByHorizon means on any close up to that day. Zero means a flat path reaches the boundary. Volatility must exceed its threshold; price must fall below the SMA exit close; the RSI brake trips when the next close is below its exit close (Wilder RSI below the exit level). SMA updates with the next close. Whichever rule's boundary is nearest exits first. Already-active or disabled gates have no new-exit boundary. Default execution is the following trading day's open.",
  };
}

/**
 * The next close at which the brake's Wilder RSI lands exactly on its exit
 * level. With smoothed averages G and L, a decline d gives
 * RSI = 100 − 100 / (1 + G(n−1) / (L(n−1) + d)), so the boundary decline is
 * d = (n−1)(G(100−a)/a − L); any lower close trips the brake.
 */
function rsiBrakeThreshold(closes: number[], brake: RsiBrakeParams, enabled: boolean, riskOff: boolean) {
  const n = brake.periodDays;
  const last = closes.at(-1);
  const recent = closes.slice(-(n + 1));
  const { gain, loss } = computeWilderAverages(closes, n);
  const g = gain.at(-1) ?? NaN;
  const l = loss.at(-1) ?? NaN;
  const rsi = rsiFromAverages(g, l);
  const status = !enabled ? "disabled" as const
    : riskOff ? "already-risk-off" as const
    : last == null || recent.length < n + 1 || !recent.every(v => Number.isFinite(v) && v > 0) || !Number.isFinite(rsi)
      ? "insufficient-data" as const
      : "available" as const;
  let nextExitClose: number | null = null;
  if (status === "available" && last != null) {
    const a = brake.exitBelow;
    const decline = Math.max(0, (n - 1) * (g * (100 - a) / a - l));
    nextExitClose = decline < last ? last - decline : null;
  }
  return {
    status,
    periodDays: n,
    exitBelow: brake.exitBelow,
    reenterAbove: brake.reenterAbove,
    rsi: status !== "insufficient-data" && Number.isFinite(rsi) ? rsi : null,
    nextExitClose,
    nextExitReturnPct: nextExitClose != null && last != null ? (nextExitClose / last - 1) * 100 : null,
  };
}
