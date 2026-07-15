import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

test("cron build marker helpers no-op when Redis is not configured", async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  const marker = await import("../src/lib/cron-build-marker");
  assert.equal(marker.isCronBuildMarkerStorageReady(), false);
  assert.equal(await marker.readCronTriggeredBuildMarker(), null);
  assert.equal(await marker.clearCronTriggeredBuildMarker(), false);
  assert.equal(await marker.markNextBuildAsCronTriggered({ source: "unit-test" }), false);
});

test("read is non-destructive and clear removes the marker", async (t) => {
  const store = new Map<string, string>();

  function runCommand([name, key, value]: [string, string?, string?]): unknown {
    switch (name.toUpperCase()) {
      case "SET":
        store.set(key!, value!);
        return "OK";
      case "GET":
        return store.get(key!) ?? null;
      case "DEL":
        return store.delete(key!) ? 1 : 0;
      default:
        throw new Error(`unsupported command: ${name}`);
    }
  }

  // @upstash/redis auto-pipelines every command by default: it POSTs to
  // `${baseUrl}/pipeline` with a body of command arrays and expects back an
  // array of `{ result }` objects, one per command, in the same order.
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const commands = JSON.parse(body) as Array<[string, string?, string?]>;
      const results = commands.map((command) => {
        try {
          return { result: runCommand(command) };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address() as AddressInfo;
  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${port}`;
  process.env.UPSTASH_REDIS_REST_TOKEN = "unit-test-token";

  const marker = await import("../src/lib/cron-build-marker");
  assert.equal(marker.isCronBuildMarkerStorageReady(), true);
  assert.equal(await marker.markNextBuildAsCronTriggered({ source: "unit-test" }), true);

  // build-vercel.ts reads the marker before `next build`; a failed build must
  // leave it in place so the retry still knows it was cron-triggered.
  const first = await marker.readCronTriggeredBuildMarker();
  assert.equal(first?.source, "unit-test");
  const second = await marker.readCronTriggeredBuildMarker();
  assert.equal(second?.source, "unit-test");

  assert.equal(await marker.clearCronTriggeredBuildMarker(), true);
  assert.equal(await marker.readCronTriggeredBuildMarker(), null);
});
