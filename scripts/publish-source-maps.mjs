/**
 * A second copy of every browser source map, under a name the host will serve.
 *
 * Vercel refuses `*.map` by extension — a request for one comes back 403 whether or not the file
 * is there — so the post-deploy coverage run cannot read the maps the preview build just emitted,
 * and every chunk it measures stays attributed to a minified bundle instead of to `src/**`. That
 * is what left the e2e stage reporting 0% while the same suite scored ~38% locally, where
 * coverage-combined.mjs reads the maps off disk instead of over HTTP. The same bytes under
 * `.map.json` are served like any other file; `harvestPageJsCoverage` tries that name second.
 *
 * Preview only: production has no coverage run to serve, and the duplicates are dead weight in a
 * bundle people actually download.
 */
import { copyFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

async function copyMapsUnder(dir) {
  let copied = 0;
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name);
    if ((await stat(full)).isDirectory()) {
      copied += await copyMapsUnder(full);
      continue;
    }
    if (!name.endsWith(".map")) continue;
    await copyFile(full, `${full}.json`);
    copied += 1;
  }
  return copied;
}

async function main() {
  if (process.env.VERCEL_ENV !== "preview") {
    console.log(`- source maps not republished (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}, preview only)`);
    return;
  }
  const staticRoot = path.join(root, ".next", "static");
  if (!existsSync(staticRoot)) {
    console.log("- source maps not republished: no .next/static");
    return;
  }
  const copied = await copyMapsUnder(staticRoot);
  console.log(`- published ${copied} source maps as .map.json for the coverage run`);
}

await main();
