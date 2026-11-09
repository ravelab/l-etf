import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { prependNdxProxyHistory } from "../src/lib/data/ndx-proxy-splice";
import type { DailyPrice } from "../src/lib/data/storage/types";
import { CONSTANT_NASDAQ100_START_DATE } from "../src/lib/constants";

const ANCHOR = "1985-01-31";
const ER = 0.0001;

function ndxRow(date: string, adj: number, close: number, open: number): DailyPrice {
  return { date, adj_close: adj, close, open, name: "NDX-TR", source: "real" };
}

// The proxy implies TR +10% / price +8% on 01-29, TR +5% / price +4% on 01-30,
// and TR -2% / price -2.5% on the anchor day itself.
function sampleProxy() {
  return [
    { date: "1985-01-28", adj_close: 1, close: 10 },
    { date: "1985-01-29", adj_close: 1.1, close: 10.8 },
    { date: "1985-01-30", adj_close: 1.155, close: 11.232 },
    { date: ANCHOR, adj_close: 1.1319, close: 10.9512 },
  ];
}

function sampleRows(): DailyPrice[] {
  return [
    // A stale pre-anchor row (the old Composite backfill) that must be replaced.
    { date: "1985-01-30", adj_close: 9, close: 99, open: 98, name: "NDQ-TR", source: "old" },
    ndxRow(ANCHOR, 2, 125, 125),
    ndxRow("1985-02-01", 2.02, 124.63, 125),
  ];
}

function splice(rows = sampleRows(), proxyRows = sampleProxy()) {
  return prependNdxProxyHistory({ rows, proxyRows, anchorDate: ANCHOR, dailyExpense: ER, name: "FF-BUSEQ-TR", source: "proxy" });
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-12;

test("rows from the anchor on are untouched; older rows are replaced by the proxy", () => {
  const { rows, prependedCount } = splice();
  assert.equal(prependedCount, 3);
  assert.deepEqual(rows.map((r) => r.date), ["1985-01-28", "1985-01-29", "1985-01-30", ANCHOR, "1985-02-01"]);
  assert.deepEqual(rows.slice(3), sampleRows().slice(1));
  assert.ok(rows.slice(0, 3).every((r) => r.name === "FF-BUSEQ-TR" && r.source === "proxy"));
});

test("total return follows the proxy less the daily expense; price follows the proxy's price", () => {
  const { rows } = splice();
  const proxy = sampleProxy();
  for (let i = 1; i < 4; i++) {
    const trGrowth = proxy[i].adj_close / proxy[i - 1].adj_close;
    const priceGrowth = proxy[i].close / proxy[i - 1].close;
    assert.ok(close(rows[i].adj_close! / rows[i - 1].adj_close!, trGrowth - ER), `TR growth on ${rows[i].date}`);
    assert.ok(close(rows[i].close! / rows[i - 1].close!, priceGrowth), `price growth on ${rows[i].date}`);
  }
});

test("opens are carried from the previous close, the first one from its own close", () => {
  const { rows } = splice();
  assert.equal(rows[0].open, rows[0].close);
  assert.equal(rows[1].open, rows[0].close);
  assert.equal(rows[2].open, rows[1].close);
});

test("refuses a missing anchor or a proxy gap rather than splicing a wrong seam", () => {
  assert.throws(() => splice(sampleRows().filter((r) => r.date !== ANCHOR)), /no index-nq row at 1985-01-31/);
  assert.throws(() => splice(sampleRows(), sampleProxy().filter((r) => r.date !== ANCHOR)), /no proxy session on 1985-01-31/);
  assert.throws(
    () => splice(sampleRows(), sampleProxy().map((r) => (r.date === "1985-01-29" ? { ...r, close: 0 } : r))),
    /non-positive proxy level on 1985-01-29/
  );
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

test("index-nq.csv: the NDX proxy covers 1926-07-01 up to real NDX, and nothing older", () => {
  const nq = readCsv("index-nq.csv");
  assert.equal(nq[0].date, CONSTANT_NASDAQ100_START_DATE);
  const pre = nq.filter((r) => r.date < ANCHOR);
  assert.ok(pre.every((r) => r.name === "FF-BUSEQ-TR"), "every pre-launch row is the proxy");
  assert.equal(nq.find((r) => r.date === ANCHOR)?.name, "NDX-TR");
});

test("index-nq.csv: proxy rows reproduce index-ffbuseq.csv's daily moves", () => {
  const nq = new Map(readCsv("index-nq.csv").map((r) => [r.date, r]));
  const proxy = readCsv("index-ffbuseq.csv");
  // Stored at 6 significant figures, so compare growth to that precision.
  for (let i = 1; i < proxy.length; i += 97) {
    const a = nq.get(proxy[i - 1].date)!, b = nq.get(proxy[i].date)!;
    const priceGrowth = Number(proxy[i].close) / Number(proxy[i - 1].close);
    assert.ok(Math.abs(Number(b.close) / Number(a.close) - priceGrowth) < 2e-5, `price on ${proxy[i].date}`);
    const trGrowth = Number(proxy[i].adj_close) / Number(proxy[i - 1].adj_close);
    assert.ok(Math.abs(Number(b.adj_close) / Number(a.adj_close) - trGrowth) < 3e-5, `TR on ${proxy[i].date}`);
  }
});
