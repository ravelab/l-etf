import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "data");

function parseCsv(filename: string) {
  const raw = readFileSync(join(DATA_DIR, filename), "utf-8");
  const lines = raw.trim().split("\n");
  const headers = lines[0].split(",");
  const rows = lines.slice(1).map(line => {
    const cols = line.split(",");
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = cols[i];
    });
    return obj;
  });
  return rows;
}

test("index-sp.csv has no large price gaps or jumps", () => {
  const rows = parseCsv("index-sp.csv");
  assert.equal(rows.length > 1000, true);
  
  for (let i = 1; i < rows.length; i++) {
    const curr = Number(rows[i].adj_close);
    const prev = Number(rows[i-1].adj_close);
    const date = rows[i].date;
    
    // Test for crazy jumps (> 25% in one day - possible but extremely rare, usually data error)
    const change = Math.abs(curr / prev - 1);
    if (change > 0.25) {
      throw new Error(`Suspicious price jump on ${date}: ${prev} -> ${curr} (${(change*100).toFixed(2)}%)`);
    }
    
    // Test for invalid values
    assert.equal(Number.isFinite(curr), true, `Non-finite price on ${date}`);
    assert.equal(curr > 0, true, `Non-positive price on ${date}`);
    
    // Test for date gaps (skip weekends)
    const currDate = new Date(date);
    const prevDate = new Date(rows[i-1].date);
    const diffDays = (currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > 7) { 
      // Allow for known major historical market closures:
      // - 1888 Blizzard: 1888-03-12 to 1888-03-13 (covered by weekend logic mostly)
      // - WWI: 1914-07-31 to 1914-12-11
      // - 1933 Bank Holiday: 1933-03-06 to 1933-03-14
      // - 9/11: 2001-09-11 to 2001-09-16
      const isKnownGap = 
        (rows[i-1].date === "1914-07-30" && date === "1914-12-14") ||
        (rows[i-1].date === "1933-03-03" && date === "1933-03-15");
      
      if (!isKnownGap && diffDays > 14) {
        throw new Error(`Suspicious date gap between ${rows[i-1].date} and ${date} (${diffDays} days)`);
      }
    }
  }
});

test("index-nq.csv has no large price gaps or jumps", () => {
  const rows = parseCsv("index-nq.csv");
  assert.equal(rows.length > 1000, true);
  
  for (let i = 1; i < rows.length; i++) {
    const curr = Number(rows[i].adj_close);
    const prev = Number(rows[i-1].adj_close);
    const date = rows[i].date;
    const change = Math.abs(curr / prev - 1);
    
    if (change > 0.35) { // Nasdaq can be more volatile
       throw new Error(`Suspicious price jump on ${date}: ${prev} -> ${curr} (${(change*100).toFixed(2)}%)`);
    }
    assert.equal(Number.isFinite(curr), true);
    assert.equal(curr > 0, true);
  }
});

test("inflation.csv has no missing values or crazy spikes", () => {
  const rows = parseCsv("inflation.csv");
  assert.equal(rows.length > 100, true);
  
  for (let i = 1; i < rows.length; i++) {
    const curr = Number(rows[i].value);
    const prev = Number(rows[i-1].value);
    const date = rows[i].date;
    
    // CPI doesn't usually move > 10% in one month (historical hyperinflation)
    const change = Math.abs(curr / prev - 1);
    assert.equal(change < 0.10, true, `Suspicious CPI move on ${date}: ${prev} -> ${curr}`);
    assert.equal(Number.isFinite(curr), true);
  }
});

test("rate-borrow.csv is valid", () => {
  const rows = parseCsv("rate-borrow.csv");
  assert.equal(rows.length > 1000, true);
  for (const row of rows) {
    const rate = Number(row.value);
    assert.equal(Number.isFinite(rate), true);
    // Rates shouldn't be negative or insanely high (e.g. 50%)
    assert.equal(rate >= -0.01 && rate < 0.5, true, `Suspicious rate on ${row.date}: ${rate}`);
  }
});

test("rate-borrow.csv takes each era from its own source (no upstream T-bill steps)", () => {
  const rows = parseCsv("rate-borrow.csv");
  const expectedName = (date: string) =>
    date < "1954-07-01" ? "CP" : date < "1986-01-02" ? "DFF" : date < "2018-04-03" ? "LIBOR1M" : "SOFR";
  for (const row of rows) {
    assert.equal(row.name, expectedName(row.date), `${row.date} should come from ${expectedName(row.date)}`);
    if (row.date < "2008-01-01") assert.ok(Number(row.value) > 0, `non-positive pre-2008 rate on ${row.date}`);
  }
  // The upstream swap column moved in 2.52% steps (0.01%/day x 252) from 1926 to 1985.
  const pre1986 = rows.filter((r) => r.date >= "1926-07-01" && r.date < "1986-01-01");
  const onGrid = pre1986.filter((r) => Math.abs(Number(r.value) / 0.0252 - Math.round(Number(r.value) / 0.0252)) < 1e-6);
  assert.ok(onGrid.length / pre1986.length < 0.05, `${onGrid.length}/${pre1986.length} rows sit on the 2.52% grid`);
});

test("risk-vgsh.csv proxy has no fake yield-step swings before DGS2 (1976-06)", () => {
  const rows = parseCsv("risk-vgsh.csv").filter((r) => r.date.length === 7 && r.date < "1976-06");
  assert.ok(rows.length > 1000);
  for (let i = 1; i < rows.length; i++) {
    const change = Number(rows[i].adj_close) / Number(rows[i - 1].adj_close) - 1;
    assert.ok(Math.abs(change) < 0.035, `VGSH proxy moved ${(change * 100).toFixed(2)}% in ${rows[i].date}`);
  }
});

test("inflation.csv is contiguous monthly CPI: Shiller, CPIAUCNS 1913-46, CPIAUCSL from 1947", () => {
  const rows = parseCsv("inflation.csv");
  const nextMonth = (m: string) => {
    const [y, mo] = m.split("-").map(Number);
    return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
  };
  for (let i = 1; i < rows.length; i++) {
    assert.equal(rows[i].date, nextMonth(rows[i - 1].date), `CPI gap before ${rows[i].date}`);
  }
  const expectedName = (m: string) => (m < "1913-01" ? "CPI" : m < "1947-01" ? "CPIAUCNS" : "CPIAUCSL");
  for (const row of rows) assert.equal(row.name, expectedName(row.date), `CPI source for ${row.date}`);
});

test("all public CSVs are readable and not empty", () => {
  const files = readdirSync(DATA_DIR).filter(f => f.endsWith(".csv"));
  for (const file of files) {
    const content = readFileSync(join(DATA_DIR, file), "utf-8").trim();
    assert.equal(content.length > 0, true, `${file} is empty`);
    assert.equal(content.includes("\n"), true, `${file} has no rows`);
  }
});
