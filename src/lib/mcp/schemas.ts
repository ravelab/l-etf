// Reusable zod fragments for MCP tool input schemas. Tools compose these raw
// shapes rather than redefining validation, mirroring the boundary-validation
// style in `src/app/api/sma-signals/route.ts`.

import { z } from "zod/v4";
import { RISK_OFF_ASSET_OPTIONS } from "@/lib/constants";
import { ETF_PRESETS } from "@/lib/simulation/presets";
import { MARKET_DATA_EARLIEST_START } from "@/lib/fetch-market-data";

export const PRESET_KEYS = Object.keys(ETF_PRESETS) as [string, ...string[]];
export const RISK_OFF_ASSET_VALUES = RISK_OFF_ASSET_OPTIONS.map((o) => o.value) as [
  string,
  ...string[],
];

/** ISO calendar date (YYYY-MM-DD), no earlier than the earliest data we hold. */
export const isoDate = z
  .iso
  .date()
  .refine((d) => d >= MARKET_DATA_EARLIEST_START, {
    message: `Date must be on or after ${MARKET_DATA_EARLIEST_START}`,
  });

export const indexSchema = z.enum(["sp500", "nasdaq100"]);
export const presetSchema = z.enum(PRESET_KEYS);
export const riskOffAssetSchema = z.enum(RISK_OFF_ASSET_VALUES);

// SMA tuning ranges match the `/api/sma-signals` route contract.
export const smaPeriodSchema = z.number().int().min(5).max(500);
export const smaBufferSchema = z.number().min(0).max(30);
