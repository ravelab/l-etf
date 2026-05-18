import test from "node:test";
import assert from "node:assert/strict";
import {
  calcMaxDrawdown,
  calcMonthlyExtremes,
} from "@/lib/simulation/metrics";

function makeDates(months: string[], daysPerMonth: number): string[] {
  const dates: string[] = [];
  for (const month of months) {
    for (let d = 1; d <= daysPerMonth; d++) {
      dates.push(`${month}-${String(d).padStart(2, "0")}`);
    }
  }
  return dates;
}

test("calcMonthlyExtremes uses first day of each month as base, not last day of previous month", () => {
  // Jan: 10 days, grows 10% (100 → 110)
  // Feb: 10 days, drops 5% (110 → 104.5)
  const janValues = Array.from({ length: 10 }, (_, i) => 100 + i * (10 / 9));
  const febValues = Array.from({ length: 10 }, (_, i) => 110 - i * (5.5 / 9));
  const values = [...janValues, ...febValues];
  const dates = makeDates(["2024-01", "2024-02"], 10);

  const { bestMonth, worstMonth } = calcMonthlyExtremes(values, dates);

  // Jan return: (110 - 100) / 100 = 10%
  assert.ok(Math.abs(bestMonth - 10) < 0.01, `bestMonth should be ~10%, got ${bestMonth}`);
  // Feb return should start from values[10] (first Feb day = 110), not values[9] (last Jan day ~110)
  // Feb: (104.5 - 110) / 110 = -5%
  assert.ok(Math.abs(worstMonth - (-5)) < 0.01, `worstMonth should be ~-5%, got ${worstMonth}`);
});

test("calcMonthlyExtremes monthly returns do not overlap across boundaries", () => {
  // Three months: each month is exactly flat except the first month goes up.
  // Jan: 100 → 100 (0% return)
  // Feb: 100 → 110 (+10% return)
  // Mar: 110 → 110 (0% return)
  const jan = Array.from({ length: 5 }, () => 100);
  const feb = Array.from({ length: 5 }, (_, i) => 100 + i * (10 / 4));
  const mar = Array.from({ length: 5 }, () => 110);
  const values = [...jan, ...feb, ...mar];
  const dates = makeDates(["2024-01", "2024-02", "2024-03"], 5);

  const { bestMonth, worstMonth } = calcMonthlyExtremes(values, dates);

  assert.ok(Math.abs(bestMonth - 10) < 0.01, `bestMonth should be ~10%, got ${bestMonth}`);
  assert.ok(Math.abs(worstMonth - 0) < 0.01, `worstMonth should be 0%, got ${worstMonth}`);
});

test("calcMonthlyExtremes handles single month", () => {
  const values = [100, 105, 110];
  const dates = ["2024-01-01", "2024-01-15", "2024-01-31"];
  const { bestMonth, worstMonth } = calcMonthlyExtremes(values, dates);
  assert.ok(Math.abs(bestMonth - 10) < 0.01);
  assert.ok(Math.abs(worstMonth - 10) < 0.01);
});

test("calcMonthlyExtremes returns date spans for best and worst months", () => {
  const values = [100, 110, 90, 120, 120, 96];
  const dates = [
    "2024-01-01",
    "2024-01-31",
    "2024-02-01",
    "2024-02-29",
    "2024-03-01",
    "2024-03-31",
  ];

  const result = calcMonthlyExtremes(values, dates);

  assert.equal(result.bestMonthDates?.start, "2024-02-01");
  assert.equal(result.bestMonthDates?.end, "2024-02-29");
  assert.equal(result.worstMonthDates?.start, "2024-03-01");
  assert.equal(result.worstMonthDates?.end, "2024-03-31");
});

test("calcMaxDrawdown returns date spans for max and longest drawdowns", () => {
  const values = [100, 120, 90, 130, 125, 128, 140];
  const dates = [
    "2024-01-01",
    "2024-01-02",
    "2024-01-03",
    "2024-01-04",
    "2024-01-05",
    "2024-01-10",
    "2024-01-11",
  ];

  const result = calcMaxDrawdown(values, dates);

  assert.equal(result.maxDrawdownDates?.start, "2024-01-02");
  assert.equal(result.maxDrawdownDates?.end, "2024-01-03");
  assert.equal(result.longestDrawdownDates?.start, "2024-01-04");
  assert.equal(result.longestDrawdownDates?.end, "2024-01-10");
});

test("date-dependent metric caches keep separate date arrays", () => {
  const values = [100, 50, 200];
  const dailyDates = ["2024-01-01", "2024-01-02", "2024-01-03"];
  const monthlyDates = ["2024-01-01", "2024-02-01", "2024-03-01"];

  assert.equal(calcMaxDrawdown(values, dailyDates).longestDays, 1);
  assert.equal(calcMaxDrawdown(values, monthlyDates).longestDays, 31);

  const monthlyValues = [100, 120, 60, 180];
  const oneMonthDates = ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"];
  const splitMonthDates = ["2024-01-01", "2024-01-02", "2024-02-01", "2024-02-02"];

  assert.equal(calcMonthlyExtremes(monthlyValues, oneMonthDates).bestMonth, 80);
  assert.equal(calcMonthlyExtremes(monthlyValues, splitMonthDates).bestMonth, 200);
});
