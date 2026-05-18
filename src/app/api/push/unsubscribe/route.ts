import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { isPushStorageReady, removePushSubscription } from "@/lib/push/server";

export const dynamic = "force-dynamic";

const unsubscribeSchema = z.object({
  endpoint: z.string().min(1),
  installId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  if (!isPushStorageReady()) {
    return NextResponse.json(
      { error: "Push notifications are not configured yet." },
      { status: 503 }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = unsubscribeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid unsubscribe payload", details: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const removed = await removePushSubscription(parsed.data.endpoint, {
      installId: parsed.data.installId,
      request,
    });
    return NextResponse.json({ success: true, removed });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to remove subscription";
    const status =
      message.includes("origin") || message.includes("install") ? 403 : 500;
    return NextResponse.json(
      { error: message },
      { status }
    );
  }
}
