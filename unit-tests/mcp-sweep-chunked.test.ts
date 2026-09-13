import test from "node:test";
import assert from "node:assert/strict";
import { resolveBacktest } from "@/lib/mcp/backtest-config";
import { runRollingSweep } from "@/lib/mcp/sweep-core";
import { createDeadline } from "@/lib/mcp/compute-budget";
import { isAbortError } from "@/lib/abort";
import type { EtfConfig } from "@/lib/simulation/types";

const RANGE = { startDate: "1990-01-01", endDate: "2020-01-01" };

function sweepConfigs(count: number): { index: "sp500" | "nasdaq100"; configs: EtfConfig[] } {
  const { config, index } = resolveBacktest({ preset: "UPRO", smaEnabled: true });
  const configs = Array.from({ length: count }, (_, i) => ({
    ...config,
    id: `sma-${100 + i * 10}`,
    name: `UPRO SMA ${100 + i * 10}`,
    smaEnabled: true,
    smaPeriod: 100 + i * 10,
  }));
  return { index, configs };
}

test("chunking a sweep produces exactly the same rows as running it in one pass", async () => {
  const { index, configs } = sweepConfigs(7);
  const [single, chunked] = await Promise.all([
    runRollingSweep({ index, configs, windowLength: 10, ...RANGE, chunkSize: 64 }),
    runRollingSweep({ index, configs, windowLength: 10, ...RANGE, chunkSize: 2 }),
  ]);

  assert.equal(single.rows.length, configs.length);
  assert.equal(chunked.rows.length, single.rows.length);
  assert.deepEqual(
    chunked.rows.map((r) => r.id),
    single.rows.map((r) => r.id),
    "chunk boundaries must not reorder or drop configs",
  );
  // Every metric must be bit-identical: chunking changes only how many configs
  // the engine holds at once, never the arithmetic.
  assert.deepEqual(chunked.rows, single.rows);
  assert.equal(chunked.truncated, false);
  assert.equal(chunked.evaluatedConfigs, configs.length);
  assert.equal(chunked.totalConfigs, configs.length);
});

test("each row lands on the config that produced it, across a chunk boundary", async () => {
  const { index, configs } = sweepConfigs(5);
  const { rows } = await runRollingSweep({
    index,
    configs,
    windowLength: 10,
    ...RANGE,
    chunkSize: 2,
  });
  // The join is on the globally-stamped parameterValue, so labels must match
  // the config at the same position — a chunk-local restamp would shift these.
  for (const [i, row] of rows.entries()) {
    assert.equal(row.id, configs[i].id);
    assert.equal(row.label, configs[i].name);
  }
});

test("an expired deadline truncates after the first chunk instead of running on", async () => {
  const { index, configs } = sweepConfigs(6);
  const result = await runRollingSweep({
    index,
    configs,
    windowLength: 10,
    ...RANGE,
    chunkSize: 2,
    // Already over budget before the sweep starts.
    deadline: createDeadline(0, Date.now() - 10_000),
  });

  assert.equal(result.truncated, true, "must report that it stopped early");
  assert.equal(result.totalConfigs, 6);
  assert.equal(result.evaluatedConfigs, 2, "the first chunk always runs");
  assert.ok(result.rows.length > 0, "a truncated sweep still returns what it computed");
  assert.ok(result.rows.length < configs.length);
});

test("a generous deadline runs every chunk", async () => {
  const { index, configs } = sweepConfigs(6);
  const result = await runRollingSweep({
    index,
    configs,
    windowLength: 10,
    ...RANGE,
    chunkSize: 2,
    deadline: createDeadline(10 * 60_000),
  });
  assert.equal(result.truncated, false);
  assert.equal(result.evaluatedConfigs, 6);
});

test("progress advances monotonically from 0 to 1 across chunks", async () => {
  const { index, configs } = sweepConfigs(6);
  const seen: number[] = [];
  await runRollingSweep({
    index,
    configs,
    windowLength: 10,
    ...RANGE,
    chunkSize: 2,
    onProgress: (fraction) => seen.push(fraction),
  });

  assert.ok(seen.length > 0, "progress was reported");
  for (const fraction of seen) {
    assert.ok(fraction >= 0 && fraction <= 1, `fraction ${fraction} out of range`);
  }
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] >= seen[i - 1], `progress went backwards at ${i}: ${seen[i - 1]} -> ${seen[i]}`);
  }
  assert.equal(seen[seen.length - 1], 1, "progress finishes at 1");
});

test("an aborted signal raises a properly-named AbortError", async () => {
  const { index, configs } = sweepConfigs(6);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      runRollingSweep({
        index,
        configs,
        windowLength: 10,
        ...RANGE,
        chunkSize: 2,
        signal: controller.signal,
      }),
    (error: unknown) => {
      assert.ok(isAbortError(error), `expected an AbortError, got ${String(error)}`);
      return true;
    },
  );
});
