import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { simulateDualSleeveFuturesStrategy, type DualSleeveFuturesParams } from '../src/lib/simulation/futures-dual-sleeve';
import { DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY } from '../src/lib/simulation/futures';
import { buildFuturesLadderPlan } from '../src/lib/simulation/futures-plan';
import { buildFuturesRunPlans } from '../src/lib/simulation/futures-run-plan';
import { loadIndexPrices, loadBorrowRates, loadInflation, loadRiskOffRawSeriesForAssets } from '../src/lib/mcp/server-data';
import { alignRiskOffPriceSeries, getMarketDataWarmUpStartDate } from '../src/lib/fetch-market-data';
import { getDefaultSmaPeriod, getDefaultSmaUpperBuffer, getDefaultSmaLowerBuffer, DEFAULT_RISK_OFF_ASSETS, DEFAULT_LEVERAGE_TOLERANCE_PCT } from '../src/lib/simulation/defaults';
import { cpiIndexRatioEndOverStart } from '../src/lib/inflation';
import type { IndexKey } from '../src/lib/simulation/types';

async function main() {
  const requestedEnd = '2026-11-13', start = '1988-04-06';
  const bands = Object.fromEntries((['sp500', 'nasdaq100'] as const).map(index => [index, { period: getDefaultSmaPeriod(index), upperBuffer: getDefaultSmaUpperBuffer(index), lowerBuffer: getDefaultSmaLowerBuffer(index), volGate: true }])) as Parameters<typeof buildFuturesLadderPlan>[0]['bands'];
  const warmDays = Math.max(280, bands.sp500.period, bands.nasdaq100.period);
  const warm = getMarketDataWarmUpStartDate(start, warmDays);
  const [sp,nq,rates,cpi,raw] = await Promise.all([loadIndexPrices('sp500',warm,requestedEnd),loadIndexPrices('nasdaq100',warm,requestedEnd),loadBorrowRates(warm,requestedEnd),loadInflation(warm,requestedEnd),loadRiskOffRawSeriesForAssets(['BRK.B+GLDM','VGSH','SGOV'],warm,requestedEnd)]);
  const end = [sp.at(-1)!.date,nq.at(-1)!.date,...Object.values(raw).map(p=>p.at(-1)!.date)].sort()[0];
  const windows = [{id:'full',start,end},{id:'train',start,end:'2007-12-31'},{id:'test',start:'2008-01-02',end},{id:'recent',start:'2016-01-04',end}];
  const steps = buildFuturesLadderPlan({showEmulations:false,hasNasdaqData:true,yearSpan:38,bands,dualRiskOffAssets:DEFAULT_RISK_OFF_ASSETS}).filter(s=>s.secondary);
  if(steps.length!==1) throw new Error('Expected exactly one dual-sleeve rung');
  const plans = new Map<string,DualSleeveFuturesParams>();
  for(const w of windows) {
    const first = getMarketDataWarmUpStartDate(w.start,warmDays);
    const prices = {sp500:sp.filter(p=>p.date>=first&&p.date<=w.end),nasdaq100:nq.filter(p=>p.date>=first&&p.date<=w.end)};
    const aligned = {sp500:alignRiskOffPriceSeries(prices.sp500.filter(p=>p.date>=w.start),raw),nasdaq100:alignRiskOffPriceSeries(prices.nasdaq100.filter(p=>p.date>=w.start),raw)};
    const built=buildFuturesRunPlans({steps,initialEquity:100_000,sleeveParams:(index:IndexKey,targetLeverage,maxLeverage,sma)=>({index,prices:prices[index],rates,startDate:w.start,endDate:w.end,targetLeverage,maxLeverage,smaPeriod:sma.period,smaUpperBuffer:sma.upperBuffer,smaLowerBuffer:sma.lowerBuffer,smaVolGate:true,riskOffAsset:DEFAULT_RISK_OFF_ASSETS[index],treasuryCollateral:true,treasuryBuyPreference:'ndx-vgsh',riskOffCloseByTicker:aligned[index].closeValuesByAsset as Record<string,number[]>,riskOffOpenByTicker:aligned[index].openValuesByAsset as Record<string,number[]>,monthlyCpi:cpi,rollCalendarDaysBeforeExpiry:DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY,futuresPriceAnchor:(index==='sp500'?sp:nq).at(-1)!.close})});
    if(built[0].kind!=='dual') throw new Error('Expected fund plan');
    plans.set(w.id,built[0].dual);
  }
  type Row={window:string,tolerance:number,initial:number,realCagr:number,nominalCagr:number,maxDD:number,futuresRowsPerYear:number,allRowsPerYear:number,annualCostPct:number,spxAvgLeverage:number,ndxAvgLeverage:number,spxMaxAbsDrift:number,ndxMaxAbsDrift:number};
  const rows:Row[]=process.env.RESUME === "1" && existsSync("benchmark-results/futures-tolerance.json") ? JSON.parse(readFileSync("benchmark-results/futures-tolerance.json","utf8")).rows : []; const seen=new Set<string>(rows.map(r=>`${r.window}|${r.tolerance}|${r.initial}`));
  const run=(window:string,tolerance:number,initial=100_000)=>{
    const key=`${window}|${tolerance}|${initial}`; if(seen.has(key)) return rows.find(r=>`${r.window}|${r.tolerance}|${r.initial}`===key)!;
    const p=plans.get(window)!;
    const run=simulateDualSleeveFuturesStrategy({...p,initialEquity:initial,primary:{...p.primary,leverageTolerancePct:tolerance},secondary:{...p.secondary,leverageTolerancePct:tolerance}});
    const e=run.etfResult, years=(Date.parse(e.dates.at(-1)!)-Date.parse(e.dates[0]))/(365.25*86400000);
    const trades=run.transactions.filter(t=>!t.isEndLiquidation);
    const row:Row={window,tolerance,initial,realCagr:(Math.pow(e.finalValue/initial/cpiIndexRatioEndOverStart(cpi,e.dates[0],e.dates.at(-1)!),1/years)-1)*100,nominalCagr:e.cagr,maxDD:e.maxDrawdownPct,futuresRowsPerYear:trades.filter(t=>t.instrument==='futures').length/years,allRowsPerYear:trades.length/years,annualCostPct:trades.reduce((s,t)=>s+(t.equity>0?(t.fees+t.spread)/t.equity:0),0)*100/years,spxAvgLeverage:run.sleeveLeverageMetrics!.primary.avgActualLeverageRiskOn,ndxAvgLeverage:run.sleeveLeverageMetrics!.secondary.avgActualLeverageRiskOn,spxMaxAbsDrift:run.sleeveLeverageMetrics!.primary.maxAbsLeverageDeltaRiskOnPct,ndxMaxAbsDrift:run.sleeveLeverageMetrics!.secondary.maxAbsLeverageDeltaRiskOnPct};
    if(!Number.isFinite(row.realCagr)) throw new Error(`Non-finite result ${key}`);
    rows.push(row);seen.add(key);return row;
  };
  const baseline=run('full',DEFAULT_LEVERAGE_TOLERANCE_PCT);
  const snapshot=JSON.parse(readFileSync('src/lib/tool-snapshots/futures.json','utf8')).pageState;
  const expected=snapshot.result.etfResults.find((r:{name:string})=>r.name==='Max 4.5x SPX / Max 3.5x NDX SMA Vol RSI');
  if(snapshot.startDate!==start||snapshot.endDate!==end||Math.abs(expected.cagr-baseline.nominalCagr)>1e-9||Math.abs(expected.maxDrawdownPct-baseline.maxDD)>1e-9) throw new Error('Baseline does not match deployed default snapshot');
  console.log('VALIDATED_BASELINE',JSON.stringify(baseline));
  if (process.env.INITIAL_CAPITAL !== undefined) {
    const initial = Number(process.env.INITIAL_CAPITAL);
    const tolerances = (process.env.TOLERANCES ?? '1,5,10,15').split(',').map(Number);
    if (!Number.isFinite(initial) || initial <= 0 || tolerances.some(t => !Number.isFinite(t) || t < 0)) {
      throw new Error('INITIAL_CAPITAL must be positive and TOLERANCES must contain nonnegative numbers');
    }
    for (const w of windows) for (const tolerance of tolerances) run(w.id, tolerance, initial);
    const selected = rows.filter(row => row.initial === initial && tolerances.includes(row.tolerance));
    mkdirSync('benchmark-results', { recursive: true });
    writeFileSync(`benchmark-results/futures-tolerance-capital-${initial}.json`, JSON.stringify({
      metadata: { start, end, requestedEnd, warmDays, bands, riskOffAssets: DEFAULT_RISK_OFF_ASSETS,
        policy: 'ndx-vgsh', initial, tolerances, windows, baselineMatchedSnapshot: true }, rows: selected,
    }, null, 2));
    console.log('CAPITAL_COMPARISON', JSON.stringify(selected));
    return;
  }
  const startTime=performance.now();
  const coarse=[...Array.from({length:81},(_,i)=>i*0.5),...Array.from({length:12},(_,i)=>45+i*5)];
  if(process.env.EXHAUSTIVE !== "1") for(const w of windows){for(const tolerance of coarse) run(w.id,tolerance); console.log('COARSE',w.id,JSON.stringify(rows.filter(r=>r.window===w.id).sort((a,b)=>b.realCagr-a.realCagr).slice(0,5)),'elapsed seconds',((performance.now()-startTime)/1000).toFixed(1));}
  const candidates=new Set<number>([DEFAULT_LEVERAGE_TOLERANCE_PCT]);
  if(process.env.EXHAUSTIVE !== "1") for(const w of windows) {
    const top=rows.filter(r=>r.window===w.id).sort((a,b)=>b.realCagr-a.realCagr).slice(0,3);
    for(const r of top) for(let delta=-10;delta<=10;delta++) candidates.add(Number(Math.max(0,r.tolerance+delta/10).toFixed(1)));
  }
  if(process.env.EXHAUSTIVE !== "1") for(const w of windows){for(const t of candidates) run(w.id,t); console.log('FINE',w.id,JSON.stringify(rows.filter(r=>r.window===w.id&&r.initial===100_000).sort((a,b)=>b.realCagr-a.realCagr).slice(0,8)));}
  if(process.env.EXHAUSTIVE === "1") {
    for(const w of windows) {
      for(let k=0;k<=1000;k++) {
        run(w.id,k/10);
        if(k%100===0) console.log('EXHAUSTIVE_PROGRESS',w.id,k/10,'elapsed',((performance.now()-startTime)/1000).toFixed(1));
      }
      console.log('EXHAUSTIVE_BEST',w.id,JSON.stringify(rows.filter(r=>r.window===w.id&&r.initial===100_000).sort((a,b)=>b.realCagr-a.realCagr).slice(0,5)));
      writeFileSync('benchmark-results/futures-tolerance-progress.json',JSON.stringify({windows,rows},null,2));
    }
  }
  const capitalChecks=new Set([0,0.5,1,2,3,5,6,6.1,10,15,20]);
  for(const w of windows) for(const row of rows.filter(r=>r.window===w.id&&r.initial===100_000).sort((a,b)=>b.realCagr-a.realCagr).slice(0,3)) capitalChecks.add(row.tolerance);
  for(const w of windows) for(const t of capitalChecks) run(w.id,t,1_000_000);
  const metadata={start,end,requestedEnd,warmDays,bands,riskOffAssets:DEFAULT_RISK_OFF_ASSETS,exhaustiveGrid:process.env.EXHAUSTIVE === "1" ? { min:0,max:100,step:0.1 } : null,defaultTolerance:DEFAULT_LEVERAGE_TOLERANCE_PCT,policy:'ndx-vgsh',windows,coarse,candidates:[...candidates].sort((a,b)=>a-b),note:'Each window opens independently at 50/50 with page-equivalent warm-up and common current futures spread anchors. All modeled trading and funding costs are enabled. Cost metric approximates annual flow cost as sum((fees+spread)/row fund equity)/years; it is not measured CAGR cost drag. Leverage tolerance also changes the max-leverage trim threshold. No default or live settings are changed.'};
  mkdirSync('benchmark-results',{recursive:true});writeFileSync('benchmark-results/futures-tolerance.json',JSON.stringify({metadata,rows},null,2));
  console.log('DONE',rows.length,'runs',((performance.now()-startTime)/1000).toFixed(1),'seconds');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
