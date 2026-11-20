import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  RATE_HIKE_SHOCK,
  computeRateHikeShockEpisodes,
  rateHikeShockRiskOff,
  type RateHikeShockModule,
} from "@/lib/simulation/rate-hike-shock";
import shipped from "@/lib/tool-snapshots/rate-hike-shock.json";
import { SMA_RATE_SHOCK_RULE } from "@/lib/simulation/sma-rate-shock";
import { DEFAULT_EXTRA_STRATEGY_IDS, getSignalRule, lineWarmUpDays, runSignalRule } from "@/lib/simulation/signal-rules";
import { generateSmaSignals } from "@/lib/simulation/sma";
import { smaRiskOffGates } from "@/lib/simulation/risk-off-gates";

function weekdays(from: string, count: number): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); out.length < count; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Flat at `base` for `flat` days, then up `rise` evenly over `rampDays`, then flat. */
function rates(dates: string[], base: number, flat: number, rise: number, rampDays: number) {
  return dates.map((date, i) => ({
    date,
    value: base + rise * Math.min(1, Math.max(0, (i - flat) / rampDays)),
  }));
}

test("the shipped parameters: 21-day smoothing, out above +2 points over 63 days, back below 0", () => {
  assert.deepEqual(RATE_HIKE_SHOCK, { smoothingDays: 21, windowDays: 63, exitAbovePct: 2, reenterBelowPct: 0 });
});

test("trips once the smoothed rate is up 2 points over 63 days, and releases when the rise is gone", () => {
  const dates = weekdays("1990-01-01", 400);
  // +3 points over 20 days, then back down 3 points over 20 days.
  const rows = rates(dates, 0.05, 100, 0.03, 20).map((r, i) => (i >= 250 ? { ...r, value: 0.08 - 0.03 * Math.min(1, (i - 250) / 20) } : r));
  const { episodes } = computeRateHikeShockEpisodes(rows);
  assert.equal(episodes.length, 1);
  const start = dates.indexOf(episodes[0].start);
  const end = dates.indexOf(episodes[0].end!);
  // A day's rate is known only from the next session; the 21-day mean then needs time to climb 2 points.
  assert.ok(start > 101 && start < 140, `start ${episodes[0].start}`);
  // Released once the smoothed 63-day change turns negative, i.e. after the cut begins.
  assert.ok(end > 251 && end < 300, `end ${episodes[0].end}`);
});

test("a rise of under 2 points never trips, however fast", () => {
  const dates = weekdays("1990-01-01", 300);
  assert.deepEqual(computeRateHikeShockEpisodes(rates(dates, 0.05, 100, 0.019, 5)).episodes, []);
});

test("commercial paper (before 1954-07) is a monthly average, so a month is known only once it ends", () => {
  const dates = weekdays("1920-01-01", 300);
  // Jump +4 points on the first day of a month: daily data would know it a day later.
  const jumpIdx = dates.findIndex((d) => d >= "1920-04-01");
  const rows = dates.map((date, i) => ({ date, value: i >= jumpIdx ? 0.09 : 0.05 }));
  const { episodes } = computeRateHikeShockEpisodes(rows);
  assert.equal(episodes.length, 1);
  assert.ok(episodes[0].start >= "1920-05-01", `CP jump seen before its month ended: ${episodes[0].start}`);
});

test("risk-off by date: inside [start, end), open episodes stay out", () => {
  const bundle: RateHikeShockModule = {
    params: RATE_HIKE_SHOCK,
    dataEndDate: "2000-12-29",
    episodes: [{ start: "2000-02-01", end: "2000-03-01" }, { start: "2000-12-01", end: null }],
  };
  const dates = ["2000-01-31", "2000-02-01", "2000-02-29", "2000-03-01", "2000-11-30", "2000-12-01", "2001-01-02"];
  assert.deepEqual(rateHikeShockRiskOff(dates, bundle), [false, true, true, false, false, true, true]);
});

test("the bundled episodes are exactly what data/rate-borrow.csv produces", () => {
  const csv = readFileSync(join(process.cwd(), "data", "rate-borrow.csv"), "utf8").trim().split("\n").slice(1);
  const rows = csv.map((line) => {
    const [date, value] = line.split(",");
    return { date, value: Number(value) };
  });
  const recomputed = computeRateHikeShockEpisodes(rows);
  assert.deepEqual(shipped.episodes, recomputed.episodes, "regenerate with `npm run fetch-data -- --rates`");
  assert.equal(shipped.dataEndDate, rows[rows.length - 1].date);
});

test("history: 13 episodes through 2026-10, the last in 1982", () => {
  const past = shipped.episodes.filter((e) => e.start < "2026-11-01");
  assert.deepEqual(past.map((e) => e.start.slice(0, 4)), [
    "1886", "1893", "1896", "1898", "1931", "1969", "1973", "1974", "1979", "1980", "1980", "1981", "1982",
  ]);
});

// ---- the Extra Strategies rule ----

const LINE = { smaIndex: "sp500", smaPeriod: 50, smaUpperBuffer: 2, smaLowerBuffer: 5 } as const;

/** A steady uptrend through the 1973 episode, so the band alone would stay invested. */
function uptrend(dates: string[]): number[] {
  return dates.map((_, i) => 100 * Math.pow(1.0004, i) * (1 + (i % 2 ? -0.002 : 0.002)));
}

test("the rule is the line's band, vol gate and RSI brake, also out during a rate-hike shock", () => {
  const dates = weekdays("1972-06-01", 500);
  const closes = uptrend(dates);
  const base = generateSmaSignals(dates, closes, LINE.smaPeriod, { upper: LINE.smaUpperBuffer, lower: LINE.smaLowerBuffer }, smaRiskOffGates("sp500")).invested;
  const off = rateHikeShockRiskOff(dates);
  assert.ok(off.some(Boolean), "the 1973 episode falls in this range");
  const { invested, signals } = runSignalRule(SMA_RATE_SHOCK_RULE, dates, closes, LINE);
  assert.deepEqual(invested, base.map((v, i) => v && !off[i]));
  const rateSignals = signals.filter((s) => s.trigger === "rate");
  assert.ok(rateSignals.some((s) => s.type === "sell" && s.date === "1973-07-12"));
  assert.ok(rateSignals.some((s) => s.type === "buy"));
});

test("offered for both indices, not ticked by default, and on the twin's own warm-up", () => {
  assert.equal(getSignalRule(SMA_RATE_SHOCK_RULE.id), SMA_RATE_SHOCK_RULE);
  assert.equal(SMA_RATE_SHOCK_RULE.indices, undefined);
  assert.equal(DEFAULT_EXTRA_STRATEGY_IDS.includes(SMA_RATE_SHOCK_RULE.id), false);
  assert.equal(lineWarmUpDays({ smaEnabled: true, smaPeriod: 262, signalRule: SMA_RATE_SHOCK_RULE.id }), 262);
});
