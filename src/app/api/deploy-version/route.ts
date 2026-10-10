import { NextResponse } from "next/server";
import { BUILD_DEPLOY_VERSION } from "@/lib/deploy-version";

export const dynamic = "force-dynamic";

/** Unique per Vercel deployment; stable for the lifetime of this build. */
export async function GET() {
  return NextResponse.json(
    { v: BUILD_DEPLOY_VERSION },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    }
  );
}
