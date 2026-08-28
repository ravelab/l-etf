import type { NextConfig } from "next";

/**
 * What the browser may load, and from where.
 *
 * This app fetches nothing off-site — no remote images, no third-party scripts, and the analytics
 * beacons are same-origin under /_vercel — so everything is `'self'` and the few exceptions are
 * the ones a framework forces. Next inlines its own hydration payload on every page and cannot be
 * hashed without threading a nonce through middleware, so inline script is allowed; that costs
 * most of what a policy buys against injected script, and leaves what it still buys: an injected
 * script cannot reach a host of its own, the page cannot be framed by anyone else, its base
 * cannot be rewritten, and no plugin can be loaded at all.
 */
function contentSecurityPolicy(): string {
  const isDev = process.env.NODE_ENV !== "production";
  const scriptSrc = ["'self'", "'unsafe-inline'"];
  // Only dev evaluates code from strings; a production bundle never does.
  if (isDev) scriptSrc.push("'unsafe-eval'");
  const connect = ["'self'"];
  if (isDev) connect.push("ws:", "wss:");
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": scriptSrc,
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": connect,
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "frame-src": ["'none'"],
    "frame-ancestors": ["'self'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy(),
  },
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
    // Strict: an address is not handed to a plain-HTTP hop at all, where the plain form would.
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    // A fund screener needs none of the hardware the browser can offer.
    key: "Permissions-Policy",
    value: "accelerometer=(), camera=(), geolocation=(), microphone=(), usb=(), payment=()",
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
