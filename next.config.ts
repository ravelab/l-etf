import type { NextConfig } from "next";

const securityHeaders = [
  {
    key: "X-DNS-Prefetch-Control",
    value: "on",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "X-Frame-Options",
    value: "SAMEORIGIN",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "origin-when-cross-origin",
  },
];

const nextConfig: NextConfig = {
  // Needed so Puppeteer V8 coverage can map `/_next/static` chunks back onto src/**
  // for the combined unit+e2e coverage report.
  productionBrowserSourceMaps: true,
  outputFileTracingIncludes: {
    "/api/**/*": ["./data/**/*.csv", "./src/lib/tool-snapshots/**/*.json"],
    // The MCP endpoint (app/[transport]/route.ts, served at /mcp) reads the same
    // CSV data and calibration snapshot, so it needs them traced into its bundle.
    "/[transport]": ["./data/**/*.csv", "./src/lib/tool-snapshots/**/*.json"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
