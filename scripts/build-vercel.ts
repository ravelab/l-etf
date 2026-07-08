import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The build container is not a serving region — anything it writes to the
// runtime cache will never be read by another invocation. Disable writes
// for the build process and every child it spawns (next build, scripts).
process.env.DISABLE_RUNTIME_CACHE_WRITES = "1";
import {
  consumeCronTriggeredBuildMarker,
  isCronBuildMarkerStorageReady,
} from "@/lib/cron-build-marker";
import {
  isWeeklyBuildMarkerStorageReady,
  mondayOfWeek,
  newYorkDateKey,
  readLastWeeklyRunTradingDate,
  writeLastWeeklyRunTradingDate,
} from "@/lib/weekly-build-marker";
import {
  isFirstMondayOfMonth,
  isMonthlyBuildMarkerStorageReady,
  monthKeyOf,
  readLastMonthlyRunMonth,
  writeLastMonthlyRunMonth,
} from "@/lib/monthly-build-marker";

function run(command: string) {
  console.log(`[build:vercel] ${command}`);
  execSync(command, { stdio: "inherit" });
}

function runBestEffort(command: string) {
  try {
    run(command);
    return true;
  } catch (error) {
    console.error(`[build:vercel] Best-effort step failed: ${command}`);
    console.error(error);
    return false;
  }
}

function getNewYorkDayOfWeek(date: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  });
  const day = formatter.format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(day);
}

async function maybeNotifySmaAlerts(cronBuildMarker: Record<string, unknown> | null) {
  if (!isCronBuildMarkerStorageReady()) {
    console.log("[build:vercel] Skipping SMA push alerts: cron build marker storage is not configured");
    return;
  }

  if (!cronBuildMarker) {
    console.log("[build:vercel] Skipping SMA push alerts: build was not marked as cron-triggered");
    return;
  }

  console.log("[build:vercel] Running SMA push alerts for cron-triggered build");
  runBestEffort("npm run notify:sma-alerts");
}

async function readCronTriggeredBuildMarker(): Promise<Record<string, unknown> | null> {
  if (!isCronBuildMarkerStorageReady()) {
    return null;
  }

  return consumeCronTriggeredBuildMarker();
}

function readLatestSpxTradingDate(): string | null {
  const candidates = ["index-sp.csv"];
  for (const file of candidates) {
    const path = join(process.cwd(), "data", file);
    if (!existsSync(path)) continue;
    const csv = readFileSync(path, "utf-8");
    const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
    for (let i = lines.length - 1; i >= 1; i--) {
      const firstCol = lines[i].split(",")[0];
      if (firstCol && /^\d{4}-\d{2}-\d{2}$/.test(firstCol)) return firstCol;
    }
  }
  return null;
}

async function isFirstTradingDayOfWeek(currentNyDate: string): Promise<{ should: boolean; latestTradingDate: string | null; weekMarkerDate: string; reason: string }> {
  const latestTradingDate = readLatestSpxTradingDate();
  const monday = mondayOfWeek(currentNyDate);
  if (!latestTradingDate) {
    return { should: false, latestTradingDate: null, weekMarkerDate: monday, reason: "no SPX price data available" };
  }
  if (!isWeeklyBuildMarkerStorageReady()) {
    return { should: false, latestTradingDate, weekMarkerDate: monday, reason: "weekly build marker storage is not configured" };
  }
  const lastRunDate = await readLastWeeklyRunTradingDate();
  if (lastRunDate == null) {
    return { should: true, latestTradingDate, weekMarkerDate: monday, reason: "first run (no prior marker)" };
  }
  if (lastRunDate < monday) {
    return { should: true, latestTradingDate, weekMarkerDate: monday, reason: `prior run ${lastRunDate} < current monday-of-week ${monday}` };
  }
  return { should: false, latestTradingDate, weekMarkerDate: monday, reason: `already ran this week (last ${lastRunDate}, current monday ${monday})` };
}

async function isFirstMondayOfMonthPending(currentNyDate: string): Promise<{ should: boolean; monthMarker: string; reason: string }> {
  const monthMarker = monthKeyOf(currentNyDate);
  if (!isFirstMondayOfMonth(currentNyDate)) {
    return { should: false, monthMarker, reason: "not the first Monday of the month" };
  }
  if (!isMonthlyBuildMarkerStorageReady()) {
    return { should: false, monthMarker, reason: "monthly build marker storage is not configured" };
  }
  const lastRunMonth = await readLastMonthlyRunMonth();
  if (lastRunMonth == null) {
    return { should: true, monthMarker, reason: "first run (no prior marker)" };
  }
  if (lastRunMonth < monthMarker) {
    return { should: true, monthMarker, reason: `prior run ${lastRunMonth} < current month ${monthMarker}` };
  }
  return { should: false, monthMarker, reason: `already ran this month (last ${lastRunMonth}, current ${monthMarker})` };
}

async function main() {
  run("npm run fetch-data");

  const now = new Date();
  const dayOfWeek = getNewYorkDayOfWeek(now);
  const currentNyDate = newYorkDateKey(now);
  console.log(`[build:vercel] NY day-of-week: ${dayOfWeek}`);
  console.log(`[build:vercel] NY date: ${currentNyDate}`);
  const forcePublicCsvCommit = process.env.COMMIT_DATA_FORCE === "1";
  const forceCalibrate = process.env.FORCE_MONTHLY_CALIBRATION === "1";
  const forceSnapshots = process.env.FORCE_SNAPSHOTS === "1";
  const forceSmaCalibration = process.env.FORCE_SMA_CALIBRATION === "1";

  const cronBuildMarker = await readCronTriggeredBuildMarker();
  const isDeployHookBuild = cronBuildMarker !== null;
  const weekly = await isFirstTradingDayOfWeek(currentNyDate);
  console.log(`[build:vercel] First trading day of week? ${weekly.should} (${weekly.reason})`);
  const runWeekly = weekly.should;
  const monthly = await isFirstMondayOfMonthPending(currentNyDate);
  console.log(`[build:vercel] First Monday of month? ${monthly.should} (${monthly.reason})`);
  const runMonthlyTasks = monthly.should;
  const isDeployHookWeeklyRun = isDeployHookBuild && runWeekly;
  const isDeployHookMonthlyRun = isDeployHookBuild && runMonthlyTasks;
  const ranMonthlySmaCalibration = forceSmaCalibration || isDeployHookMonthlyRun;
  const ranMonthlySnapshots = forceSnapshots || isDeployHookMonthlyRun;

  if (forceCalibrate || (isDeployHookBuild && runWeekly)) {
    console.log(
      `[build:vercel] Running ETF calibration (${forceCalibrate ? "forced" : "Deploy Hook on first trading day of week"})`
    );
    run("npm run calibrate");
  } else {
    console.log(
      `[build:vercel] Skipping ETF calibration (${isDeployHookBuild ? "not first trading day of week" : "not Deploy Hook build"})`
    );
  }

  if (ranMonthlySnapshots) {
    console.log(
      `[build:vercel] Generating snapshots (${forceSnapshots ? "forced" : "Deploy Hook on first Monday of month"})`
    );
    run("npm run snapshots:generate");
  } else {
    console.log(
      `[build:vercel] Skipping snapshot generation (${isDeployHookBuild ? "not first Monday of month" : "not Deploy Hook build"})`
    );
  }

  if (ranMonthlySmaCalibration) {
    console.log(
      `[build:vercel] Running SMA calibration (${forceSmaCalibration ? "forced" : "Deploy Hook on first Monday of month"})`
    );
    run("npm run calibrate-sma");
  } else {
    console.log(
      `[build:vercel] Skipping SMA calibration (${isDeployHookBuild ? "not first Monday of month" : "not Deploy Hook build"})`
    );
  }

  run("next build");

  await maybeNotifySmaAlerts(cronBuildMarker);

  if (runWeekly || forcePublicCsvCommit || ranMonthlySmaCalibration || ranMonthlySnapshots) {
    console.log(
      `[build:vercel] Committing generated artifacts (${forcePublicCsvCommit ? "forced" : ranMonthlySmaCalibration || ranMonthlySnapshots ? "monthly task ran" : "first trading day of week"})`
    );
    run("npm run commit-data");
  } else {
    console.log(`[build:vercel] Skipping generated artifact commit (not first trading day of week or first Monday of month)`);
  }

  // Update markers only after the build pipeline succeeded so a failed weekly/monthly
  // run is retried on the next build of the same week/month. Gated on isDeployHookBuild
  // (not just the calendar check) so a non-cron build landing on the trigger day can't
  // mark the period done without the periodic tasks actually having run.
  if (isDeployHookWeeklyRun) {
    await writeLastWeeklyRunTradingDate(weekly.weekMarkerDate);
    console.log(`[build:vercel] Recorded weekly run marker: ${weekly.weekMarkerDate}`);
  }
  if (isDeployHookMonthlyRun) {
    await writeLastMonthlyRunMonth(monthly.monthMarker);
    console.log(`[build:vercel] Recorded monthly run marker: ${monthly.monthMarker}`);
  }
}

main().catch((error) => {
  console.error("[build:vercel] Fatal error:", error);
  process.exitCode = 1;
});
