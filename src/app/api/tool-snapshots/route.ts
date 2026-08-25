import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildApiCacheHeaders } from "@/lib/api/cache-headers";

type SnapshotPayload = {
  generatedAt: string;
  snapshotEndDate: string;
  sharedInputs: Record<string, unknown>;
  pageKey: string;
  pageState: Record<string, unknown>;
};

const snapshotFileByPageKey = {
  backtesting: "backtesting.json",
  "compare-letfs": "compare-letfs.json",
  "compare-riskoff-assets": "compare-riskoff-assets.json",
  "compare-sma": "compare-sma.json",
  "compare-threshold": "compare-threshold.json",
  "statistical-analysis": "statistical-analysis.json",
  "futures": "futures.json",
} as const;

/**
 * Serialized response bodies, memoized by file mtime. These snapshots are large
 * (futures ~4MB, backtesting ~1.8MB) and were re-read, re-parsed and
 * re-serialized on every request. Caching the finished body string skips both
 * the parse and the stringify; mtime keying keeps dev correct after
 * `npm run snapshots:generate`.
 */
const bodyCache = new Map<string, { mtimeMs: number; body: string }>();

export async function GET(request: NextRequest) {
  const requestedPageKey = request.nextUrl.searchParams.get("pageKey") ?? "backtesting";
  if (!isSnapshotPageKey(requestedPageKey)) {
    return NextResponse.json(
      { error: `Snapshot for page ${requestedPageKey} missing` },
      { status: 404 }
    );
  }

  const pageKey = requestedPageKey;
  const snapshotPath = join(
    process.cwd(),
    "src",
    "lib",
    "tool-snapshots",
    snapshotFileByPageKey[pageKey]
  );

  let mtimeMs: number;
  try {
    mtimeMs = (await stat(snapshotPath)).mtimeMs;
  } catch {
    return NextResponse.json(
      { error: `Snapshot for page ${pageKey} missing` },
      { status: 404 }
    );
  }

  const cached = bodyCache.get(pageKey);
  if (cached && cached.mtimeMs === mtimeMs) {
    return jsonBody(cached.body);
  }

  let payload: SnapshotPayload;
  try {
    const raw = await readFile(snapshotPath, "utf-8");
    payload = JSON.parse(raw) as SnapshotPayload;
  } catch {
    return NextResponse.json(
      { error: `Snapshot for page ${pageKey} missing` },
      { status: 404 }
    );
  }

  if (payload.pageKey !== pageKey) {
    return NextResponse.json(
      { error: `Snapshot payload mismatch for page ${pageKey}` },
      { status: 500 }
    );
  }

  const body = JSON.stringify({
    snapshotEndDate: payload.snapshotEndDate,
    sharedInputs: payload.sharedInputs,
    pageState: payload.pageState,
  });
  bodyCache.set(pageKey, { mtimeMs, body });
  return jsonBody(body);
}

function jsonBody(body: string): Response {
  return new Response(body, {
    headers: {
      ...buildApiCacheHeaders({ dataCacheSources: ["file"] }),
      "Content-Type": "application/json",
    },
  });
}

function isSnapshotPageKey(value: string): value is keyof typeof snapshotFileByPageKey {
  return Object.hasOwn(snapshotFileByPageKey, value);
}
