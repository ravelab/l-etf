import { NextResponse } from "next/server";
import { getVapidPublicKey } from "@/lib/push/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const publicKey = getVapidPublicKey();
  if (!publicKey) {
    return NextResponse.json(
      { error: "Push notifications are not configured yet." },
      { status: 503 }
    );
  }

  return NextResponse.json(
    { publicKey },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
