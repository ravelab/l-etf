import { collateralCashInterest, type CollateralTrade, type TreasuryHoldings } from "./futures-collateral";

/** Daily-bar model of IBKR's "sweep excess funds into securities" election.
 * Sources and the deliberately approximate overnight timing are documented in
 * docs/futures-collateral-model.md. Margin is held cash, never an expense.
 */
export type FuturesCashMember = {
  commoditiesCash: number;
  margin: number;
  equity: () => number;
  securitiesCash: () => number;
  treasuries: () => TreasuryHoldings;
  assignTreasuries: (holdings: TreasuryHoldings) => void;
  canBuyTreasuries: () => boolean;
  preferVgsh: () => boolean;
  sgovBufferEnabled: () => boolean;
  riskOnEntry: () => boolean;
  execute: (fn: () => void) => void;
  rateDaily: () => number;
  dollarScale: () => number;
  buy: (budget: number, preferVgsh: boolean, selectedTickerOnly: boolean) => void;
  sell: (symbol: keyof TreasuryHoldings, budget: number) => CollateralTrade[];
  accrueInterest: (amount: number, days: number) => void;
  refresh: () => void;
};

export class FuturesCashAccount {
  private members: FuturesCashMember[] = [];
  private session?: string;

  add(member: FuturesCashMember) { this.members.push(member); }

  private totals() {
    const total = this.members.reduce((s, m) => ({
      equity: s.equity + m.equity(), cash: s.cash + m.commoditiesCash,
      margin: s.margin + m.margin, securities: s.securities + m.securitiesCash(),
    }), { equity: 0, cash: 0, margin: 0, securities: 0 });
    if (!Object.values(total).every(Number.isFinite)) {
      throw new Error("Futures cash account has non-finite segment balances");
    }
    return total;
  }

  /** Fund real margin deficiencies immediately; the nominal transfer band must
   * never prevent margin compliance. Keep the same 5% cushion as the sweep.
   */
  fundMargin() {
    const total = this.totals();
    if (total.cash >= total.margin) return;
    const needed = total.margin * 1.05 - total.cash;
    const gaps = this.members.map(m => Math.max(0, m.margin * 1.05 - m.commoditiesCash));
    const gap = gaps.reduce((a, b) => a + b, 0);
    if (gap <= 0) return;
    this.members.forEach((m, i) => { m.commoditiesCash += needed * gaps[i] / gap; });
  }

  /** Prior settlement's excess becomes available on the following index session.
   * No current-session price/P&L may enter this calculation. IB's "1% ... or
   * $200" is treated conservatively as the larger threshold, in historical dollars.
   */
  beginSession(date: string, dollarScale: number, rateDaily: number, extraDays: number) {
    if (date === this.session) return;
    if (extraDays > 0) this.accrueInterest(rateDaily, dollarScale, extraDays);
    this.session = date;
    this.fundMargin();
    const total = this.totals();
    const excess = total.cash - total.margin * 1.05;
    if (excess <= 0 || excess < Math.max(total.equity * 0.01, 200 * dollarScale)) return;
    const available = this.members.map(m => Math.max(0, m.commoditiesCash - m.margin * 1.05));
    const sum = available.reduce((a, b) => a + b, 0);
    if (sum <= 0) return;
    this.members.forEach((m, i) => { m.commoditiesCash -= Math.min(excess, sum) * available[i] / sum; });
  }

  /** One physical Treasury pool: net cash before ordering, sell SGOV account-wide
   * first, and replenish SGOV below 200 shares OR 5% of the Treasury pool.
   * Ownership and costs stay attributed to the sleeve executing each leg.
   */
  close() {
    this.fundMargin();
    // A trade-induced securities debit can use free commodities cash without
    // waiting for the discretionary excess-transfer band (IB pre-trade rule).
    const before = this.totals();
    const free = this.members.map(m => Math.max(0, m.commoditiesCash - m.margin * 1.05));
    const freeTotal = free.reduce((a, b) => a + b, 0);
    // Summing buffered margins and buffering their sum can differ by a few ulps.
    // The aggregate can appear to have free cash while EVERY member has zero.
    // Cap by distributable cash before dividing by its total.
    const debitCover = Math.min(Math.max(0, -before.securities), Math.max(0, before.cash - before.margin * 1.05), freeTotal);
    if (debitCover > 0) this.members.forEach((m, i) => { m.commoditiesCash -= debitCover * free[i] / freeTotal; });
    const total = this.totals();
    const treasuries = this.members.reduce((v, m) => v + m.treasuries().SGOV + m.treasuries().VGSH, 0);
    // Treasury haircut and the bot's 15% liquidity floor constrain new allocation.
    const capacity = Math.max(0, (total.equity * 0.85 - total.margin) / 0.25);
    let gap = Math.min(total.securities, capacity - treasuries);
    if (gap < 0) {
      for (const symbol of ["SGOV", "VGSH"] as const) {
        if (gap >= 0) break;
        const held = this.members.map(m => m.treasuries()[symbol]);
        const pool = held.reduce((a, b) => a + b, 0);
        if (pool <= 0) continue;
        const seller = this.members[held.indexOf(Math.max(...held))];
        // Consolidate virtual ownership before ONE physical order, so its band
        // and minimum commission apply to the account's shares, not each sleeve.
        // Fund holdings/NAV do not change until that order executes.
        this.members.forEach(m => m.assignTreasuries({ ...m.treasuries(), [symbol]: m === seller ? pool : 0 }));
        seller.execute(() => {
          const trades = seller.sell(symbol, -gap);
          gap += trades.reduce((s, t) => s - t.quantity * t.price - t.fees - t.spread, 0);
        });
      }
    } else if (gap > 0) {
      const buyers = this.members.map(m => m.canBuyTreasuries() ? Math.max(0, m.securitiesCash()) : 0);
      const available = buyers.reduce((a, b) => a + b, 0);
      const vgsh = this.members.reduce((s, m, i) => s + (m.preferVgsh() ? buyers[i] : 0), 0);
      const sgovBufferEnabled = this.members.every(m => m.sgovBufferEnabled());
      const sgov = this.members.reduce((sum, m) => sum + m.treasuries().SGOV, 0);
      // Historical total-return series use $100 CPI-scaled share equivalents,
      // matching the collateral helper's order sizing rather than synthetic prices.
      const sgovPrice = 100 * (this.members[0]?.dollarScale() ?? 1);
      const needsSgov = sgov / sgovPrice < 200 || sgov < treasuries * 0.05;
      const preferVgsh = sgovBufferEnabled ? !needsSgov
        : this.members.some(m => m.riskOnEntry()) || (vgsh > 0 && vgsh >= available - vgsh);
      // Apply the share minimum to the physical order, not separately to two
      // virtual wallets. Re-split ownership afterwards, without trading.
      const buyer = buyers.indexOf(Math.max(...buyers));
      if (available > 0) this.members[buyer].execute(() => this.members[buyer].buy(Math.min(gap, available), preferVgsh, sgovBufferEnabled));
    }
    this.splitTreasuryOwnership();
    if (this.members.length > 0) this.accrueInterest(this.members[0].rateDaily(), this.members[0].dollarScale(), 1);
    this.members.forEach(m => m.refresh());
  }

  private splitTreasuryOwnership() {
    if (this.members.length < 2) return;
    const pool = this.members.reduce((s, m) => ({ SGOV: s.SGOV + m.treasuries().SGOV,
      VGSH: s.VGSH + m.treasuries().VGSH }), { SGOV: 0, VGSH: 0 });
    const wallets = this.members.map(m => Math.max(0, m.securitiesCash() + m.treasuries().SGOV + m.treasuries().VGSH));
    const total = wallets.reduce((a, b) => a + b, 0);
    if (total > 0) this.members.forEach((m, i) => m.assignTreasuries({
      SGOV: pool.SGOV * wallets[i] / total, VGSH: pool.VGSH * wallets[i] / total,
    }));
  }

  private accrueInterest(rateDaily: number, dollarScale: number, days: number) {
    const total = this.totals();
    // IB's AdjustmentForSecuritiesDeficit offsets a securities debit with free
    // commodities cash for interest only. Retained commodities cash earns nothing.
    const adjustedCash = total.securities + Math.min(Math.max(0, -total.securities), Math.max(0, total.cash - total.margin));
    const interest = collateralCashInterest({ equity: total.equity, treasuryValue: total.equity - adjustedCash,
      rateDaily, dollarScale, days });
    const weights = this.members.map(m => Math.max(0, interest < 0 ? -m.securitiesCash() : m.securitiesCash()));
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum > 0) this.members.forEach((m, i) => m.accrueInterest(interest * weights[i] / sum, days));
  }
}
