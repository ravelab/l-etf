const GENERATED_ARTIFACT_COMMIT_SUBJECT = "chore(data): refresh generated artifacts";

function main() {
  const commitMessage = process.env.VERCEL_GIT_COMMIT_MESSAGE ?? "";
  const subject = commitMessage.split(/\r?\n/, 1)[0].trim();

  if (subject === GENERATED_ARTIFACT_COMMIT_SUBJECT) {
    console.log(`[ignore-vercel-build] Ignoring generated artifact commit: ${subject}`);
    process.exit(0);
  }

  console.log(`[ignore-vercel-build] Allowing build for commit: ${subject || "(no message)"}`);
  process.exit(1);
}

main();
