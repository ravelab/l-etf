import test from "node:test";
import assert from "node:assert/strict";
import { FuturesCashAccount, type FuturesCashMember } from "@/lib/simulation/futures-cash-account";
import { createFuturesCollateral } from "@/lib/simulation/futures-collateral";
import { createFuturesSleeve } from "@/lib/simulation/futures";
import { simulateDualSleeveFuturesStrategy } from "@/lib/simulation/futures-dual-sleeve";

function member(account: FuturesCashAccount, equity = 100_000, margin = 24_000, preferVgsh = false) {
  const collateral = createFuturesCollateral({ close: { SGOV: [100, 100], VGSH: [58, 58] },
    open: { SGOV: [100, 100], VGSH: [58, 58] }, dollarScale: () => 1 });
  collateral.mark(0, "2026-01-02", false);
  let capital = equity;
  let interest = 0;
  const trades: Array<{ symbol: string; quantity: number }> = [];
  const book = (txs: ReturnType<typeof collateral.buy>) => {
    for (const tx of txs) { capital -= tx.fees + tx.spread; trades.push(tx); }
    return txs;
  };
  const m: FuturesCashMember = {
    commoditiesCash: 0, margin,
    equity: () => capital,
    securitiesCash: () => capital - collateral.value() - m.commoditiesCash,
    treasuries: () => collateral.readHoldings(), assignTreasuries: collateral.writeHoldings,
    canBuyTreasuries: () => true, preferVgsh: () => preferVgsh,
    sgovBufferEnabled: () => false,
    riskOnEntry: () => false, execute: fn => fn(),
    rateDaily: () => 0, dollarScale: () => 1,
    buy: (budget, vgsh, strict) => { book(strict ? collateral.buy(vgsh ? "VGSH" : "SGOV", budget, "2026-01-02")
      : collateral.rebalance(collateral.value() + budget, 0, "2026-01-02", vgsh)); },
    sell: (symbol, budget) => book(collateral.sell(symbol, budget, "2026-01-02")),
    accrueInterest: amount => { interest += amount; }, refresh: () => {},
  };
  account.add(m);
  return { m, collateral, trades, interest: () => interest,
    pnl: (amount: number) => { capital += amount; m.commoditiesCash += amount; } };
}

test("margin cash plus 5% is retained, earns no Treasury return, and is not an expense", () => {
  const account = new FuturesCashAccount();
  const { m, collateral, trades } = member(account);
  account.close();
  assert.equal(m.commoditiesCash, 25_200);
  assert.ok(collateral.value() > 74_000 && collateral.value() < 74_800);
  assert.ok(m.equity() > 99_900, "retained margin is still part of NAV");
  assert.equal(trades.length, 1);
});

test("default purchase policy uses held SGOV shares OR its share of the whole Treasury pool", () => {
  for (const [sgov, vgsh, expected] of [
    [0, 0, "SGOV"], [19_900, 60_100, "SGOV"], // <200 shares, already >20%
    [20_000, 80_000, "VGSH"], // exactly 200 shares AND exactly 20%
    [20_000, 80_001, "SGOV"], // >=200 shares, below 20%
    [20_100, 79_900, "VGSH"],
  ] as const) {
    const account = new FuturesCashAccount();
    const a = member(account, sgov + vgsh + 40_000, 0, true);
    a.m.sgovBufferEnabled = () => true;
    a.m.riskOnEntry = () => true; // neither index nor entry-day preferences bypass it
    a.collateral.writeHoldings({ SGOV: sgov, VGSH: vgsh });
    account.close();
    assert.equal(a.trades[0]?.symbol, expected, `${sgov} SGOV / ${vgsh} VGSH`);
  }
});

test("SGOV buffer is measured across both sleeves and does not fall back to VGSH for a small order", () => {
  const account = new FuturesCashAccount();
  const a = member(account, 90_000, 0), b = member(account, 90_000, 0);
  for (const m of [a, b]) {
    m.m.sgovBufferEnabled = () => true;
    m.collateral.writeHoldings({ SGOV: 10_000, VGSH: 40_000 });
  }
  account.close();
  assert.deepEqual([...a.trades, ...b.trades].map(t => t.symbol), ["VGSH"], "each sleeve has 100 SGOV shares but the account has 200");
  const small = new FuturesCashAccount();
  const c = member(small, 15_000, 0);
  c.m.sgovBufferEnabled = () => true;
  small.close();
  assert.equal(c.trades.length, 0, "wait for enough cash for the selected SGOV order");
});

test("today's futures gain cannot buy Treasuries until the next session's sweep", () => {
  const account = new FuturesCashAccount();
  const { m, pnl, trades } = member(account);
  account.close();
  const openingTrades = trades.length;
  pnl(30_000);
  account.close();
  assert.equal(trades.length, openingTrades);
  assert.equal(m.commoditiesCash, 55_200);
  account.beginSession("2026-01-05", 1, 0, 2);
  assert.equal(m.commoditiesCash, 25_200);
  account.close();
  assert.ok(trades.length > openingTrades);
});

test("elective transfers honor 1% of account NAV and the CPI-scaled $200 minimum", () => {
  for (const [equity, scale, minimum] of [[100_000, 1, 1000], [10_000, 1, 200], [1_000, 0.5, 100]]) {
    const account = new FuturesCashAccount();
    const { m } = member(account, equity, 0);
    m.commoditiesCash = minimum - 1;
    account.beginSession("2026-01-02", scale, 0, 0);
    assert.equal(m.commoditiesCash, minimum - 1);
    m.commoditiesCash++;
    account.beginSession("2026-01-05", scale, 0, 2);
    assert.equal(m.commoditiesCash, 0, "the entire excess transfers at the boundary");
  }
});

test("the fund's sweep band is account-wide, and the same session cannot sweep twice", () => {
  const account = new FuturesCashAccount();
  const a = member(account, 50_000, 5000), b = member(account, 50_000, 5000);
  a.m.commoditiesCash = 5250 + 900;
  b.m.commoditiesCash = 5250;
  account.beginSession("2026-01-02", 1, 0, 0);
  assert.equal(a.m.commoditiesCash, 6150, "$900 is below the fund's $1000 threshold");
  a.m.commoditiesCash += 100;
  account.beginSession("2026-01-02", 1, 0, 0);
  assert.equal(a.m.commoditiesCash, 6250, "a second sleeve cannot sweep today's gain");
  account.beginSession("2026-01-05", 1, 0, 2);
  assert.equal(a.m.commoditiesCash, 5250);
});

test("margin deficiencies are funded even below the elective transfer threshold", () => {
  const account = new FuturesCashAccount();
  const { m } = member(account, 100_000, 1000);
  m.commoditiesCash = 999;
  account.fundMargin();
  assert.equal(m.commoditiesCash, 1050);
  assert.equal(m.equity(), 100_000);
});

test("buffer rounding cannot divide by zero and silently stop later Treasury maintenance", () => {
  // First failing close in the default historical fund: aggregate free cash is
  // positive by rounding after funding, but each sleeve has EXACTLY its buffer.
  const account = new FuturesCashAccount();
  const a = member(account, 103024.01391268255, 38824.19746267832);
  const b = member(account, 59308.4051831727, 16394.630118453806);
  a.m.commoditiesCash = 37840.001291525325;
  b.m.commoditiesCash = 15794.164569744229;
  a.collateral.writeHoldings({ SGOV: 0, VGSH: 62737.48608857994 });
  b.collateral.writeHoldings({ SGOV: 0, VGSH: 41881.04621357578 });
  account.close();
  for (const { m } of [a, b]) {
    assert.ok(Number.isFinite(m.commoditiesCash));
    assert.ok(Number.isFinite(m.securitiesCash()));
    assert.ok(m.commoditiesCash >= m.margin);
  }
  a.pnl(50_000);
  account.beginSession("2026-01-05", 1, 0, 2);
  account.close();
  assert.ok([...a.trades, ...b.trades].some(t => t.quantity > 0), "later sweeps must still produce Treasury purchases");
});

test("an invalid cash segment fails explicitly rather than suppressing Treasury trades", () => {
  const account = new FuturesCashAccount();
  member(account).m.commoditiesCash = NaN;
  assert.throws(() => account.close(), /non-finite segment balances/);
});

test("a reduction in required margin releases cash on the next session, not the same close", () => {
  const account = new FuturesCashAccount();
  const { m } = member(account);
  account.close();
  m.margin = 0;
  account.close();
  assert.equal(m.commoditiesCash, 25_200);
  account.beginSession("2026-01-05", 1, 0, 2);
  assert.equal(m.commoditiesCash, 0);
});

test("Treasury orders net the wallets; NDX can choose VGSH for the physical purchase", () => {
  const account = new FuturesCashAccount();
  const a = member(account, 100_000, 10_000), b = member(account, 100_000, 10_000, true);
  a.m.commoditiesCash = b.m.commoditiesCash = 20_000;
  a.collateral.writeHoldings({ SGOV: 100_000, VGSH: 0 }); // virtual cash -20k
  b.collateral.writeHoldings({ SGOV: 0, VGSH: 40_000 }); // virtual cash +40k
  account.close();
  assert.equal(a.trades.length, 0, "do not sell SPX Treasuries to finance NDX's virtual wallet");
  assert.equal(b.trades.length, 1);
  assert.equal(b.trades[0].symbol, "VGSH");
  assert.ok(b.trades[0].quantity > 0);
  assert.ok(a.m.securitiesCash() >= 0 && b.m.securitiesCash() >= 0, "ownership is re-split in kind");
});

test("a shared purchase clears the share minimum even when each virtual budget would not", () => {
  const account = new FuturesCashAccount();
  const a = member(account, 20_000, 0), b = member(account, 20_000, 0, true);
  a.collateral.writeHoldings({ SGOV: 12_500, VGSH: 0 });
  b.collateral.writeHoldings({ SGOV: 12_500, VGSH: 0 });
  account.close();
  const txs = [...a.trades, ...b.trades];
  assert.equal(txs.length, 1);
  assert.equal(txs[0].symbol, "VGSH");
  assert.ok(txs[0].quantity >= 200);
});

test("a shared sale applies the order band and commission once per ticker", () => {
  const account = new FuturesCashAccount();
  const a = member(account, 50_000, 10_000), b = member(account, 50_000, 10_000);
  a.m.commoditiesCash = b.m.commoditiesCash = 10_000;
  a.collateral.writeHoldings({ SGOV: 50_000, VGSH: 0 });
  b.collateral.writeHoldings({ SGOV: 50_000, VGSH: 0 });
  account.close();
  const sells = [...a.trades, ...b.trades];
  assert.equal(sells.length, 1);
  assert.equal(sells[0].symbol, "SGOV");
  assert.equal(sells[0].quantity, -200);
});

test("margin cash earns no cash interest, including across a weekend", () => {
  const account = new FuturesCashAccount();
  const a = member(account, 100_000, 24_000);
  account.close();
  account.beginSession("2026-01-05", 1, 0.05 / 360, 2);
  assert.equal(a.interest(), 0);
  const surplus = new FuturesCashAccount();
  const b = member(surplus, 100_000, 0);
  b.m.commoditiesCash = 100_000;
  surplus.beginSession("2026-01-05", 1, 0.05 / 360, 2);
  assert.equal(b.interest(), 0, "unswept excess commodities cash earns nothing over the gap");
});

test("post-trade securities funding bypasses the elective band without spending margin", () => {
  const account = new FuturesCashAccount();
  const a = member(account, 100_000, 10_000);
  a.m.commoditiesCash = 11_000;
  a.collateral.writeHoldings({ SGOV: 89_500, VGSH: 0 });
  assert.equal(a.m.securitiesCash(), -500);
  account.close();
  assert.equal(a.m.commoditiesCash, 10_500);
  assert.equal(a.m.securitiesCash(), 0);
  assert.equal(a.trades.length, 0);
  assert.equal(a.m.equity(), 100_000);
});

test("cash-interest exclusion applies once to the fund, with free commodities cash offsetting debits", () => {
  const account = new FuturesCashAccount();
  const a = member(account, 100_000, 0), b = member(account, 100_000, 0);
  for (const m of [a, b]) m.collateral.writeHoldings({ SGOV: 94_000, VGSH: 0 });
  account.beginSession("2026-01-05", 1, 0.05 / 360, 2);
  assert.ok(Math.abs(a.interest() + b.interest() - 2000 * 0.045 / 360 * 2) < 1e-10);

  const other = new FuturesCashAccount();
  const c = member(other, 100_000, 10_000);
  c.m.commoditiesCash = 13_000;
  c.collateral.writeHoldings({ SGOV: 89_000, VGSH: 0 });
  assert.equal(c.m.securitiesCash(), -2000);
  other.beginSession("2026-01-05", 1, 0.05 / 360, 2);
  assert.equal(c.interest(), 0, "free commodities cash offsets this securities debit for interest");
});

const dates = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"];
function inputs() {
  const closes = [5000, 5500, 5500, 5500];
  return { index: "sp500" as const,
    prices: dates.map((date, i) => ({ date, close: closes[i], adj_close: closes[i], open: i === 1 ? 5000 : closes[i] })),
    rates: dates.map(date => ({ date, rateType: "borrow", rateValue: 0 })),
    startDate: dates[0], endDate: dates.at(-1)!, initialEquity: 1_000_000,
    targetLeverage: 1, leverageTolerancePct: 100, smaPeriod: 2, smaUpperBuffer: 99, smaLowerBuffer: 99,
    riskOffAsset: "VGSH" as const, treasuryCollateral: true, futuresFundingSpreadAnnual: 0,
    riskOffCloseByTicker: { SGOV: dates.map(() => 100), VGSH: dates.map(() => 58) },
    riskOffOpenByTicker: { SGOV: dates.map(() => 100), VGSH: dates.map(() => 58) },
  };
}

test("engine keeps commodities P&L separate and trades only after the following sweep", () => {
  const sleeve = createFuturesSleeve(inputs());
  const initial = sleeve.readHoldings();
  assert.ok(initial.commoditiesCash! > 0);
  const pool = (s: typeof initial) => s.treasuryHoldings!.SGOV + s.treasuryHoldings!.VGSH;
  assert.ok(pool(initial) < 930_000, "margin cash cannot also buy Treasury ETFs");
  sleeve.stepDay(1);
  assert.equal(pool(sleeve.readHoldings()), pool(initial));
  assert.ok(sleeve.readHoldings().commoditiesCash! > initial.commoditiesCash!);
  sleeve.stepDay(2);
  assert.ok(pool(sleeve.readHoldings()) > pool(initial));
  const result = sleeve.finish();
  assert.equal(result.transactions.some(t => t.date === dates[1] && t.symbol.endsWith("(COLLATERAL)")), false);
  assert.ok(result.transactions.some(t => t.date === dates[2] && t.symbol.endsWith("(COLLATERAL)") && t.action === "buy"));
});

test("the two-index engine uses a shared pool and records each physical trade once", () => {
  const common = inputs();
  const result = simulateDualSleeveFuturesStrategy({ displayName: "Shared", initialEquity: 2_000_000,
    primary: common, secondary: { ...common, index: "nasdaq100" } });
  const buys = result.transactions.filter(t => t.action === "buy" && t.symbol.endsWith("(COLLATERAL)"));
  assert.equal(buys.filter(t => t.date === dates[0]).length, 1);
  assert.equal(buys.filter(t => t.date === dates[1]).length, 0);
  assert.equal(buys.filter(t => t.date === dates[2]).length, 1);
  assert.equal(buys[0].symbol, "SGOV (COLLATERAL)");
  assert.equal(buys[1].symbol, "VGSH (COLLATERAL)");
  for (const row of result.transactions) {
    assert.ok(row.holdingsAfter);
    assert.ok(Object.values(row.holdingsAfter).every(Number.isFinite));
  }
});
