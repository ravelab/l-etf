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
10% as the production default in l-etf and futures, including leo and mia configs.

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


Production tolerance is now 10%. This is a relative band: the leverage-only
trim thresholds are 4.95x for a 4.5x SPX target and 3.85x for a 3.5x NDX target.
Explicit URL settings and persisted page inputs still override the site default.
The default futures snapshot is regenerated whenever this setting changes.
