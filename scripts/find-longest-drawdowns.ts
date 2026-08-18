
/**
 * Top 10 Longest Drawdowns (Peak to Trough):
 * 
 * 1. 1929-09-16 to 1932-06-01 (2.71 years, -83.66%)
 *    http://localhost:3000/tools?tab=backtest&letf=UPRO%2BTQQQ&sd=1929-09-16&ed=1932-06-01&autorun=1
 * 
 * 2. 2000-03-24 to 2002-10-09 (2.54 years, -47.56%)
 *    http://localhost:3000/tools?tab=backtest&letf=UPRO%2BTQQQ&sd=2000-03-24&ed=2002-10-09&autorun=1
 * 
 * 3. 1912-10-03 to 1914-12-24 (2.22 years, -19.30%)
 *    http://localhost:3000/tools?tab=backtest&letf=UPRO%2BTQQQ&sd=1912-10-03&ed=1914-12-24&autorun=1
 * 
 * 4. 1973-01-11 to 1974-10-03 (1.72 years, -44.89%)
 *    http://localhost:3000/tools?tab=backtest&letf=UPRO%2BTQQQ&sd=1973-01-11&ed=1974-10-03&autorun=1
 * 
 * 5. 1980-11-28 to 1982-08-12 (1.70 years, -19.73%)
 *    http://localhost:3000/tools?tab=backtest&letf=UPRO%2BTQQQ&sd=1980-11-28&ed=1982-08-12&autorun=1
 * 
 * 6. 1919-11-03 to 1921-06-20 (1.63 years, -27.81%)
 *    http://localhost:3000/tools?tab=backtest&letf=UPRO%2BTQQQ&sd=1919-11-03&ed=1921-06-20&autorun=1
 * 
 * 7. 1968-11-29 to 1970-05-26 (1.49 years, -32.69%)
 *    http://localhost:3000/tools?tab=backtest&letf=UPRO%2BTQQQ&sd=1968-11-29&ed=1970-05-26&autorun=1
 * 
 * 8. 2007-10-09 to 2009-03-09 (1.42 years, -55.21%)
 *    http://localhost:3000/tools?tab=backtest&letf=UPRO%2BTQQQ&sd=2007-10-09&ed=2009-03-09&autorun=1
 * 
 * 9. 1892-03-04 to 1893-07-26 (1.39 years, -38.65%)
 *    http://localhost:3000/tools?tab=backtest&letf=UPRO%2BTQQQ&sd=1892-03-04&ed=1893-07-26&autorun=1
 * 
 * 10. 1976-12-31 to 1978-03-06 (1.18 years, -14.33%)
 *     http://localhost:3000/tools?tab=backtest&letf=UPRO%2BTQQQ&sd=1976-12-31&ed=1978-03-06&autorun=1
 */
import fs from 'fs';
import path from 'path';

const filePath = path.join(process.cwd(), 'data/index-sp.csv');
const content = fs.readFileSync(filePath, 'utf-8');
const lines = content.split('\n');

const drawdowns: { start: string; trough: string; days: number; pct: number }[] = [];

const BASE_URL = 'http://localhost:3000/tools?tab=backtest&letf=UPRO%2BTQQQ&smaPsp=175&smaPnq=150&smatspU=3.5&smatspL=3.5&smatnqU=12&smatnqL=12&ro=BRK.B%2BGLDM%2BVGSH&autorun=1';

function getBacktestUrl(start: string, end: string) {
    return `${BASE_URL}&sd=${start}&ed=${end}`;
}

let peak = -1;
let peakDate = '';
let troughValue = -1;
let troughDate = '';
let inDrawdown = false;

// Skip header
for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  
  const [date, , adjCloseStr] = line.split(',');
  const val = parseFloat(adjCloseStr);
  
  if (isNaN(val)) continue;

  if (val > peak) {
    if (inDrawdown) {
      const duration = (new Date(troughDate).getTime() - new Date(peakDate).getTime()) / (1000 * 60 * 60 * 24);
      drawdowns.push({
        start: peakDate,
        trough: troughDate,
        days: Math.round(duration),
        pct: ((troughValue - peak) / peak) * 100
      });
      inDrawdown = false;
    }
    peak = val;
    peakDate = date;
    troughValue = val;
    troughDate = date;
  } else {
    inDrawdown = true;
    if (val < troughValue) {
      troughValue = val;
      troughDate = date;
    }
  }
}

// Handle ongoing drawdown if any
if (inDrawdown) {
    const duration = (new Date(troughDate).getTime() - new Date(peakDate).getTime()) / (1000 * 60 * 60 * 24);
    drawdowns.push({
        start: peakDate,
        trough: troughDate,
        days: Math.round(duration),
        pct: ((troughValue - peak) / peak) * 100
    });
}

drawdowns.sort((a, b) => b.days - a.days);

console.log('Top 10 Longest Drawdowns (Peak to Trough):');
console.table(drawdowns.slice(0, 10).map(d => ({
    Peak: d.start,
    Trough: d.trough,
    Years: (d.days / 365.25).toFixed(2),
    'Max Depth': d.pct.toFixed(2) + '%',
    'Backtest Link': getBacktestUrl(d.start, d.trough)
})));
