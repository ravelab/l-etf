// Cash-sweep interest: accrued daily, posted to cash monthly, and attributed to
// the next ledger row that trades.

import { addCalendarDaysIso } from "./futures-contracts";
import type { SleeveContext } from "./futures-sleeve-context";
import type { SleeveState } from "./futures-sleeve-state";

/** Net annual cash-sweep yield (percent points) implied by daily borrow minus broker spread (/360). */
export function sweepNetAnnualPctFromRateDaily(rateDaily: number, spreadAnnual: number): number {
  return Math.max(0, rateDaily - spreadAnnual / 360) * 360 * 100;
}


/** Sweep interest earned but not yet posted; it posts to cash monthly. */
export function accrueSleeveCashInterest(st: SleeveState, amount: number, days: number): void {
  if (!Number.isFinite(amount) || amount <= 0 || days <= 0) return;
  st.pendingMonthlyCashInterest += amount;
  st.pendingMonthlyCashInterestDays += days;
}

export function accrueSleeveCollateralInterest(st: SleeveState, amount: number, days: number): void {
  if (amount >= 0) accrueSleeveCashInterest(st, amount, days);
  else st.cash += amount; // Debit interest reduces available equity; never earns interest itself.
}

/** Posts the pending sweep to cash; returns the amount posted. */
export function creditSleevePendingCashInterest(st: SleeveState): number {
  if (!Number.isFinite(st.pendingMonthlyCashInterest) || st.pendingMonthlyCashInterest <= 0) return 0;
  const amount = st.pendingMonthlyCashInterest;
  st.cash += amount;
  st.accruedInterestSinceLastTx += amount;
  st.interestSweepSessionCount += Math.max(1, st.pendingMonthlyCashInterestDays);
  st.pendingMonthlyCashInterest = 0;
  st.pendingMonthlyCashInterestDays = 0;
  return amount;
}

/** Sweep-attribution fields for the ledger row that carries `amount`; resets the day count. */
export function takeSleeveInterestFields(
  ctx: SleeveContext,
  st: SleeveState,
  rateDaily: number,
  amount: number,
): { cashInterestTradingDays?: number; cashInterestAnnualRatePct?: number } {
  const { spreadAnnual } = ctx;
  if (!Number.isFinite(amount) || amount <= 0) return {};
  const fields = {
    cashInterestTradingDays: Math.max(1, st.interestSweepSessionCount),
    cashInterestAnnualRatePct: sweepNetAnnualPctFromRateDaily(rateDaily, spreadAnnual),
  };
  st.interestSweepSessionCount = 0;
  return fields;
}

/**
 * Legacy cash-sweep mode accrues the non-trading calendar days since the prior
 * session, posting at each month boundary; with collateral, only the month post.
 */
export function accrueSleeveSweepAcrossGap(
  ctx: SleeveContext,
  st: SleeveState,
  i: number,
  date: string,
  extraSweepDays: number,
): void {
  const { dates, rateLookup, spreadAnnual, freeCashAt, collateral } = ctx;
  const creditPendingCashInterest = (): number => creditSleevePendingCashInterest(st);
  const accrueCashInterest = (amount: number, days: number): void => accrueSleeveCashInterest(st, amount, days);
  if (!collateral && extraSweepDays > 0) {
    const ratePrev = rateLookup.getRate(dates[i - 1] as string);
    const spreadDailyGap = spreadAnnual / 360;
    const cashRateGap = Math.max(0, ratePrev - spreadDailyGap);
    const cashYieldGap = Math.max(0, st.cash - freeCashAt(dates[i - 1] as string));
    let accrualMonth = (dates[i - 1] as string).slice(0, 7);
    for (let gapDay = 1; gapDay <= extraSweepDays; gapDay++) {
      const gapDate = addCalendarDaysIso(dates[i - 1] as string, gapDay);
      const gapMonth = gapDate.slice(0, 7);
      if (gapMonth !== accrualMonth) {
        creditPendingCashInterest();
        accrualMonth = gapMonth;
      }
      accrueCashInterest(cashYieldGap * cashRateGap, 1);
    }
    if (date.slice(0, 7) !== accrualMonth) {
      creditPendingCashInterest();
    }
  } else if (date.slice(0, 7) !== (dates[i - 1] as string).slice(0, 7)) {
    // First trading row of a new month: prior-month sweep is now posted cash.
    creditPendingCashInterest();
  }
}
