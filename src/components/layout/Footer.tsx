export function Footer() {
  return (
    <footer className="border-t border-card-border py-4 mt-8 bg-card-bg/50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
          <p className="text-xs text-muted leading-relaxed max-w-5xl">
            <strong className="font-semibold text-foreground">Disclaimer:</strong>{" "}
            For research and education only, not investment advice. Leveraged ETFs are high risk, and backtests or signals do not guarantee future results.
          </p>
          <div className="flex flex-col items-end">
            <span className="text-xs text-muted/50">© 2026</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
