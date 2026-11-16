// When an account's estimated taxes are paid: the prior-year safe harbor that
// investors with uneven gains use, since this year's gains are not known in
// advance. Each year pays 110% of the previous year's tax (the rate above $150k
// AGI) in four equal installments due Apr 15, Jun 15, Sep 15 and Jan 15, and the
// return due the next Apr 15 settles the difference, paying the balance or
// refunding the excess. Shared by the futures and leveraged-ETF estimates.

/** Month-day of each estimated-tax due date, in calendar order. */
const DUE_MONTH_DAYS = ["01-15", "04-15", "06-15", "09-15"] as const;

/** Share of the prior year's tax paid in estimates, so no underpayment penalty applies. */
const SAFE_HARBOR_PRIOR_YEAR_MULTIPLE = 1.1;

const INSTALLMENTS_PER_YEAR = 4;

/** Due dates in `(after, through]`, oldest first: those a session at `through` settles. */
export function taxDueDatesBetween(after: string, through: string): string[] {
  const dates: string[] = [];
  for (let year = Number(after.slice(0, 4)); year <= Number(through.slice(0, 4)); year++) {
    for (const monthDay of DUE_MONTH_DAYS) {
      const date = `${year}-${monthDay}`;
      if (date > after && date <= through) dates.push(date);
    }
  }
  return dates;
}

/** The estimated-tax ledger of one account, year by year. */
export class SafeHarborTaxes {
  private readonly taxByYear = new Map<number, number>();
  private readonly paidByYear = new Map<number, number>();
  private readonly settledYears = new Set<number>();

  /** A tax year's liability, known once the year has closed. */
  setTax(year: number, tax: number): void {
    this.taxByYear.set(year, tax);
  }

  /** Cash the account pays on a due date (negative: a refund it receives). */
  due(date: string): number {
    const year = Number(date.slice(0, 4));
    const monthDay = date.slice(5);
    if (monthDay === "01-15") return this.installment(year - 1);
    if (monthDay === "04-15") return this.trueUp(year - 1) + this.installment(year);
    return this.installment(year);
  }

  /** What is still owed (negative: refundable) for every year not yet settled, when the account closes. */
  outstanding(): number {
    let total = 0;
    for (const [year, tax] of this.taxByYear) {
      if (!this.settledYears.has(year)) total += tax - (this.paidByYear.get(year) ?? 0);
    }
    return total;
  }

  private installment(forYear: number): number {
    const amount = (SAFE_HARBOR_PRIOR_YEAR_MULTIPLE * (this.taxByYear.get(forYear - 1) ?? 0)) / INSTALLMENTS_PER_YEAR;
    this.paidByYear.set(forYear, (this.paidByYear.get(forYear) ?? 0) + amount);
    return amount;
  }

  private trueUp(year: number): number {
    const tax = this.taxByYear.get(year);
    if (tax === undefined || this.settledYears.has(year)) return 0;
    this.settledYears.add(year);
    return tax - (this.paidByYear.get(year) ?? 0);
  }
}
