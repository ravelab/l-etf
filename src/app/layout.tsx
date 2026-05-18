import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import "./globals.css";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { Toaster } from "sonner";
import { ChartJSInitializer } from "@/components/ui/ChartJSInitializer";
import { DeployVersionWatcher } from "@/components/DeployVersionWatcher";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#000000",
};

export const metadata: Metadata = {
  title: "L-ETF",
  description:
    "Backtest leveraged ETF strategies",
  appleWebApp: {
    capable: true,
    title: "L-ETF",
    statusBarStyle: "black-translucent",
  },
};

const THEME_INIT_SCRIPT = `
(() => {
  try {
    const saved = localStorage.getItem("theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const dark = saved ? saved === "dark" : prefersDark;
    document.documentElement.classList.toggle("dark", dark);
  } catch {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <meta name="apple-touch-fullscreen" content="yes" />
        {/* iOS Splash Screens */}
        {/* iPhone 16 Pro Max */}
        <link rel="apple-touch-startup-image" href="/splash-portrait.png" media="screen and (device-width: 440px) and (device-height: 952px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        {/* iPhone 16 Pro */}
        <link rel="apple-touch-startup-image" href="/splash-portrait.png" media="screen and (device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        {/* iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus */}
        <link rel="apple-touch-startup-image" href="/splash-portrait.png" media="screen and (device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        {/* iPhone 14 Pro, 15, 15 Pro, 16 */}
        <link rel="apple-touch-startup-image" href="/splash-portrait.png" media="screen and (device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        {/* iPhone 13 Pro Max, 14 Plus */}
        <link rel="apple-touch-startup-image" href="/splash-portrait.png" media="screen and (device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        {/* iPhone 12, 12 Pro, 13, 13 Pro, 14 */}
        <link rel="apple-touch-startup-image" href="/splash-portrait.png" media="screen and (device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        {/* iPhone 12 mini, 13 mini, 11 Pro, XS, X */}
        <link rel="apple-touch-startup-image" href="/splash-portrait.png" media="screen and (device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        {/* iPhone 11 Pro Max, XS Max */}
        <link rel="apple-touch-startup-image" href="/splash-portrait.png" media="screen and (device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        {/* iPhone 11, XR */}
        <link rel="apple-touch-startup-image" href="/splash-portrait.png" media="screen and (device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" />
        {/* iPhone 8 Plus, 7 Plus, 6s Plus, 6 Plus */}
        <link rel="apple-touch-startup-image" href="/splash-portrait.png" media="screen and (device-width: 414px) and (device-height: 736px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" />
        {/* iPhone 8, 7, 6s, 6, SE 2/3 */}
        <link rel="apple-touch-startup-image" href="/splash-portrait.png" media="screen and (device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" />
        
        {/* iPads */}
        <link rel="apple-touch-startup-image" href="/splash-portrait.png" media="screen and (device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash-portrait.png" media="screen and (device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" />
        <link rel="apple-touch-startup-image" href="/splash-portrait.png" media="screen and (device-width: 768px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" />

        {/* Landscape */}
        <link rel="apple-touch-startup-image" href="/splash-landscape.png" media="screen and (device-width: 440px) and (device-height: 952px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" />
        <link rel="apple-touch-startup-image" href="/splash-landscape.png" media="screen and (device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" />
        <link rel="apple-touch-startup-image" href="/splash-landscape.png" media="screen and (device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" />
        <link rel="apple-touch-startup-image" href="/splash-landscape.png" media="screen and (device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" />
        <link rel="apple-touch-startup-image" href="/splash-landscape.png" media="screen and (device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" />
        <link rel="apple-touch-startup-image" href="/splash-landscape.png" media="screen and (device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" />
        <link rel="apple-touch-startup-image" href="/splash-landscape.png" media="screen and (device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" />
      </head>
      <body className="antialiased min-h-screen flex flex-col">
        <DeployVersionWatcher />
        <ChartJSInitializer />
        <Suspense fallback={null}>
          <Header />
        </Suspense>
        <main className="flex-1">{children}</main>
        <Footer />
        <Toaster theme="dark" position="bottom-right" closeButton />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
