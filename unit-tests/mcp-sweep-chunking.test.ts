import test from "node:test";
import assert from "node:assert/strict";
import {
  SWEEP_CHUNK_SIZE,
  buildGlobalParamValues,
  chunkConfigs,
  chunkProgressFraction,
} from "@/lib/mcp/sweep-chunking";
import type { EtfConfig } from "@/lib/simulation/types";

function fakeConfigs(n: number): EtfConfig[] {
  return Array.from({ length: n }, (_, i) => ({ id: `c${i}` }) as EtfConfig);
}

test("chunkConfigs splits into even chunks plus a remainder", () => {
  const chunks = chunkConfigs(fakeConfigs(10), 4);
  assert.deepEqual(chunks.map((c) => c.length), [4, 4, 2]);
  assert.equal(chunks.flat().length, 10);
});

test("chunkConfigs returns one chunk when the size covers everything", () => {
  assert.equal(chunkConfigs(fakeConfigs(3), 10).length, 1);
  assert.equal(chunkConfigs(fakeConfigs(4), 4).length, 1);
});

test("chunkConfigs handles an empty list", () => {
  assert.deepEqual(chunkConfigs([], 4), []);
});

test("chunkConfigs rejects a non-positive size rather than looping forever", () => {
  assert.throws(() => chunkConfigs(fakeConfigs(3), 0));
  assert.throws(() => chunkConfigs(fakeConfigs(3), -1));
});

test("chunkConfigs does not mutate or alias its input", () => {
  const configs = fakeConfigs(6);
  const snapshot = configs.map((c) => c.id);
  const chunks = chunkConfigs(configs, 2);
  chunks[0].push({ id: "injected" } as EtfConfig);
  assert.deepEqual(configs.map((c) => c.id), snapshot, "source array untouched");
  assert.equal(configs.length, 6);
});

test("buildGlobalParamValues stamps each config with its index in the WHOLE list", () => {
  const configs = fakeConfigs(5);
  const paramValues = buildGlobalParamValues(configs);
  assert.deepEqual(paramValues, { c0: 0, c1: 1, c2: 2, c3: 3, c4: 4 });
});

test("a chunk's configs keep their GLOBAL index, never a chunk-local one", () => {
  // The engine drops configs whose bucket comes back empty, so rows are joined
  // on `parameterValue`, not array position. If a later chunk restamped from 0
  // its rows would collide with the first chunk's and silently overwrite them.
  const configs = fakeConfigs(10);
  const paramValues = buildGlobalParamValues(configs);
  const chunks = chunkConfigs(configs, 4);
  const lastChunk = chunks[chunks.length - 1];
  assert.deepEqual(
    lastChunk.map((c) => paramValues[c.id]),
    [8, 9],
    "final chunk must carry indices 8 and 9, not 0 and 1",
  );
  const stamped = Object.values(paramValues);
  assert.equal(new Set(stamped).size, stamped.length, "indices are unique across chunks");
});

test("chunkProgressFraction spans 0..1 monotonically across chunks", () => {
  assert.equal(chunkProgressFraction(0, 4, 0), 0);
  assert.equal(chunkProgressFraction(0, 4, 1), 0.25);
  assert.equal(chunkProgressFraction(2, 4, 0.5), 0.625);
  assert.equal(chunkProgressFraction(4, 4, 0), 1);
  assert.equal(chunkProgressFraction(3, 4, 1), 1);
});

test("chunkProgressFraction clamps out-of-range input", () => {
  assert.equal(chunkProgressFraction(0, 0, 0.5), 1, "no chunks means nothing left to do");
  assert.equal(chunkProgressFraction(9, 4, 0), 1);
  assert.equal(chunkProgressFraction(0, 4, -1), 0);
  assert.equal(chunkProgressFraction(0, 4, 5), 0.25);
});

test("the default chunk size keeps peak heap bounded", () => {
  // ~2.8 MB of precomputed daily values is retained per config for the life of
  // one engine call; a 400-config sweep measured 1.1 GB unchunked. The chunk
  // size is what keeps that flat, so it must stay well under that breadth.
  assert.ok(SWEEP_CHUNK_SIZE >= 8, "too small wastes per-chunk setup");
  assert.ok(SWEEP_CHUNK_SIZE <= 64, "too large reintroduces the memory ceiling");
});
