# Standalone futures collateral model

The objective is a standalone version of the trading policy in `~/futures`,
without core VTI/UPRO positions or box-spread liabilities. ETF tracking is not a
calibration target. Browser runs, MCP futures tools and generated futures
snapshots enable `treasuryCollateral` in the same engine.

## Account economics

- Futures P&L and financing retain the existing index-total-return invariant.
- Separate commodities cash is included in NAV but is unavailable for Treasury
  purchases. The configurable futures maintenance estimate (default 8% of marked
  notional) is retained there with a 5% margin buffer. It is not an expense.
- Futures P&L and futures execution costs change commodities cash. Treasury and
  basket transactions, Treasury returns and posted cash interest belong to the
  securities side. Cash transfers conserve account NAV.
- The production model assumes **sweep excess funds into securities** is enabled.
  Elective transfers use the previous session's settled commodities cash and
  margin, before the next index session's opening move. They retain 105% of
  maintenance margin and transfer only if excess reaches the larger of 1% of
  account NAV and $200 in CPI-scaled dollars. IB's FAQ says “1% ... or $200” without
  specifying min/max; the larger threshold is an explicit conservative modeling
  choice, not a verified broker formula.
- Mandatory margin funding bypasses that elective band. A trade-induced securities
  debit can consume free commodities cash above the buffered requirement without
  waiting for the elective sweep. This approximates IB's cross-segment post-trade
  funding rule; statutory release times are not available in daily price data.
- Default `treasuryBuyPreference: "sgov-buffer"` buys SGOV if the existing
  physical account holds fewer than 200 SGOV share-equivalents **or** SGOV is
  below 20% of combined SGOV+VGSH market value. Otherwise new cash buys VGSH.
  Exactly 200 shares and exactly 20% meets both minimums and selects VGSH. The
  share threshold uses $100 CPI-scaled SGOV equivalents in synthetic history.
  The whole new purchase goes to the selected ETF; this is not a forced
  rebalance to 20%. Entry days and NDX use the same rule. Existing holdings are
  retained, and sales prefer SGOV account-wide before VGSH.
- The two-index fund shares one physical Treasury pool and one cash-account
  transfer band. Close maintenance nets both virtual securities wallets first,
  so an SPX deficit does not sell Treasuries merely to buy them for NDX.
  The 200-share order band applies to the physical purchase, not two smaller
  virtual orders. If cash cannot fund the selected ETF's minimum order, it waits
  rather than purchasing the other ETF. Explicit risk-off basket allocations
  continue to use their configured assets; this rule governs reserve maintenance.
- Existing securities holdings are not swapped. After maintenance, Treasury
  ownership is re-split in kind in proportion to positive securities wallets,
  preserving sleeve NAV and aggregate holdings. This is a daily ownership proxy
  for the live bot's persisted virtual reserves, not a replay of account claims.
  `"ndx-vgsh"`, `"entry-only"`, `"vgsh-only"` and `"vgsh-above-sma"` remain explicit
  historical comparison preferences; they do not override the new default policy.
- Use Treasury total-return series, including their embedded fund expenses.
  These holdings receive no additional cash-interest credit.
- Charge Treasury commissions and a limit order one cent through the quote
  (`COLLATERAL_LIMIT_ORDER_OFFSET_DOLLARS`, vs two cents for regime trades),
  plus SEC/FINRA sell fees. Small adjustments stay in cash.
  Cash-constrained maintenance buys use the bot’s 0.1% sizing buffer.
- Eligible positive securities cash earns benchmark minus 0.50%, excluding the
  first $10k and scaling the rate by NAV below $100k. Positive interest accrues
  daily and posts monthly. Free commodities cash first offsets securities debits
  for interest calculations (IB's AdjustmentForSecuritiesDeficit); any remaining
  debit is charged benchmark plus 1.50% (a first-tier approximation). Commodities
  cash itself receives no credit interest. Thresholds and fees use the engine's
  existing CPI deflator for historical purchasing-power consistency.
- Treasury collateral carries a 25% maintenance haircut approximation; the
  allocation targets at least a 15% excess-liquidity cushion where feasible.
- Treasury P&L is part of consolidated capital used for futures sizing.
  Buying Treasuries changes asset allocation, never account equity except costs.

## Explicit limits

This is a daily-bar approximation, not a replay of broker statements:

- Opens proxy 10:00 ET execution; closes proxy the final-five-minute Treasury
  maintenance window. No 10:00 prices or intraday liquidation paths are invented.
- Actual IBKR SPAN/house margin histories and initial-margin schedules are
  unavailable. The 8% maintenance estimate and 25% ETF haircut remain configurable
  approximations, not broker what-if results. Deficiency funding uses daily marks;
  intraday transfers and liquidation interventions are not reconstructed.
- The overnight sweep is a next-index-session proxy. Holidays, exact statutory
  hold/release times, PDT buying-power snapshots, order settlement delays and
  broker-specific transfer times are not reconstructed. Today’s gains do not fund
  today's routine close purchases. The model does not infer the paper account's
  sweep election; its production assumption is the live sweep-to-securities setup.
- Historical Treasury proxy data is adjusted total return, not executable share
  prices. Order bands and commissions use $100 SGOV / $58 VGSH share equivalents
  in present dollars, CPI-deflated; distributions are reinvested in those units.
- SGOV and VGSH jointly satisfy Treasury risk-off targets and survive re-entry
  in kind. Non-Treasury targets (e.g. 100% BRK.B for SPX risk-off) are funded by
  selling surplus Treasury collateral first; they are not limited to residual
  cash. This matches the bot’s Treasury-pool funding policy.
  The 50/50 sleeve reset transfers Treasury holdings in
  kind, without creating trades. Settlement delays are not modeled.
  The two-index fund uses account-wide sweep, Treasury and interest thresholds,
  while retaining sleeve NAV and attributing each executed leg's costs to its owner.
- Futures richness remains an explicit 0.35% annual assumption on notional.
  It has not been fitted to LETFs or replaced by one recent roll observation.
- The legacy analytical whole-cash sweep remains available to engine callers
  that omit `treasuryCollateral`, principally existing low-level regression tests.
- Default snapshots omit individual collateral transactions to stay within the
  download budget; their equity and cost metrics include all trades. A fresh
  run exposes the full ledger, with collateral quantities in equivalent units.

## Evidence and checks

Broker documentation checked 2026-11-13:

- https://www.interactivebrokers.com/support/faq/content/1112354345
  (segregated cash, 5% margin cushion, transfer band and post-trade funding)
- https://www.interactivebrokers.com/support/faq/content/will-able-use-proceeds-closed-34492970
  (release from statutory margin and the typical following-morning transfer)

- https://www.interactivebrokers.com/en/pricing/pricing-calculations-int.php
  (segment eligibility; USD ACT/360)
- https://www.interactivebrokers.com/en/accounts/fees/pricing-interest-rates.php
  (cash exclusion, NAV scaling and Pro credit spread)
- https://www.interactivebrokers.com/en/trading/margin-rates.php
  (first-tier debit spread)
- https://www.cmegroup.com/articles/2026/funding-the-us-equity-market-to-new-heights.html
  (variable implied financing, not a constant historical spread)

`unit-tests/futures-cash-account.test.ts` checks margin segregation, the buffer,
transfer boundaries, overnight timing, mandatory funding, account-wide netting,
SGOV share/percentage boundaries, VGSH selection and no interest on commodities cash. The collateral suite
checks ETF marking, share bands, execution costs and regime transitions.

The historical studies below predate this cash-segment correction and shared-pool
maintenance. Their values describe the earlier model and must be rerun before
using them to compare current policies or choose a leverage tolerance.

## Reserve policy comparison (2026-11-13)

Reproduce the historical 1% tolerance comparison with
`LEVERAGE_TOLERANCE=1 node --import tsx scripts/compare-collateral-policies.ts`.
Bundled common data ends 2026-11-10; start 1988-04-06, $100,000 initial,
Max 4.5x SPX / Max 3.5x NDX fund, calibrated bands and vol/RSI gates,
SPX risk-off BRK.B+GLDM and NDX risk-off VGSH. All policies use separate
sleeve reserves and the same in-kind resets.

| Treasury purchase policy | Average daily VGSH | Final VGSH | Real CAGR | Max drawdown |
| --- | ---: | ---: | ---: | ---: |
| Both sleeves always VGSH | 100.00% | 100.00% | 35.45% | 64.08% |
| Current: NDX always VGSH, SPX entry VGSH / routine SGOV-first | 85.12% | 76.57% | 35.45% | 64.11% |
| Old: both entry VGSH / routine SGOV-first | 33.72% | 27.41% | 35.03% | 64.72% |

VGSH mix is VGSH market value / (VGSH + SGOV market values), excluding cash;
the average weights funded trading dates equally. Final mix is before forced
liquidation. Real CAGR uses CPI. These are historical model results, including
pre-inception Treasury proxies; differences of a few hundredths of a point
are not evidence of a reliably superior policy.

The comparison uses the page's 280-session warm-up and aligns Treasury/risk-off
prices to the trading window, excluding warm-up rows. Its default-policy CAGR
and drawdown must equal the generated futures snapshot before a report is
accepted. The earlier report aligned these arrays to the warm-up-inclusive
index dates and is superseded by the corrected table above.

## Leverage tolerance search (2026-11-13)

The search script was removed once the study concluded; recover it with
`git show 44bec7e:scripts/optimize-futures-tolerance.ts`. Its baseline check
predates the SGOV-buffer, Micro Futures and "SPX/NDX start" defaults, so a
rerun must first be brought back in line with the current snapshot.

`EXHAUSTIVE=1 node --import tsx scripts/optimize-futures-tolerance.ts` tests
0–100% inclusive in 0.1-point increments (one common tolerance for both sleeves).
Each of four windows opens independently at 50/50: 1988-04-06..2026-11-10,
1988-04-06..2007-12-31, 2008-01-02..2026-11-10 and 2016-01-04..2026-11-10.
The 4,004 grid runs use $100,000 initial capital; 80 additional runs check
selected settings at $1 million. All modeled costs remain enabled. Before searching, the current production-default full-window nominal CAGR and
drawdown must match the generated snapshot. The historical study below used 1%.

| Tolerance | Full-window real CAGR | Max drawdown | Futures transaction rows/year | 2008–2026 real CAGR |
| --- | ---: | ---: | ---: | ---: |
| Previous default 1% | 35.45% | 64.11% | 271.7 | 34.07% |
| 6.1% | 35.81% | 64.01% | 66.2 | 34.28% |
| 10% candidate | 35.94% | 64.69% | 38.1 | 34.20% |
| Full-grid winner 42.4% | 38.34% | 51.83% | 14.8 | 31.72% |

42.4% also wins the early-period grid, but ranks 461/1,001 in the later period.
The later-period grid winner is 36.5%; the recent-period winner is 17.8%.
This is a retrospective sensitivity study, not a universally optimal parameter.
Starting capital changes contract rounding and rankings: at $1 million, 10%
returns 35.95% real CAGR over the full window versus 35.37% at 1%, but returns
36.11% versus 36.85% at 1% in the recent window. There is no all-window dominance.

Tolerance controls both routine sizing and the open-session leverage-only trim
threshold. At 42.4%, those thresholds become 4.5×1.424 = 6.408x SPX and
3.5×1.424 = 4.984x NDX; average risk-on futures leverage nevertheless falls to
3.55x/2.82x from 4.47x/3.49x at 1%. Its return difference is a different leverage
path as well as lower transaction costs. At 10%, the thresholds are 4.95x/3.85x.
The study initially left settings unchanged. The operator subsequently selected
9% as the production default in l-etf and futures, including leo and mia configs.

### $10 million starting capital

Run `INITIAL_CAPITAL=10000000 TOLERANCES=1,5,10,15 node --import tsx scripts/optimize-futures-tolerance.ts`.
The default $100k baseline is still checked against the snapshot before these
16 independent-window runs; only initial capital changes.

| Tolerance | Full real CAGR | Max drawdown | Futures transaction rows/year | 2008–2026 real CAGR | 2016–2026 real CAGR |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1% | 35.37% | 64.22% | 292.5 | 34.78% | 36.93% |
| 5% | 35.15% | 64.30% | 85.9 | 34.48% | 37.16% |
| 10% | 35.74% | 64.79% | 38.8 | 35.10% | 36.84% |
| 15% | 34.96% | 64.13% | 26.6 | 33.82% | 34.83% |

10% still has the highest full-window CAGR among 5/10/15, but 5% wins the
recent-window comparison. More starting capital reduces contract-rounding
sensitivity; it does not remove sensitivity to the chosen starting date.


Production tolerance is now 9%. This is a relative band: the leverage-only
trim thresholds are 4.905x for a 4.5x SPX target and 3.815x for a 3.5x NDX target.
Explicit URL settings and persisted page inputs still override the site default.
The default futures snapshot is regenerated whenever this setting changes.


### $10 million: every whole percent from 5 through 15

Run `INITIAL_CAPITAL=10000000 TOLERANCES=1,5,6,7,8,9,10,11,12,13,14,15 node --import tsx scripts/optimize-futures-tolerance.ts`.
These 48 runs reproduce the earlier sixteen $10M results exactly.

| Tolerance | Full real CAGR | Max drawdown | Futures transaction rows/year | 2008–2026 real CAGR | 2016–2026 real CAGR |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5% | 35.15% | 64.30% | 85.9 | 34.48% | 37.16% |
| 6% | 35.57% | 64.06% | 69.9 | 34.91% | 36.99% |
| 7% | 35.99% | 64.11% | 57.5 | 35.37% | 37.79% |
| 8% | 36.13% | 64.21% | 49.2 | 35.01% | 37.06% |
| 9% | 36.18% | 64.79% | 42.9 | 35.69% | 37.34% |
| 10% | 35.74% | 64.79% | 38.8 | 35.10% | 36.84% |
| 11% | 35.67% | 65.35% | 35.0 | 34.45% | 36.90% |
| 12% | 35.81% | 64.88% | 32.3 | 34.36% | 36.21% |
| 13% | 35.84% | 64.81% | 29.6 | 35.05% | 35.71% |
| 14% | 35.15% | 65.42% | 28.0 | 34.42% | 36.31% |
| 15% | 34.96% | 64.13% | 26.6 | 33.82% | 34.83% |

9% has the highest full-window and later-window CAGR in this grid; 7% wins the
recent window. The operator chose 9% after reviewing this comparison.
