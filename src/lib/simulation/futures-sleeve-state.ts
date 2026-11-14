// What a sleeve carries from one session to the next, and the values one session
// shares across its phases. The phase modules (open trades, rebalance, close, …)
// read and write `SleeveState` in the order `createFuturesSleeve`'s `stepDay` runs them.

import type { FuturesCashMember } from "./futures-cash-account";
import type { FuturesContractSymbol } from "./futures-contracts";
import { clampToFinite } from "./futures-sizing";
import type { SleeveContext } from "./futures-sleeve-context";
import type { FuturesTransactionRow } from "./futures-types";

export type SleeveState = {
  /**
   * Consolidated marked capital, including Treasury collateral and commodities
   * cash. Only P&L and costs change it; collateral purchases are internal transfers.
   */
  cash: number;
  /** Open futures by listing, in sizing units (micro units with micros on). */
  readonly lots: Map<string, number>;
  contract: FuturesContractSymbol | null;
  /** Risk-off basket, one slot per `ctx.heldTickers` entry. */
  riskOffShares: number[] | null;
  riskOffCash: number[] | null;
  riskOffLastPrice: number[] | null;
  /**
   * Price the ledger values each futures listing at: the open fill while the day's
   * open trades execute, the close mark once the day is marked. The same prices the
   * trades fill at, so a fresh position's value equals what was paid for it.
   */
  ledgerFuturesMark: ((symbol: string) => number) | null;
  readonly transactions: FuturesTransactionRow[];
  readonly dailyEquity: number[];
  /** End-of-day excess liquidity, so a composite fund can add its sleeves' together. */
  readonly dailyExcessLiquidity: number[];
  totalFees: number;
  totalSpreadCosts: number;
  accruedInterestSinceLastTx: number;
  /** Count of credited sweep-interest days since last attribution row. */
  interestSweepSessionCount: number;
  pendingMonthlyCashInterest: number;
  pendingMonthlyCashInterestDays: number;
  sumActualLeverageRiskOn: number;
  riskOnLeverageDayCount: number;
  maxAbsLeverageDeltaRiskOnPct: number;
  collateralMarginRequirement: number;
  /**
   * Whether the last close ran risk-on maintenance, so the next risk-on close after a
   * risk-off stretch (or the run's first) is flagged as the entry that rebuilds the pool.
   */
  collateralRiskOnAtLastClose: boolean;
  cashMember: FuturesCashMember | undefined;
  pendingEnterRiskOff: boolean;
  pendingExitRiskOff: boolean;
  dividendEmaDaily: number;
  closeIndex: number;
  closeBasket: number;
  closeNotional: number;
  closeMetricEquity: number;
  closeCounted: boolean;
  maintenanceVgsh: boolean;
  entryClose: boolean;
  /**
   * Wiped out: every remaining day is already zeroed, so no later day may run.
   * Stands in for the `break` this was before it became a per-day step.
   */
  ruined: boolean;
};

/** One session's market inputs, computed once at the start of `stepDay`. */
export type SleeveDay = {
  readonly i: number;
  readonly date: string;
  readonly prevSpot: number;
  readonly spot: number;
  readonly idxOpen: number;
  readonly gapCalendarDays: number;
  /** Already /360. */
  readonly rateDaily: number;
  readonly dividendDaily: number;
  /** This row's realized payout; drives the carry charged to held positions. */
  readonly realizedDividend: number;
  /** Basis-adjusted fill for a listing at the open (or at `spotPrice`). */
  readonly futuresFillAt: (symbol: string, spotPrice?: number) => number;
};

export function createSleeveState(ctx: SleeveContext): SleeveState {
  return {
    cash: clampToFinite(ctx.params.initialEquity, 0),
    lots: new Map<string, number>(),
    contract: null,
    riskOffShares: null,
    riskOffCash: null,
    riskOffLastPrice: null,
    ledgerFuturesMark: null,
    transactions: [],
    dailyEquity: new Array<number>(ctx.dates.length),
    dailyExcessLiquidity: new Array<number>(ctx.dates.length).fill(0),
    totalFees: 0,
    totalSpreadCosts: 0,
    accruedInterestSinceLastTx: 0,
    interestSweepSessionCount: 0,
    pendingMonthlyCashInterest: 0,
    pendingMonthlyCashInterestDays: 0,
    sumActualLeverageRiskOn: 0,
    riskOnLeverageDayCount: 0,
    maxAbsLeverageDeltaRiskOnPct: 0,
    collateralMarginRequirement: 0,
    collateralRiskOnAtLastClose: false,
    cashMember: undefined,
    pendingEnterRiskOff: false,
    pendingExitRiskOff: false,
    dividendEmaDaily: 0,
    closeIndex: 0,
    closeBasket: 0,
    closeNotional: 0,
    closeMetricEquity: 0,
    closeCounted: false,
    maintenanceVgsh: true,
    entryClose: true,
    ruined: false,
  };
}
