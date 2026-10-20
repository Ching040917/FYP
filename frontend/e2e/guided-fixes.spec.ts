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
  await expect(page.locator('button[aria-pressed]:visible').first()).toBeVisible()
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
    await expect(page.getByText('ACA cannot safely correct this finding automatically. Follow its Required action in the audit report.').first()).toBeAttached()
    const manualRows = page.locator('li:has-text("ACA cannot safely correct this finding automatically")')
    for (let i = 0; i < (await manualRows.count()); i++) {
      expect(await manualRows.nth(i).locator('input[type="checkbox"]').count()).toBe(0)
    }

    await expect(page.getByText(/selected · .*candidates for safety review · Maximum 20|selected · Maximum reached/).first()).toBeVisible()
    await expect(page.getByText(/Candidate only — safety review required/).first()).toBeVisible()
    await page.getByRole('button', { name: /Review .* selected chang(e|es)/ }).click()
    await expect(page.getByText('Upload the original DOCX')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Apply and verify changes' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Back to findings' })).toHaveCount(2)
    await page.getByRole('button', { name: 'Back to findings' }).first().click()
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
    const beforeBody = await (await page.request.get(`/api/audit/${summary.auditId}`)).json()
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
    await page.getByRole('button', { name: 'Back to findings' }).last().click()
    await expect(page.getByText(/selected · .*candidates for safety review · Maximum 20/)).toBeVisible()
    await page.getByRole('button', { name: /Review .* selected chang(e|es)/ }).click()

    // Replace with the EXACT original bytes used for the audit.
    await wrong.setInputFiles(SAMPLE_THESIS)
    await page.getByRole('button', { name: 'Review safety and locations' }).click()
    await expect(page.getByText(/Safety review passed for 1 selected finding/)).toBeVisible({ timeout: 60_000 })
    const reviewDialog = page.getByRole('dialog', { name: 'Guided Fixes — review confirmed changes' })
    await expect(reviewDialog.getByText('Font family does not match')).toBeVisible()
    await expect(reviewDialog.getByText(/affected location/)).toBeVisible()
    await expect(reviewDialog.getByText('Property to change: font consistency')).toBeVisible()
    await expect(reviewDialog.getByText(/Current: Calibri/)).toBeVisible()
    await expect(reviewDialog.getByText(/Required and proposed: Times New Roman/)).toBeVisible()
    await expect(reviewDialog.getByText(/Nothing has been changed yet/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download corrected document' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Cancel review' }).click()
    await expect(page.getByRole('button', { name: 'Review safety and locations' })).toBeEnabled()
    await page.getByRole('button', { name: 'Review safety and locations' }).click()
    await expect(page.getByText(/Safety review passed for 1 selected finding/)).toBeVisible({ timeout: 60_000 })
    const applyRequests: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/audit\/[^/]+\/guided-fixes$/.test(request.url())) applyRequests.push(request.url())
    })
    const applyButton = page.getByRole('button', { name: 'Apply and verify changes' })
    await applyButton.dblclick()
    expect(applyRequests).toHaveLength(1)
    await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed' })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(/No new findings/)).toBeVisible()
    await expect(page.getByText(/Your original document and its History entry are unchanged/)).toBeVisible()

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download corrected document' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toContain('_ACA-fixed.docx')
    await expect(page.getByRole('button', { name: 'Download corrected document' })).toBeDisabled()

    // Original audit score and findings remain unchanged after verification and download.
    const originalBody = await (await page.request.get(`/api/audit/${summary.auditId}`)).json()
    expect(originalBody.weighted_compliance_score).toBe(beforeBody.weighted_compliance_score)
    expect(originalBody.violations).toEqual(beforeBody.violations)
    await page.goto('/history')
    await page.getByRole('link', { name: 'Open report' }).first().click()
    await expect(page).toHaveURL(new RegExp(`/audit/${summary.auditId}$`))
    await page.reload()
    await openGuidedFixes(page)
    await expect(page.getByRole('button', { name: 'Review 0 selected changes' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Download corrected document' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Close Guided Fixes' }).click()

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

  test('manual-only audit explains empty candidates without offering Apply', async ({ page }) => {
    const backendDir = path.resolve(process.cwd(), '..', 'backend')
    const python = path.join(backendDir, '.venv', 'Scripts', 'python.exe')
    const fixture = JSON.parse(execFileSync(python, ['-c', `
import base64, io, json
from docx import Document
from app.services.profile_schema import new_custom_profile
doc = Document()
doc.add_paragraph("A claim (Garcia, 2018) without a reference list.")
out = io.BytesIO()
doc.save(out)
print(json.dumps({"docx": base64.b64encode(out.getvalue()).decode(), "profile": new_custom_profile("Manual only E2E").to_dict()}))
`], { cwd: backendDir, encoding: 'utf8' })) as { docx: string; profile: object }
    const file = {
      name: 'manual-only.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from(fixture.docx, 'base64'),
    }
    const response = await page.request.post('/api/audit', {
      multipart: { file, custom_profile: JSON.stringify(fixture.profile) },
      timeout: 90_000,
    })
    expect(response.ok(), await response.text()).toBeTruthy()
    const audit = await response.json()
    const report = await (await page.request.get(`/api/audit/${audit.audit_id}`)).json()
    expect(report.violations.some((v: { rule_code: string }) => v.rule_code === 'CITATION_MISMATCH')).toBeTruthy()
    await page.goto(`/audit/${audit.audit_id}`)
    await openGuidedFixes(page)
    await expect(page.getByRole('radio', { name: /Candidates for safety review · 0/ })).toBeVisible()
    await expect(page.getByText('No findings are candidates for Guided Fixes. Choose Manual correction required to view the other findings.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Review 0 selected changes' })).toBeDisabled()
    await page.getByRole('radio', { name: /Manual correction required/ }).click()
    await expect(page.getByText('ACA cannot safely correct this finding automatically. Follow its Required action in the audit report.').first()).toBeVisible()
    await expect(page.locator('input[type="checkbox"]')).toHaveCount(0)
  })

  test('Apply verification failure offers re-review but no download', async ({ page }) => {
    await openCompletedAudit(page)
    await openGuidedFixes(page)
    await page.locator('input[type="checkbox"][aria-label]').first().check()
    await page.getByRole('button', { name: /Review .* selected chang(e|es)/ }).click()
    await page.locator('#guided-fixes-file-input').setInputFiles(SAMPLE_THESIS)
    await page.getByRole('button', { name: 'Review safety and locations' }).click()
    await expect(page.getByText(/Safety review passed for 1 selected finding/)).toBeVisible({ timeout: 60_000 })
    await page.route(/\/api\/audit\/[^/]+\/guided-fixes$/, async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ detail: 'Verification failed after re-audit' }) })
      } else {
        await route.continue()
      }
    })
    await page.getByRole('button', { name: 'Apply and verify changes' }).click()
    await expect(page.getByRole('alert')).toContainText('The output was discarded; no corrected document is available.')
    await expect(page.getByRole('button', { name: 'Download corrected document' })).toHaveCount(0)
    await page.unrouteAll()
    await page.getByRole('button', { name: 'Review safety and locations' }).click()
    await expect(page.getByText(/Safety review passed for 1 selected finding/)).toBeVisible({ timeout: 60_000 })
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
  test('narrow Review and completion retain scroll, focus and readable status', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 })
    await openCompletedAudit(page)
    await openGuidedFixes(page)
    await page.locator('input[type="checkbox"][aria-label]').first().check()
    await page.getByRole('button', { name: /Review .* selected chang(e|es)/ }).click()
    await page.locator('#guided-fixes-file-input').setInputFiles(SAMPLE_THESIS)
    await page.getByRole('button', { name: 'Review safety and locations' }).click()
    const review = page.getByRole('dialog', { name: 'Guided Fixes — review confirmed changes' })
    await expect(review.getByRole('status')).toContainText('Nothing has been changed yet', { timeout: 60_000 })
    await expect(review.getByText(/Scope: Only the confirmed formatting property/)).toBeVisible()
    await expect(review.getByText(/Layout risk: Font and paragraph formatting/)).toBeVisible()
    const blocking = (await new AxeBuilder({ page }).analyze()).violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    )
    expect(blocking).toEqual([])
    const width = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
    expect(width[0]).toBeLessThanOrEqual(width[1] + 1)
    await page.getByRole('button', { name: 'Apply and verify changes' }).focus()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Cancel safety review' })).toBeFocused()
    await page.getByRole('button', { name: 'Apply and verify changes' }).click()
    const completed = page.getByRole('dialog', { name: 'Fix applied; re-audit passed' })
    await expect(completed.getByRole('heading', { name: 'Fix applied; re-audit passed' })).toBeVisible({ timeout: 60_000 })
    await expect(completed.getByText(/Your original document and its History entry are unchanged/)).toBeVisible()
    const completedWidth = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
    expect(completedWidth[0]).toBeLessThanOrEqual(completedWidth[1] + 1)
    const completionBlocking = (await new AxeBuilder({ page }).analyze()).violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    )
    expect(completionBlocking).toEqual([])
    const resultsPane = completed.locator('[aria-label="Re-audit results"]')
    await resultsPane.focus()
    await expect(resultsPane).toBeFocused()
    const initialScroll = await resultsPane.evaluate((element) => element.scrollTop)
    await page.keyboard.press('End')
    await expect.poll(() => resultsPane.evaluate((element) => element.scrollTop)).toBeGreaterThan(initialScroll)
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Guided Fixes' })).toBeFocused()
  })

  test('effective 200% zoom keeps Review safety and completion reachable', async ({ page }) => {
    // A 390px physical window at 200% zoom exposes about 195 CSS pixels.
    await page.setViewportSize({ width: 195, height: 390 })
    await openCompletedAudit(page)
    await openGuidedFixes(page)
    const assertDialogBounds = async (primaryLabel: string) => {
      const bounds = await page.getByRole('dialog').evaluate((dialog, label) => {
        const frame = dialog.getBoundingClientRect()
        const primary = Array.from(dialog.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === label,
        )
        const button = primary?.getBoundingClientRect()
        const clipped = Array.from(dialog.querySelectorAll('*'))
          .filter((element) => {
            const rect = element.getBoundingClientRect()
            return rect.width > 1 && (
              rect.left < frame.left - 1 || rect.right > frame.right + 1 ||
              element.scrollWidth > element.clientWidth + 1
            )
          })
          .map((element) => `${element.tagName}: ${element.textContent?.trim().slice(0, 40)}`)
        return {
          clipped,
          primary: button && { left: button.left, right: button.right, textFits: primary!.scrollWidth <= primary!.clientWidth + 1 },
          frame: { left: frame.left, right: frame.right },
          pageWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth,
        }
      }, primaryLabel)
      expect(bounds.clipped).toEqual([])
      expect(bounds.pageWidth).toBeLessThanOrEqual(bounds.viewportWidth + 1)
      expect(bounds.primary).toBeTruthy()
      expect(bounds.primary!.left).toBeGreaterThanOrEqual(bounds.frame.left)
      expect(bounds.primary!.right).toBeLessThanOrEqual(bounds.frame.right)
      expect(bounds.primary!.textFits).toBeTruthy()
    }
    await assertDialogBounds('Review 0 selected changes')
    const candidateWidth = await page.locator('input[type="checkbox"][aria-label]').first()
      .locator('..').locator('.min-w-0').evaluate((element) => element.getBoundingClientRect().width)
    expect(candidateWidth).toBeGreaterThanOrEqual(120)
    await page.locator('input[type="checkbox"][aria-label]').first().check()
    await page.getByRole('button', { name: /Review .* selected chang(e|es)/ }).click()
    await assertDialogBounds('Review safety and locations')
    await page.locator('#guided-fixes-file-input').setInputFiles(SAMPLE_THESIS)
    await page.getByRole('button', { name: 'Review safety and locations' }).click()
    const review = page.getByRole('dialog', { name: 'Guided Fixes — review confirmed changes' })
    await expect(review.getByRole('status')).toContainText('Nothing has been changed yet', { timeout: 60_000 })
    await assertDialogBounds('Apply and verify changes')
    await expect(review.getByText(/Scope: Only the confirmed formatting property/)).toBeAttached()
    await expect(review.getByText(/Layout risk: Font and paragraph formatting/)).toBeAttached()
    await review.focus()
    await page.keyboard.press('End')
    await expect.poll(() => review.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    await page.getByRole('button', { name: 'Apply and verify changes' }).click()
    const completion = page.getByRole('dialog', { name: 'Fix applied; re-audit passed' })
    await expect(completion.getByText(/Your original document and its History entry are unchanged/)).toBeAttached({ timeout: 60_000 })
    await completion.focus()
    await page.keyboard.press('End')
    await expect.poll(() => completion.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    await expect(completion.getByRole('button', { name: 'Download corrected document' })).toBeVisible()
    await assertDialogBounds('Download corrected document')
  })

})
