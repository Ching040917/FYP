import { test, expect } from '@playwright/test'
import type { Page, Locator, TestInfo } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createSyntheticAudit } from './helpers'

const disclosureSelector = '[data-testid="preview-evidence-disclosure"]'
const sizes = [{ width: 1366, height: 768 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 768, height: 800 }, { width: 683, height: 768 }, { width: 195, height: 667 }]

// TASK-OWNED HISTORICAL FALLBACK CONTROL: this PDF and block describe the
// same paragraph on two rendered lines, so the product must use its existing
// paragraph fallback rather than the single-line run shortcut.
function fallbackPdf(): Buffer {
  const first = 'First half of the paragraph.'
  const second = 'Second half continues.'
  const content = `BT /F1 12 Tf 72 720 Td (${first}) Tj 0 -18 Td (${second}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

// TASK-OWNED HISTORICAL RENDERED-PREVIEW CONTROL. Synthetic API responses
// represent historical UI state, not a fresh upload or a real table finding.
async function openHistoricalPreview(page: Page, options: {
  auditId?: string
  fallback?: boolean
  selection?: 'font' | 'header'
} = {}) {
  const auditId = options.auditId ?? `historical-${randomUUID()}`
  const fixtureDir = path.join(process.cwd(), 'tests', 'fixtures')
  const rawBlocks: Array<{ index: number; text: string }> = options.fallback
    ? [{ index: 0, text: 'First half of the paragraph. Second half continues.' }]
    : JSON.parse(fs.readFileSync(path.join(fixtureDir, 'sec2next-blocks.json'), 'utf8'))
  const blocks = rawBlocks.map(({ index, text }) => ({
    order: index, index, type: 'paragraph', text, style_name: 'Normal', heading_level: null,
  }))
  const sections = options.fallback
    ? [{ section_index: 0, start_paragraph_index: 0, end_paragraph_index: null,
        break_type: 'nextPage', page_width: 8.5, page_height: 11,
        margin_left: 1, margin_right: 1, margin_top: 1, margin_bottom: 1 }]
    : JSON.parse(fs.readFileSync(path.join(fixtureDir, 'sec2next-meta.json'), 'utf8'))
  const pdf = options.fallback ? fallbackPdf() : fs.readFileSync(path.join(fixtureDir, 'sec2next.pdf'))
  const font = { id: 'font', rule_code: 'FONT_CONSISTENCY', severity: 'MINOR',
    location: { paragraph_index: 0, run_index: 0 }, message: 'Font family differs.',
    actual_value: options.fallback ? 'Helvetica' : 'Arial', expected_value: 'Times New Roman' }
  const table = { id: 'table', rule_code: 'TABLE_CAPTION_MISSING', severity: 'MINOR',
    location: { table_index: 0, previous_anchor_paragraph_index: 0, next_anchor_paragraph_index: 1 },
    message: 'Table caption is missing.', actual_value: null, expected_value: 'Caption' }
  const header = { id: 'header', rule_code: 'HEADER_CONTENT_REQUIRED', severity: 'REVIEW',
    location: { structural_story: true, section_index: 0, story_type: 'header', story_variant: 'default', evidence_state: 'missing' },
    message: 'Header needs review.', actual_value: null, expected_value: 'Header' }
  const footer = { ...header, id: 'footer', rule_code: 'FOOTER_CONTENT_REQUIRED',
    location: { ...header.location, story_type: 'footer' }, message: 'Footer needs review.', expected_value: 'Footer' }
  const report = {
    id: auditId, filename: 'sample-thesis.docx', file_size: 1024, weighted_score: 84,
    deploy_mode: 'LOCAL', status: 'completed', created_at: null, completed_at: null,
    citation_issues: [], paragraph_page_mapping: null, sections,
    profile_snapshot: { profile_id: 'historical-control', profile_name: 'Historical control',
      profile_version: 2, profile_source: 'custom', citation_style: 'APA 7',
      margins: { left_in: 1, right_in: 1, top_in: 1, bottom_in: 1 } },
    violations: options.fallback ? [font, header] : [font, table, header, footer],
    score_breakdown: [],
  }
  await page.route(`**/api/audit/${auditId}`, route => route.fulfill({ json: report }))
  await page.route(`**/api/audit/${auditId}/document-blocks`, route => route.fulfill({ json: { audit_id: auditId, blocks } }))
  await page.route(`**/api/audit/${auditId}/rendered-preview`, route => route.fulfill({ contentType: 'application/pdf', body: pdf }))
  await page.setViewportSize(sizes[0])
  await page.goto(`/audit/${auditId}`)
  await page.waitForLoadState('networkidle')
  const finding = options.selection === 'header' ? 'Header needs review' : 'Font family does not match'
  await page.locator('#ws-panel-findings li button').filter({ hasText: finding }).click()
  const preview = page.locator('#ws-panel-preview')
  const details = preview.locator(disclosureSelector)
  await expect(details).toBeVisible()
  return { auditId, preview, details, summary: details.locator('summary') }
}

async function openAudit(page: Page) {
  return openHistoricalPreview(page)
}

async function openFreshAudit(page: Page) {
  await page.setViewportSize(sizes[0])
  const presetResponse = await page.request.get('/api/formatting-profiles/suc-academic-report/payload')
  expect(presetResponse.ok()).toBe(true)
  const { profile } = await presetResponse.json()
  profile.profile_id = 'evidence-privacy-reference'
  profile.profile_name = 'Evidence privacy reference'
  profile.profile_source = 'custom'
  profile.references.check_start_on_new_page = true
  profile.references.check_hanging_indent = true
  profile.references.hanging_indent_in = 0.5
  profile.headers.check_header_requirements = true
  profile.footers.check_footer_requirements = true
  profile.page_numbers.check_page_number_requirements = true

  const bytes = fs.readFileSync(path.join(process.cwd(), 'public', 'samples', 'sample-thesis.docx'))
  const response = await page.request.post('/api/audit', { multipart: {
    file: { name: 'sample-thesis.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: bytes },
    custom_profile: JSON.stringify(profile),
  } })
  expect(response.ok(), await response.text()).toBe(true)
  const submitted = await response.json()
  const auditResponse = await page.request.get(`/api/audit/${submitted.audit_id}`)
  expect(auditResponse.ok()).toBe(true)
  const audit = await auditResponse.json()
  expect(audit.profile_snapshot.references.check_start_on_new_page).toBe(true)
  expect(audit.paragraph_page_mapping).toBeNull()
  expect(submitted.paragraph_page_mapping).toBeNull()
  expect(audit.weighted_score).toBe(submitted.weighted_compliance_score)
  expect(audit.major_count).toBe(submitted.major_count)
  expect(audit.minor_count).toBe(submitted.minor_count)
  expect(audit.violations.map((v: { id: string }) => v.id).sort())
    .toEqual(submitted.physical_layout_errors.map((v: { id: string }) => v.id).sort())
  const codes = audit.violations.map((v: { rule_code: string }) => v.rule_code)
  expect(codes).not.toContain('REFERENCE_SECTION_NEW_PAGE')
  expect(codes).toContain('REFERENCE_HANGING_INDENT')
  expect(codes).toContain('FONT_CONSISTENCY')
  const blocksResponse = await page.request.get(`/api/audit/${submitted.audit_id}/document-blocks`)
  expect(blocksResponse.ok()).toBe(true)
  const { blocks } = await blocksResponse.json()
  expect(blocks.find((block: { index: number }) => block.index === 3)?.text).toContain('Calibri')
  const previewResponse = await page.request.get(`/api/audit/${submitted.audit_id}/rendered-preview`)
  expect(previewResponse.status()).toBe(409)
  expect(previewResponse.headers()['x-preview-error-category']).toBe('preview_disabled')

  await page.goto(`/audit/${submitted.audit_id}`)
  const preview = page.locator('#ws-panel-preview')
  const region = preview.getByRole('region', { name: 'Document preview', exact: true })
  await expect(preview.getByText('Page-rendered preview is unavailable. The extracted-text preview remains available.', { exact: true })).toBeVisible()
  await expect(region).toBeVisible()
  await expect(preview.getByRole('button', { name: 'Rendered pages', exact: true })).toHaveCount(0)
  await expect(preview).not.toContainText('The rendered preview could not be loaded')
  await expect(preview).not.toContainText('conversion failed', { ignoreCase: true })
  const findings = page.locator('#ws-panel-findings li button')
  const fontFinding = findings.filter({ hasText: 'Font family does not match' })
  await fontFinding.click()
  const fontBlock = region.locator('[data-block-index="3"]')
  await expect(fontBlock).toContainText('Calibri')
  await expect(fontBlock).toHaveAttribute('aria-pressed', 'true')
  await expect(fontFinding).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#ws-panel-findings')).not.toContainText(/Page\s+\d+/)
  return { submitted, audit, preview, region, findings, fontFinding, fontBlock }
}

async function rows(details: Locator) {
  return details.locator('dt').evaluateAll(elements => Object.fromEntries(elements.map(el => [el.textContent, el.nextElementSibling!.textContent])))
}

async function recordAxe(page: Page, testInfo: TestInfo, name: string) {
  const result = await new AxeBuilder({ page }).analyze()
  await testInfo.attach(name, {
    body: JSON.stringify({ violations: result.violations, incomplete: result.incomplete }, null, 2),
    contentType: 'application/json',
  })
  expect(result.violations.filter(v => v.id === 'heading-order' || v.impact === 'serious' || v.impact === 'critical')).toEqual([])
}

// TASK-OWNED SYNTHETIC HEADING CONTROL: not a real upload or Backend result.
// The response is deliberately out of order and paragraph identities do not
// match positions. Roles and source levels are retained as supplied by the API.
const headingBlocks = [
  { index: 40, text: 'Deep start', heading_level: 6, level: 3 },
  { index: 41, text: 'Deep repeat', heading_level: 6, level: 3 },
  { index: 42, text: 'First section', heading_level: 1, level: 3 },
  { index: 37, text: 'First subsection', heading_level: 3, level: 4 },
  { index: 44, text: 'Repeated subsection', heading_level: 3, level: 4 },
  { index: 45, text: 'Body between headings', heading_level: null, level: null },
  { index: 46, text: 'Larger leap', heading_level: 6, level: 5 },
  { index: 47, text: 'Back to section', heading_level: 1, level: 3 },
  { index: 48, text: 'Second level', heading_level: 2, level: 4 },
  { index: 49, text: 'Second level leap', heading_level: 4, level: 5 },
  { index: 50, text: 'Missing level', level: null },
  { index: 51, text: 'Zero level', heading_level: 0, level: null },
  { index: 52, text: 'Fractional level', heading_level: 2.5, level: null },
  { index: 53, text: 'Too high level', heading_level: 7, level: null },
  { index: 54, text: 'Negative level', heading_level: -1, level: null },
  { index: 55, text: 'String level', heading_level: '3', level: null },
  { index: 56, text: 'After invalid levels', heading_level: 5, level: 6 },
  { index: 57, text: 'Repeated section', heading_level: 1, level: 3 },
  { index: 58, text: 'Depth two', heading_level: 2, level: 4 },
  { index: 59, text: 'Depth three', heading_level: 3, level: 5 },
  { index: 60, text: 'Depth four', heading_level: 4, level: 6 },
  { index: 61, text: 'Depth five', heading_level: 5, level: 6 },
  { index: 62, text: 'Depth six', heading_level: 6, level: 6 },
  { index: 11, text: 'Return shallower', heading_level: 2, level: 4 },
]

async function openHeadingFixture(page: Page) {
  const blocks = headingBlocks.map(({ level: _level, ...block }, order) => ({
    ...block, order, type: 'paragraph', style_name: `Source style ${order}`,
    role: order === 5 ? 'HEADING' : 'BODY',
  })).reverse()
  const report = {
    id: 'heading-normalization', filename: 'Heading fixture.docx', file_size: 1024,
    weighted_score: 84, deploy_mode: 'LOCAL', status: 'completed',
    created_at: null, completed_at: null, citation_issues: [],
    violations: [
      { id: 'first', rule_code: 'FONT_SIZE', severity: 'MINOR', location: { paragraph_index: 37, run_index: 0 }, message: 'Font size differs.', actual_value: '10 pt', expected_value: '12 pt' },
      { id: 'second', rule_code: 'FONT_CONSISTENCY', severity: 'MAJOR', location: { paragraph_index: 11, run_index: 0 }, message: 'Font family differs.', actual_value: 'Arial', expected_value: 'Times New Roman' },
    ],
    score_breakdown: [
      { category: 'font_size', label: 'Font Size', major: 0, minor: 1, deduction: 6, remaining: 94 },
      { category: 'font_family', label: 'Font Family', major: 1, minor: 0, deduction: 10, remaining: 90 },
    ],
  }
  await page.route(/\/api\/audit\/heading-normalization(?:\/(?:document-blocks|rendered-preview))?$/, route => {
    if (route.request().method() !== 'GET') return route.continue()
    const pathname = new URL(route.request().url()).pathname
    if (pathname.endsWith('/document-blocks')) return route.fulfill({ json: { audit_id: report.id, blocks } })
    if (pathname.includes('/rendered')) return route.fulfill({ status: 404 })
    return route.fulfill({ json: report })
  })
  await page.setViewportSize(sizes[0])
  await page.goto('/audit/heading-normalization')
  const preview = page.locator('#ws-panel-preview')
  const region = preview.getByRole('region', { name: 'Document preview', exact: true })
  await expect(region).toBeVisible()
  return { preview, region }
}

test('extracted preview normalizes heading outline in document order without changing source styles', async ({ page }, testInfo) => {
  const { preview, region } = await openHeadingFixture(page)
  await expect(preview.getByRole('heading', { name: 'Document preview', exact: true, level: 2 })).toBeVisible()
  await expect(region.locator('[data-block-index]')).toHaveCount(headingBlocks.length)
  expect(await region.locator('[data-block-index]').evaluateAll(els => els.map(el => Number(el.getAttribute('data-block-index')))))
    .toEqual(headingBlocks.map(block => block.index))

  for (const block of headingBlocks) {
    const container = region.locator(`[data-block-index="${block.index}"]`)
    await expect(container).toContainText(`Paragraph ${block.index + 1}`)
    if (block.level === null) {
      await expect(container.getByText(block.text, { exact: true })).toBeVisible()
      await expect(container.getByRole('heading')).toHaveCount(0)
    } else {
      const heading = container.getByRole('heading', { name: block.text, exact: true, level: block.level })
      await expect(heading).toBeVisible()
      const size = block.heading_level === 1 ? 'text-lg' : block.heading_level === 2 ? 'text-base' : 'text-sm'
      await expect(heading).toHaveClass(new RegExp(`\\b${size}\\b`))
    }
  }
  await testInfo.attach('corrected-heading-outline.png', { body: await page.screenshot(), contentType: 'image/png' })
  await recordAxe(page, testInfo, 'heading-fixture-axe.json')
})

test('fallback heading selection preserves paragraph linkage, report totals and Guided Fixes', async ({ page }, testInfo) => {
  const { region } = await openHeadingFixture(page)
  const header = page.locator('#audit-report > div.border-b')
  await expect(header).toContainText('84')
  await expect(header).toContainText('1 Major · 1 Minor · 0 Manual review (unscored)')
  const findings = page.locator('#ws-panel-findings li button')
  await expect(findings).toHaveCount(2)
  const first = region.locator('[data-block-index="37"]')
  const second = region.locator('[data-block-index="11"]')
  await expect(first.getByRole('heading', { name: 'First subsection', level: 4 })).toBeVisible()
  await expect(second.getByRole('heading', { name: 'Return shallower', level: 4 })).toBeVisible()
  await first.click()
  await expect(first).toHaveAttribute('aria-pressed', 'true')
  await expect(first).toContainText('Selected')
  await expect(second).toHaveAttribute('aria-pressed', 'false')
  await expect(findings.filter({ hasText: 'Font size does not match' })).toHaveAttribute('aria-pressed', 'true')
  await second.click()
  await expect(second).toHaveAttribute('aria-pressed', 'true')
  await expect(second).toContainText('Selected')
  await expect(first).toHaveAttribute('aria-pressed', 'false')
  await expect(findings.filter({ hasText: 'Font family does not match' })).toHaveAttribute('aria-pressed', 'true')
  await findings.filter({ hasText: 'Font size does not match' }).click()
  await expect(first).toHaveAttribute('aria-pressed', 'true')
  await expect(second).toHaveAttribute('aria-pressed', 'false')
  await expect(header).toContainText('84')
  await expect(header).toContainText('1 Major · 1 Minor · 0 Manual review (unscored)')
  await testInfo.attach('heading-selected-finding.png', { body: await page.screenshot(), contentType: 'image/png' })
  await page.getByRole('button', { name: 'Guided Fixes' }).click()
  const dialog = page.getByRole('dialog', { name: 'Guided Fixes Beta — select candidate findings' })
  await expect(dialog.getByRole('radio', { name: /All findings · 2/ })).toBeVisible()
  await expect(dialog.getByRole('radio', { name: /Candidates for safety review · 2/ })).toBeVisible()
  await expect(dialog.getByRole('checkbox')).toHaveCount(2)
  await expect(dialog.getByRole('button', { name: 'Review 0 selected findings' })).toBeDisabled()
})

test('native Evidence toggle is nonmodal and Preview controls remain interactive', async ({ page }, testInfo) => {
  const { preview, details, summary } = await openAudit(page)
  const overflow = await page.evaluate(() => document.body.style.overflow)
  await expect(summary).toHaveAccessibleName('Evidence details')
  await expect(details).toHaveJSProperty('open', false)
  await summary.focus()
  await page.keyboard.press('Enter')
  await expect(details).toHaveJSProperty('open', true)
  await page.keyboard.press('Space')
  await expect(details).toHaveJSProperty('open', false)
  await page.keyboard.press('Space')
  await expect(details).toHaveJSProperty('open', true)
  await expect(page.getByRole('dialog', { name: 'Evidence details', exact: true })).toHaveCount(0)
  expect(await details.evaluate(el => !!el.closest('#ws-panel-preview'))).toBe(true)
  expect(await page.evaluate(() => document.body.style.overflow)).toBe(overflow)
  expect(await page.evaluate(() => document.querySelector(':modal, [inert]') === null)).toBe(true)
  // Escape is deliberately not custom disclosure behavior.
  await page.keyboard.press('Escape')
  await expect(details).toHaveJSProperty('open', true)
  await preview.getByRole('button', { name: 'Next page', exact: true }).click()
  await expect(preview.getByRole('group', { name: 'Page navigation' })).toContainText('Page 2 of 2')
  await testInfo.attach('historical-sec2next-page2.png', { body: await page.screenshot(), contentType: 'image/png' })
  await preview.getByRole('button', { name: 'Previous page', exact: true }).click()
  await preview.getByRole('button', { name: 'Fit width', exact: true }).click()
  await expect(preview.getByRole('button', { name: 'Fit width', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await preview.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect(preview.getByRole('group', { name: 'Zoom and fit controls' })).toContainText('%')
  await preview.getByRole('button', { name: 'Fit page', exact: true }).click()
  await expect(details).toHaveJSProperty('open', true)
  await page.getByRole('button', { name: 'Profile details', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Profile details', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(details).toHaveJSProperty('open', true)
})

test('selection replaces every row and view-mode clearing removes stale evidence', async ({ page }) => {
  const { preview, details, summary } = await openAudit(page)
  await summary.click()
  const paragraph = await rows(details)
  expect(paragraph.Finding).toBe('Font family does not match')
  expect(paragraph.Location).toBe('Page 1 · Paragraph 1')
  expect(paragraph['Evidence target']).toBe('Paragraph 1')
  expect(paragraph['Evidence precision']).toBe('Paragraph evidence')
  await page.locator('#ws-panel-findings li button').filter({ hasText: 'Table caption is missing' }).click()
  await expect(details).toHaveJSProperty('open', true)
  expect(await rows(details)).toEqual({ Finding: 'Table caption is missing', Location: 'Table 1 · Page 1', 'Evidence target': 'Table 1 · Page 1', 'Evidence precision': 'Page-only evidence' })
  await expect(details).not.toContainText(paragraph.Finding)
  await preview.getByRole('button', { name: 'Extracted text', exact: true }).click()
  await expect(preview.getByRole('region', { name: 'Document preview', exact: true })).toBeVisible()
  await expect(details).toHaveCount(0)
  await preview.getByRole('button', { name: 'Rendered pages', exact: true }).click()
  await expect(preview.getByRole('region', { name: 'Rendered document preview', exact: true })).toBeVisible()
  await page.locator('#ws-panel-findings li button').filter({ hasText: 'Font family does not match' }).click()
  await expect(details).toBeVisible()
  await expect(details).toHaveJSProperty('open', false)
  await details.locator('summary').click()
  expect(await rows(details)).toEqual(paragraph)
})

test('TASK-OWNED HISTORICAL FALLBACK CONTROL preserves the original fallback availability assertion', async ({ page }, testInfo) => {
  const { preview, details, summary } = await openHistoricalPreview(page, { fallback: true })
  await summary.click()
  const message = 'The exact text range could not be highlighted. The affected paragraph is marked instead.'
  const activePreviews = []
  for (const layout of await page.locator('#panel-document, #ws-tablet-document, #ws-panel-preview').all()) {
    if (await layout.isVisible() && await layout.evaluate(el => !el.closest('[hidden],[inert],[aria-hidden="true"]'))) {
      activePreviews.push(await layout.getAttribute('id'))
    }
  }
  expect(activePreviews).toEqual(['ws-panel-preview'])
  await expect(preview).toHaveCount(1)
  await expect(preview).toBeVisible()
  expect(await preview.evaluate(el => el.isConnected && !el.closest('[hidden],[inert],[aria-hidden="true"]'))).toBe(true)
  const scopedMessage = preview.getByText(message, { exact: true })
  await expect(scopedMessage).toHaveCount(1)
  await expect(scopedMessage).toBeVisible()
  const responsiveCopies = []
  for (const copy of await page.getByText(message, { exact: true }).all()) {
    responsiveCopies.push({
      ...await copy.evaluate(el => {
        const rect = el.getBoundingClientRect()
        return { container: el.closest('#panel-document, #ws-tablet-document, #ws-panel-preview')?.id,
          text: el.textContent, role: el.getAttribute('role') ?? (el.tagName === 'DD' ? 'definition' : null),
          hidden: el.hasAttribute('hidden'), inert: el.hasAttribute('inert'), ariaHidden: el.getAttribute('aria-hidden'),
          blockedByAncestor: !!el.closest('[hidden],[inert],[aria-hidden="true"]'),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
      }),
      visible: await copy.isVisible(),
    })
  }
  await testInfo.attach('historical-fallback-responsive-copies.json', {
    body: JSON.stringify({ activePreviews, responsiveCopies, fixture: 'TASK-OWNED HISTORICAL FALLBACK CONTROL' }, null, 2),
    contentType: 'application/json',
  })
  const paragraph = await rows(details)
  expect(paragraph.Finding).toBe('Font family does not match')
  expect(paragraph.Location).toBe('Page 1 · Paragraph 1')
  expect(paragraph['Evidence target']).toBe('Paragraph 1')
  expect(paragraph['Evidence precision']).toBe('Paragraph evidence')
  expect(paragraph.Availability).toBe(message)
  await testInfo.attach('historical-fallback-message.png', { body: await page.screenshot(), contentType: 'image/png' })
  await recordAxe(page, testInfo, 'historical-fallback-axe.json')
  await page.locator('#ws-panel-findings li button').filter({ hasText: 'Header needs review' }).click()
  await expect(details).toHaveJSProperty('open', true)
  await expect(details).not.toContainText(paragraph.Availability)
})

test('existing structural fixture retains stored provenance with and without a rendered page', async ({ page }) => {
  const { auditId } = await openHistoricalPreview(page, { selection: 'header' })
  let details = page.locator(`#ws-panel-preview ${disclosureSelector}`)
  await details.locator('summary').click()
  const available = await rows(details)
  expect(available).toEqual({ Finding: 'Header needs review', Location: 'Page 1 · Section 1 · Header · Normal pages', 'Evidence target': 'Section 1 · Header · Normal pages', 'Evidence precision': 'Page-level structural evidence', Availability: 'No exact Header/Footer highlight is available.' })
  await page.locator('#ws-panel-findings li button').filter({ hasText: 'Footer needs review' }).click()
  await expect(details).toHaveJSProperty('open', true)
  await expect(details).toContainText('Footer needs review')
  await expect(details).not.toContainText('Header needs review')
  const requestFailed = page.waitForEvent('requestfailed', request => request.url().endsWith(`/api/audit/${auditId}/rendered-preview`))
  await page.route(`**/api/audit/${auditId}/rendered-preview`, route => route.abort())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await requestFailed
  await expect(page.locator('#ws-panel-preview').getByText('Loading rendered preview…')).toHaveCount(0)
  await expect(page.locator('#ws-panel-preview').getByRole('button', { name: 'Next page', exact: true })).toHaveCount(0)
  await expect(page.locator('#ws-panel-preview').getByRole('region', { name: 'Document preview', exact: true })).toBeVisible()
  await page.locator('#ws-panel-findings li button').filter({ hasText: 'Header needs review' }).click()
  details = page.locator(`#ws-panel-preview ${disclosureSelector}`)
  await details.locator('summary').click()
  expect(await rows(details)).toEqual({ Finding: 'Header needs review', Location: 'Section 1 · Header · Normal pages', 'Evidence target': 'Section 1 · Header · Normal pages', 'Evidence precision': 'Structural evidence only', Availability: 'Rendered page could not be determined' })
})

for (const focusTarget of ['summary', 'content']) {
  test(`disappearing Evidence moves ${focusTarget} focus to the visible Preview heading`, async ({ page }) => {
    const { preview, details, summary } = await openAudit(page)
    await summary.focus()
    await page.keyboard.press('Enter')
    if (focusTarget === 'content') await details.locator('dt').first().evaluate(el => { el.setAttribute('tabindex', '-1'); (el as HTMLElement).focus() })
    // Existing text-mode transition clears paragraph overlays, without moving focus first.
    await preview.getByRole('button', { name: 'Extracted text', exact: true }).evaluate(el => (el as HTMLButtonElement).click())
    await expect(details).toHaveCount(0)
    const heading = preview.getByRole('heading', { name: 'Document preview', exact: true })
    await expect(heading).toBeFocused()
    expect(await heading.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe('none')
    await preview.getByRole('button', { name: 'Rendered pages', exact: true }).click()
    await expect(details).toBeVisible()
    await expect(details).toHaveJSProperty('open', false)
    await expect(heading).not.toHaveAttribute('tabindex')
  })
}

test('no Evidence control is invented when rendered Preview cannot supply evidence', async ({ page }) => {
  const audit = await createSyntheticAudit(page)
  const previewUrl = `**/api/audit/${audit.auditId}/rendered-preview`
  await page.route(previewUrl, route => route.abort())
  const requestFailed = page.waitForEvent('requestfailed', request => request.url().endsWith(`/api/audit/${audit.auditId}/rendered-preview`))
  await page.setViewportSize(sizes[0])
  await page.goto(`/audit/${audit.auditId}`, { waitUntil: 'domcontentloaded' })
  await requestFailed
  await expect(page.locator('#ws-panel-preview').getByText('Loading rendered preview…')).toHaveCount(0)
  await expect(page.locator('#ws-panel-preview').getByRole('button', { name: 'Next page', exact: true })).toHaveCount(0)
  await expect(page.locator(`#ws-panel-preview ${disclosureSelector}`)).toHaveCount(0)
  await expect(page.locator('#ws-panel-preview').getByRole('region', { name: 'Document preview', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Profile details', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Profile details', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.unroute(previewUrl)
  const response = page.waitForResponse(result => result.url().endsWith(`/api/audit/${audit.auditId}/rendered-preview`) && result.status() === 409)
  await page.reload()
  expect((await response).headers()['x-preview-error-category']).toBe('preview_disabled')
  await expect(page.locator('#ws-panel-preview')).toContainText('Page-rendered preview is unavailable. The extracted-text preview remains available.')
  await expect(page.locator('#ws-panel-preview').getByRole('region', { name: 'Document preview', exact: true })).toBeVisible()
})

test('Evidence wraps within Preview bounds across desktop, tab and stress widths without adding a scroll owner', async ({ page }, testInfo) => {
  await openAudit(page)
  for (const size of sizes) {
    await page.setViewportSize(size)
    if (size.width < 1024) await page.getByRole('tab', { name: 'Document', exact: true }).click()
    const details = page.locator(`${disclosureSelector}:visible`)
    await expect(details).toBeVisible()
    if (!(await details.evaluate(el => (el as HTMLDetailsElement).open))) await details.locator('summary').click()
    const geometry = await details.evaluate(el => {
      const r = el.getBoundingClientRect(), parent = el.parentElement!.getBoundingClientRect()
      return { left: r.left, right: r.right, parentLeft: parent.left, parentRight: parent.right,
        widths: [el, ...el.querySelectorAll('dl,dt,dd')].map(e => [e.scrollWidth, e.clientWidth]),
        scrollOwners: [el, ...el.querySelectorAll('*')].filter(e => ['auto', 'scroll'].includes(getComputedStyle(e).overflowY)).length }
    })
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.parentLeft - 1)
    expect(geometry.right).toBeLessThanOrEqual(geometry.parentRight + 1)
    for (const [scroll, client] of geometry.widths) expect(scroll).toBeLessThanOrEqual(client + 1)
    expect(geometry.scrollOwners).toBe(0)
    await expect(details.locator('summary')).toHaveAccessibleName('Evidence details')
  }
  await page.setViewportSize(sizes[0])
  await recordAxe(page, testInfo, 'historical-disclosure-axe.json')
})

test('Export PDF still downloads a PDF from the report header', async ({ page }) => {
  const audit = await createSyntheticAudit(page)
  await openHistoricalPreview(page, { auditId: audit.auditId })
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click()
  const download = await pending
  expect(download.suggestedFilename()).toBe('sample-thesis-compliance-report.pdf')
  const bytes = fs.readFileSync((await download.path())!)
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
  expect(await download.failure()).toBeNull()
})

test('fresh uploads keep the extracted preview interactive without rendered pages', async ({ page }, testInfo) => {
  const { submitted, preview, region, fontBlock } = await openFreshAudit(page)
  await expect(preview.locator(disclosureSelector)).toHaveCount(0)
  await expect(preview.getByRole('button', { name: 'Next page', exact: true })).toHaveCount(0)
  await expect(preview.getByRole('group', { name: 'Zoom and fit controls' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Profile details', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Profile details', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(fontBlock).toHaveAttribute('aria-pressed', 'true')

  const previewUrl = `**/api/audit/${submitted.audit_id}/rendered-preview`
  await page.route(previewUrl, route => route.abort())
  const failed = page.waitForEvent('requestfailed', request => request.url().endsWith(`/api/audit/${submitted.audit_id}/rendered-preview`))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await failed
  await expect(preview.getByText('Loading rendered preview…')).toHaveCount(0)
  await expect(region).toBeVisible()
  await expect(preview.locator(disclosureSelector)).toHaveCount(0)
  await expect(preview.getByRole('button', { name: 'Next page', exact: true })).toHaveCount(0)
  await page.unroute(previewUrl)
  const response = page.waitForResponse(result => result.url().endsWith(`/api/audit/${submitted.audit_id}/rendered-preview`) && result.status() === 409)
  await page.reload()
  expect((await response).headers()['x-preview-error-category']).toBe('preview_disabled')
  await expect(region).toBeVisible()
  await expect(preview).toContainText('Page-rendered preview is unavailable. The extracted-text preview remains available.')
  await testInfo.attach('fresh-extracted-fallback.png', { body: await page.screenshot(), contentType: 'image/png' })
  await expect(preview).not.toContainText('The rendered preview could not be loaded')
  await recordAxe(page, testInfo, 'fresh-extracted-axe.json')
})

test('switching findings preserves extracted paragraph linkage without page claims', async ({ page }) => {
  const { submitted, audit, region, findings, fontFinding, fontBlock } = await openFreshAudit(page)
  const sizeFinding = findings.filter({ hasText: 'Font size does not match' }).filter({ hasText: 'Document paragraph 5' })
  const sizeBlock = region.locator('[data-block-index="4"]')
  await sizeFinding.click()
  await expect(sizeFinding).toHaveAttribute('aria-pressed', 'true')
  await expect(sizeBlock).toHaveAttribute('aria-pressed', 'true')
  await expect(fontBlock).toHaveAttribute('aria-pressed', 'false')
  await expect(sizeBlock).toContainText('14pt instead of 12pt')
  await fontBlock.click()
  await expect(fontFinding).toHaveAttribute('aria-pressed', 'true')
  await expect(fontBlock).toHaveAttribute('aria-pressed', 'true')
  await expect(sizeBlock).toHaveAttribute('aria-pressed', 'false')
  expect(await (await page.request.get(`/api/audit/${submitted.audit_id}`)).json()).toEqual(audit)
})

test('structural evidence remains truthful when physical pages are unavailable', async ({ page }) => {
  const { preview, findings } = await openFreshAudit(page)
  const header = findings.filter({ hasText: 'Header needs review' })
  const footer = findings.filter({ hasText: 'Footer needs review' })
  await header.click()
  const details = preview.locator(disclosureSelector)
  await details.locator('summary').click()
  const headerRows = await rows(details)
  expect(headerRows.Finding).toBe('Header needs review')
  expect(headerRows.Location).toContain('Section 1')
  expect(headerRows.Location).not.toMatch(/Page\s+\d+/)
  expect(headerRows['Evidence precision']).toBe('Structural evidence only')
  expect(headerRows.Availability).toBe('Rendered page could not be determined')
  await footer.click()
  await expect(details).toHaveJSProperty('open', true)
  await expect(details).toContainText('Footer needs review')
  await expect(details).not.toContainText('Header needs review')
  await expect(details).not.toContainText(/Page\s+\d+/)
  await page.reload()
  await header.click()
  await details.locator('summary').click()
  expect(await rows(details)).toEqual(headerRows)
})

test('keyboard selection from the findings list preserves extracted evidence', async ({ page }) => {
  const { region, findings, fontBlock } = await openFreshAudit(page)
  const sizeFinding = findings.filter({ hasText: 'Font size does not match' }).filter({ hasText: 'Document paragraph 5' })
  await sizeFinding.focus()
  await page.keyboard.press('Enter')
  await expect(sizeFinding).toBeFocused()
  await expect(sizeFinding).toHaveAttribute('aria-pressed', 'true')
  await expect(region.locator('[data-block-index="4"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(fontBlock).toHaveAttribute('aria-pressed', 'false')
  expect(await sizeFinding.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe('none')
})

test('keyboard selection from extracted text preserves the matching finding', async ({ page }) => {
  const { region, findings, fontBlock } = await openFreshAudit(page)
  const sizeBlock = region.locator('[data-block-index="4"]')
  const sizeFinding = findings.filter({ hasText: 'Font size does not match' }).filter({ hasText: 'Document paragraph 5' })
  await sizeBlock.focus()
  await page.keyboard.press('Space')
  await expect(sizeBlock).toBeFocused()
  await expect(sizeBlock).toHaveAttribute('aria-pressed', 'true')
  await expect(sizeFinding).toHaveAttribute('aria-pressed', 'true')
  await expect(fontBlock).toHaveAttribute('aria-pressed', 'false')
  expect(await sizeBlock.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe('none')
})

test('extracted evidence stays within Preview bounds across desktop and stress widths', async ({ page }, testInfo) => {
  await openFreshAudit(page)
  for (const size of sizes) {
    await page.setViewportSize(size)
    if (size.width < 1024) await page.getByRole('tab', { name: 'Document', exact: true }).click()
    const region = page.locator('[role="region"][aria-label="Document preview"]:visible')
    await expect(region).toBeVisible()
    await expect(region.locator('[data-block-index="3"]')).toContainText('Calibri')
    const geometry = await region.evaluate(el => {
      const r = el.getBoundingClientRect(), parent = el.parentElement!.getBoundingClientRect()
      return { left: r.left, right: r.right, parentLeft: parent.left, parentRight: parent.right,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
    })
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.parentLeft - 1)
    expect(geometry.right).toBeLessThanOrEqual(geometry.parentRight + 1)
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
    await expect(region).not.toContainText(/Page\s+\d+/)
  }
  await page.setViewportSize(sizes[0])
  const axe = await new AxeBuilder({ page }).analyze()
  await testInfo.attach('extracted-evidence-axe.json', {
    body: JSON.stringify({ violations: axe.violations, incomplete: axe.incomplete }, null, 2),
    contentType: 'application/json',
  })
  expect(axe.violations.filter(v => v.id === 'heading-order' || v.impact === 'serious' || v.impact === 'critical')).toEqual([])
})

test('PDF export remains available after a fresh upload without rendered pages', async ({ page }, testInfo) => {
  await openFreshAudit(page)
  // A separate canonical-profile control has one real audit POST of its own.
  const bytes = fs.readFileSync(path.join(process.cwd(), 'public', 'samples', 'sample-thesis.docx'))
  const response = await page.request.post('/api/audit?profile_id=suc-academic-report', { multipart: {
    file: { name: 'sample-thesis.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: bytes },
  } })
  expect(response.ok(), await response.text()).toBe(true)
  const sample = await response.json()
  expect(sample.weighted_compliance_score).toBe(62)
  expect(sample.major_count).toBe(5)
  expect(sample.minor_count).toBe(6)
  expect(sample.paragraph_page_mapping).toBeNull()
  await testInfo.attach('sample-audit-post.json', { body: JSON.stringify(sample), contentType: 'application/json' })
  await page.goto(`/audit/${sample.audit_id}`)
  await expect(page.locator('#ws-panel-preview')).toContainText('Page-rendered preview is unavailable.')
  await expect(page.locator('#ws-panel-preview').getByRole('region', { name: 'Document preview', exact: true })).toBeVisible()
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click()
  const download = await pending
  expect(download.suggestedFilename()).toBe('sample-thesis-compliance-report.pdf')
  const pdf = fs.readFileSync((await download.path())!)
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  expect(await download.failure()).toBeNull()
})
