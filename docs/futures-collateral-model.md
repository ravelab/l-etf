# Standalone futures collateral model

The objective is a standalone version of the trading policy in `~/futures`,
without core VTI/UPRO positions or box-spread liabilities. ETF tracking is not a
calibration target. Browser runs, MCP futures tools and generated futures
snapshots enable `treasuryCollateral` in the same engine.

## Account economics

- Futures P&L and financing retain the existing index-total-return invariant.
- No fixed margin cash reserve, matching the operator’s setup. The modeled
  futures maintenance requirement (default 8% of notional) constrains capacity
  and excess liquidity; it is not deducted from investable capital.
- The risk-on entry close (the first after a risk-off stretch, or the run's
  first) buys its whole Treasury purchase in VGSH, which is what rebuilds an
  SPX pool emptied to fund BRK.B+GLDM. A deliberate operator choice: across the
  backtests it added about +0.1 to +0.2 pts/yr to the SPX sleeve, but lost when
  re-entry came during hikes with an inverted curve (2023-01, 2025-06).
- NDX Treasury purchases always use VGSH, regardless of SMA. SPX routine
  maintenance buys SGOV first, with VGSH as the fallback below the SGOV minimum.
  Both sleeves buy VGSH on risk-on entry. Existing holdings are retained and
  sales use SGOV first within the owning sleeve.
  `treasuryBuyPreference: "ndx-vgsh"` is the default; `"entry-only"` and
  `"vgsh-above-sma"` retain the earlier policies for comparisons.
- The live bot now persists separate virtual Treasury reserves within its one
  physical account. Existing sleeve claims survive migration; unowned shares
  are allocated by NAV without migration trades. Routine reserve and risk-off
  basket orders use their owner's holdings and cash, with physical cash caps.
  Account-wide emergency sales reduce each sleeve's ownership proportionally.
  Common financing and segment transfers follow NAV weights; this remains an
  approximation to broker cash-flow attribution. The daily backtest excludes
  box financing and core holdings, and uses closes as the maintenance proxy.
- Use Treasury total-return series, including their embedded fund expenses.
  These holdings receive no additional cash-interest credit.
- Charge Treasury commissions and a limit order one cent through the quote
  (`COLLATERAL_LIMIT_ORDER_OFFSET_DOLLARS`, vs two cents for regime trades),
  plus SEC/FINRA sell fees. Small adjustments stay in cash.
  Cash-constrained maintenance buys use the bot’s 0.1% sizing buffer.
- Eligible positive securities cash earns benchmark minus 0.50%, excluding the
  first $10k and scaling the rate by NAV below $100k. Positive interest accrues
  daily and posts monthly. Negative securities cash is charged benchmark plus
  1.50% (a first-tier approximation). Thresholds and fees use the engine's
  existing CPI deflator for historical purchasing-power consistency.
- Treasury collateral carries a 25% maintenance haircut approximation; the
  allocation targets at least a 15% excess-liquidity cushion where feasible.
- Treasury P&L is part of consolidated capital used for futures sizing.
  Buying Treasuries changes asset allocation, never account equity except costs.

## Explicit limits

This is a daily-bar approximation, not a replay of broker statements:

- Opens proxy 10:00 ET execution; closes proxy the final-five-minute Treasury
  maintenance window. No 10:00 prices or intraday liquidation paths are invented.
- Actual IBKR margin requirements, initial-margin buffers and segment sweeps
  are unavailable historically. The maintenance requirement/haircut are estimates,
  not broker what-if results. They do not model all intraday cushion interventions.
- Historical Treasury proxy data is adjusted total return, not executable share
  prices. Order bands and commissions use $100 SGOV / $58 VGSH share equivalents
  in present dollars, CPI-deflated; distributions are reinvested in those units.
- SGOV and VGSH jointly satisfy Treasury risk-off targets and survive re-entry
  in kind. Non-Treasury targets (e.g. 100% BRK.B for SPX risk-off) are funded by
  selling surplus Treasury collateral first; they are not limited to residual
  cash. This matches the bot’s Treasury-pool funding policy.
  The 50/50 sleeve reset transfers Treasury holdings in
  kind, without creating trades. Settlement delays are not modeled.
  The two-index fund maintains collateral per sleeve,
  matching the live virtual ownership policy. Interest thresholds remain per sleeve
  in the backtest and account-wide at IB.
- Futures richness remains an explicit 0.35% annual assumption on notional.
  It has not been fitted to LETFs or replaced by one recent roll observation.
- The legacy analytical whole-cash sweep remains available to engine callers
  that omit `treasuryCollateral`, principally existing low-level regression tests.
- Default snapshots omit individual collateral transactions to stay within the
  download budget; their equity and cost metrics include all trades. A fresh
  run exposes the full ledger, with collateral quantities in equivalent units.

## Evidence and checks

Broker documentation checked 2026-10-29:

- https://www.interactivebrokers.com/en/pricing/pricing-calculations-int.php
  (segment eligibility; USD ACT/360)
- https://www.interactivebrokers.com/en/accounts/fees/pricing-interest-rates.php
  (cash exclusion, NAV scaling and Pro credit spread)
- https://www.interactivebrokers.com/en/trading/margin-rates.php
  (first-tier debit spread)
- https://www.cmegroup.com/articles/2026/funding-the-us-equity-market-to-new-heights.html
  (variable implied financing, not a constant historical spread)

`unit-tests/futures-collateral.test.ts` checks that margin does not reserve cash, no duplicate
Treasury interest, the order band/fallback, debit interest, NAV scaling, trading
costs and integration with the futures engine.

## Reserve policy comparison (2026-11-13)

Reproduce with `node --import tsx scripts/compare-collateral-policies.ts`.
Bundled common data ends 2026-11-10; start 1988-04-06, $100,000 initial,
Max 4.5x SPX / Max 3.5x NDX fund, calibrated bands and vol/RSI gates,
SPX risk-off BRK.B+GLDM and NDX risk-off VGSH. All policies use separate
sleeve reserves and the same in-kind resets.

| Treasury purchase policy | Average daily VGSH | Final VGSH | Real CAGR | Max drawdown |
| --- | ---: | ---: | ---: | ---: |
| Both sleeves always VGSH | 100.00% | 100.00% | 36.20% | 64.23% |
| Current: NDX always VGSH, SPX entry VGSH / routine SGOV-first | 85.40% | 76.44% | 36.23% | 64.31% |
| Old: both entry VGSH / routine SGOV-first | 33.74% | 28.86% | 35.87% | 64.28% |

VGSH mix is VGSH market value / (VGSH + SGOV market values), excluding cash;
the average weights funded trading dates equally. Final mix is before forced
liquidation. Real CAGR uses CPI. These are historical model results, including
pre-inception Treasury proxies; differences of a few hundredths of a point
are not evidence of a reliably superior policy.
