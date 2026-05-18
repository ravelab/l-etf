import { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const routes = [
    "",
    "/signals",
    "/faq",
    "/tools",
    "/backtesting-tool",
    "/compare-letfs",
    "/compare-riskoff-assets",
    "/compare-sma-strategies",
    "/compare-threshold-strategies",
    "/statistical-analysis",
  ];

  return routes.map((route) => ({
    url: `${baseUrl}${route}`,
    lastModified: new Date(),
    changeFrequency: "daily" as const,
    priority: route === "" ? 1 : 0.8,
  }));
}
