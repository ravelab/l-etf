import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

  return NextResponse.json({
    snapshotEndDate: payload.snapshotEndDate,
    sharedInputs: payload.sharedInputs,
    pageState: payload.pageState,
  });
}

function isSnapshotPageKey(value: string): value is keyof typeof snapshotFileByPageKey {
  return Object.hasOwn(snapshotFileByPageKey, value);
}
