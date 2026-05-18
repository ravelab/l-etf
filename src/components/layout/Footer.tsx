export function Footer() {
  return (
    <footer className="border-t border-card-border py-4 mt-8 bg-card-bg/50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
          <div className="max-w-5xl">
            <h3 className="text-xs font-semibold text-foreground mb-1">Disclaimer</h3>
            <p className="text-xs text-muted leading-relaxed">
              For research and education only, not investment advice. Leveraged ETFs are high risk,
              and backtests or signals do not guarantee future results.
            </p>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-xs text-muted/50">
              © 2026{" "}
              <a
                href="https://github.com/ravelab/l-etf"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-muted"
              >
                L-ETF Repo
              </a>
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
