export const OG_IMAGE_SIZE = { width: 1200, height: 630 };

export function SiteOgImage() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#0c0d0d",
        backgroundImage:
          "radial-gradient(circle at 25% 20%, rgba(167,139,250,0.28), transparent 55%), radial-gradient(circle at 80% 80%, rgba(139,92,246,0.22), transparent 50%)",
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          fontSize: 130,
          fontWeight: 700,
          color: "#f5f3ff",
          letterSpacing: -2,
        }}
      >
        L-<span style={{ color: "#a78bfa" }}>ETF</span>
      </div>
      <div
        style={{
          display: "flex",
          marginTop: 24,
          fontSize: 34,
          color: "#c8c9cf",
          maxWidth: 880,
          textAlign: "center",
        }}
      >
        {"Leveraged ETF Backtesting & SMA Signal Tracker"}
      </div>
    </div>
  );
}
