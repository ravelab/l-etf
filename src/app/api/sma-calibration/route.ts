import { NextResponse } from "next/server";
import { readSmaCalibrationSnapshot } from "@/lib/sma-calibration";

/** `?variant=inflation` serves the inflation-adjusted calibration; anything else the nominal one. */
export async function GET(request: Request) {
  const variant = new URL(request.url).searchParams.get("variant") === "inflation" ? "inflation" : "nominal";
  const payload = await readSmaCalibrationSnapshot(variant);
  if (!payload) {
    return NextResponse.json({ error: "SMA calibration data missing" }, { status: 404 });
  }

  return NextResponse.json(payload);
}
