# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Simulation engine: entry/exit spread contract

`src/lib/simulation/window-calculations.ts` is the single source of truth for
entry/exit trading-cost deduction, shared by `engine.ts`, `parallel.ts`,
`wrapped-window.ts`, and `worker.ts`. Contract: entry spread is folded into
the renormalization factor at a window's start (so it compounds through the
whole path, matching `simulateSingleEtf`'s day-0 bake-in); exit spread is
only ever deducted from the final reported value, never baked into a
`dailyValues` array. Any new code that renormalizes a windowed sub-range of a
precomputed daily-value series must route through `computeRenormalizedPathMetrics`
/ `renormalizeSeriesFromIndex` (both take an `entrySpread` param) rather than
hand-rolling `factor = CONSTANT_INITIAL_INVESTMENT / firstValue` — that
pattern silently discards the entry-spread cost.

`src/lib/simulation/worker.ts` is a hand-maintained duplicate of
`parallel.ts`'s windowed-extraction logic for the Web Worker bundle (it
doesn't import from `parallel.ts`). When changing spread/cost logic in
`extractRegularWindowSimulation` (parallel.ts), mirror the change in
`buildWindowSimulation` (worker.ts) — `wrapped-worker.ts` doesn't have this
problem since it imports `wrapped-window.ts` directly.

Both `worker.ts`'s `mode_type === 'backtest'` branch and `parallel.ts`'s
`extractResultsMainThread`'s `mode === 'backtest'` branch are dead code as of
2026-07 — no caller passes that literal mode. They contain the same
spread-deduction bug pattern as the live paths; leave them alone unless you
also verify they've become reachable.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
