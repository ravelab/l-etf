/** Canonical URL keys for asymmetric SMA re-entry/exit bands (shared across tool tabs). */
const SMA_BUFFER_URL_KEYS = {
  spUpper: "smatspU",
  spLower: "smatspL",
  nqUpper: "smatnqU",
  nqLower: "smatnqL",
} as const;

type SmaBufferUrlFields = {
  smaSpUpperBuffer: number;
  smaSpLowerBuffer: number;
  smaNqUpperBuffer: number;
  smaNqLowerBuffer: number;
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

/** Write all four asymmetric SMA buffer params. */
export function appendSmaBufferUrlParams(params: URLSearchParams, values: SmaBufferUrlFields): void {
  deleteSmaBufferUrlParams(params);
  params.set(SMA_BUFFER_URL_KEYS.spUpper, String(values.smaSpUpperBuffer));
  params.set(SMA_BUFFER_URL_KEYS.spLower, String(values.smaSpLowerBuffer));
  params.set(SMA_BUFFER_URL_KEYS.nqUpper, String(values.smaNqUpperBuffer));
  params.set(SMA_BUFFER_URL_KEYS.nqLower, String(values.smaNqLowerBuffer));
}

/** Remove SMA buffer keys from a URLSearchParams object. */
export function deleteSmaBufferUrlParams(params: URLSearchParams): void {
  for (const key of Object.values(SMA_BUFFER_URL_KEYS)) params.delete(key);
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
  return true;
}
