import type { IndexKey } from "./types";
import { NDX_ARGMAX_VOL_GATE, SMA_VOL_GATE, SMA_VOL_GATE_PARAMS_TEXT, type VolGateParams } from "./vol-gate";
import { SMA_RSI_BRAKE, SMA_RSI_BRAKE_PARAMS_TEXT, type RsiBrakeParams } from "./rsi-brake";

// Opt-in Signals alternative using the calibrated SMA band with more responsive gates.
const HIGHER_TURNOVER_GATES = {
  sp500: {
    volGate: { windowDays: 21, exitAbove: 0.26, reenterBelow: 0.23 },
    rsiBrake: { periodDays: 5, exitBelow: 4, reenterAbove: 79 },
  },
  nasdaq100: {
    volGate: NDX_ARGMAX_VOL_GATE,
    rsiBrake: { periodDays: 5, exitBelow: 6, reenterAbove: 54 },
  },
} satisfies Record<IndexKey, { volGate: VolGateParams; rsiBrake: RsiBrakeParams }>;

/**
 * Everything the `smaVolGate` switch turns on for one index's signals: the
 * volatility gate (`vol-gate.ts`) and the RSI crash brake (`rsi-brake.ts`).
 * Every signal generator resolves the switch through this, so a new layer is
 * added in one place rather than at each call site.
 */
export function smaRiskOffGates(index: IndexKey, higherTurnover = false): { volGate: VolGateParams; rsiBrake: RsiBrakeParams } {
  if (higherTurnover) return HIGHER_TURNOVER_GATES[index];
  return { volGate: SMA_VOL_GATE[index], rsiBrake: SMA_RSI_BRAKE[index] };
}

export function describeSmaRiskOffGates(index: IndexKey, higherTurnover = false): string {
  const { volGate, rsiBrake } = smaRiskOffGates(index, higherTurnover);
  return `Vol ${volGate.windowDays}d ${Math.round(volGate.exitAbove * 100)}%/${Math.round(volGate.reenterBelow * 100)}%, RSI ${rsiBrake.periodDays}d <${rsiBrake.exitBelow}/>${rsiBrake.reenterAbove}`;
}

/** Both layers' parameters, for summaries of the gate switch. */
export const SMA_RISK_OFF_GATES_PARAMS_TEXT = `${SMA_VOL_GATE_PARAMS_TEXT}; ${SMA_RSI_BRAKE_PARAMS_TEXT}`;
