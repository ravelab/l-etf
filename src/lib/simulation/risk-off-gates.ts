import type { IndexKey } from "./types";
import { SMA_VOL_GATE, SMA_VOL_GATE_PARAMS_TEXT, type VolGateParams } from "./vol-gate";
import { SMA_RSI_BRAKE, SMA_RSI_BRAKE_PARAMS_TEXT, type RsiBrakeParams } from "./rsi-brake";

/**
 * Everything the `smaVolGate` switch turns on for one index's signals: the
 * volatility gate (`vol-gate.ts`) and the RSI crash brake (`rsi-brake.ts`).
 * Every signal generator resolves the switch through this, so a new layer is
 * added in one place rather than at each call site.
 */
export function smaRiskOffGates(index: IndexKey): { volGate: VolGateParams; rsiBrake: RsiBrakeParams } {
  return { volGate: SMA_VOL_GATE[index], rsiBrake: SMA_RSI_BRAKE[index] };
}

/** Both layers' parameters, for summaries of the gate switch. */
export const SMA_RISK_OFF_GATES_PARAMS_TEXT = `${SMA_VOL_GATE_PARAMS_TEXT}; ${SMA_RSI_BRAKE_PARAMS_TEXT}`;
