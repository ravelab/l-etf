import { config } from "dotenv";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

config({ path: ".env.local" });

function isTruthyEnv(value) {
  return value === "1" || value === "true" || value === "yes";
}

function runGit(args, inherit = false) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });

  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    throw new Error(stderr || stdout || `git ${args.join(" ")} failed`);
  }

  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function getGitHubRepoSlug(remoteUrl) {
  const match = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

function getGitHubRepoSlugFromEnv() {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }

  const owner = process.env.VERCEL_GIT_REPO_OWNER;
  const slug = process.env.VERCEL_GIT_REPO_SLUG;
  if (owner && slug) {
    return `${owner}/${slug}`;
  }

  return null;
}

function getGitHubRepoSlugOrNull() {
  try {
    const remoteUrl = runGit(["remote", "get-url", "origin"]);
    const repoSlug = getGitHubRepoSlug(remoteUrl);
    if (repoSlug) {
      return repoSlug;
    }
    console.log(`[commit-data] origin is not a GitHub repo (${remoteUrl})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("No such remote 'origin'")) {
      throw error;
    }
  }

  const envRepoSlug = getGitHubRepoSlugFromEnv();
  if (envRepoSlug) {
    return envRepoSlug;
  }

  return null;
}

function getGitHubToken() {
  return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.VERCEL_GIT_COMMIT_TOKEN ?? null;
}

async function getGitHubCommitAuthor(token) {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub user lookup failed (${response.status})`);
  }

  const user = await response.json();
  const login = user.login;
  const id = user.id;
  const name = user.name || login;

  if (!login || !id || !name) {
    throw new Error("GitHub user lookup returned incomplete identity data");
  }

  return {
    name,
    email: `${id}+${login}@users.noreply.github.com`,
  };
}

function getBranchName() {
  return process.env.VERCEL_GIT_COMMIT_REF || process.env.GITHUB_REF_NAME || "main";
}

async function main() {
  // Scheduling lives in scripts/build-vercel.ts (only invokes this on the
  // first trading day of the NY week or when COMMIT_DATA_FORCE is set).
  // Keep this script focused on "stage + push the changed artifacts".
  const dryRun = isTruthyEnv(process.env.COMMIT_DATA_DRY_RUN);

  const dataDir = join(process.cwd(), "data");
  const csvFiles = readdirSync(dataDir)
    .filter((file) => file.endsWith(".csv"))
    .map((file) => `data/${file}`);

  if (csvFiles.length === 0) {
    console.log("[commit-data] Skipping: no data files found");
    return;
  }

  const statusOutput = runGit(["status", "--porcelain", "--", "data", "src/lib/simulation/engine.ts", "src/lib/tool-snapshots"]);
  const changedGeneratedFiles = statusOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/).pop())
    .filter(Boolean)
    .filter(
      (file) =>
        file.endsWith(".csv") ||
        file === "src/lib/simulation/engine.ts" ||
        file.startsWith("src/lib/tool-snapshots/")
    );

  if (changedGeneratedFiles.length === 0) {
    console.log("[commit-data] Skipping: no generated artifact changes to commit");
    return;
  }

  const repoSlug = getGitHubRepoSlugOrNull();
  if (!repoSlug) {
    console.log("[commit-data] Skipping: no GitHub repo metadata available");
    return;
  }

  const branch = getBranchName();

  if (dryRun) {
    console.log(`[commit-data] Dry run: would stage ${changedGeneratedFiles.length} generated file(s)`);
    console.log(`[commit-data] Dry run: would commit chore(data): refresh generated artifacts`);
    console.log(`[commit-data] Dry run: would push HEAD:${branch}`);
    return;
  }

  const token = getGitHubToken();
  if (!token) {
    console.log(
      "[commit-data] Skipping: no GitHub token configured (set GITHUB_TOKEN, GH_TOKEN, or VERCEL_GIT_COMMIT_TOKEN)"
    );
    return;
  }

  const pushUrl = `https://x-access-token:${encodeURIComponent(token)}@github.com/${repoSlug}.git`;
  const author = await getGitHubCommitAuthor(token);

  console.log(`[commit-data] Staging ${changedGeneratedFiles.length} generated file(s)`);
  runGit(["add", "-A", "--", ...changedGeneratedFiles], true);

  const commitCheck = spawnSync("git", ["diff", "--cached", "--quiet", "--", ...changedGeneratedFiles], {
    cwd: process.cwd(),
  });
  if (commitCheck.status === 0) {
    console.log("[commit-data] Skipping: staged diff is empty");
    return;
  }
  if (commitCheck.status !== 1) {
    throw new Error("git diff --cached --quiet failed");
  }

  runGit(["config", "user.name", author.name], true);
  runGit(["config", "user.email", author.email], true);
  runGit(["commit", "-m", "chore(data): refresh generated artifacts"], true);
  console.log(`[commit-data] Pushing to ${branch}`);
  runGit(["push", pushUrl, `HEAD:${branch}`], true);
  console.log("[commit-data] Done");
}

main().catch((error) => {
  console.error("[commit-data] Fatal error:", error);
  process.exit(1);
});
