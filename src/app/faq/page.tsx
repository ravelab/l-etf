import { Card } from "@/components/ui/Card";

type FAQItem = {
  id?: string;
  question: string;
  answer: React.ReactNode;
};

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
          <strong className="text-accent"> SMA Risk-Off Assets</strong>, and <strong className="text-accent">Holding Period</strong>
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
          <strong className="text-foreground">How it works:</strong>
        </p>
        <ul className="list-disc list-inside space-y-1 ml-4">
          <li>With a <strong className="text-foreground">5% buffer</strong>, you only exit when 
            price falls 5% below the SMA</li>
          <li>You only re-enter when price rises 5% above the SMA</li>
        </ul>
        <p>
          Buffers can reduce false switches and trading costs. The tradeoff is that they can also
          delay exits or delay buying back in.
        </p>
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

export default function FAQPage() {
  return (
    <div className="min-h-screen bg-background text-foreground p-3 md:p-6">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl md:text-4xl font-bold mb-2">Frequently Asked Questions</h1>
        <p className="text-muted mb-8">
          Plain-English answers about leveraged ETFs, moving-average strategies, and how to read the
          backtests.
        </p>

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
