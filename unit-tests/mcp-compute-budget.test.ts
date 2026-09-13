import test from "node:test";
import assert from "node:assert/strict";
import {
  MCP_SWEEP_BUDGET_MS,
  SWEEP_MS_PER_CONFIG_WINDOW,
  createDeadline,
  deadlineRemainingMs,
  estimateSweepMs,
  isDeadlineExpired,
  maxConfigsInBudget,
} from "@/lib/mcp/compute-budget";

test("estimateSweepMs scales with both configs and windows", () => {
  const one = estimateSweepMs(1, 1000);
  const ten = estimateSweepMs(10, 1000);
  const wide = estimateSweepMs(1, 2000);
  // Per-chunk overhead means it is not exactly 10x, but it must be monotonic
  // and dominated by the config x window term at this size.
  assert.ok(ten > one);
  assert.ok(wide > one);
  assert.ok(ten > wide, "config count dominates at 10x breadth");
  assert.ok(estimateSweepMs(0, 1000) >= 0);
});

test("estimateSweepMs is grounded in the measured per-unit cost", () => {
  // 1000 configs over ~1572 full-history windows measured ~37s locally; the
  // constant carries a server-slowdown margin, so the estimate must be at
  // least that, and within an order of magnitude of it.
  const estimate = estimateSweepMs(1000, 1572);
  assert.ok(estimate >= 37_000, `estimate ${estimate} should not undercut the measured 37s`);
  assert.ok(estimate <= 370_000, `estimate ${estimate} should stay within 10x of measured`);
  assert.ok(SWEEP_MS_PER_CONFIG_WINDOW > 0);
});

test("maxConfigsInBudget inverts the estimate", () => {
  const windows = 1572;
  const n = maxConfigsInBudget(windows, MCP_SWEEP_BUDGET_MS);
  assert.ok(n >= 1, "at least one config must always fit");
  assert.ok(
    estimateSweepMs(n, windows) <= MCP_SWEEP_BUDGET_MS,
    "the returned count must fit the budget",
  );
  assert.ok(
    estimateSweepMs(n + 1, windows) > MCP_SWEEP_BUDGET_MS,
    "one more config must not fit",
  );
});

test("maxConfigsInBudget never returns zero, even on an absurd window count", () => {
  assert.equal(maxConfigsInBudget(10_000_000, 1), 1);
});

test("a deadline measures against an injected clock", () => {
  const deadline = createDeadline(1000, 5_000);
  assert.equal(deadline.budgetMs, 1000);
  assert.equal(deadlineRemainingMs(deadline, 5_000), 1000);
  assert.equal(deadlineRemainingMs(deadline, 5_400), 600);
  assert.equal(isDeadlineExpired(deadline, 5_400), false);
  assert.equal(isDeadlineExpired(deadline, 6_000), true);
  assert.equal(isDeadlineExpired(deadline, 9_999), true);
});

test("deadlineRemainingMs clamps at zero rather than going negative", () => {
  const deadline = createDeadline(1000, 0);
  assert.equal(deadlineRemainingMs(deadline, 50_000), 0);
});

test("createDeadline returns a frozen value, never a mutable handle", () => {
  const deadline = createDeadline(1000, 0);
  assert.ok(Object.isFrozen(deadline));
});
