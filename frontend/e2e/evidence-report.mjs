/**
 * Evidence summary generator (development tooling only).
 *
 * Reads the ACTUAL custom-reporter results from
 * test-results/evidence/e2e-results.json and produces a Markdown summary
 * under the same ignored output tree. Every row is derived from a real,
 * executed Playwright case; case metadata comes from annotations declared in
 * the specs. No fabricated data — failed cases carry the actual error text.
 *
 * Usage: npm run test:e2e:evidence   (after npm run test:e2e)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, '..', 'test-results', 'evidence')
const jsonPath = path.join(outDir, 'e2e-results.json')

if (!existsSync(jsonPath)) {
  console.error(`No evidence results found at ${jsonPath}. Run "npm run test:e2e" first.`)
  process.exit(1)
}

const report = JSON.parse(readFileSync(jsonPath, 'utf8'))
const lines = []
lines.push('# Browser usability & accessibility validation — evidence summary')
lines.push('')
lines.push(`Run window: ${report.startedAt} -> ${report.finishedAt} · overall run status: ${report.runStatus}`)
lines.push('Source of truth: `test-results/evidence/e2e-results.json` (machine-written by the Playwright reporter; no manual edits).')
lines.push('')
lines.push(`Total cases: ${report.stats.total} · PASS: ${report.stats.pass} · FAIL: ${report.stats.fail} · SKIP: ${report.stats.skip}`)
lines.push('')
lines.push('| Test case ID | Objective | Precondition | Steps | Expected result | Actual result | Status | Viewport | Evidence filename | Severity | Notes |')
lines.push('|---|---|---|---|---|---|---|---|---|---|---|')

for (const c of report.cases) {
  const actual =
    c.status === 'PASS'
      ? `Behaviour matched expectations (${c.durationMs} ms).`
      : c.status === 'SKIP'
        ? 'Skipped (not applicable for this viewport).'
        : `Failed (${c.durationMs} ms): ${(c.error || '').replace(/\r?\n/g, ' ').slice(0, 400)}`
  const row = [
    c.id,
    c.objective || c.title,
    c.precondition,
    c.steps,
    c.expected,
    actual,
    c.status,
    c.project,
    c.evidence.length ? c.evidence.join(', ') : '(none)',
    c.severity,
    c.notes,
  ]
  lines.push(`| ${row.map((cell) => String(cell ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`)
}
lines.push('')
lines.push('## Failure grouping (actual errors)')
const failures = report.cases.filter((c) => c.status === 'FAIL')
if (failures.length === 0) {
  lines.push('_None._')
} else {
  const byError = new Map()
  for (const f of failures) {
    const key = (f.error || 'unknown').split('\n')[0].slice(0, 160)
    if (!byError.has(key)) byError.set(key, [])
    byError.get(key).push(`${f.id} [${f.project}]`)
  }
  for (const [err, ids] of byError) {
    lines.push(`- ${err}`)
    lines.push(`  - Cases: ${ids.join(', ')}`)
  }
}
lines.push('')

writeFileSync(path.join(outDir, 'evidence-summary.md'), lines.join('\n'), 'utf8')
console.log(`Evidence summary written to ${path.join(outDir, 'evidence-summary.md')}`)
