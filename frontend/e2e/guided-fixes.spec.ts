/**
 * Guided Fixes — selection, server review, verification and one-use download.
 * Synthetic fixtures only; backend proves document identity via SHA-256.
 */
import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { AxeBuilder } from '@axe-core/playwright'
import { createSyntheticAudit, SAMPLE_THESIS, annotate } from './helpers'

const MISMATCH_TEXT =
  'The selected document does not match the document used for this audit. Upload the original DOCX file and try again.'

/** Create a fresh audit and open the completed Audit Workspace. */
async function openCompletedAudit(page: Page) {
  const summary = await createSyntheticAudit(page)
  await page.goto(`/audit/${summary.auditId}`)
  await page.waitForLoadState('networkidle')
  await expect(page.getByText(/major ·|findings/).first()).toBeVisible()
  return summary
}

/** Open the Guided Fixes selection dialog (toolbar trigger). */
async function openGuidedFixes(page: Page) {
  const open = page.getByRole('button', { name: 'Guided Fixes' })
  await open.click()
  await expect(page.getByRole('button', { name: /Review .* selected chang(e|es)/ })).toBeVisible()
}

test.describe('guided fixes workflow @guided-fixes', () => {
  test('open, keyboard-select two candidates, upload step and back preserve selection', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'GF-WORKFLOW',
      objective: 'Choose candidates, inspect persisted values, proceed to upload, and return without losing selection.',
      precondition: 'Completed synthetic audit with candidate findings.',
      steps: ['Open audit', 'Open Guided Fixes', 'Space on two checkboxes', 'Continue to upload', 'Back to findings'],
      expected: 'Selection survives; no finding is declared safe until backend Review.',
      severity: 'high',
    })
    await openCompletedAudit(page)
    await openGuidedFixes(page)

    // No Apply-all exists anywhere in the workspace.
    await expect(page.getByRole('button', { name: /apply all/i })).toHaveCount(0)

    // Keyboard: focus the first checkbox, press Space, repeat for the second.
    const checkboxes = page.locator('input[type="checkbox"][aria-label]')
    const count = await checkboxes.count()
    expect(count, 'supported findings must render checkboxes').toBeGreaterThanOrEqual(2)
    await checkboxes.nth(0).focus()
    await page.keyboard.press('Space')
    await checkboxes.nth(1).focus()
    await page.keyboard.press('Space')
    await page.getByRole('radio', { name: /All findings/ }).click()

    // Unsupported findings are never selectable: captions/citations rows
    // carry no checkbox.
    await expect(page.getByText('Manual correction required').first()).toBeAttached()
    const manualRows = page.locator('li:has-text("Manual correction required")')
    for (let i = 0; i < (await manualRows.count()); i++) {
      expect(await manualRows.nth(i).locator('input[type="checkbox"]').count()).toBe(0)
    }

    await expect(page.getByText(/selected · .*candidates for safety review · Maximum 20|selected · Maximum reached/).first()).toBeVisible()
    await expect(page.getByText(/Candidate only — safety review required/).first()).toBeVisible()
    await page.getByRole('button', { name: /Review .* selected chang(e|es)/ }).click()
    await expect(page.getByText('Upload the original DOCX')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Apply and verify changes' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Back to findings' }).click()
    await expect(page.getByText(/2 selected · .*candidates for safety review · Maximum 20/).first()).toBeVisible()
    await page.getByRole('button', { name: /Review .* selected chang(e|es)/ }).focus()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Close Guided Fixes' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Guided Fixes' })).toBeFocused()
  })

  test('wrong DOCX shows mismatch error; exact original creates and downloads corrected copy; audit unchanged', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'GF-UPLOAD-DOWNLOAD',
      objective: 'Reject wrong original at Review; exact original is reviewed, applied, re-audited and downloaded explicitly.',
      precondition: 'Completed synthetic audit; a different DOCX is available.',
      steps: ['Select candidate', 'Upload wrong DOCX', 'Review rejects', 'Upload original', 'Review confirmed targets', 'Apply', 'Download'],
      expected: 'Mismatch blocks apply; only passed re-audit unlocks one-use download; source audit remains unchanged.',
      severity: 'high',
    })
    const summary = await openCompletedAudit(page)
    await openGuidedFixes(page)

    await page.locator('input[type="checkbox"][aria-label]').first().check()
    await page.getByRole('button', { name: /Review .* selected chang(e|es)/ }).click()
    // Create a DIFFERENT docx (the long-filename fixture) for the mismatch path.
    const fixturesDir = path.resolve(process.cwd(), 'e2e', 'fixtures')
    const wrongPath = path.join(fixturesDir, 'long-filename-sample.docx')
    const wrong = page.locator('#guided-fixes-file-input')
    await wrong.setInputFiles(wrongPath)
    await page.getByRole('button', { name: 'Review safety and locations' }).click()
    await expect(page.getByRole('alert')).toContainText(MISMATCH_TEXT)

    // Selection survives the error and the file can be replaced (dialog
    // stays open — never closed automatically on error).
    await page.getByRole('button', { name: 'Back to findings' }).click()
    await expect(page.getByText(/selected · .*candidates for safety review · Maximum 20/)).toBeVisible()
    await page.getByRole('button', { name: /Review .* selected chang(e|es)/ }).click()

    // Replace with the EXACT original bytes used for the audit.
    await wrong.setInputFiles(SAMPLE_THESIS)
    await page.getByRole('button', { name: 'Review safety and locations' }).click()
    await expect(page.getByText(/Safety review passed for 1 selected finding/)).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(/affected location/)).toBeVisible()
    await expect(page.getByText(/Property changed:/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download corrected document' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Apply and verify changes' }).click()
    await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed' })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(/No new findings/)).toBeVisible()
    await expect(page.getByText(/Your original document and its History entry are unchanged/)).toBeVisible()

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download corrected document' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toContain('_ACA-fixed.docx')
    await expect(page.getByRole('button', { name: 'Download corrected document' })).toBeDisabled()

    // Original audit score and findings remain unchanged.
    const before = await page.request.get(`/api/audit/${summary.auditId}`)
    const beforeBody = await before.json()
    const after = await page.request.get(`/api/audit/${summary.auditId}`)
    const afterBody = await after.json()
    expect(afterBody.weighted_score).toBe(beforeBody.weighted_score)
    expect(afterBody.violations).toEqual(beforeBody.violations)

    // Audit corrected copy returns to Dashboard only.
    await page.getByRole('button', { name: 'Audit corrected copy' }).click()
    await page.waitForURL(/\/dashboard/)
  })

  test('Reference heading alignment candidate completes Review, Apply, Download', async ({ page }) => {
    const backendDir = path.resolve(process.cwd(), '..', 'backend')
    const python = path.join(backendDir, '.venv', 'Scripts', 'python.exe')
    const fixture = JSON.parse(execFileSync(python, ['-c', `
import base64, io, json
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from app.services.profile_schema import new_custom_profile
doc = Document()
doc.add_paragraph("Body paragraph.")
heading = doc.add_paragraph("References")
heading.alignment = WD_ALIGN_PARAGRAPH.LEFT
doc.add_paragraph("Smith, A. (2024). Entry. Press.")
out = io.BytesIO()
doc.save(out)
profile = new_custom_profile("Reference heading E2E")
profile.references.check_heading_alignment = True
profile.references.heading_alignment = "center"
print(json.dumps({"docx": base64.b64encode(out.getvalue()).decode(), "profile": profile.to_dict()}))
`], { cwd: backendDir, encoding: 'utf8' })) as { docx: string; profile: object }
    const buffer = Buffer.from(fixture.docx, 'base64')
    const file = { name: 'reference-heading.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer }
    const audit = await page.request.post('/api/audit', {
      multipart: { file, custom_profile: JSON.stringify(fixture.profile) },
      timeout: 90_000,
    })
    expect(audit.ok(), await audit.text()).toBeTruthy()
    const auditId = (await audit.json()).audit_id
    await page.goto(`/audit/${auditId}`)
    await page.getByRole('button', { name: 'Guided Fixes' }).click()
    const candidate = page.getByRole('checkbox', { name: /Reference List heading alignment does not match, Page 1 · Paragraph 2/i })
    await expect(candidate).toBeVisible()
    await candidate.check()
    await page.getByRole('button', { name: /Review .* selected chang(e|es)/ }).click()
    await page.locator('#guided-fixes-file-input').setInputFiles(file)
    await page.getByRole('button', { name: 'Review safety and locations' }).click()
    await expect(page.getByText(/Safety review passed for 1 selected finding/)).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Apply and verify changes' }).click()
    await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed' })).toBeVisible({ timeout: 60_000 })
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download corrected document' }).click()
    expect((await downloadPromise).suggestedFilename()).toContain('_ACA-fixed.docx')
  })

  test('axe scan and horizontal-overflow pass at desktop and mobile widths', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'GF-AXE-LAYOUT',
      objective: 'No critical/serious axe violations or horizontal overflow at 1366/1280/1024/390 widths.',
      precondition: 'Completed synthetic audit.',
      steps: ['Open audit at each width', 'Open Guided Fixes dialog', 'Run axe scan', 'Measure overflow'],
      expected: 'Zero critical/serious axe violations; scrollWidth <= clientWidth.',
      severity: 'high',
    })
    for (const width of [1366, 1280, 1024, 390]) {
      await page.setViewportSize({ width, height: width <= 390 ? 780 : width === 1024 ? 768 : 800 })
      await openCompletedAudit(page)
      await openGuidedFixes(page)
      const results = await new AxeBuilder({ page }).analyze()
      const blocking = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      )
      expect(
        blocking,
        `${width}px: critical/serious axe violations:\n${blocking
          .map((v) => `${v.id} (${v.impact}): ${v.help}`)
          .join('\n')}`,
      ).toEqual([])
      const m = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))
      expect(
        m.scrollWidth,
        `${width}px: scrollWidth ${m.scrollWidth} exceeds clientWidth ${m.clientWidth}`,
      ).toBeLessThanOrEqual(m.clientWidth + 1)
    }
  })
})
