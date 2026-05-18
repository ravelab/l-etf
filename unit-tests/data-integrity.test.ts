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

test("all public CSVs are readable and not empty", () => {
  const files = readdirSync(DATA_DIR).filter(f => f.endsWith(".csv"));
  for (const file of files) {
    const content = readFileSync(join(DATA_DIR, file), "utf-8").trim();
    assert.equal(content.length > 0, true, `${file} is empty`);
    assert.equal(content.includes("\n"), true, `${file} has no rows`);
  }
});
