import { config as loadEnv } from "dotenv";
import {
  isPushInfrastructureReady,
  sendSmaPushNotifications,
} from "@/lib/push/server";

loadEnv({ path: ".env.local" });
loadEnv();

function parseForceMode(): boolean {
  const args = process.argv.slice(2);
  if (args.includes("--force") || args.includes("-f")) {
    return true;
  }

  const value = process.env.SMA_PUSH_FORCE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

async function main() {
  const force = parseForceMode();

  if (!isPushInfrastructureReady()) {
    console.log("[push-alerts] Skipping: push infrastructure is not configured");
    return;
  }

  const result = await sendSmaPushNotifications({ force });

  if (result.skippedReason) {
    console.log(`[push-alerts] ${result.skippedReason}`);
    return;
  }

  const mode = result.forced ? " (forced)" : "";
  console.log(
    `[push-alerts] Sent ${result.sent} notifications, removed ${result.removed} stale subscriptions${mode}`
  );
}

main().catch((error) => {
  console.error("[push-alerts] Fatal error:", error);
  process.exitCode = 1;
});
