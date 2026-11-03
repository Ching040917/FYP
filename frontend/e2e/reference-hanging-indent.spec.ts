/**
 * Reference hanging indent + Finding location/filters/AI gate — browser case.
 *
 * Uses the committed synthetic fixture that produces the full mix under the
 * APA 7 Student Paper profile: MAJOR citation mismatch (eligible for Local AI),
 * MAJOR page margins, REVIEW ambiguous citation, MINOR line-spacing finding
 * and the MINOR Reference hanging indent finding (three entries, consolidated,
 * 0 in → 0.5 in).
 *
 * Validates the corrected behaviour on every supported desktop viewport:
 *   1. Minor filter shows the hanging-indent finding
 *   2. Manual-review filter hides Minor findings
 *   3. Empty filtered state states a truthful hidden count
 *   4. Filter controls stack instead of clipping at narrow panel widths
 *   5. Selected Line spacing finding shows a truthful location and no AI section
 *   6. Selected Reference hanging-indent finding shows the configured 0.5 in
 *   7. Selected eligible citation shows Local AI Citation Guidance
 *   8. Reset returns both filters to All
 *
 * All three surfaces must show ONE friendly location: the Findings card, the
 * selected-evidence chip and Finding Details. A bare "Paragraph N" never
 * appears.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { annotate, createSyntheticAudit, evidenceShot, expectNoHorizontalOverflow } from './helpers'

const FIXTURE = path.join(process.cwd(), 'e2e', 'fixtures', 'reference-hanging-indent-synthetic.docx')

/** The severity combobox is a Radix Select; option text is its accessible name. */
async function chooseSeverity(page: Page, option: string) {
  await page.getByRole('combobox', { name: 'Filter by severity' }).locator('visible=true').first().click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

/**
 * At 1024–1279 the Detail pane opens in a modal right drawer; its backdrop
 * covers the Findings list until it is dismissed. No-op on wider viewports,
 * where the pane is a sibling column.
 */
async function dismissTabletDrawer(page: Page) {
  const close = page.locator('[data-drawer-close]:visible').first()
  if (await close.count()) {
    await close.click()
  }
}

test.describe('reference hanging indent, location and filters @reference', () => {
  test('hanging indent, shared location, filters and the Local AI gate', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'REF-HANGING-INDENT-WORKSPACE',
      objective:
        'The Reference hanging indent finding is visible and truthful; every location surface shows one friendly label; the Local AI section appears only for an eligible CITATION_MISMATCH; filters and the empty state behave truthfully.',
      precondition: 'Isolated backend + committed synthetic fixture audited with the APA 7 Student Paper profile.',
      steps: [
        'Upload e2e/fixtures/reference-hanging-indent-synthetic.docx against the APA 7 profile',
        'Open /audit/:auditId',
        'Filter Minor → read the hanging-indent row and its Current/Required values',
        'Select it → read the Findings card, the selected-evidence chip and Finding Details location',
        'Filter Manual review → confirm Minor rows are hidden and the empty state is truthful',
        'Reset → confirm both filters return to All',
        'Select the Line spacing finding → confirm no AI section',
        'Select the eligible citation finding → confirm Local AI Citation Guidance',
      ],
      expected:
        'Hanging indent shows 0 in → 0.5 in and the configured action; all three surfaces show the same location; no AI section for ineligible findings; filters reset to All; no clipping or horizontal overflow.',
      severity: 'high',
    })

    const audit = await createSyntheticAudit(page, FIXTURE, 'reference-hanging-indent-synthetic.docx', 'apa7-student-paper')
    await page.goto(`/audit/${audit.auditId}`)
    await page.waitForLoadState('networkidle')

    // ---------------------------------------------------------------
    // 1. The hanging-indent finding is present (All severities)
    // ---------------------------------------------------------------
    // The findings list renders in more than one responsive container; always
    // target the visible instance.
    const hangingRow = page
      .locator('button:visible', { hasText: 'Reference entry hanging indent does not match' })
      .first()
    await expect(hangingRow).toBeVisible()
    await expect(hangingRow.getByText('Minor', { exact: true })).toBeVisible()

    // Its card carries the Current → Required comparison the rule emits.
    await expect(page.locator('span:visible', { hasText: '0 in → 0.5 in' }).first()).toBeVisible()

    // ---------------------------------------------------------------
    // 6. Selected hanging-indent Details (Current/Required + action)
    // ---------------------------------------------------------------
    await hangingRow.click()
    // The detail stack renders in responsive containers; assert on the
    // visible instance only.
    const detail = page.getByRole('region', { name: 'Finding detail', exact: true }).locator('visible=true').first()
    await expect(detail).toBeVisible()
    await expect(detail.getByText('0 in', { exact: true })).toBeVisible()
    await expect(detail.getByText('0.5 in', { exact: true })).toBeVisible()
    await expect(detail.getByText(/Apply a 0\.5 in hanging indent/)).toBeVisible()
    // The category badge is gone; the friendly title already names the rule.
    await expect(detail.getByText('Paragraph Typography')).toHaveCount(0)
    // Hanging indent is deterministic-only: no AI section.
    await expect(page.getByRole('heading', { name: 'Local AI Citation Guidance' })).toHaveCount(0)

    // ---------------------------------------------------------------
    // Shared location across all three surfaces
    // ---------------------------------------------------------------
    const cardLocation = (await hangingRow.locator('span.text-ink-muted').first().innerText()).trim()
    const detailLocation = (await detail.locator('dd').first().innerText()).trim()
    expect(cardLocation).toBe(detailLocation)
    // Never the ambiguous bare form, and never the raw internal index.
    expect(cardLocation).not.toMatch(/^Paragraph \d+$/)
    expect(cardLocation).toMatch(/^(Page \d+( · Paragraph \d+)?|Document paragraph \d+( · Page unavailable)?)$/)

    // The selected-evidence chip (document pane) carries the same location.
    const chip = page.getByText(/Selected evidence:/).locator('visible=true').first()
    if (await chip.count()) {
      const chipText = (await chip.innerText()).trim()
      expect(chipText).toContain(cardLocation)
    }

    await evidenceShot(page, `ref-hanging-indent-details-${testInfo.project.name}.png`)
    await dismissTabletDrawer(page)

    // ---------------------------------------------------------------
    // 1b. Minor filter keeps showing it; All restores everything
    // ---------------------------------------------------------------
    await chooseSeverity(page, 'Minor')
    await expect(hangingRow).toBeVisible()
    await evidenceShot(page, `ref-minor-filter-${testInfo.project.name}.png`)

    await chooseSeverity(page, 'All severities')
    await expect(hangingRow).toBeVisible()

    // ---------------------------------------------------------------
    // 2. Manual review filter hides every Minor finding
    // ---------------------------------------------------------------
    await chooseSeverity(page, 'Manual review')
    await expect(hangingRow).toHaveCount(0)
    await expect(page.locator('span:visible', { hasText: '0 in → 0.5 in' })).toHaveCount(0)
    // The one review finding is still listed.
    await expect(
      page.locator('button:visible', { hasText: 'Citation could match more than one entry' }).first(),
    ).toBeVisible()
    await evidenceShot(page, `ref-manual-review-filter-${testInfo.project.name}.png`)

    // ---------------------------------------------------------------
    // 3. Empty filtered state (combined filters) — truthful hidden count
    // ---------------------------------------------------------------
    await page.getByRole('combobox', { name: 'Filter by category' }).locator('visible=true').first().click()
    await page.getByRole('option', { name: 'Page Margins', exact: true }).click()
    await expect(page.locator('p:visible', { hasText: 'No findings match these filters' }).first()).toBeVisible()
    await expect(page.locator('p:visible', { hasText: /^\d+ findings are hidden\.$/ }).first()).toBeVisible()
    await expect(page.locator('p:visible', { hasText: /^Showing 0 of \d+ findings$/ }).first()).toBeVisible()
    await evidenceShot(page, `ref-filtered-empty-combined-${testInfo.project.name}.png`)

    // 8. Reset control restores BOTH filters and brings the finding back.
    const resetButton = page.getByRole('button', { name: 'Reset filters' })
    await expect(resetButton).toBeVisible()
    await resetButton.click()
    await expect(hangingRow).toBeVisible()
    await evidenceShot(page, `ref-reset-filters-${testInfo.project.name}.png`)

    // Single-filter empty state: Unclassified severity never exists in an
    // audit, so this hides everything with the "other findings" wording.
    await chooseSeverity(page, 'Unclassified')
    await expect(page.locator('p:visible', { hasText: 'No Unclassified findings' }).first()).toBeVisible()
    await expect(
      page.locator('p:visible', { hasText: /other findings are hidden by the current filters\./ }).first(),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Show all findings' })).toBeVisible()
    await page.getByRole('button', { name: 'Show all findings' }).click()
    await expect(hangingRow).toBeVisible()

    // ---------------------------------------------------------------
    // 4. Narrow filter layout: controls stack without clipping/overlap
    // ---------------------------------------------------------------
    const overflow = await expectNoHorizontalOverflow(page)
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)
    const severityBox = await page
      .getByRole('combobox', { name: 'Filter by severity' })
      .locator('visible=true')
      .first()
      .boundingBox()
    const categoryBox = await page
      .getByRole('combobox', { name: 'Filter by category' })
      .locator('visible=true')
      .first()
      .boundingBox()
    expect(severityBox).not.toBeNull()
    expect(categoryBox).not.toBeNull()
    if (severityBox && categoryBox) {
      // No overlap between the two controls at any supported width.
      const overlap = severityBox.x < categoryBox.x + categoryBox.width && categoryBox.x < severityBox.x + severityBox.width
      const stacked = categoryBox.y >= severityBox.y + severityBox.height - 1
      expect(overlap && !stacked).toBe(false)
    }
    await evidenceShot(page, `ref-filter-layout-${testInfo.project.name}.png`)

    // ---------------------------------------------------------------
    // 5. Selected Line spacing finding: same location, no AI section
    // ---------------------------------------------------------------
    const lineSpacingRow = page.getByRole('button', { name: /Line spacing does not match/ }).first()
    await lineSpacingRow.click()
    const lsDetail = page.getByRole('region', { name: 'Finding detail', exact: true }).locator('visible=true').first()
    await expect(lsDetail.getByText('Line spacing does not match')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Local AI Citation Guidance' })).toHaveCount(0)
    const lsCardLocation = (await lineSpacingRow.locator('span.text-ink-muted').first().innerText()).trim()
    const lsDetailLocation = (await lsDetail.locator('dd').first().innerText()).trim()
    expect(lsCardLocation).toBe(lsDetailLocation)
    await evidenceShot(page, `ref-line-spacing-details-${testInfo.project.name}.png`)
    await dismissTabletDrawer(page)

    // ---------------------------------------------------------------
    // 7. Eligible CITATION_MISMATCH shows Local AI Citation Guidance
    // ---------------------------------------------------------------
    const citationRow = page
      .getByRole('button', { name: /Citation has no matching Reference List entry/ })
      .first()
    await citationRow.click()
    await expect(
      page.getByRole('heading', { name: 'Local AI Citation Guidance' }).first(),
    ).toBeVisible()
    // The heading never renders for the ineligible findings checked above.
    await expect(page.getByRole('heading', { name: 'AI-assisted guidance' })).toHaveCount(0)
    await evidenceShot(page, `ref-eligible-citation-${testInfo.project.name}.png`)
  })

  test('finding detail identities remain unique across responsive copies and drawer lifecycle', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 })
    const audit = await createSyntheticAudit(page, FIXTURE, 'reference-hanging-indent-synthetic.docx', 'apa7-student-paper')
    await page.goto(`/audit/${audit.auditId}`)
    await page.waitForLoadState('networkidle')

    const compact = page.locator('#finding-detail-compact')
    const desktop = page.locator('#finding-detail-desktop')
    const drawer = page.locator('#finding-detail-drawer')
    const assertIdentities = async (drawerMounted: boolean) => {
      await expect(compact).toHaveCount(1)
      await expect(desktop).toHaveCount(1)
      await expect(drawer).toHaveCount(drawerMounted ? 1 : 0)
      const ids = await page.locator('section[aria-label="Finding detail"]').evaluateAll(
        sections => sections.map(section => section.id).sort(),
      )
      expect(ids).toEqual([
        'finding-detail-compact',
        'finding-detail-desktop',
        ...(drawerMounted ? ['finding-detail-drawer'] : []),
      ])
      for (const id of ids) {
        expect(await page.locator('[id]').evaluateAll(
          (elements, value) => elements.filter(element => element.id === value).length,
          id,
        )).toBe(1)
      }
      const duplicates = await page.locator('[id]').evaluateAll(elements => {
        const seen = new Set<string>()
        const repeated = new Set<string>()
        for (const element of elements) {
          if (!element.id) continue
          if (seen.has(element.id)) repeated.add(element.id)
          seen.add(element.id)
        }
        return [...repeated].sort()
      })
      expect(duplicates).toEqual([])
    }

    const hanging = page.getByRole('button', { name: /Reference entry hanging indent does not match/ }).first()
    const spacing = page.getByRole('button', { name: /Line spacing does not match/ }).first()
    await hanging.click()
    await expect(desktop).toContainText('Reference entry hanging indent does not match')
    await expect(compact).toContainText('Reference entry hanging indent does not match')
    await assertIdentities(false)
    await spacing.click()
    await expect(desktop).toContainText('Line spacing does not match')
    await expect(compact).toContainText('Line spacing does not match')
    await assertIdentities(false)

    await page.setViewportSize({ width: 1024, height: 768 })
    await assertIdentities(false)
    await page.locator('#ws-tablet-findings').getByRole('button', { name: /Reference entry hanging indent does not match/ }).click()
    await expect(drawer).toBeVisible()
    await expect(drawer).toContainText('Reference entry hanging indent does not match')
    await expect(compact).toContainText('Reference entry hanging indent does not match')
    await expect(desktop).toContainText('Reference entry hanging indent does not match')
    await assertIdentities(true)
    await page.getByRole('button', { name: 'Close finding details' }).click()
    await assertIdentities(false)
    await page.locator('#ws-tablet-findings').getByRole('button', { name: /Line spacing does not match/ }).click()
    await expect(drawer).toContainText('Line spacing does not match')
    await expect(compact).toContainText('Line spacing does not match')
    await expect(desktop).toContainText('Line spacing does not match')
    await assertIdentities(true)
    await page.getByRole('button', { name: 'Close finding details' }).click()
    await assertIdentities(false)

    await page.setViewportSize({ width: 768, height: 800 })
    await page.getByRole('tab', { name: 'Details', exact: true }).click()
    await expect(compact).toBeVisible()
    await expect(compact).toContainText('Line spacing does not match')
    await assertIdentities(false)
    await page.getByRole('tab', { name: 'Findings', exact: true }).click()
    await page.locator('#panel-findings').getByRole('button', { name: /Reference entry hanging indent does not match/ }).click()
    await page.getByRole('tab', { name: 'Details', exact: true }).click()
    await expect(compact).toContainText('Reference entry hanging indent does not match')
    await assertIdentities(false)
  })

  test('empty finding details retain unique layout identities', async ({ page }) => {
    const python = path.join(process.cwd(), '..', 'backend', '.venv', 'Scripts', 'python.exe')
    const document = execFileSync(python, ['-B', '-c', `
import io
import sys
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt

doc = Document()
section = doc.sections[0]
section.left_margin = Inches(1.5)
section.right_margin = section.top_margin = section.bottom_margin = Inches(1)
body = doc.add_paragraph("Body paragraph.")
body.paragraph_format.line_spacing = 1.5
body.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
for run in body.runs:
    run.font.name = "Times New Roman"
    run.font.size = Pt(12)
heading = doc.add_paragraph("References")
for run in heading.runs:
    run.font.name = "Times New Roman"
    run.font.size = Pt(16)
entry = doc.add_paragraph("Smith, J. (2020). Title. Press.")
for run in entry.runs:
    run.font.name = "Times New Roman"
    run.font.size = Pt(12)
buffer = io.BytesIO()
doc.save(buffer)
sys.stdout.buffer.write(buffer.getvalue())
`], { maxBuffer: 1024 * 1024 })
    const response = await page.request.post('/api/audit?profile_id=suc-academic-report', {
      multipart: {
        file: {
          name: 'clean.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          buffer: document,
        },
      },
    })
    expect(response.ok(), await response.text()).toBe(true)
    const { audit_id: auditId } = await response.json()
    const report = await page.request.get(`/api/audit/${auditId}`)
    expect(report.ok()).toBe(true)
    expect((await report.json()).violations).toEqual([])

    await page.setViewportSize({ width: 1366, height: 768 })
    await page.goto(`/audit/${auditId}`)
    const compact = page.locator('#finding-detail-compact')
    const desktop = page.locator('#finding-detail-desktop')
    await expect(compact).toHaveCount(1)
    await expect(desktop).toHaveCount(1)
    await expect(desktop).toContainText('Select a finding from the list to inspect its evidence.')
    await page.setViewportSize({ width: 768, height: 800 })
    await page.getByRole('tab', { name: 'Details', exact: true }).click()
    await expect(compact).toBeVisible()
    await expect(compact).toContainText('Select a finding from the list to inspect its evidence.')
    await expect(desktop).toHaveCount(1)
    const ids = await page.locator('section[aria-label="Finding detail"]').evaluateAll(
      sections => sections.map(section => section.id).sort(),
    )
    expect(ids).toEqual(['finding-detail-compact', 'finding-detail-desktop'])
  })
})
