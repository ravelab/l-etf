import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Component / jsdom suite only. Pure logic stays on node:test (unit-tests/**/*.test.ts).
    include: ["unit-tests/**/*.test.tsx"],
    environment: "jsdom",
    setupFiles: ["./unit-tests/vitest.setup.ts"],
    css: false,
    coverage: {
      provider: "v8",
      // Only files the jsdom suite actually loads. Overall (all-src) fill happens
      // in scripts/unit-coverage-report.mjs so statement maps stay consistent
      // with the node:test V8 remapping.
      all: false,
      reportsDirectory: "./coverage/unit-jsdom",
      reporter: ["json", "json-summary", "text-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts"],
      thresholds: undefined,
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
