const GENERATED_ARTIFACT_COMMIT_SUBJECT = "chore(data): refresh generated artifacts";

// Source of truth: CRON_TRIGGERED_BUILD_MARKER_KEY in src/lib/cron-build-marker.ts.
// The refresh-data cron writes this key right before it fires the Vercel Deploy
// Hook, so its presence marks a build as cron-triggered. A Deploy Hook redeploys
// the current branch tip (usually the artifact commit), which would otherwise be
// indistinguishable from the redundant deployment that fires when commit-data
// pushes the artifact commit — and get wrongly ignored.
const CRON_TRIGGERED_BUILD_MARKER_KEY = "cron:refresh-data:pending-build";

// Exit codes follow Vercel's "Ignored Build Step" convention:
//   exit 0 → skip the build, exit 1 → proceed with the build.
const SKIP_BUILD = 0;
const PROCEED_BUILD = 1;

function hasRedisConfig() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

/**
 * Peek at the pending cron build marker without consuming it. build-vercel.ts is
 * responsible for consuming the marker; here we only need to know whether the
 * current deployment was triggered by the cron's Deploy Hook.
 *
 * Returns:
 *   true  → marker present (cron-triggered build)
 *   false → marker absent (Redis configured, but nothing pending)
 *   null  → could not determine (Redis unconfigured or the request failed)
 */
async function peekCronTriggeredBuildMarker() {
  if (!hasRedisConfig()) return null;

  const baseUrl = process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const url = `${baseUrl}/get/${encodeURIComponent(CRON_TRIGGERED_BUILD_MARKER_KEY)}`;

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      console.warn(`[ignore-vercel-build] Marker check failed: HTTP ${response.status}`);
      return null;
    }
    const body = await response.json();
    return body?.result != null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ignore-vercel-build] Marker check errored: ${message}`);
    return null;
  }
}

async function main() {
  const commitMessage = process.env.VERCEL_GIT_COMMIT_MESSAGE ?? "";
  const subject = commitMessage.split(/\r?\n/, 1)[0].trim();

  if (subject !== GENERATED_ARTIFACT_COMMIT_SUBJECT) {
    console.log(`[ignore-vercel-build] Allowing build for commit: ${subject || "(no message)"}`);
    process.exit(PROCEED_BUILD);
  }

  // The branch tip is the artifact commit. Distinguish a cron Deploy Hook
  // redeploy (must build) from the redundant push of the artifact commit (skip).
  const cronTriggered = await peekCronTriggeredBuildMarker();

  if (cronTriggered === true) {
    console.log(
      `[ignore-vercel-build] Allowing build: cron Deploy Hook marker present despite artifact commit subject`,
    );
    process.exit(PROCEED_BUILD);
  }

  if (cronTriggered === null && hasRedisConfig()) {
    // Redis is configured but unreachable. Prefer building over silently
    // dropping a cron-triggered deployment; a redundant build is cheaper than
    // stale data.
    console.log(
      `[ignore-vercel-build] Allowing build: could not read cron marker, failing safe toward building`,
    );
    process.exit(PROCEED_BUILD);
  }

  console.log(`[ignore-vercel-build] Ignoring generated artifact commit: ${subject}`);
  process.exit(SKIP_BUILD);
}

main();
