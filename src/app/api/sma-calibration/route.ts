import { NextResponse } from "next/server";
import { readSmaCalibrationSnapshot } from "@/lib/sma-calibration";

export async function GET() {
  const payload = await readSmaCalibrationSnapshot();
  if (!payload) {
    return NextResponse.json({ error: "SMA calibration data missing" }, { status: 404 });
  }

  return NextResponse.json(payload);
}
