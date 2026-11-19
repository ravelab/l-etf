/** Canonical URL keys for asymmetric SMA re-entry/exit bands (shared across tool tabs). */
export const SMA_BUFFER_URL_KEYS = {
  spUpper: "smatspU",
  spLower: "smatspL",
  nqUpper: "smatnqU",
  nqLower: "smatnqL",
} as const;

/** Present as "1" only when the volatility risk-off gate is on. */
export const SMA_VOL_GATE_URL_KEY = "vg";

/** Present as "1" only when the SMA band runs on the CPI-deflated index. */
export const SMA_INFLATION_URL_KEY = "ia";

type SmaBufferUrlFields = {
  smaSpUpperBuffer: number;
  smaSpLowerBuffer: number;
  smaNqUpperBuffer: number;
  smaNqLowerBuffer: number;
  smaVolGate: boolean;
  smaInflationAdjusted: boolean;
};

function parseNumParam(params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key);
  if (raw == null || raw === "") return undefined;
  const v = Number(raw);
  return Number.isFinite(v) ? v : undefined;
}

function urlNumMatchesState(params: URLSearchParams, key: string, stateVal: unknown): boolean {
  const raw = params.get(key);
  if (raw == null || raw === "") return true;
  const a = Number(stateVal);
  const b = Number(raw);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a === b;
}

/** Write all four asymmetric SMA buffer params, the volatility gate and inflation flags. */
export function appendSmaBufferUrlParams(params: URLSearchParams, values: SmaBufferUrlFields): void {
  deleteSmaBufferUrlParams(params);
  params.set(SMA_BUFFER_URL_KEYS.spUpper, String(values.smaSpUpperBuffer));
  params.set(SMA_BUFFER_URL_KEYS.spLower, String(values.smaSpLowerBuffer));
  params.set(SMA_BUFFER_URL_KEYS.nqUpper, String(values.smaNqUpperBuffer));
  params.set(SMA_BUFFER_URL_KEYS.nqLower, String(values.smaNqLowerBuffer));
  if (values.smaVolGate) params.set(SMA_VOL_GATE_URL_KEY, "1");
  if (values.smaInflationAdjusted) params.set(SMA_INFLATION_URL_KEY, "1");
}

/** Remove SMA buffer keys (and the gate and inflation flags) from a URLSearchParams object. */
export function deleteSmaBufferUrlParams(params: URLSearchParams): void {
  for (const key of Object.values(SMA_BUFFER_URL_KEYS)) params.delete(key);
  params.delete(SMA_VOL_GATE_URL_KEY);
  params.delete(SMA_INFLATION_URL_KEY);
}

function hasSmaBufferUrlParams(params: URLSearchParams): boolean {
  return Object.values(SMA_BUFFER_URL_KEYS).some((key) => params.has(key));
}

/**
 * The gate flag is written only when on, so a link that carries the SMA
 * buffers but no flag means "off". A link with neither says nothing.
 */
function parseSmaFlagUrlParam(params: URLSearchParams, key: string): boolean | undefined {
  if (params.has(key)) return params.get(key) === "1";
  return hasSmaBufferUrlParams(params) ? false : undefined;
}

/** Parse SMA buffer fields from URL params. */
export function parseSmaBufferUrlParams(params: URLSearchParams): Partial<SmaBufferUrlFields> {
  const out: Partial<SmaBufferUrlFields> = {};

  const spUpper = parseNumParam(params, SMA_BUFFER_URL_KEYS.spUpper);
  if (spUpper != null) out.smaSpUpperBuffer = spUpper;

  const spLower = parseNumParam(params, SMA_BUFFER_URL_KEYS.spLower);
  if (spLower != null) out.smaSpLowerBuffer = spLower;

  const nqUpper = parseNumParam(params, SMA_BUFFER_URL_KEYS.nqUpper);
  if (nqUpper != null) out.smaNqUpperBuffer = nqUpper;

  const nqLower = parseNumParam(params, SMA_BUFFER_URL_KEYS.nqLower);
  if (nqLower != null) out.smaNqLowerBuffer = nqLower;

  const volGate = parseSmaFlagUrlParam(params, SMA_VOL_GATE_URL_KEY);
  if (volGate != null) out.smaVolGate = volGate;

  const inflationAdjusted = parseSmaFlagUrlParam(params, SMA_INFLATION_URL_KEY);
  if (inflationAdjusted != null) out.smaInflationAdjusted = inflationAdjusted;

  return out;
}

/** True when every buffer param present in the URL matches persisted state. */
export function urlSmaBuffersMatchState(
  params: URLSearchParams,
  state: Partial<SmaBufferUrlFields>
): boolean {
  if (!urlNumMatchesState(params, SMA_BUFFER_URL_KEYS.spUpper, state.smaSpUpperBuffer)) return false;
  if (!urlNumMatchesState(params, SMA_BUFFER_URL_KEYS.spLower, state.smaSpLowerBuffer)) return false;
  if (!urlNumMatchesState(params, SMA_BUFFER_URL_KEYS.nqUpper, state.smaNqUpperBuffer)) return false;
  if (!urlNumMatchesState(params, SMA_BUFFER_URL_KEYS.nqLower, state.smaNqLowerBuffer)) return false;
  const volGate = parseSmaFlagUrlParam(params, SMA_VOL_GATE_URL_KEY);
  if (volGate != null && volGate !== (state.smaVolGate === true)) return false;
  const inflationAdjusted = parseSmaFlagUrlParam(params, SMA_INFLATION_URL_KEY);
  if (inflationAdjusted != null && inflationAdjusted !== (state.smaInflationAdjusted === true)) return false;
  return true;
}
