/**
 * Shared E2E helpers.
 *
 * All evidence screenshots are written to the git-ignored e2e/screenshots/
 * directory with stable, descriptive English filenames.
 */
import { type Page, type TestInfo, expect, test } from '@playwright/test'
import path from 'node:path'
import { createAuditViaApi } from './api-upload'

export const SAMPLE_THESIS = path.join(process.cwd(), 'public', 'samples', 'sample-thesis.docx')

/** Upload + complete a synthetic audit straight through the backend API
 *  (defaults to the committed synthetic sample DOCX). */
export async function createSyntheticAudit(
  page: Page,
  docxPath: string = SAMPLE_THESIS,
  filename = 'sample-thesis.docx',
) {
  return createAuditViaApi(page, docxPath, filename)
}

export const SCREENSHOT_DIR = path.join(process.cwd(), 'e2e', 'screenshots')

/**
 * Assert that the document does not overflow horizontally: scroll width must
 * not exceed client width. On failure, lists the widest offenders so the
 * finding is objectively attributable.
 */
export async function expectNoHorizontalOverflow(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  const m = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    offenders: Array.from(document.querySelectorAll('body *'))
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && (r.right > document.documentElement.clientWidth + 1 || r.left < -1)
      })
      .slice(0, 6)
      .map((el) => {
        const r = el.getBoundingClientRect()
        const desc = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} ${String(el.className).split(' ').slice(0, 4).join(' ')}`.trim()
        return `${desc} (right=${Math.round(r.right)}, width=${Math.round(r.width)})`
      }),
  }))
  expect(
    m.scrollWidth,
    `document.scrollWidth (${m.scrollWidth}) exceeds clientWidth (${m.clientWidth}). Widest offenders:\n${m.offenders.join('\n')}`,
  ).toBeLessThanOrEqual(m.clientWidth + 1)
  return { scrollWidth: m.scrollWidth, clientWidth: m.clientWidth }
}

/** Capture an evidence screenshot into the ignored screenshots directory and
 *  attach it to the test result so the JSON report references the real file. */
export async function evidenceShot(page: Page, filename: string): Promise<string> {
  const filePath = path.join(SCREENSHOT_DIR, filename)
  await page.screenshot({ path: filePath, fullPage: true })
  await test.info().attach(filename, { path: filePath, contentType: 'image/png' })
  return filePath
}

/** Upload + complete a synthetic audit straight through the backend API
 *  (re-exported from api-upload.ts). */

/**
 * Record structured case metadata as Playwright annotations; consumed by
 * e2e/evidence-report.mjs to build the Chapter-5 evidence summary from real
 * executed results. No result data is ever fabricated here.
 */
export interface CaseMeta {
  id: string
  objective: string
  precondition: string
  steps: string[]
  expected: string
  severity: string
  notes?: string
}

export function annotate(testInfo: TestInfo, meta: CaseMeta): void {
  testInfo.annotations.push(
    { type: 'case-id', description: meta.id },
    { type: 'objective', description: meta.objective },
    { type: 'precondition', description: meta.precondition },
    { type: 'steps', description: meta.steps.join(' -> ') },
    { type: 'expected', description: meta.expected },
    { type: 'severity', description: meta.severity },
    ...(meta.notes ? [{ type: 'notes', description: meta.notes }] : []),
  )
}
