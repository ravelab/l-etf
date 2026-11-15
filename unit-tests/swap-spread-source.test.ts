import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  replaceSwapSpreadModelLiteral,
  SWAP_SPREAD_SOURCE_PATH,
} from "../scripts/lib/swap-spread-source";
import { getSwapSpreadModel } from "../src/lib/simulation/swap-spread";

const source = readFileSync(join(process.cwd(), ...SWAP_SPREAD_SOURCE_PATH), "utf-8");

test("calibration rewrites the shipped model literal in place", () => {
  // Re-rendering the current model must touch only the dated comments: the
  // markers are found and every coefficient round-trips at six decimals.
  const rewritten = replaceSwapSpreadModelLiteral(source, getSwapSpreadModel(), "2000-01-01");
  const strip = (text: string) => text.replace(/calibrated \d{4}-\d{2}-\d{2}/g, "calibrated <date>");
  assert.equal(strip(rewritten), strip(source));
});

test("a calibration result lands in the source and nowhere else", () => {
  const model = getSwapSpreadModel();
  model.sp500[3] = { rateSensitivity: 0.123456, baseSpread: 0.000789 };
  const rewritten = replaceSwapSpreadModelLiteral(source, model, "2000-01-01");
  assert.match(rewritten, /3: \{ rateSensitivity: 0\.123456, baseSpread: 0\.000789 \}/);
  assert.equal(rewritten.split("\n").length, source.split("\n").length);
});

test("a moved model fails the calibration run instead of shipping stale coefficients", () => {
  assert.throws(
    () => replaceSwapSpreadModelLiteral("export const nothing = 1;", getSwapSpreadModel(), "2000-01-01"),
    /Could not find SWAP_SPREAD_MODEL/
  );
});
