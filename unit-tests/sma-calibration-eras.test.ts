import { strict as assert } from "node:assert";
import { it } from "node:test";
import { SMA_CALIBRATION_ERAS, combineEraScores } from "../src/lib/simulation/sma-calibration-eras";
import { CONSTANT_SP500_SHORTCUT_DATE, CONSTANT_NASDAQ100_SHORTCUT_DATE } from "../src/lib/constants";
it("scores only the observed index era", () => {
  for (const [index, start] of [["sp500", CONSTANT_SP500_SHORTCUT_DATE], ["nasdaq100", CONSTANT_NASDAQ100_SHORTCUT_DATE]] as const) {
    assert.deepEqual(SMA_CALIBRATION_ERAS[index].map(e => [e.key, e.startDate, e.weight, e.endDate]), [["start", start, 100, undefined]]);
    assert.equal(combineEraScores(index, {start: 123, proto: -99999}), 123);
    assert.ok(Number.isNaN(combineEraScores(index, {})));
  }
});
