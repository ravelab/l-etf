---
name: unused-code-cleanup
description: Use when the user wants a one-time or periodic cleanup of unused code in this repo, including dead files, unused components/functions/constants, dead exports, and stale package dependencies. Follow the repo's cleanup workflow with Knip, ESLint, and build verification, and keep the cleanup isolated in its own commit.
---

# Unused Code Cleanup

Use this skill for dead-code sweeps in this repo.

## Workflow

1. Check the worktree first.
   - Run `git status --short`.
   - If unrelated changes are present, make a baseline commit before the cleanup so the sweep stays isolated.

2. Run proof tools before deleting anything.
   - `npm run lint`
   - `npm run knip`
   - `npm run build`

3. Remove unused code in this order.
   - Delete truly unused files.
   - Remove unused locals/imports/constants/functions.
   - For unused exports, prefer making them private before deleting logic if the logic is still used internally.
   - Remove unused package dependencies and add missing explicit dependencies when the repo is relying on transitive ones.

4. Preserve real entrypoints.
   - Do not remove anything referenced by `package.json` scripts.
   - Do not remove framework entrypoints under `src/app`.
   - Be careful with dynamically referenced code; keep it unless it is clearly dead.

5. Reconcile package state.
   - If `package.json` changes, sync `package-lock.json` with `npm install`.

6. Re-run validation until clean.
   - `npm run lint`
   - `npm run knip`
   - `npm run build`

7. Commit cleanup separately.
   - Use a cleanup-only commit message such as `Remove unused code`.

## Repo Notes

- The repo uses `knip` as the dead-code analyzer.
- `tsx` and `postcss` should remain explicit dependencies because repo scripts/configs use them.
- A stale `.git/index.lock` can block commits here. If commit fails with that specific stale-lock error, remove it with `rm -f .git/index.lock` and retry.

## Success Criteria

- `npm run lint` passes
- `npm run knip` passes
- `npm run build` passes
- cleanup is isolated in its own commit
