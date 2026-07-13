"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { buildToolsUrl, getToolTabForPathname, type ToolTab } from "@/lib/tools-route";
import { ToolRunHistoryMenu } from "@/components/layout/ToolRunHistoryMenu";

const NAV_ITEMS = [
  { href: "/signals", label: "Signals" },
  { tab: "strategies" as ToolTab, label: "Strategies" },
  { tab: "backtest" as ToolTab, label: "Backtest" },
  { tab: "futures" as ToolTab, label: "Futures" },
  { tab: "statistics" as ToolTab, label: "Holding Period" },
  { tab: "sma-buffer" as ToolTab, label: "SMA Buffer" },
  { tab: "sma-period" as ToolTab, label: "SMA Period" },
  { tab: "riskoff" as ToolTab, label: "SMA Risk-Off Assets" },
  ...(process.env.NEXT_PUBLIC_DISPLAY_BOX_TRADES === "true"
    ? [{ href: "/box-trades", label: "Box Trades" }]
    : []),
  { href: "/faq", label: "FAQ" },
] as const;

export function Header() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // The inline script in layout.tsx sets the correct class before paint.
  // We only read the DOM state on mount — never write it from useEffect.
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof document === "undefined") return "dark";
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  });

  const toggleTheme = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    document.documentElement.classList.toggle("dark", nextTheme === "dark");
    window.localStorage.setItem("theme", nextTheme);
  };

  const activeTab = pathname === "/tools"
    ? (searchParams.get("tab") as ToolTab | null)
    : getToolTabForPathname(pathname);

  return (
    <header className="border-b border-card-border bg-card-bg/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-14">
          <Link href="/" className="text-accent font-bold text-xl tracking-tight">
            L-ETF
          </Link>
          <div className="flex items-center gap-2">
            <nav className="order-1 hidden md:flex items-center gap-1">
              {NAV_ITEMS.map((item) => {
                const href = "tab" in item
                  ? buildToolsUrl(item.tab)
                  : item.href;
                const isActive = "tab" in item
                  ? activeTab === item.tab
                  : pathname === item.href;
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                      isActive
                        ? "bg-accent/10 text-accent"
                        : "text-muted hover:text-foreground hover:bg-white/5"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="order-3 md:order-2">
              <ToolRunHistoryMenu />
            </div>
            <button
              type="button"
              onClick={toggleTheme}
              className="order-1 md:order-3 p-1.5 rounded-md text-muted hover:text-foreground hover:bg-white/5 border border-card-border"
              aria-label="Toggle dark mode"
            >
              {theme === "dark" ? (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path d="M10 2a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 0110 2zm0 13a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 0110 15zm-8-5a.75.75 0 01.75-.75h1.5a.75.75 0 010 1.5h-1.5A.75.75 0 012 10zm13 0a.75.75 0 01.75-.75h1.5a.75.75 0 010 1.5h-1.5A.75.75 0 0115 10zM4.343 4.343a.75.75 0 011.06 0l1.061 1.06a.75.75 0 01-1.06 1.061l-1.061-1.06a.75.75 0 010-1.06zm9.193 9.193a.75.75 0 011.06 0l1.061 1.06a.75.75 0 01-1.06 1.061l-1.06-1.06a.75.75 0 010-1.061zM4.343 15.657a.75.75 0 010-1.06l1.06-1.061a.75.75 0 111.061 1.06l-1.06 1.061a.75.75 0 01-1.061 0zm9.193-9.193a.75.75 0 010-1.06l1.06-1.061a.75.75 0 111.061 1.06l-1.06 1.06a.75.75 0 01-1.061 0zM10 7a3 3 0 100 6 3 3 0 000-6zm-4 3a4 4 0 118 0 4 4 0 01-8 0z" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path fillRule="evenodd" d="M7.455 2.004a.75.75 0 01.26.77 7 7 0 009.958 7.967.75.75 0 011.067.853A8.5 8.5 0 116.647 1.921a.75.75 0 01.808.083z" clipRule="evenodd" />
                </svg>
              )}
            </button>
            <button
              type="button"
              onClick={() => setMobileMenuOpen((v) => !v)}
              className="order-2 md:hidden px-2.5 py-1.5 rounded-md text-sm text-muted hover:text-foreground hover:bg-white/5 border border-card-border"
              aria-label="Toggle navigation menu"
            >
              Menu
            </button>
          </div>
        </div>
        {mobileMenuOpen && (
          <nav className="md:hidden pb-3 flex flex-col gap-1">
            {NAV_ITEMS.map((item) => {
              const href = "tab" in item
                ? buildToolsUrl(item.tab)
                : item.href;
              const isActive = "tab" in item
                ? activeTab === item.tab
                : pathname === item.href;
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`px-3 py-2 rounded-md text-sm transition-colors ${
                    isActive
                      ? "bg-accent/10 text-accent"
                      : "text-muted hover:text-foreground hover:bg-white/5"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        )}
      </div>
    </header>
  );
}
