import { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo";

const BOX_TRADES_ENABLED = process.env.NEXT_PUBLIC_DISPLAY_BOX_TRADES === "true";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = [
    { path: "", priority: 1, changeFrequency: "daily" as const },
    { path: "/signals", priority: 0.9, changeFrequency: "hourly" as const },
    { path: "/tools", priority: 0.9, changeFrequency: "daily" as const },
    { path: "/backtesting-tool", priority: 0.8, changeFrequency: "daily" as const },
    { path: "/compare-letfs", priority: 0.8, changeFrequency: "daily" as const },
    { path: "/compare-riskoff-assets", priority: 0.8, changeFrequency: "daily" as const },
    { path: "/compare-sma-strategies", priority: 0.8, changeFrequency: "daily" as const },
    { path: "/compare-threshold-strategies", priority: 0.8, changeFrequency: "daily" as const },
    { path: "/statistical-analysis", priority: 0.8, changeFrequency: "daily" as const },
    { path: "/futures-tool", priority: 0.8, changeFrequency: "daily" as const },
    { path: "/faq", priority: 0.6, changeFrequency: "monthly" as const },
    ...(BOX_TRADES_ENABLED
      ? [{ path: "/box-trades", priority: 0.5, changeFrequency: "daily" as const }]
      : []),
  ];

  return routes.map((route) => ({
    url: `${SITE_URL}${route.path}`,
    lastModified: new Date(),
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
