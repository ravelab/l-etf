import type { Metadata } from "next";
import Link from "next/link";
import { isValidElement, type ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { JsonLd } from "@/components/seo/JsonLd";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "FAQ — Leveraged ETFs, SMA Strategies & Methodology",
  description:
    "Answers on leveraged ETF mechanics, SMA timing strategies, drawdowns, risk-off assets, trading cost assumptions, and how this app simulates leveraged ETFs before they existed.",
  path: "/faq",
});

type FAQItem = {
  id?: string;
  question: string;
  answer: React.ReactNode;
};

/** Plain-text version of a rich JSX answer, for the FAQPage JSON-LD (search engines/AI agents can't parse JSX). */
function answerToPlainText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(answerToPlainText).join(" ");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return answerToPlainText(node.props.children);
  }
  return "";
}

function faqAnswerText(answer: React.ReactNode): string {
  return answerToPlainText(answer).replace(/\s+/g, " ").trim();
}

const FAQ_DATA: FAQItem[] = [
  {
    question: "What are leveraged ETFs?",
    answer: (
      <>
        <p className="mb-3">
          Leveraged ETFs try to move by a multiple of an index each day. If the index is up 1%
          today, a 3x fund tries to be up about 3% today. If the index is down 1%, the fund tries
          to be down about 3%.
        </p>
        <ul className="list-disc list-inside space-y-1 ml-4">
          <li><strong className="text-foreground">UPRO</strong> — about 3x the S&P 500</li>
          <li><strong className="text-foreground">TQQQ</strong> — about 3x the Nasdaq 100</li>
          <li><strong className="text-foreground">SSO</strong> — about 2x the S&P 500</li>
          <li><strong className="text-foreground">QLD</strong> — about 2x the Nasdaq 100</li>
        </ul>
        <p className="mt-3">
          The important catch is that the leverage resets every day. Over months or years, the result
          will not be exactly 2x or 3x the index&apos;s total return.
        </p>
      </>
    ),
  },
  {
    question: "What is a leveraged SMA strategy?",
    answer: (
      <>
        <p className="mb-3">
          It is a rule for when to be aggressive and when to step aside. The strategy compares the
          market price with its moving average, which is just the average price over the last N
          trading days.
        </p>
        <ul className="list-disc list-inside space-y-1 ml-4">
          <li>Price above the moving average: hold the leveraged ETF</li>
          <li>Price below the moving average: move to the selected safer asset</li>
        </ul>
        <p className="mt-3">
          The goal is to stay invested during long uptrends and reduce exposure during major bear
          markets. Shorter moving averages react faster but can switch too often. Longer moving
          averages are calmer but react later.
        </p>
      </>
    ),
  },
  {
    question: "Why consider holding leveraged ETFs long term?",
    answer: (
      <>
        <p className="mb-3">
          The basic idea is that stocks have historically gone up over long periods. If the market
          return is high enough to overcome borrowing costs, fees, and bad periods, leveraged stock
          exposure can compound strongly.
        </p>
        <p className="mb-3">
          The moving-average rule is a way to avoid some of the worst crashes. It is not free: it can
          sell too early, buy back too late, or switch back and forth in choppy markets.
        </p>
        <p className="mb-3">
          This app lets you test that idea over long history. The simulated
          <strong className="text-foreground"> UPRO</strong> data goes back more than 140 years,
          and the simulated <strong className="text-foreground">TQQQ</strong> data goes back more
          than 55 years.
        </p>
        <p>
          This approach tends to look best when markets trend upward or when the rule avoids major
          crashes. It can look bad in sideways markets, where leverage costs and repeated switches
          can eat away returns. Historical results are not a guarantee.
        </p>
      </>
    ),
  },
  {
    question: "Why is higher real CAGR so important?",
    answer: (
      <>
        <p className="mb-3">
          CAGR means the average yearly growth rate. Real CAGR means the average yearly growth rate
          after inflation. It is closer to your real buying-power growth.
        </p>
        <p className="mb-3">
          Small yearly differences become large over time. For example, $10,000 growing at
          <strong className="text-foreground"> 8%</strong> for 20 years ends around
          <strong className="text-foreground"> $46,600</strong>. At
          <strong className="text-foreground"> 16%</strong>, it ends around
          <strong className="text-foreground"> $194,600</strong>.
        </p>
        <p>
          That is why the app focuses on real CAGR and real end value instead of only short-term
          gains.
        </p>
      </>
    ),
  },
  {
    question: "What does the Score mean?",
    answer: (
      <>
        <p className="mb-3">
          Score is a quick ranking number for comparison tables. It is not a return, and it is not a
          recommendation. It is just a shortcut for comparing strategies.
        </p>
        <p className="mb-3">
          A higher score usually means the strategy had a better mix of:
        </p>
        <ul className="list-disc list-inside space-y-1 ml-4">
          <li>Higher inflation-adjusted returns</li>
          <li>Better results in bad historical periods</li>
          <li>Smaller losses from peak to bottom</li>
          <li>Less excessive trading</li>
        </ul>
        <p className="mt-3">
          Use it as a sorting aid, then look at the actual return, drawdown, and trade-count numbers
          before drawing conclusions.
        </p>
      </>
    ),
  },
  {
    question: "How are expense ratios and borrowing costs handled?",
    answer: (
      <>
        <p className="mb-3">
          The app tries to avoid showing fantasy returns. It subtracts costs where they matter:
        </p>
        <ul className="list-disc list-inside space-y-2 ml-4">
          <li>
            <strong className="text-foreground">VOO and QQQ:</strong> The benchmark rows include ETF
            expense ratios, so they are closer to owning the real funds.
          </li>
          <li>
            <strong className="text-foreground">Simulated leveraged ETFs:</strong> The engine subtracts
            the fund fee every day and estimates borrowing costs from market interest-rate data plus
            a swap-spread estimate.
          </li>
          <li>
            <strong className="text-foreground">Real ETF presets:</strong> These use historical fund
            prices, which already include the fund&apos;s internal costs.
          </li>
        </ul>
      </>
    ),
  },
  {
    question: "What is a drawdown?",
    answer: (
      <>
        <p className="mb-3">
          A drawdown is how far your portfolio falls after reaching a high point. It is measured from
          the peak to the lowest point before recovery.
        </p>
        <p className="mb-3">
          <strong className="text-foreground">Example:</strong> If your portfolio drops from $100,000
          to $40,000 before recovering, that&apos;s a 60% drawdown.
        </p>
        <p>
          Drawdowns matter because big losses are hard to live through and hard to recover from. A
          50% loss needs a 100% gain just to get back to even.
        </p>
      </>
    ),
  },
  {
    question: "What are risk-off assets?",
    answer: (
      <>
        <p className="mb-3">
          Risk-off assets are what the strategy holds when it is not holding the leveraged ETF. Think
          of them as the defensive parking place.
        </p>
        <p className="mb-3">
          The choices include:
        </p>
        <ul className="list-disc list-inside space-y-2 ml-4">
          <li>
            <strong className="text-foreground">SGOV</strong> and
            <strong className="text-foreground"> VGSH</strong> — short-term Treasury bond funds.
          </li>
          <li>
            <strong className="text-foreground">GLDM</strong> — gold.
          </li>
          <li>
            <strong className="text-foreground">BRK.B</strong> — Berkshire Hathaway.
          </li>
          <li><strong className="text-foreground">VOO</strong> — S&P 500 exposure.</li>
          <li><strong className="text-foreground">QQQ</strong> — Nasdaq 100 exposure.</li>
        </ul>
        <p className="mt-3">
          For long backtests, the app extends these series backward with historical proxy data when
          the ETF did not exist yet. You can also use equal-weight mixes such as
          <strong className="text-foreground"> VGSH + GLDM</strong> or
          <strong className="text-foreground"> BRK.B + GLDM + VGSH</strong>.
        </p>
      </>
    ),
  },
  {
    id: "monthly-interpolation",
    question: "Some risk-off proxy data is only monthly. How does the app turn that into daily prices?",
    answer: (
      <>
        <p className="mb-3">
          Before some risk-off assets existed as ETFs, the app extends them with historical proxy
          data (see <strong className="text-foreground">What are risk-off assets?</strong> above)
          — for example gold before GLDM launched in 2018, or early segments of the SGOV/VGSH
          Treasury proxies. Some of that historical source data only reports one price per month,
          but backtests need a price for every trading day.
        </p>
        <p className="mb-3">
          To fill the gap, the app spreads each month&apos;s total return smoothly across that
          month&apos;s trading days instead of dumping the whole move onto a single day. This
          avoids an artificial, one-day volatility spike that a naive fill would create.
        </p>
        <p>
          The tradeoff: each mid-month daily price during these proxy-only stretches is partly
          shaped by the following month-end price, so the proxy&apos;s real intra-month swings and
          drawdowns are smoothed out, and an SMA crossing that lands mid-month in one of these
          periods uses a mildly smoothed fill price rather than that day&apos;s actual close. This
          is a deliberate, bounded look-ahead confined to filling in gaps within a single month of
          early proxy history — it does not affect modern daily data, and it is not used anywhere
          else in the simulation.
        </p>
      </>
    ),
  },
  {
    question: "What trading costs are built into the simulations?",
    answer: (
      <>
        <p className="mb-3">
          When the strategy switches, the app subtracts an estimated trading cost. This is meant to
          represent the bid-ask spread: the small cost of buying at the ask and selling at the bid.
        </p>
        <p className="mb-3">
          A switch means selling one asset and buying another. The app charges a spread cost on the
          leveraged ETF side and on the risk-off side. If the risk-off asset is a mix, it averages the
          spread cost across the assets in the mix.
        </p>
        <p className="mb-3">
          Regular-session trades use tighter spreads. Same-day close execution uses wider spreads to
          be more conservative.
        </p>
        <p className="mb-2 font-medium text-foreground">
          Assumed half-spread fractions: regular session / wider close spread
        </p>
        <ul className="list-disc list-inside space-y-1 ml-4 text-sm">
          <li>
            <strong className="text-foreground">TQQQ:</strong> 0.0001 / 0.0010
          </li>
          <li>
            <strong className="text-foreground">UPRO:</strong> 0.0001 / 0.0010
          </li>
          <li>
            <strong className="text-foreground">QLD:</strong> 0.0002 / 0.0012
          </li>
          <li>
            <strong className="text-foreground">SSO:</strong> 0.0002 / 0.0012
          </li>
          <li>
            <strong className="text-foreground">SGOV:</strong> 0.0001 / 0.0006
          </li>
          <li>
            <strong className="text-foreground">VGSH:</strong> 0.0002 / 0.0008
          </li>
          <li>
            <strong className="text-foreground">GLDM:</strong> 0.0002 / 0.0010
          </li>
          <li>
            <strong className="text-foreground">BRK.B:</strong> 0.0002 / 0.0008
          </li>
          <li>
            <strong className="text-foreground">VOO:</strong> 0.0001 / 0.0006
          </li>
          <li>
            <strong className="text-foreground">QQQ:</strong> 0.0001 / 0.0008
          </li>
        </ul>
        <p className="mt-3 text-sm text-muted">
          Example: 0.0001 means 0.01% of the traded amount for that side of the trade. Brokerage
          commissions are not modeled separately.
        </p>
      </>
    ),
  },
  {
    question: "How does the Futures page differ from the ETF backtest?",
    answer: (
      <>
        <p className="mb-3">
          The <strong className="text-accent">Futures</strong> page simulates SMA strategies with
          index futures and risk-off securities executing at the next open.
        </p>
        <ul className="list-disc list-inside space-y-1 ml-4">
          <li>Uses explicit futures costs such as IBKR-style fees and spread assumptions.</li>
          <li>Applies maintenance-margin scenarios (Normal, Stress, Crisis, Extreme).</li>
          <li>
            Tracks futures-specific diagnostics like leverage delta, excess liquidity, and
            transaction-level roll behavior.
          </li>
        </ul>
        <p className="mt-3">
          It is still a model, but it is designed to emulate real futures workflow more closely than
          ETF-only backtests.
        </p>
      </>
    ),
  },
  {
    question: "What are Best Real CAGR and Worst Real CAGR?",
    answer: (
      <>
        <p className="mb-3">
          These show the best and worst periods found in the rolling-window tests.
        </p>
        <ul className="list-disc list-inside space-y-1 ml-4">
          <li>
            <strong className="text-foreground">Best Real CAGR:</strong> the best inflation-adjusted
            yearly return in any tested period.
          </li>
          <li>
            <strong className="text-foreground">Worst Real CAGR:</strong> the worst inflation-adjusted
            yearly return in any tested period.
          </li>
        </ul>
        <p className="mt-3">
          A strategy with a great best case but a terrible worst case may be harder to stick with.
        </p>
      </>
    ),
  },
  {
    question: "How do simulations extend into the future when a full rolling window needs more data?",
    answer: (
      <>
        <p className="mb-3">
          Some pages test fixed-length periods, such as 10-year or 30-year windows. Near the end of
          the data, there may not be enough future days left to complete the full window.
        </p>
        <p className="mb-3">
          On the <strong className="text-accent">SMA Period</strong>, <strong className="text-accent">SMA Buffer</strong>,
          <strong className="text-accent"> SMA Risk-Off Assets</strong>, and <strong className="text-accent">Holding Period</strong>{" "}
          pages, the app can still include those recent starting months.
        </p>
        <p className="mb-3">
          The app does <strong className="text-foreground">not</strong> look past your selected end
          date. Instead, it fills the missing tail by wrapping back through older history. This avoids
          using future data that would not have been known at the time.
        </p>
        <p>
          This is a modeling choice. It gives newer start dates a full-length test window, but the
          tail is historical stand-in data, not a prediction.
        </p>
      </>
    ),
  },
  {
    id: "index-start-dates",
    question: "Why do the SPX and NDX start-date shortcuts use 1988 and 1985?",
    answer: (
      <>
        <p className="mb-3">
          The shortcut buttons choose practical starts for the modern index regimes. They are not
          the earliest dates available in the app, and the S&amp;P 500 is not mechanically the 500
          biggest U.S. companies—it is a committee-selected index of leading large-cap companies.
        </p>
        <ul className="ml-4 list-disc space-y-3">
          <li>
            <strong className="text-foreground">April 6, 1988 — SPX shortcut.</strong>{" "}On this date,
            S&amp;P removed the fixed numerical limits for its four major industry groups. Companies
            could then be added and removed across those categories, allowing the index to adapt
            more quickly as the market&apos;s sector mix changed. L-ETF uses this as a clean start for
            the more flexible, modern S&amp;P 500 composition regime.
          </li>
          <li>
            <strong className="text-foreground">October 1, 1985 — NDX shortcut.</strong>{" "}The Nasdaq-100
            officially launched on January 31, 1985, but October 1 is the first date for which
            L-ETF&apos;s source feed has actual NDX daily open and close data. Starting here avoids the
            earlier Nasdaq Composite proxy and keeps the strategy signal tied directly to NDX.
          </li>
          <li>
            <strong className="text-foreground">February 5, 1971 — earliest Nasdaq proxy.</strong>{" "}This
            is the launch and base date of the Nasdaq Composite. For 1971 through September 1985,
            L-ETF uses Composite price moves scaled to meet NDX at the 1985 boundary, then adds
            estimated dividends and QQQ&apos;s expense drag. It provides useful older market regimes,
            but it is not actual Nasdaq-100 history.
          </li>
          <li>
            <strong className="text-foreground">March 20, 1885 — earliest S&amp;P proxy row.</strong>{" "}This
            is where L-ETF&apos;s stitched long-history U.S. equity series begins. The S&amp;P 500 itself
            did not launch until March 4, 1957, so the older portion is a historical reconstruction,
            not live S&amp;P 500 performance. From July 1, 1926 to April 5, 1988 that reconstruction
            is a rules-based cap-weighted large-cap index rather than the S&amp;P itself — see{" "}
            <strong className="text-foreground">
              &ldquo;What is the benchmark before 1988?&rdquo;
            </strong>{" "}
            below. It is useful for very long stress tests, but conclusions should be treated more
            cautiously than results from the modern-index period.
          </li>
        </ul>
        <p className="mt-3">
          In short: use the <strong className="text-foreground">1988 SPX</strong> and
          <strong className="text-foreground"> 1985 NDX</strong> shortcuts for cleaner index-specific
          comparisons; use <strong className="text-foreground">1971</strong> or
          <strong className="text-foreground"> 1885</strong> when the extra historical regimes are
          worth accepting more proxy uncertainty.
        </p>
        <p className="mt-3 text-sm text-muted">
          Historical references:{" "}
          <a
            href="https://www.spglobal.com/spdji/en/indices/equity/sp-500/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline hover:opacity-80"
          >
            S&amp;P 500 history
          </a>
          ,{" "}
          <a
            href="https://users.cla.umn.edu/~erm/data/qrf00/data/nuttall/sp500chg.pdf"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline hover:opacity-80"
          >
            1988 constituent-change note
          </a>
          ,{" "}
          <a
            href="https://www.nasdaq.com/newsroom/celebrating-40-year-rise-nasdaq-100-index"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline hover:opacity-80"
          >
            Nasdaq-100 history
          </a>
          , and{" "}
          <a
            href="https://www.nasdaq.com/articles/nasdaq-composite-indextm%3A-50th-anniversary-brings-new-records-and-further-optimism"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline hover:opacity-80"
          >
            Nasdaq Composite history
          </a>
          .
        </p>
      </>
    ),
  },
  {
    id: "pre-1988-benchmark",
    question: "What is the benchmark before 1988?",
    answer: (
      <>
        <p className="mb-3">
          For <strong className="text-foreground">July 1, 1926 through April 5, 1988</strong>, L-ETF
          does not use the S&amp;P 500. It uses a rules-based, cap-weighted large-cap index built
          from Ken French&apos;s public data library — every U.S. stock above the NYSE 70th-percentile
          size breakpoint, weighted by market value, dividends included. From April 6, 1988 onward the
          benchmark is the actual S&amp;P 500.
        </p>
        <p className="mb-3">
          The reason is that the older S&amp;P 500 is a weaker yardstick than it looks:
        </p>
        <ul className="ml-4 list-disc space-y-3">
          <li>
            <strong className="text-foreground">Before April 6, 1988</strong> the index ran under
            fixed industry quotas — 425 industrials, 25 railroads, 25 utilities, 50 financials. Which
            companies got in depended on filling those slots, not purely on size.
          </li>
          <li>
            <strong className="text-foreground">Before March 1957</strong> there was no 500-stock
            index at all. That era is backfilled from a 90-stock composite, and it compounds about
            0.65% per year <em>faster than the entire U.S. stock market</em> over 1926–1957. A
            large-cap index cannot really outrun the whole market it is drawn from, so that gap is a
            sign of reconstruction bias rather than real return.
          </li>
        </ul>
        <p className="mt-3">
          The replacement is a close structural match: about 403 companies holding 80.7% of U.S.
          market value over 1957–1988, against the S&amp;P&apos;s 500 names and roughly 80% of value.
          Day-to-day the two move almost identically (daily correlation 0.989), and over 1957–1988
          their volatility differs by only 0.13 percentage points — which matters most here, because
          leveraged decay is driven by volatility. The main difference is level: the rules-based index
          compounds about 0.30% per year slower than the old S&amp;P series.
        </p>
        <p className="mt-3">
          Rows before July 1, 1926 are still the older Cowles-era reconstruction, rescaled to join the
          series smoothly. That data cannot be rebuilt this way — the underlying stock-level records
          simply do not exist before 1926 — so treat the pre-1926 stretch as the least reliable part
          of the history.
        </p>
        <p className="mt-3 text-sm text-muted">
          Source:{" "}
          <a
            href="https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline hover:opacity-80"
          >
            Kenneth R. French Data Library
          </a>{" "}
          — &ldquo;Portfolios Formed on ME&rdquo;, daily value-weighted returns.
        </p>
      </>
    ),
  },
  {
    question: "How do I compare different SMA periods?",
    answer: (
      <>
        <p className="mb-3">
          Use the <strong className="text-accent">SMA Period</strong> tool. It runs the same strategy
          with many moving-average lengths and compares the results.
        </p>
        <p>
          Short moving averages react quickly, which can help in crashes but can also cause too many
          false switches. Long moving averages are smoother, but they can react late.
        </p>
      </>
    ),
  },
  {
    question: "What is an SMA Buffer?",
    answer: (
      <>
        <p className="mb-3">
          A buffer is a cushion around the moving-average line. It prevents the strategy from
          switching just because the price barely crossed the line.
        </p>
        <p className="mb-3">
          The buffer is a <strong className="text-foreground">pair</strong> of values: the lower
          (sell-side) threshold for falling below the SMA, and the upper (buy-side) threshold for
          rising above it. They&apos;re shown in the input field as{" "}
          <code className="text-foreground">−[lower] , [upper] %</code>.
        </p>
        <p className="mb-3">
          <strong className="text-foreground">Symmetric example:</strong> set both to{" "}
          <strong className="text-foreground">5%</strong> and the strategy exits when price falls
          5% below the SMA and re-enters when price rises 5% above it.
        </p>
        <p className="mb-3">
          <strong className="text-foreground">Asymmetric example:</strong> set{" "}
          <code className="text-foreground">−4 / 8%</code> to exit relatively quickly on the way
          down (4% below SMA) but wait for a clearer recovery before buying back in (8% above
          SMA). The reverse —{" "}
          <code className="text-foreground">−8 / 4%</code> — is more reluctant to sell but eager to
          re-enter. Tuning the two sides independently lets you bias toward fewer whipsaws or
          earlier exits.
        </p>
        <p>
          Buffers can reduce false switches and trading costs. The tradeoff is that they can also
          delay exits or delay buying back in.
        </p>
      </>
    ),
  },
  {
    id: "letf-simulation",
    question: "How does this app simulate leveraged ETFs?",
    answer: (
      <>
        <p className="mb-3">
          <strong className="text-foreground">Why simulate at all?</strong> The real ETFs are
          young — UPRO and SSO launched in 2006-2009, TQQQ and QLD in 2006-2010. That&apos;s not
          enough history to test how a strategy would have done through, say, the 1929 crash or
          the 1970s. So the app builds a synthetic version of each ETF going back as far as the
          underlying index data exists (S&amp;P 500 since the 1800s, Nasdaq 100 since the 1980s).
        </p>

        <p className="mb-3">
          <strong className="text-foreground">How a real leveraged ETF works in plain terms.</strong>{" "}
          A 3x fund like UPRO doesn&apos;t hold $3 of stock for every $1 you put in — it holds
          roughly $1 of stock plus a $2 swap with a bank that mirrors the index. The bank
          essentially lends UPRO $2 of exposure, and UPRO pays for that loan every day. So your
          daily return is:
        </p>
        <ol className="list-decimal list-inside space-y-1 ml-4 mb-3">
          <li>3 × what the index did today, minus</li>
          <li>the fund&apos;s expense ratio (a tiny daily slice), minus</li>
          <li>the cost of borrowing the extra $2 of exposure (interest + a bank fee).</li>
        </ol>
        <p className="mb-3">
          That&apos;s exactly what the simulation does. Step 1 is the index. Step 2 is the
          published expense ratio. Step 3 is what we have to model.
        </p>

        <p className="mb-3">
          <strong className="text-foreground">Modeling the borrowing cost.</strong> The base
          borrowing rate is a real interest-rate series: historical bank rates back to 1885,
          stitched with the modern overnight SOFR rate from 2018 onward. On top of that base rate
          the bank charges an extra premium (called the &quot;swap spread&quot;). The premium
          isn&apos;t fixed — when interest rates are higher, banks charge a higher premium. So we
          model it as a slope and an intercept: <em>rate-sensitivity</em> (how much the premium
          rises when rates rise) plus a small <em>base-spread</em> (the fee when rates are zero).
        </p>

        <p className="mb-3">
          <strong className="text-foreground">How we know those two numbers are right.</strong>{" "}
          We have actual UPRO, TQQQ, SSO, and QLD prices going back to their launch dates. The
          app runs the simulation against those real prices and adjusts the two numbers until the
          simulated NAV tracks the real ETF as closely as possible day by day, over the full
          15-20 year history. The fitter looks at four kinds of error at once (day-to-day
          tracking, long-term drift, average gap, worst gap) and picks the parameters that
          minimize the combined score. This calibration re-runs automatically every Monday.
        </p>

        <p className="mb-3">
          <strong className="text-foreground">Current calibrated values:</strong>
        </p>
        <div className="overflow-x-auto mb-3">
          <table className="text-xs md:text-sm w-full">
            <thead>
              <tr className="text-left text-muted">
                <th className="pr-4 pb-1">ETF</th>
                <th className="pr-4 pb-1">Index / Leverage</th>
                <th className="pr-4 pb-1">Rate sensitivity</th>
                <th className="pb-1">Base spread</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              <tr><td className="pr-4">SSO</td><td className="pr-4">S&amp;P 500 / 2x</td><td className="pr-4">0.7182</td><td>0.413%</td></tr>
              <tr><td className="pr-4">UPRO</td><td className="pr-4">S&amp;P 500 / 3x</td><td className="pr-4">0.8993</td><td>0.300%</td></tr>
              <tr><td className="pr-4">QLD</td><td className="pr-4">Nasdaq 100 / 2x</td><td className="pr-4">0.8991</td><td>-0.023%</td></tr>
              <tr><td className="pr-4">TQQQ</td><td className="pr-4">Nasdaq 100 / 3x</td><td className="pr-4">1.0780</td><td>-0.120%</td></tr>
            </tbody>
          </table>
        </div>
        <p className="mb-3">
          A few sanity checks fall out of this. 3x funds have higher rate sensitivities than 2x —
          banks charge more for taking on more leverage. Nasdaq-tracking funds are slightly more
          rate-sensitive than S&amp;P-tracking ones, which fits the intuition that a more volatile
          index has a more expensive swap book.
        </p>

        <p className="mb-3">
          <strong className="text-foreground">Where the model stops extrapolating.</strong> Those
          two numbers can only be fitted where the real ETFs exist — 2006 onward for SSO and QLD,
          2009-10 for UPRO and TQQQ — and across that entire window the base rate never rose above
          5.8%. Inside that range the slope is well supported: forcing it to zero throws UPRO&apos;s
          simulated final return off by about 6%. Outside it there is no evidence at all, and a
          straight line runs away quickly — at the ~15% rates of 1981 it would have banks charging
          a 5-7%/yr premium <em>on top of</em> an already-15% rate, several times anything a
          funding market has charged. So above 6% the premium holds flat at its end-of-range value
          while the base rate keeps passing through in full. Every backtest that stays inside the
          fitted range — anything from 2006 on — is completely unaffected.
        </p>

        <p className="mb-3">
          <strong className="text-foreground">If you want the math.</strong> The daily formula is:
        </p>
        <pre className="text-xs md:text-sm bg-muted/20 p-3 rounded mb-3 overflow-x-auto whitespace-pre-wrap">
{`R_LETF(t) = L × R_index(t)
            − ER_daily
            − (|L| − 1) × (R_borrow(t) + swapSpread_daily(t))

swapSpread_daily(t) = (rateSensitivity × min(R_borrow_annual(t), 6%)
                       + baseSpread
                       + 0.4286 × max(0, R_borrow_annual(t) − 6%)) / 360
NAV(t) = NAV(t-1) × (1 + R_LETF(t))      (floored at 0)`}
        </pre>
        <p className="mb-3">
          The third term in the spread is what keeps the cap honest above 6%. Because the borrow
          rate is quoted on a 360-day year but charged only on the ~252 days the market is open,
          the borrow term by itself delivers 252/360 of the annual rate; the extra 0.4286 slope
          carries the remaining rate through. Without it, freezing the premium would make a 1981
          backtest borrow more cheaply than the risk-free rate.
        </p>

        <p className="mb-3">
          The <code>(|L| − 1)</code> factor is &quot;you only pay financing on the borrowed
          portion&quot; — a 3x fund borrows 2x its own capital, so it pays the borrow + spread on
          that 2x slice. Compounding day by day is what produces volatility decay over long
          horizons.
        </p>

        <p className="mb-3">
          <strong className="text-foreground">How well does it match reality?</strong> After the
          latest calibration, the simulated cumulative returns for UPRO, TQQQ, SSO, and QLD match
          their real counterparts to within roughly a few basis points of final return over
          15-20 years. You can verify this yourself on the{" "}
          <Link
            href="/tools?tab=backtest&letf=UPRO%2BTQQQ&sd=2006-06-21&ed=2026-05-22&sma=0&e0_n=QLD&e1_n=SSO&e2_n=UPRO-real&e3_n=TQQQ-real&e4_n=QLD-real&e5_n=SSO-real"
            className="text-accent underline hover:opacity-80"
          >
            backtest with simulated and real ETFs side-by-side
          </Link>{" "}
          — the simulated and <code>-real</code> lines should overlap.
        </p>

        <p>
          <strong className="text-foreground">What this simulation does <em>not</em> capture.</strong>{" "}
          Intraday rebalancing slippage, bid/ask widening during stress, dividend timing quirks,
          and any future regime change in how banks price these swaps. Treat the synthetic
          history as a reasonable approximation for research, not a guarantee.
        </p>
      </>
    ),
  },
  {
    id: "links",
    question: "Where can I find the source code or discuss this app?",
    answer: (
      <>
        <ul className="list-disc list-inside space-y-2 ml-4">
          <li>
            <strong className="text-foreground">Source code on GitHub:</strong>{" "}
            <a
              href="https://github.com/ravelab/l-etf"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline hover:opacity-80 break-all"
            >
              github.com/ravelab/l-etf
            </a>
          </li>
          <li>
            <strong className="text-foreground">Reddit discussion (r/LETFs):</strong>{" "}
            <a
              href="https://www.reddit.com/r/LETFs/comments/1tiu8ar/letfcom_track_sma_signals_backtest_leveraged_etf/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline hover:opacity-80 break-all"
            >
              r/LETFs thread
            </a>
          </li>
        </ul>
      </>
    ),
  },
  {
    question: "Are past results a guarantee of future performance?",
    answer: (
      <>
        <p className="mb-3">
          <strong className="text-foreground">No.</strong> Past performance does not guarantee
          future results.
        </p>
        <p>
          This site is for education and research only. Market conditions change, borrowing costs
          change, and strategies that worked historically may fail later. Leveraged ETFs can lose
          money very quickly and are not suitable for everyone.
        </p>
      </>
    ),
  },
];

const FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_DATA.map((item) => ({
    "@type": "Question",
    name: item.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: faqAnswerText(item.answer),
    },
  })),
};

export default function FAQPage() {
  return (
    <div className="min-h-screen bg-background text-foreground p-3 md:p-6">
      <JsonLd data={FAQ_JSON_LD} />
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl md:text-4xl font-bold mb-8">Frequently Asked Questions</h1>

        <div className="space-y-4 md:space-y-6">
          {FAQ_DATA.map((item, index) => (
            <Card key={index} id={item.id} className="p-4 md:p-6 scroll-mt-24">
              <h2 className="text-lg font-semibold mb-3 text-accent">
                {item.question}
              </h2>
              <div className="text-muted">
                {item.answer}
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
