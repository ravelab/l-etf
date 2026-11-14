/**
 * Futures page "Micro Futures" switch in the URL (`mf`). It defaults on
 * (`DEFAULT_MICRO_FUTURES`), so the page always writes it explicitly: `mf=0` is
 * the only way a link can ask for full contracts.
 */
const MICRO_FUTURES_URL_PARAM = "mf";

/** The URL's choice, or `undefined` when it names none (the page keeps its state). */
export function readMicroFuturesUrlParam(params: URLSearchParams): boolean | undefined {
  const raw = params.get(MICRO_FUTURES_URL_PARAM);
  if (raw == null) return undefined;
  return raw === "1" || raw === "true";
}

export function appendMicroFuturesUrlParam(params: URLSearchParams, microFutures: boolean): void {
  params.set(MICRO_FUTURES_URL_PARAM, microFutures ? "1" : "0");
}
