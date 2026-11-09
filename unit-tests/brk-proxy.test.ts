import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BRK_PROXY_EQUITY_WEIGHT, buildBrkProxyLevels, logLevelInterpolator } from "../src/lib/data/brk-proxy";

const near = (a: number, b: number, tol = 1e-12) => Math.abs(a - b) <= tol;

test("70% equity (large value from 1926, the S&P before) and 30% Treasuries, daily", () => {
  assert.equal(BRK_PROXY_EQUITY_WEIGHT, 0.7);
  const dates = ["1926-06-29", "1926-06-30", "1926-07-01", "1926-07-02"];
  const sp500 = new Map([["1926-06-29", 100], ["1926-06-30", 110], ["1926-07-01", 99], ["1926-07-02", 120]]);
  // Large value starts on 07-01, so it drives only the 07-02 step.
  const largeValue = new Map([["1926-07-01", 1], ["1926-07-02", 1.05]]);
  const treasury = new Map(dates.map((d, i) => [d, Math.log(1 + 0.001 * i)]));
  const rows = buildBrkProxyLevels({ dates, sp500, largeValue, treasuryLogLevel: (d) => treasury.get(d) ?? null });

  assert.deepEqual(rows.map((r) => r.date), dates);
  assert.equal(rows[0].close, 100);
  const tsy = (i: number) => (1 + 0.001 * i) / (1 + 0.001 * (i - 1)) - 1;
  assert.ok(near(rows[1].close / rows[0].close - 1, 0.7 * 0.1 + 0.3 * tsy(1)));
  assert.ok(near(rows[2].close / rows[1].close - 1, 0.7 * (99 / 110 - 1) + 0.3 * tsy(2)));
  assert.ok(near(rows[3].close / rows[2].close - 1, 0.7 * 0.05 + 0.3 * tsy(3)), "large value replaces the S&P");
  assert.deepEqual(rows.map((r) => r.equity), ["sp500", "sp500", "sp500", "largeValue"]);
});

test("a missing Treasury reading contributes no return; a missing equity session is an error", () => {
  const dates = ["1900-01-02", "1900-01-03"];
  const sp500 = new Map([["1900-01-02", 10], ["1900-01-03", 11]]);
  const rows = buildBrkProxyLevels({ dates, sp500, largeValue: new Map(), treasuryLogLevel: () => null });
  assert.ok(near(rows[1].close / rows[0].close - 1, 0.07));
  assert.throws(
    () => buildBrkProxyLevels({ dates: [...dates, "1900-01-04"], sp500, largeValue: new Map(), treasuryLogLevel: () => null }),
    /no equity return for 1900-01-04/
  );
});

test("logLevelInterpolator reads monthly YYYY-MM rows as the 1st and interpolates in calendar days", () => {
  const at = logLevelInterpolator([
    { date: "1900-01", adj_close: Math.E },
    { date: "1900-02", adj_close: Math.E ** 2 },
    { date: "1900-02-11", adj_close: Math.E ** 3 },
  ]);
  assert.ok(near(at("1900-01-01")!, 1));
  assert.ok(near(at("1900-01-16")!, 1 + 15 / 31));
  assert.ok(near(at("1900-02-06")!, 2 + 5 / 10));
  assert.ok(near(at("1899-12-01")!, 1), "before the first row: the first level");
  assert.ok(near(at("1901-01-01")!, 3), "after the last row: the last level");
});

function readCsv(filename: string): Array<Record<string, string>> {
  const raw = readFileSync(join(process.cwd(), "data", filename), "utf-8").trim();
  const [header, ...lines] = raw.split("\n");
  const cols = header.split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

test("risk-brka.csv: real BRK-A from 1980-03-17, the 70/30 proxy before it", () => {
  const brk = readCsv("risk-brka.csv");
  const firstReal = brk.findIndex((r) => r.name === "BRK-A");
  assert.equal(brk[firstReal].date, "1980-03-17");
  assert.ok(brk.slice(firstReal).every((r) => r.name === "BRK-A"));
  const pre = brk.slice(0, firstReal);
  assert.ok(pre.filter((r) => r.date < "1926-07-02").every((r) => r.name === "SP500+VGSH(70/30)"));
  assert.ok(pre.filter((r) => r.date >= "1926-07-02").every((r) => r.name === "FFLV+VGSH(70/30)"));
});

test("risk-brka.csv: the proxy's equity leg is index-fflargevalue.csv from 1926", () => {
  const brk = new Map(readCsv("risk-brka.csv").map((r) => [r.date, Number(r.adj_close)]));
  const lv = readCsv("index-fflargevalue.csv");
  const vgsh = logLevelInterpolator(readCsv("risk-vgsh.csv").map((r) => ({ date: r.date, adj_close: Number(r.adj_close) })));
  // Stored at 6 significant figures, so compare growth to that precision.
  for (let i = 1; i < lv.length; i += 89) {
    const [a, b] = [lv[i - 1], lv[i]];
    const lvRet = Number(b.adj_close) / Number(a.adj_close) - 1;
    const tsyRet = Math.exp(vgsh(b.date)! - vgsh(a.date)!) - 1;
    const actual = brk.get(b.date)! / brk.get(a.date)! - 1;
    assert.ok(Math.abs(actual - (0.7 * lvRet + 0.3 * tsyRet)) < 3e-5, `${b.date}`);
  }
});

test("risk-brka.csv: before 1926 the proxy is 70% S&P / 30% VGSH", () => {
  const brk = readCsv("risk-brka.csv").filter((r) => r.date < "1926-07-01");
  const sp = new Map(readCsv("index-sp.csv").map((r) => [r.date, Number(r.adj_close)]));
  const vgsh = logLevelInterpolator(readCsv("risk-vgsh.csv").map((r) => ({ date: r.date, adj_close: Number(r.adj_close) })));
  for (let i = 1; i < brk.length; i += 97) {
    const [a, b] = [brk[i - 1], brk[i]];
    const spRet = sp.get(b.date)! / sp.get(a.date)! - 1;
    const tsyRet = Math.exp(vgsh(b.date)! - vgsh(a.date)!) - 1;
    const actual = Number(b.adj_close) / Number(a.adj_close) - 1;
    assert.ok(Math.abs(actual - (0.7 * spRet + 0.3 * tsyRet)) < 3e-5, `${b.date}`);
  }
});
