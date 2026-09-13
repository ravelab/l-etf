// Links from an MCP result back to the same run on the site.
//
// A tool result is a table of numbers; the site shows the same run as a chart
// with its trade log, which is where a reader checks whether a backtest means
// what the summary claims. The link is a plain URL field rather than an MCP
// `resource_link` block on purpose: a client that treats a resource link as
// server-readable would call `resources/read` on an `https://` URI this server
// does not serve.
//
// Only links that genuinely open the same strategy belong here. Both builders
// return undefined rather than approximating — a link that silently opens a
// different run is worse than none.

import { SITE_URL } from "@/lib/seo";
import { ETF_PRESETS } from "@/lib/simulation/presets";
import { buildPresetBacktestUrl } from "@/lib/url-builders";
import { buildToolsUrl } from "@/lib/tools-route";
import { buildFuturesLadderPlan, type SmaBand } from "@/lib/simulation/futures-plan";
import { SMA_BUFFER_URL_KEYS } from "@/lib/sma-buffer-url-params";
import type { EtfConfig, IndexKey } from "@/lib/simulation/types";

type RiskOffAsset = EtfConfig["riskOffAsset"];

interface BacktestLinkParams {
  preset?: string;
  startDate: string;
  endDate: string;
  smaPeriod: number;
  smaUpperBuffer: number;
  smaLowerBuffer: number;
  riskOffAsset: RiskOffAsset;
}

/**
 * Absolute URL that opens this configuration in the site's backtesting tool and
 * runs it. Undefined for anything a named preset does not describe — a custom
 * leverage/index has no preset the page can select.
 *
 * Shares `buildPresetBacktestUrl` with the four compare pages that build the
 * same link, so the parameter spelling cannot drift between them.
 */
export function backtestPermalink(params: BacktestLinkParams): string | undefined {
  if (!params.preset) return undefined;
  const preset = ETF_PRESETS[params.preset];
  if (!preset || !preset.simulated) return undefined;

  return `${SITE_URL}${buildPresetBacktestUrl({
    preset,
    startDate: params.startDate,
    endDate: params.endDate,
    smaPeriod: params.smaPeriod,
    smaUpperBuffer: params.smaUpperBuffer,
    smaLowerBuffer: params.smaLowerBuffer,
    riskOffAsset: params.riskOffAsset,
  })}`;
}

interface FuturesLinkParams {
  index: IndexKey;
  targetLeverage: number;
  maxLeverage?: number;
  startDate: string;
  endDate: string;
  smaPeriod: number;
  smaUpperBuffer: number;
  smaLowerBuffer: number;
  riskOffAsset: RiskOffAsset;
  initialEquity: number;
}

/** Whether the page's ladder contains this exact single-index rung. */
function findLadderRung(
  params: FuturesLinkParams,
  band: SmaBand,
  showEmulations: boolean,
): boolean {
  const yearSpan =
    (Date.parse(params.endDate) - Date.parse(params.startDate)) / (365.25 * 24 * 3600 * 1000);
  const plan = buildFuturesLadderPlan({
    showEmulations,
    hasNasdaqData: true,
    yearSpan,
    bands: { sp500: band, nasdaq100: band },
  });
  return plan.some(
    (step) =>
      // A step with a secondary sleeve is a two-index fund, not this run.
      step.secondary === undefined &&
      step.index === params.index &&
      step.leverage === params.targetLeverage &&
      (step.maxLeverage ?? null) === (params.maxLeverage ?? null),
  );
}

/**
 * Absolute URL that opens the site's futures ladder with this configuration.
 *
 * The page has no leverage input — it runs a fixed ladder of rungs
 * (`futures-plan.ts`) and renders them as a table — so this links only when the
 * requested leverage IS one of those rungs, and sets `em=1` when the rung only
 * exists in emulation mode. The rungs are read from the page's own plan builder
 * rather than restated here, for the reason `futures-plan.ts` exists.
 *
 * The link opens the whole ladder, not a single run: the requested rung is one
 * row of it. Leverage tolerance is left off, since page and engine share the
 * same default.
 */
export function futuresLadderPermalink(params: FuturesLinkParams): string | undefined {
  const band: SmaBand = {
    period: params.smaPeriod,
    upperBuffer: params.smaUpperBuffer,
    lowerBuffer: params.smaLowerBuffer,
  };

  const showEmulations = findLadderRung(params, band, false)
    ? false
    : findLadderRung(params, band, true)
      ? true
      : undefined;
  if (showEmulations === undefined) return undefined;

  const search = new URLSearchParams();
  search.set("sd", params.startDate);
  search.set("ed", params.endDate);
  if (params.index === "nasdaq100") {
    search.set("smaPnq", String(params.smaPeriod));
    search.set(SMA_BUFFER_URL_KEYS.nqUpper, String(params.smaUpperBuffer));
    search.set(SMA_BUFFER_URL_KEYS.nqLower, String(params.smaLowerBuffer));
  } else {
    search.set("smaPsp", String(params.smaPeriod));
    search.set(SMA_BUFFER_URL_KEYS.spUpper, String(params.smaUpperBuffer));
    search.set(SMA_BUFFER_URL_KEYS.spLower, String(params.smaLowerBuffer));
  }
  search.set("ro", params.riskOffAsset);
  search.set("amt", String(params.initialEquity));
  if (showEmulations) search.set("em", "1");

  return `${SITE_URL}${buildToolsUrl("futures", search, { autorun: true })}`;
}
