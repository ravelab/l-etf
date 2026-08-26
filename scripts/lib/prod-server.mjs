import { spawn } from "node:child_process";
import { createServer } from "node:net";

/**
 * Build (unless skipped) and start a Next.js production server on a free local
 * port. Returns the base URL and a `stop()` function for teardown.
 *
 * Env:
 *  - SNAPSHOT_TEST_SKIP_BUILD=1 → reuse existing .next directory
 *  - E2E_TEST_SKIP_BUILD=1       → same
 */

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function runChildToCompletion(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", cwd: process.cwd() });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code}`));
    });
  });
}

async function waitForReady(baseUrl, deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(`${baseUrl}/api/tool-snapshots?pageKey=compare-letfs`);
      if (res.ok) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${baseUrl} did not become ready within ${deadlineMs}ms`);
}

/**
 * @param {{ skipBuild?: boolean; readyTimeoutMs?: number }} [options]
 * @returns {Promise<{ baseUrl: string; stop: () => Promise<void> }>}
 */
export async function startProdServer(options = {}) {
  const skipBuild =
    options.skipBuild ??
    Boolean(process.env.SNAPSHOT_TEST_SKIP_BUILD || process.env.E2E_TEST_SKIP_BUILD);
  const readyTimeoutMs = options.readyTimeoutMs ?? 60000;

  if (!skipBuild) {
    console.log("Building production bundle (set E2E_TEST_SKIP_BUILD=1 to skip)...");
    await runChildToCompletion("npx", ["next", "build"], "next build");
  } else {
    console.log("Skipping next build (E2E_TEST_SKIP_BUILD=1 or SNAPSHOT_TEST_SKIP_BUILD=1)");
  }

  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`Starting prod server on ${baseUrl}...`);
  const server = spawn("npx", ["next", "start", "-p", String(port)], {
    stdio: ["ignore", "inherit", "inherit"],
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
  });

  let exited = false;
  server.on("exit", () => {
    exited = true;
  });

  try {
    await waitForReady(baseUrl, readyTimeoutMs);
  } catch (err) {
    if (!exited) server.kill("SIGTERM");
    throw err;
  }

  return {
    baseUrl,
    stop: () =>
      new Promise((resolve) => {
        if (exited) return resolve();
        server.once("exit", () => resolve());
        server.kill("SIGTERM");
        setTimeout(() => {
          if (!exited) server.kill("SIGKILL");
        }, 5000);
      }),
  };
}
