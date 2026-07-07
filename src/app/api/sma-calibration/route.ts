import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SmaCalibrationResult } from "@/lib/sma-calibration";

const SNAPSHOT_PATH = join(process.cwd(), "src", "lib", "tool-snapshots", "sma-calibration.json");

export async function GET() {
  let payload: SmaCalibrationResult;
  try {
    const raw = await readFile(SNAPSHOT_PATH, "utf-8");
    payload = JSON.parse(raw) as SmaCalibrationResult;
  } catch {
    return NextResponse.json({ error: "SMA calibration data missing" }, { status: 404 });
  }

  return NextResponse.json(payload);
}
