/**
 * The coverage answers, in a terminal, at the end of every ship.
 *
 * What each suite covers on its own and what they cover together is written by
 * coverage-combined.mjs as stages.json. Left alone it is only visible by opening the Actions log
 * and reading it — a poor way to hand a number to anybody, and a worse way to hand one to an
 * agent. So a ship prints it whatever happens to that ship: the numbers are as worth seeing when
 * a deploy fails as when it lands, and more so.
 *
 *   node scripts/print-coverage.mjs                 # the last local combined run
 *   node scripts/print-coverage.mjs <stages.json>   # one particular file
 *   node scripts/print-coverage.mjs --sha <sha>     # whichever CI run for that commit has it,
 *                                                   # falling back to the local run
 */
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'

const run = promisify(execFile)
const root = process.cwd()
const LOCAL = path.join(root, 'coverage', 'combined', 'stages.json')

const line = (label, totals) =>
  `  ${label.padEnd(14)}· ${String(totals.statements.pct).padStart(6)}% statements` +
  ` · ${String(totals.branches.pct).padStart(6)}% branches` +
  ` · ${String(totals.functions.pct).padStart(6)}% functions` +
  ` · ${String(totals.lines.pct).padStart(6)}% lines`

/**
 * A commit gets more than one run — a Preview one that measures it and a Production one that
 * skips most of the suite — so every run for the commit is asked until one has the artifact.
 */
async function fromCi(shortOrFull) {
  // `gh run list --commit` matches the full hash only, and a caller with a short one in hand
  // otherwise gets a silent empty answer that reads exactly like "this commit has no coverage".
  let sha = shortOrFull
  try {
    const { stdout } = await run('git', ['rev-parse', shortOrFull])
    sha = stdout.trim()
  } catch {
    // Not a revision this checkout knows; try it as given.
  }
  let ids = []
  try {
    const { stdout } = await run('gh', ['run', 'list', '--commit', sha, '--limit', '10', '--json', 'databaseId', '--jq', '.[].databaseId'])
    ids = stdout.split('\n').map((id) => id.trim()).filter(Boolean)
  } catch {
    return null
  }
  for (const id of ids) {
    const dir = await mkdtemp(path.join(tmpdir(), 'coverage-'))
    try {
      await run('gh', ['run', 'download', id, '-n', 'coverage-combined', '-D', dir])
      const file = path.join(dir, 'stages.json')
      if (existsSync(file)) return { report: JSON.parse(await readFile(file, 'utf8')), where: `run ${id}` }
    } catch {
      // This run published nothing; the next one may have.
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  return null
}

async function main() {
  const args = process.argv.slice(2)
  const shaFlag = args.indexOf('--sha')
  const sha = shaFlag >= 0 ? args[shaFlag + 1] : null
  const explicit = args.find((arg) => !arg.startsWith('--') && arg !== sha)

  let found = null
  if (explicit && existsSync(explicit)) found = { report: JSON.parse(await readFile(explicit, 'utf8')), where: explicit }
  if (!found && sha) found = await fromCi(sha)
  if (!found && existsSync(LOCAL)) found = { report: JSON.parse(await readFile(LOCAL, 'utf8')), where: 'the last local run' }

  if (!found) {
    process.stdout.write('\ncoverage · nothing measured for this commit yet\n')
    return
  }
  process.stdout.write(`\ncoverage (${found.where})\n`)
  for (const stage of found.report.stages ?? []) process.stdout.write(`${line(stage.label ?? stage.name, stage)}\n`)
  if (found.report.combined) process.stdout.write(`${line('combined', found.report.combined)}\n`)
}

await main()
