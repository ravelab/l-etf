/**
 * The three coverage answers, in a terminal, at the end of a ship.
 *
 * What each suite covers on its own and what they cover together is written by
 * coverage-combined.mjs as stages.json. It is otherwise only visible by opening the Actions log
 * and reading it — which is a poor way to hand a number to anybody, and a worse way to hand one
 * to an agent. This prints whatever stages.json it is pointed at, local or downloaded.
 *
 *   node scripts/print-coverage.mjs [path/to/stages.json]
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const file = process.argv[2] ?? path.join(root, 'coverage', 'combined', 'stages.json')

const line = (label, totals) =>
  `  ${label.padEnd(14)}· ${String(totals.statements.pct).padStart(6)}% statements` +
  ` · ${String(totals.branches.pct).padStart(6)}% branches` +
  ` · ${String(totals.functions.pct).padStart(6)}% functions` +
  ` · ${String(totals.lines.pct).padStart(6)}% lines`

if (!existsSync(file)) {
  const shown = path.relative(root, file)
  process.stderr.write(`  (no coverage summary at ${shown.startsWith('..') ? file : shown})\n`)
  process.exit(0)
}

const report = JSON.parse(await readFile(file, 'utf8'))
process.stdout.write('\ncoverage\n')
for (const stage of report.stages ?? []) process.stdout.write(`${line(stage.label ?? stage.name, stage)}\n`)
if (report.combined) process.stdout.write(`${line('combined', report.combined)}\n`)
