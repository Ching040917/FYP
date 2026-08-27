/**
 * Minimal custom Playwright reporter.
 *
 * Writes a compact, machine-readable record of ACTUAL executed results to
 * test-results/evidence/e2e-results.json:
 *   { stats, cases: [{ id, title, project, status, durationMs, error,
 *      objective, precondition, steps, expected, severity, notes, evidence }] }
 *
 * Case metadata comes from test annotations declared in the specs; evidence
 * filenames come from real PNG attachments captured during the run. The
 * Markdown summary is generated from this file by e2e/evidence-report.mjs —
 * nothing is fabricated after the fact.
 */
import fs from 'node:fs'
import path from 'node:path'

const OUT_DIR = path.join(process.cwd(), 'test-results', 'evidence')
const OUT_FILE = path.join(OUT_DIR, 'e2e-results.json')

class EvidenceReporter {
  constructor() {
    this.cases = []
    this.startedAt = new Date().toISOString()
  }

  onTestEnd(test, result) {
    const ann = Object.fromEntries(result.annotations.map((a) => [a.type, a.description]))
    const attachments = result.attachments
      .filter((a) => a.contentType === 'image/png' && a.path)
      .map((a) => path.basename(a.path))
    this.cases.push({
      id: ann['case-id'] ?? test.title,
      title: test.title,
      file: path.relative(process.cwd(), test.location.file),
      project: String(test.parent?.project()?.name ?? '').toLowerCase(),
      status: result.status === 'passed' ? 'PASS' : result.status === 'skipped' ? 'SKIP' : 'FAIL',
      durationMs: Math.round(result.duration ?? 0),
      error: result.error?.message ?? '',
      objective: ann.objective ?? '',
      precondition: ann.precondition ?? '',
      steps: ann.steps ?? '',
      expected: ann.expected ?? '',
      severity: ann.severity ?? '',
      notes: ann.notes ?? '',
      evidence: Array.from(new Set(attachments)),
    })
  }

  onEnd(result) {
    const pass = this.cases.filter((c) => c.status === 'PASS').length
    const fail = this.cases.filter((c) => c.status === 'FAIL').length
    const skip = this.cases.filter((c) => c.status === 'SKIP').length
    const doc = {
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      runStatus: result?.status ?? 'unknown',
      stats: { total: this.cases.length, pass, fail, skip },
      cases: this.cases,
    }
    try {
      console.log(`[evidence-reporter] cwd=${process.cwd()} cases=${this.cases.length}`)
      fs.mkdirSync(OUT_DIR, { recursive: true })
      fs.writeFileSync(OUT_FILE, JSON.stringify(doc, null, 2), 'utf8')
      console.log(`Evidence results written to ${path.relative(process.cwd(), OUT_FILE)} (pass=${pass} fail=${fail} skip=${skip})`)
    } catch (err) {
      console.error(`[evidence-reporter] FAILED to write ${OUT_FILE}: ${(err as Error).message}`)
    }
  }
}

export default EvidenceReporter
