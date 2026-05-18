# S&P 500 and Nasdaq 100: Composition Drift, Volatility Drag, and 3× LETF Break-Evens

## TL;DR

- **Both indices have drifted from diversified large-cap exposure toward concentrated mega-cap growth exposure.** SPX top-10 weight is roughly mid/high-30s percent in 2024-2026. NDX has required concentration-driven special rebalances in 1998, 2011, and 2023.
- **This changes what UPRO and TQQQ actually lever.** UPRO is still broader than TQQQ, but both products now contain more shared mega-cap technology/platform factor risk than long-run index history suggests.
- **Volatility drag is quadratic in leverage and scales with σ².** For a daily-reset 3× ETF, the pure variance drag versus 3× the index's compounded return is approximately 3·σ².
- **That drag shortcut is incomplete.** Real LETF carry also includes financing, expense ratio, swap spread/tracking error, and path effects not captured by the log-normal approximation.
- **Current local borrowing-rate data matters.** `public/rate-borrow.csv` shows SOFR at **3.66% on 2026-04-27**. With a 0.40% swap-spread assumption, a 3× ETF's financing cost is about 2·(3.66% + 0.40%) = 8.1%/yr before fund expenses and volatility drag.
- **Corrected buy-and-hold break-evens at current rates:** UPRO needs roughly **8.7%/yr SPX return** at 16% SPX vol to tie unleveraged SPX. TQQQ needs roughly **12.5%/yr NDX return** at 22% NDX vol to tie unleveraged NDX.
- **SMA can lower the hurdle, but not mechanically.** It helps when it reduces time spent in high-volatility drawdowns and high-financing exposure. It hurts when exits are followed by fast V-shaped recoveries or policy-noise whipsaws.

## Table of Contents

1. [S&P 500: From industrial America to mega-cap platforms](#1-sp-500-from-industrial-america-to-mega-cap-platforms)
2. [Nasdaq 100: From growth OTC basket to concentrated tech/platform index](#2-nasdaq-100-from-growth-otc-basket-to-concentrated-techplatform-index)
3. [Cross-cutting observations](#3-cross-cutting-observations)
4. [Volatility drag mechanics](#4-volatility-drag-mechanics)
5. [Corrected break-even math](#5-corrected-break-even-math)
6. [SMA-modified LETF math](#6-sma-modified-letf-math)
7. [Tax-aware implementation in a taxable account](#7-tax-aware-implementation-in-a-taxable-account)
8. [Simulator implications](#8-simulator-implications)

## 1. S&P 500: From industrial America to mega-cap platforms

The modern S&P 500 began on March 4, 1957. It remains a broad U.S. large-cap index, but the economic exposure inside the index has changed substantially.

### 1.1 Sector evolution (approximate weights)

| Sector group | 1957 | 1980 | 2000 | 2010 | 2026 approx. |
|---|---:|---:|---:|---:|---:|
| Industrials + Materials + Energy | ~55% | ~45% | ~17% | ~22% | ~15% |
| Utilities | ~10% | ~6% | ~4% | ~3% | ~2-3% |
| Financials | ~2% | ~5% | ~17% | ~16% | ~13% |
| Consumer Staples + Discretionary | ~20% | ~22% | ~19% | ~21% | ~19% |
| Health Care | ~3% | ~6% | ~14% | ~12% | ~11% |
| Info Tech + Communication Services | ~3% | ~10% | ~30% | ~22% | ~35-40% |

The exact numbers depend on historical sector definitions. Communication Services did not exist as the current GICS bucket before 2018, and some companies moved between Tech, Consumer Discretionary, and Communication Services.

The structural point is more important than the exact sector line: capital-light, high-margin platform companies replaced a large amount of capital-heavy cyclicality. SPX is now less purely an industrial-cycle index and more exposed to software, semiconductors, cloud, digital advertising, and global platform margins.

### 1.2 Concentration

- SPX top-10 weight was roughly mid-20s percent around 1980.
- It was lower around 2010.
- It rose into the mid/high-30s percent range in the 2024-2026 period.

Because SPX is float-cap weighted, winners mechanically compound their index weight until either:

1. they draw down,
2. another company outgrows them,
3. issuance/float changes matter,
4. or index committee changes affect membership.

There is no hard single-name cap comparable to Nasdaq 100's modified market-cap methodology.

### 1.3 Volatility and factor implications

SPX realized volatility has not obviously trended upward in proportion to concentration. Long-run SPX annualized volatility remains roughly 15-17% in many windows. But the source of that volatility has changed.

Earlier SPX risk was more tied to industrial production, banks, energy, materials, and rate-sensitive cyclicals. Current SPX risk is more tied to:

- mega-cap technology earnings,
- AI capex expectations,
- long-duration discount-rate sensitivity,
- platform regulation and antitrust,
- semiconductor cycle risk,
- dollar/global revenue exposure.

That distinction matters for leveraged products. A stable long-run volatility estimate can hide a changing tail-risk source. A 10% gap in a top mega-cap name moves the index more today than the same single-name shock would have moved an older, less concentrated SPX.

### 1.4 UPRO implication

UPRO targets 3× daily SPX exposure. At 16% SPX vol, pure daily-reset drag is:

3·0.16² = 7.68%/yr

That is manageable in a low-rate, trending market. It is not manageable during high-volatility bear markets:

3·0.28² = 23.52%/yr

At 40% realized vol, the pure variance drag is:

3·0.40² = 48.0%/yr

This is why UPRO-style exposure can fail badly even when the underlying index eventually recovers. The daily-reset path matters.

## 2. Nasdaq 100: From growth OTC basket to concentrated tech/platform index

Nasdaq 100 launched on January 31, 1985 as the largest non-financial Nasdaq-listed companies. The exclusion of financials is the key design choice: it embeds a permanent growth/technology tilt.

### 2.1 Sector evolution (approximate weights)

| Sector group | 1985 | 1995 | 2000 | 2015 | 2026 approx. |
|---|---:|---:|---:|---:|---:|
| Information Technology | ~30% | ~40% | ~57% | ~54% | ~50% |
| Communication Services | small | ~5% | ~10% | split later | ~15% |
| Consumer Discretionary | ~25% | ~20% | ~18% | ~22% | ~18% |
| Consumer Staples | ~15% | ~10% | ~3% | ~6% | ~4% |
| Health Care | ~15% | ~15% | ~7% | ~12% | ~6% |
| Industrials + Other | ~15% | ~10% | ~5% | ~3% | ~7% |

In 1985, NDX was not a pure technology index. It had technology, but also retailers, food companies, apparel companies, and other non-financial growth companies. By 2000 it was close to a technology-bubble proxy. By 2026, it is much closer to "mega-cap platform technology plus AMZN/TSLA plus a smaller set of consumer/health/industrial survivors."

### 2.2 Concentration and special rebalances

Nasdaq 100 uses a modified market-cap methodology precisely because concentration can become extreme. Special rebalances have been used when concentration became index-integrity-threatening:

1. **December 1998:** Microsoft had become extremely large in the index.
2. **May 2011:** Apple had become extremely large in the index.
3. **July 24, 2023:** the largest mega-cap technology names had again become too large as a group.

The exact caps and thresholds are methodology-specific, but the intuition is simple: NDX has an explicit concentration-control mechanism that SPX does not have in the same form.

### 2.3 Volatility

NDX is structurally more volatile than SPX:

- SPX: roughly 15-17% annualized vol in many long-run windows.
- NDX: roughly 22-28% annualized vol depending on sample window.
- NDX beta to SPX is commonly above 1, often around 1.2-1.35 by period.

Major historical NDX drawdowns:

- 2000-2002: roughly -83%.
- 2008: roughly -50%+.
- 2022: roughly -35%.

The upside skew also matters. NDX can deliver extreme upside months in growth-led bull markets. That is why TQQQ can look spectacular in the right regime and catastrophic in the wrong one.

### 2.4 TQQQ implication

For TQQQ, baseline volatility drag is much larger than for UPRO:

3·0.22² = 14.52%/yr

At 28% NDX vol:

3·0.28² = 23.52%/yr

At 40% NDX vol:

3·0.40² = 48.0%/yr

TQQQ therefore starts with a much higher break-even hurdle. It needs either:

- a strong trend,
- low realized volatility,
- low financing rates,
- or a timing/filter rule that avoids high-volatility drawdowns.

Without those, daily reset plus financing can overwhelm the higher long-run return of the underlying index.

## 3. Cross-cutting observations

### 3.1 The quality/growth factor dominates both indices

The largest names in both indices increasingly share similar factor exposures:

- high ROIC,
- high margins,
- high intangible-asset weight,
- long-duration cash-flow profile,
- global revenue,
- sensitivity to discount rates,
- sensitivity to AI/platform capital allocation.

This makes SPX and NDX less independent than a naive "broad index versus tech index" framing suggests. In a mega-cap growth drawdown, both UPRO and TQQQ are likely to be hit together.

### 3.2 Passive flows can amplify concentration

Cap-weighted passive flows buy more of the largest names by construction. That does not mean passive flows alone create concentration, but they can make concentration more persistent once fundamentals and price momentum have created it.

This creates a reflexive component:

1. winners outperform,
2. their index weights rise,
3. passive flows allocate more dollars to them,
4. they become larger drivers of index returns.

This is helpful in the bull phase and dangerous in reversal phases.

### 3.3 SMA is a convex bet on drawdown duration

SMA does not "know" the future. It helps when drawdowns persist long enough that the saved loss and saved volatility drag outweigh:

- exit slippage,
- re-entry slippage,
- missed rebound,
- tax friction if taxable,
- risk-off underperformance.

It tends to help in slow, grinding bear markets: 2000-2002, 2008, and 2022 are the classic examples. It tends to struggle in fast V-shaped recoveries, where the exit and re-entry can become the entire loss.

### 3.4 Fast V-shapes are not all the same

There are at least two mechanisms:

1. **Structural fast-V:** real shock, forced selling, then rapid policy/liquidity response. March 2020 is the clean example.
2. **Policy-noise fast-V:** headline-driven selloff followed by clarification, walk-back, or political reversal. These can create temporary signals without a durable economic downtrend.

The distinction matters because filters that help with one may not help with the other.

| Mitigation | Structural fast-V | Policy-noise fast-V |
|---|---|---|
| Wider buffer / hysteresis | partial | partial |
| Longer SMA | yes | yes |
| Re-entry confirmation | yes | partial |
| Vol-of-vol filter | yes | weak |
| Breadth / credit confirmation | yes | stronger |

Credit and breadth confirmation are promising because real bear markets usually show up outside the index price. A pure headline shock often does not propagate as deeply into credit spreads or market breadth.

## 4. Volatility drag mechanics

### 4.1 Derivation

Notation:

- μ = annualized arithmetic return of the index,
- σ = annualized volatility of the index,
- L = leverage multiple,
- g₁ = compounded log return of the unleveraged index,
- gₗ = compounded log return of the L× daily-reset ETF before fees and financing.

Approximate compounded log return for the unleveraged index:

g₁ ≈ μ − ½·σ²

For a daily-reset L× ETF before fees and financing:

gₗ ≈ L·μ − ½·L²·σ²

Naive expectation of "L times the index's compounded return":

L × g₁ = L × (μ − ½·σ²) = L·μ − ½·L·σ²

The gap is:

L·g₁ − gₗ = ½·L·(L − 1)·σ²

For L = 3:

½·3·2·σ² = 3·σ²

This is the pure variance drag. It is not the total cost of the product.

### 4.2 Drag by volatility regime

| Index annual volatility σ | 3× drag = 3·σ² | Regime intuition |
|---:|---:|---|
| 12% | 4.3%/yr | very calm bull market |
| 16% | 7.7%/yr | normal SPX-ish long-run vol |
| 22% | 14.5%/yr | normal NDX-ish long-run vol |
| 28% | 23.5%/yr | stressed equity regime |
| 40% | 48.0%/yr | crisis vol |

The non-linearity is the whole point. Doubling volatility quadruples volatility drag.

### 4.3 Round-trip example

Underlying:

1.10 × 0.90 = 0.99

The index loses 1%.

3× daily-reset ETF:

1.30 × 0.70 = 0.91

The ETF loses 9%.

The index's two-day return is -1%, so a naive 3× expectation would be -3%. The realized 3× ETF return is -9%. The extra -6% is daily-reset path dependence.

### 4.4 Measuring annualized volatility

Use daily log returns:

rₜ = ln(Pₜ / Pₜ₋₁)

Where rₜ is the one-day log return, Pₜ is the price on day t, and Pₜ₋₁ is the prior trading day's price.

Sample daily volatility:

σ_daily = √[Σ(rₜ − mean daily return)² / (N − 1)]

Annualized volatility:

σ_annual = σ_daily·√252

The estimate depends materially on window length. A 60-day window reacts quickly but is noisy. A 252-day window is more stable but lags regime shifts. For LETF risk, recent realized volatility is often more relevant than a full-history average.

## 5. Corrected break-even math

### 5.1 Buy-and-hold condition

The old version of this report used too little volatility drag in the buy-and-hold break-even. The corrected approximation is:

Notation:

- g₁ = compounded log return of the unleveraged index,
- g₃ = compounded log return of the 3× LETF,
- μ = annualized arithmetic return of the index,
- σ = annualized volatility of the index,
- ER = fund expense ratio,
- financing = annualized cost of borrowed exposure and swaps.

Unleveraged index log return:

g₁ ≈ μ − ½·σ²

3× LETF log return after expense ratio and financing:

g₃ ≈ 3·μ − 4.5·σ² − ER − financing

Set g₃ = g₁:

3·μ − 4.5·σ² − ER − financing = μ − ½·σ²

Therefore:

2·μ = 4·σ² + ER + financing

This solves for the required arithmetic drift. The table reports the required
index compounded return, which is:

g₁ = μ − ½·σ²

Substitute the arithmetic-drift solution into g₁:

Break-even return = index compounded return needed for the 3× LETF to tie the unleveraged index:

break-even return ≈ exp[(3·σ² + ER + financing) / 2] − 1

Why 3·σ² rather than 1.5·σ²? Because the relevant hurdle is the 3× product's pure volatility drag versus 3× the index's compounded return. The two extra turns of leverage must pay for that full drag plus fees and financing.

### 5.2 Financing assumption

For a 3× ETF, financing cost is approximately:

financing ≈ 2·(risk-free rate + swap spread)

Current local data:

- `public/rate-borrow.csv` latest row: **2026-04-27, 3.66%, SOFR**
- swap-spread assumption: **0.40%**
- 3× financing: 2·(3.66% + 0.40%) = 8.12%/yr

This is before expense ratio and before volatility drag.

### 5.3 UPRO buy-and-hold break-even

Assumptions:

- leverage L = 3
- ER = 0.91%
- financing = 2·(risk-free rate + 0.40%)

| SPX vol σ | Risk-free rate | Financing | Total hurdle term 3·σ² + ER + financing | SPX return needed |
|---:|---:|---:|---:|---:|
| 16% | 0.00% | 0.80% | 9.39% | **4.8%/yr** |
| 16% | 2.00% | 4.80% | 12.39% | **6.9%/yr** |
| 16% | 3.66% | 8.12% | 16.71% | **8.7%/yr** |
| 16% | 5.30% | 11.40% | 19.99% | **10.5%/yr** |
| 22% | 3.66% | 8.12% | 23.55% | **12.5%/yr** |
| 28% | 3.66% | 8.12% | 32.55% | **17.7%/yr** |

Interpretation: at 16% SPX vol and current SOFR, UPRO needs SPX to return roughly 9%/yr just to tie unleveraged SPX. If volatility rises to 22%, the hurdle moves into the low double digits.

### 5.4 TQQQ buy-and-hold break-even

Assumptions:

- leverage L = 3
- ER = 0.84%
- financing = 2·(risk-free rate + 0.40%)

| NDX vol σ | Risk-free rate | Financing | Total hurdle term 3·σ² + ER + financing | NDX return needed |
|---:|---:|---:|---:|---:|
| 22% | 0.00% | 0.80% | 16.16% | **8.4%/yr** |
| 22% | 2.00% | 4.80% | 20.16% | **10.6%/yr** |
| 22% | 3.66% | 8.12% | 23.48% | **12.5%/yr** |
| 22% | 5.30% | 11.40% | 26.76% | **14.3%/yr** |
| 28% | 3.66% | 8.12% | 32.48% | **17.6%/yr** |
| 32% | 3.66% | 8.12% | 39.68% | **21.9%/yr** |

The TQQQ hurdle is high because NDX volatility is high. The long-run NDX return can justify leverage in good regimes, but the margin is much thinner than the 2010s experience implies.

### 5.5 Reconciling with empirical LETF gaps

The formula is directionally useful, but actual ETF returns can diverge because:

- swap financing varies through the year,
- funds rebalance daily with implementation frictions,
- realized path has skew/kurtosis beyond log-normal assumptions,
- dividends and index/fund timing differ,
- expense ratios and swap spreads are not the only tracking components,
- strong trend years can beat the simple variance approximation.

The formula should be treated as a break-even estimator, not a return predictor.

## 6. SMA-modified LETF math

### 6.1 Four effects

SMA changes the buy-and-hold equation in four ways.

**1. Conditional volatility falls while invested.**

The strategy tends to exit during downtrends, which often overlap with high realized volatility. If full-period SPX vol is 16% but invested-time vol is 12%, pure 3× volatility drag falls from:

3·0.16² = 7.7%

to:

3·0.12² = 4.3%

For NDX, a drop from 22% to 17% reduces pure drag from:

14.5% to 8.7%

**2. Financing exposure falls.**

When in the 3× ETF, the strategy pays approximately:

2·(risk-free rate + spread)

When out of the 3× ETF, it may earn risk-off yield instead. At current SOFR, this effect is meaningful. It was much less important in ZIRP.

**3. Deep drawdown compounding improves.**

Avoiding part of a -50% or -80% drawdown matters more than the arithmetic percentage saved. It also avoids some crisis-volatility drag during the recovery path.

**4. Whipsaw subtracts return.**

Whipsaw is not a small implementation detail. In fast V-shaped regimes, the strategy can sell near the bottom and buy back higher. That can dominate the year.

### 6.2 A more honest SMA formula

Let:

- p = fraction of time invested in the LETF,
- μᵢₙ = index arithmetic drift during invested periods,
- σᵢₙ = index volatility during invested periods,
- yᵣₒ = risk-off yield,
- ER = fund expense ratio,
- financing = leveraged financing cost,
- W = whipsaw/trading/missed-rebound drag,
- gₛₘₐ = compounded log return of the SMA strategy.

Approximate SMA-LETF log return:

gₛₘₐ ≈ p·(3·μᵢₙ − 4.5·σᵢₙ² − ER − financing) + (1 − p)·yᵣₒ − W

This is better than pretending the SMA break-even is a fixed number. It shows why SMA can help, and why it can still fail.

### 6.3 Illustrative current-rate break-evens

These are not hard facts. They are scenario estimates using:

- current SOFR around 3.66%,
- swap spread 0.40%,
- risk-off yield roughly SOFR,
- 70% invested time,
- lower invested-time volatility,
- no extreme whipsaw year.

| Product | Buy-and-hold break-even | SMA illustrative break-even before whipsaw |
|---|---:|---:|
| UPRO | ~8.7% SPX return | roughly **5-6% SPX return** |
| TQQQ | ~12.5% NDX return | roughly **7-8% NDX return** |

In a normal trend-following regime, SMA can lower the hurdle materially. In a whipsaw-heavy regime, add several percentage points of drag. In an extreme policy-noise regime, the SMA version can be worse than buy-and-hold for that year.

### 6.4 Why SMA edge is bigger on TQQQ than UPRO

SMA's structural value comes mostly from reducing exposure to high volatility. Since the volatility term is squared, the same proportional volatility reduction saves more absolute return on NDX/TQQQ than on SPX/UPRO.

Example:

- SPX: reducing invested vol from 16% to 12% saves 3·(0.16² − 0.12²) = 3.36%/yr.
- NDX: reducing invested vol from 22% to 17% saves 3·(0.22² − 0.17²) = 5.85%/yr.

This is the mathematical reason SMA has more room to add value on TQQQ. It is not because the signal is necessarily better.

## 7. Tax-aware implementation in a taxable account

The Section 6 SMA equation is a pre-tax equation. In a tax-deferred account, pre-tax and after-tax returns are equal at the time of accrual. In a taxable brokerage account they are not, and the gap is large enough to change the choice of vehicle.

### 7.1 The tax term added to the SMA equation

UPRO and TQQQ are usually held for periods shorter than one year inside an SMA strategy. Realized gains on each exit are short-term capital gains, taxed at ordinary income rates. Define:

- f = fraction of pre-tax annual gain realized as taxable income that year. f ≈ 1 for SMA, f → 0 for indefinite buy-and-hold,
- t_st = combined federal + state short-term capital gains rate,
- t_lt = combined federal + state long-term capital gains rate, including NIIT,
- t_1256 = §1256 blended rate, t_1256 = 0.6·t_lt + 0.4·t_st.

Approximate after-tax SMA-LETF log return:

gₛₘₐ,ₐfₜₑᵣ ≈ gₛₘₐ − f·max(gₛₘₐ, 0)·t

where t is the rate that applies to the chosen instrument. For UPRO/TQQQ, t = t_st. For SPX index options or /ES/MES futures, t = t_1256.

This is a one-year approximation. Multi-year compounding effects make the gap somewhat larger because lost dollars to tax cannot compound forward.

### 7.2 Illustrative after-tax break-evens

Top-bracket federal + state composite assumptions, not specific to any state:

- t_st ≈ 0.40,
- t_lt ≈ 0.24,
- t_1256 = 0.6·0.24 + 0.4·0.40 ≈ 0.30.

Take an illustrative pre-tax SMA-LETF CAGR of 12% and a 10-year horizon.

| Vehicle in taxable | Effective tax pattern | Approximate after-tax CAGR |
|---|---|---:|
| UPRO/TQQQ + SMA | t_st on full gain each year | ~7.2% |
| /MES or /ES + SMA | t_1256 on full gain each year (year-end mark-to-market) | ~8.4% |
| SPX index options + SMA | t_1256 on full gain each year | ~8.4% |
| UPRO/TQQQ buy-and-hold | t_lt on terminal sale only | ~10.0% |
| UPRO/TQQQ in Roth IRA / 401k | 0 | 12.0% |

The §1256 vehicles recover roughly 1.2 percentage points of CAGR versus running the same SMA on UPRO. Tax-deferred accounts recover the full 4.8 points. These numbers move with bracket and state and should not be treated as fixed.

### 7.3 Replacing UPRO with /MES futures

The E-mini S&P 500 future has multiplier $50·SPX. The Micro E-mini /MES has multiplier $5·SPX. To replicate $X of UPRO 3× SPX exposure:

n_MES ≈ 3·X / (5·SPX)

At SPX = 6500 and X = $30,000: n_MES ≈ 2.77, rounded to 3 contracts.

Differences from UPRO:

- No fund expense ratio.
- No daily-reset volatility drag. /MES tracks SPX cleanly.
- Embedded financing rate is the implied repo in the futures basis, structurally similar to UPRO's swap financing.
- §1256 mark-to-market: realized and unrealized P&L are taxed each year on Form 6781. Tax deferral past December 31 is not available.
- /MES does not reproduce UPRO's positive convexity in clean uptrends. UPRO can outperform /MES pre-tax in strong trending years and underperform in choppy years.

### 7.4 Long puts as a partial substitute for SMA exit

Long puts on SPX or SPY are bounded-duration insurance, not equivalent to an SMA exit-to-cash. For premium drag π:

g_with_puts ≈ g_buy_and_hold − π + payouts

Empirical π for 5% OTM rolling protective puts:

- IV ≈ 15%: π ≈ 3-5%/yr,
- IV ≈ 30%+: π ≈ 8-12%/yr.

Long puts work well when the drawdown is fast and largely contained inside one contract window. They underperform an SMA exit in long, gradual bear markets because:

1. Premium decay accumulates across many rolls.
2. Bear-market rallies crush in-flight puts.
3. Each new put hedges only the next leg down at a lower strike, not the cumulative move from the prior peak.

Vertical put spreads reduce π by capping the maximum payout. They are cheaper insurance with smaller maximum recovery.

### 7.5 §1092 straddle rules

A put on UPRO, or a put on SPX held while long UPRO, can be treated as an offsetting position under §1092. Consequences include:

- Suspension of the LTCG holding period of UPRO,
- Deferral of loss recognition on the closed leg,
- Conversion of long-term gains into ordinary income in some structures.

A hedge structure designed to preserve LTCG by hedging instead of selling can lose that benefit if §1092 applies. This is the single most common reason the apparent tax win from a protective-put strategy fails to materialize. Confirm with a tax professional before relying on a hedge structure to keep UPRO's holding period intact.

### 7.6 Decision summary

1. Tax-advantaged room first. UPRO/TQQQ + SMA inside a Roth IRA or 401k captures the full pre-tax SMA edge.
2. In taxable, prefer §1256 instruments (/MES, /ES, SPX index options) for any active timing strategy.
3. Buy-and-hold UPRO/TQQQ in taxable can outperform SMA-on-UPRO after taxes, but only if the buy-and-hold break-even from Section 5 is met.
4. Long puts substitute for SMA only against fast crashes within the contract lifetime, not against long bear markets.
5. Verify §1092 applicability before relying on hedge structures to preserve LTCG status.

### 7.7 Limits of this section

- Brokerage commissions, futures roll cost, and option bid-ask spread are not modeled.
- State and local tax variation is collapsed into a single composite rate.
- Cash-drag during exit periods is captured in Section 6 yᵣₒ, not re-modeled here.
- Capital loss harvesting in down years can reduce the effective t and is not modeled.
- Wash-sale rules apply to UPRO and TQQQ but not to §1256 contracts. SPY and SPX-on-SPY interactions are not modeled.

## 8. Simulator implications

1. **Incorporate financing.** The 3·σ² shortcut alone understates current real-world LETF carry by about 8 percentage points before expenses.

2. **Report realized volatility beside returns.** A high CAGR with high realized volatility may have a much worse forward hurdle than the return number suggests.

3. **Use rolling windows.** Full-period results can be dominated by one rate/volatility regime, especially the ZIRP 2010s for TQQQ.

4. **Separate buy-and-hold from SMA.** They have different economics:
   - buy-and-hold LETF depends heavily on expected index return, volatility, and rates,
   - SMA-LETF depends additionally on invested fraction, conditional volatility, risk-off yield, and whipsaw.

5. **Treat concentration as a forward-looking risk input.** Full-history SPX/NDX volatility may understate future tail risk if mega-cap concentration keeps rising.

6. **Do not overfit the newest whipsaw years.** Recent policy-noise years are real data, but they may be administration/regime-specific. They should inform the model without becoming the whole model.

7. **The right question is break-even, not historical CAGR.** Historical TQQQ CAGR is heavily shaped by a favorable low-rate, mega-cap-tech bull market. A better question is: "At today's rate and volatility regime, what index return is required for the leveraged strategy to beat the unleveraged index?"

## Bottom line

UPRO and TQQQ are not just "3× SPX" and "3× NDX" over long horizons. They are daily-reset products whose long-run results depend on:

- index return,
- volatility path,
- financing rate,
- fund expenses,
- tracking/swap spread,
- concentration/tail risk,
- and any timing rule used to reduce exposure.

At current local rate assumptions, buy-and-hold UPRO needs roughly high-single-digit SPX returns to justify leverage, while buy-and-hold TQQQ needs low-double-digit NDX returns. SMA can lower those hurdles by reducing high-volatility exposure, but whipsaw risk is the price paid for that protection.
