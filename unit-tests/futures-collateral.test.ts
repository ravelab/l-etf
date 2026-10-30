import test from "node:test";
import assert from "node:assert/strict";
import { createFuturesCollateral, collateralCashInterest } from "@/lib/simulation/futures-collateral";
import { simulateFuturesSmaStrategy } from "@/lib/simulation/futures";

function treasury(sgov = [100, 101], vgsh = [58, 58]) {
  return createFuturesCollateral({ close: { SGOV: sgov, VGSH: vgsh },
    open: { SGOV: sgov, VGSH: vgsh }, dollarScale: () => 1 });
}
test("Treasury collateral invests capital without reserving margin cash and earns the ETF return once", () => {
  const c = treasury();
  c.mark(0, "2026-01-02", false);
  const trades = c.rebalance(100_000, 24_000, "2026-01-02");
  assert.equal(trades[0].symbol, "SGOV");
  assert.ok(c.value() > 99_000 && c.value() < 100_000, "margin must not hold 24% of equity in idle cash");
  const before = c.value();
  assert.ok(Math.abs(c.mark(1, "2026-01-05", true) - before * 0.01) < 1e-8);
  assert.equal(c.mark(1, "2026-01-05", false), 0);
  const sells = c.liquidate("2026-01-05");
  assert.equal(c.value(), 0);
  assert.ok(sells[0].fees > 0 && sells[0].spread > 0);
});
test("Nonbinding futures margin changes neither Treasury allocation nor cash interest", () => {
  const low = treasury(), high = treasury();
  for (const c of [low, high]) c.mark(0, "2026-01-02", false);
  low.rebalance(100_000, 8_000, "2026-01-02");
  high.rebalance(100_000, 40_000, "2026-01-02");
  assert.equal(low.value(), high.value());
  const interest = (c: ReturnType<typeof treasury>) => collateralCashInterest({
    equity: 100_000, treasuryValue: c.value(), rateDaily: 0.05 / 360, dollarScale: 1, days: 1,
  });
  assert.equal(interest(low), interest(high));
});
test("Treasury sizing retains the 200-share band and VGSH fallback", () => {
  const small = treasury(); small.mark(0, "2026-01-02", false);
  assert.deepEqual(small.rebalance(10_000, 0, "2026-01-02"), []);
  const medium = treasury(); medium.mark(0, "2026-01-02", false);
  assert.equal(medium.rebalance(15_000, 0, "2026-01-02")[0].symbol, "VGSH");
  const tinyMove = medium.rebalance(15_100, 0, "2026-01-02");
  assert.deepEqual(tinyMove, []);
});
test("Treasury allocation preserves the modeled excess-liquidity floor", () => {
  const c = treasury(); c.mark(0, "2026-01-02", false);
  const tx = c.rebalance(100_000, 80_000, "2026-01-02");
  const costs = tx.reduce((s,t) => s+t.fees+t.spread,0);
  assert.ok(100_000 - costs - 80_000 - c.value()*0.25 >= 15_000 - costs);
});
test("Cash interest excludes Treasury holdings, scales by NAV, and charges debits", () => {
  const args = { equity: 100_000, treasuryValue: 80_000,
    rateDaily: 0.05 / 360, dollarScale: 1, days: 3 };
  assert.ok(Math.abs(collateralCashInterest(args) - 10_000 * 0.045 / 360 * 3) < 1e-10);
  assert.equal(collateralCashInterest({...args, treasuryValue:90_000}), 0);
  assert.ok(Math.abs(collateralCashInterest({...args,equity:50_000,treasuryValue:30_000}) - 10_000*0.045/360*3*0.5) < 1e-10);
  assert.ok(collateralCashInterest({...args,treasuryValue:110_000}) < 0);
});
test("Futures integration books collateral returns, costs and final liquidation without creating purchase equity", () => {
  const dates = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"];
  const run = (sgov:number[]) => simulateFuturesSmaStrategy({ index:"sp500", prices: dates.map(date=>({date,close:5000,open:5000,adj_close:5000})),
    rates:dates.map(date=>({date,rateType:"borrow",rateValue:0})), startDate:dates[0],endDate:dates[3],initialEquity:1_000_000,
    targetLeverage:2,smaPeriod:2,smaUpperBuffer:99,smaLowerBuffer:99,riskOffAsset:"VGSH",treasuryCollateral:true,
    riskOffCloseByTicker:{SGOV:sgov,VGSH:[58,58,58,58]},riskOffOpenByTicker:{SGOV:sgov,VGSH:[58,58,58,58]},futuresFundingSpreadAnnual:0 });
  const flat=run([100,100,100,100]), rising=run([100,101,102,103]);
  assert.ok(flat.etfResult.finalValue<1_000_000);
  assert.ok(rising.etfResult.finalValue>flat.etfResult.finalValue+20_000);
  assert.ok(flat.transactions.some(t=>t.symbol.includes("COLLATERAL")&&t.action==="buy"));
  assert.ok(flat.transactions.some(t=>t.symbol.includes("COLLATERAL")&&t.action==="sell"));
});

test("BRK.B risk-off target liquidates Treasury collateral; VGSH target reuses SGOV", () => {
  const c = treasury(); c.mark(0, "2026-01-02", false);
  c.rebalance(100_000, 0, "2026-01-02");
  const pool = c.value();
  assert.deepEqual(c.fundRiskOff(100_000, "2026-01-02"), [], "Treasury target must keep existing SGOV");
  assert.equal(c.value(), pool);
  const partial = c.fundRiskOff(50_000, "2026-01-02");
  assert.ok(partial[0].quantity < 0);
  assert.ok(Math.abs(c.value() - 50_000) < 1e-8, "mixed basket keeps only its Treasury allocation");
  c.fundRiskOff(0, "2026-01-02");
  assert.equal(c.value(), 0, "100% BRK.B must not leave collateral in Treasuries");
});

test("Regime exits buy BRK.B from released collateral and Treasury-only exits do not churn", () => {
  const dates = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"];
  const closes = [100, 110, 60, 55, 120, 125];
  const series = (x:number) => dates.map(()=>x);
  const run = (riskOffAsset: "BRK.B" | "VGSH") => simulateFuturesSmaStrategy({
    index:"sp500", prices:dates.map((date,i)=>({date,close:closes[i],open:closes[i],adj_close:closes[i]})),
    rates:dates.map(date=>({date,rateType:"borrow",rateValue:0})), startDate:dates[0],endDate:dates.at(-1)!,initialEquity:1_000_000,
    targetLeverage:1,smaPeriod:2,smaUpperBuffer:0,smaLowerBuffer:0,riskOffAsset,treasuryCollateral:true,
    riskOffCloseByTicker:{SGOV:series(100),VGSH:series(58),"BRK.B":series(500)},
    riskOffOpenByTicker:{SGOV:series(100),VGSH:series(58),"BRK.B":series(500)},futuresFundingSpreadAnnual:0 });
  const brk = run("BRK.B");
  const purchase = brk.transactions.find(t=>t.symbol==="BRK.B"&&t.action==="buy");
  assert.ok(purchase, "exit must fund BRK.B");
  assert.ok(purchase.qtyDelta * purchase.fillPrice > purchase.equity * 0.99, "BRK.B must receive essentially the whole sleeve, not just leftover cash");
  const vgsh = run("VGSH");
  const sellSignal = vgsh.etfResult.smaSignals.find(s=>s.type==="sell");
  assert.ok(sellSignal);
  const transitionDate = dates[dates.indexOf(sellSignal.date) + 1];
  const initialTreasury = vgsh.transactions.find(t=>t.symbol==="SGOV (COLLATERAL)"&&t.action==="buy")!;
  const sold = vgsh.transactions.filter(t=>t.date===transitionDate&&t.symbol==="SGOV (COLLATERAL)"&&t.action==="sell").reduce((sum,t)=>sum-t.qtyDelta,0);
  assert.ok(sold < initialTreasury.qtyDelta, "sell only surplus needed for futures losses, not the entire pool");
  assert.equal(vgsh.transactions.some(t=>t.date===transitionDate&&t.symbol.startsWith("VGSH")&&t.action==="buy"), false);
});
