import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Unique per Vercel deployment; stable for the lifetime of this build. */
export async function GET() {
  const v =
    process.env.VERCEL_DEPLOYMENT_ID ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    "local";
  return NextResponse.json(
    { v },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    }
  );
}
