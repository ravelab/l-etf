import test from "node:test";
import assert from "node:assert/strict";
import { fetchJsonCached, clearApiJsonCacheForTests } from "../src/lib/fetch-market-data";

type StubResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
};

function jsonResponse(data: unknown, status = 200): StubResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => data,
  };
}

function withStubbedFetch(
  handler: (url: string) => Promise<StubResponse>,
): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    calls.push(String(url));
    return handler(String(url));
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test("fetchJsonCached caches successful responses", async () => {
  clearApiJsonCacheForTests();
  const stub = withStubbedFetch(async () => jsonResponse({ value: 42 }));
  try {
    const first = await fetchJsonCached<{ value: number }>("/api/test?a=1");
    const second = await fetchJsonCached<{ value: number }>("/api/test?a=1");
    assert.equal(first.data?.value, 42);
    assert.equal(second.data?.value, 42);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test("fetchJsonCached does not cache error responses", async () => {
  clearApiJsonCacheForTests();
  const stub = withStubbedFetch(async () => jsonResponse({ error: "nope" }, 500));
  try {
    const first = await fetchJsonCached("/api/test?fail=1");
    const second = await fetchJsonCached("/api/test?fail=1");
    assert.equal(first.ok, false);
    assert.equal(second.ok, false);
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test("fetchJsonCached deduplicates concurrent identical requests", async () => {
  clearApiJsonCacheForTests();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stub = withStubbedFetch(async () => {
    await gate;
    return jsonResponse({ value: "shared" });
  });
  try {
    const a = fetchJsonCached<{ value: string }>("/api/test?dedup=1");
    const b = fetchJsonCached<{ value: string }>("/api/test?dedup=1");
    release!();
    const [resA, resB] = await Promise.all([a, b]);
    assert.equal(resA.data?.value, "shared");
    assert.equal(resB.data?.value, "shared");
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test("fetchJsonCached evicts the oldest entries once the cache is full", async () => {
  clearApiJsonCacheForTests();
  const stub = withStubbedFetch(async (url) => jsonResponse({ url }));
  try {
    // Fill past the cap (64) so the first URL gets evicted.
    for (let i = 0; i <= 64; i++) {
      await fetchJsonCached(`/api/test?fill=${i}`);
    }
    const fillCalls = stub.calls.length;
    assert.equal(fillCalls, 65);

    // The most recent entry is still cached...
    await fetchJsonCached("/api/test?fill=64");
    assert.equal(stub.calls.length, fillCalls);

    // ...but the oldest was evicted and refetches.
    await fetchJsonCached("/api/test?fill=0");
    assert.equal(stub.calls.length, fillCalls + 1);
  } finally {
    stub.restore();
  }
});

test("fetchJsonCached rejects an aborted caller but still caches the shared response", async () => {
  clearApiJsonCacheForTests();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stub = withStubbedFetch(async () => {
    await gate;
    return jsonResponse({ value: "late" });
  });
  try {
    const controller = new AbortController();
    const pending = fetchJsonCached<{ value: string }>("/api/test?abort=1", controller.signal);
    controller.abort();
    await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");

    // The underlying request keeps going and populates the cache.
    release!();
    const cached = await fetchJsonCached<{ value: string }>("/api/test?abort=1");
    assert.equal(cached.data?.value, "late");
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test("fetchJsonCached rejects immediately when the signal is already aborted", async () => {
  clearApiJsonCacheForTests();
  const stub = withStubbedFetch(async () => jsonResponse({ value: "unused" }));
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      fetchJsonCached("/api/test?pre-aborted=1", controller.signal),
      (error: unknown) => (error as Error).name === "AbortError",
    );
  } finally {
    stub.restore();
  }
});
