# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- `npm install` is required before `npm run typecheck` / `npm run lint` / `npm test` — `node_modules` is not pre-provisioned in fresh worktrees.
- Rolling-window simulation buckets (`src/lib/simulation/parallel.ts`) drop windows independently per config when extraction returns null (e.g. a leveraged config wiped out, or a synthetic-tail resimulation that fails) — the same `windows` array can produce buckets of different lengths per config. Never zip two buckets by array index; join on `` `${startDate}|${endDate}` `` instead (see `joinByWindow` in `src/lib/simulation/win-rates.ts`, mirrored from the SGOV comparison in the same file).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
