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
- Park the securities pool in SGOV, with VGSH as the fallback when
  the order is too small for 200 SGOV-equivalent shares but large enough for
  200 VGSH-equivalent shares. Sell SGOV before VGSH to replenish cash.
- Use Treasury total-return series, including their embedded fund expenses.
  These holdings receive no additional cash-interest credit.
- Charge Treasury half-spreads and commissions. Small adjustments stay in cash.
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
  rather than netting all Treasury orders and interest thresholds at account level.
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
