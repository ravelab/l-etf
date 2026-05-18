import { NextRequest, NextResponse } from "next/server";
import { pushSubscribePayloadSchema } from "@/lib/push/schema";
import { isPushStorageReady, savePushSubscription } from "@/lib/push/server";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isPushStorageReady()) {
    return NextResponse.json(
      { error: "Push notifications are not configured yet." },
      { status: 503 }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = pushSubscribePayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid subscription payload", details: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const record = await savePushSubscription(parsed.data.subscription, {
      installId: parsed.data.installId,
      smaConfig: parsed.data.smaConfig,
      request,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
    return NextResponse.json({ success: true, subscription: record });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save subscription";
    const status =
      message.includes("origin") ? 403 :
      message.includes("wait a moment") || message.includes("Too many alert signups") ? 429 :
      500;
    return NextResponse.json(
      { error: message },
      { status }
    );
  }
}
