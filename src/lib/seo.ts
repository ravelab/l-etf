import type { Metadata } from "next";

/**
 * NEXT_PUBLIC_SITE_URL isn't set in the Vercel production env, so sitemap/canonical/OG
 * URLs must not silently fall back to localhost in prod — only dev gets that fallback.
 */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.NODE_ENV === "development" ? "http://localhost:3000" : "https://l-etf.com");

export const SITE_NAME = "L-ETF";

/** Per-route metadata for pages whose page.tsx is a client component (metadata must live in a sibling layout.tsx). */
export function pageMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: string;
}): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      url: path,
      siteName: SITE_NAME,
      type: "website",
    },
    twitter: {
      title,
      description,
      card: "summary_large_image",
    },
  };
}
