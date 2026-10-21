import { test, expect, type Page, type Locator } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createSyntheticAudit } from './helpers'

const disclosureSelector = '[data-testid="preview-evidence-disclosure"]'
const sizes = [{ width: 1366, height: 768 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 768, height: 800 }, { width: 683, height: 768 }, { width: 195, height: 667 }]

async function openAudit(page: Page) {
  await page.setViewportSize(sizes[0])
  const audit = await createSyntheticAudit(page)
  await page.goto(`/audit/${audit.auditId}`)
  await page.waitForLoadState('networkidle')
  await page.locator('#ws-panel-findings li button').first().click()
  const preview = page.locator('#ws-panel-preview')
  const details = preview.locator(disclosureSelector)
  await expect(details).toBeVisible()
  return { audit, preview, details, summary: details.locator('summary') }
}

async function rows(details: Locator) {
  return details.locator('dt').evaluateAll(elements => Object.fromEntries(elements.map(el => [el.textContent, el.nextElementSibling!.textContent])))
}

test('native Evidence toggle is nonmodal and Preview controls remain interactive', async ({ page }) => {
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
  expect(paragraph.Location).toBe('Page 1 · Paragraph 4')
  expect(paragraph['Evidence target']).toBe('Paragraph 4')
  expect(paragraph['Evidence precision']).toBe('Paragraph evidence')
  expect(paragraph.Availability).toBe('The exact text range could not be highlighted. The affected paragraph is marked instead.')
  await page.locator('#ws-panel-findings li button').nth(7).click()
  await expect(details).toHaveJSProperty('open', true)
  expect(await rows(details)).toEqual({ Finding: 'Table caption is missing', Location: 'Table 1 · Page 1', 'Evidence target': 'Table 1 · Page 1', 'Evidence precision': 'Page-only evidence' })
  await expect(details).not.toContainText(paragraph.Finding)
  await expect(details).not.toContainText(paragraph.Availability)
  await preview.getByRole('button', { name: 'Extracted text', exact: true }).click()
  await expect(preview.getByRole('region', { name: 'Document preview', exact: true })).toBeVisible()
  await expect(details).toHaveCount(0)
  await preview.getByRole('button', { name: 'Rendered pages', exact: true }).click()
  await expect(preview.getByRole('region', { name: 'Rendered document preview', exact: true })).toBeVisible()
  await page.locator('#ws-panel-findings li button').first().click()
  await expect(details).toBeVisible()
  await expect(details).toHaveJSProperty('open', false)
  await details.locator('summary').click()
  expect(await rows(details)).toEqual(paragraph)
})

test('existing structural fixture retains stored provenance with and without a rendered page', async ({ page }) => {
  // Reuse the exact absent-story fixture recipe from backend/tests/test_page_element_rules.py.
  const backend = path.resolve(process.cwd(), '..', 'backend')
  const fixture = JSON.parse(execFileSync(path.join(backend, '.venv', 'Scripts', 'python.exe'), ['-c', `
import json,base64
from docx import Document
from tests.test_page_element_rules import saved
from app.services.profile_schema import new_custom_profile
doc=Document()
doc.add_paragraph('Body remains unchanged.')
profile=new_custom_profile('Stored structural review')
profile.headers.check_header_requirements=True
profile.footers.check_footer_requirements=True
profile.page_numbers.check_page_number_requirements=True
print(json.dumps({'docx':base64.b64encode(saved(doc)).decode(),'profile':profile.to_dict()}))
`], { cwd: backend, encoding: 'utf8' }))
  const response = await page.request.post('/api/audit', { multipart: {
    file: { name: 'structural.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(fixture.docx, 'base64') },
    custom_profile: JSON.stringify(fixture.profile),
  }, timeout: 90000 })
  expect(response.ok()).toBe(true)
  const audit = await response.json()
  await page.setViewportSize(sizes[0])
  await page.goto(`/audit/${audit.audit_id}`)
  await page.waitForLoadState('networkidle')
  let details = page.locator(`#ws-panel-preview ${disclosureSelector}`)
  await details.locator('summary').click()
  const available = await rows(details)
  expect(available).toEqual({ Finding: 'Header needs review', Location: 'Page 1 · Section 1 · Header · Normal pages', 'Evidence target': 'Section 1 · Header · Normal pages', 'Evidence precision': 'Page-level structural evidence', Availability: 'No exact Header/Footer highlight is available.' })
  await page.locator('#ws-panel-findings li button').nth(1).click()
  await expect(details).toHaveJSProperty('open', true)
  await expect(details).toContainText('Footer needs review')
  await expect(details).not.toContainText('Header needs review')
  await page.route('**/rendered-preview', route => route.abort())
  await page.reload({ waitUntil: 'networkidle' })
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
  await page.route('**/rendered-preview', route => route.abort())
  const audit = await createSyntheticAudit(page)
  await page.setViewportSize(sizes[0])
  await page.goto(`/audit/${audit.auditId}`)
  await page.waitForLoadState('networkidle')
  await expect(page.locator(`#ws-panel-preview ${disclosureSelector}`)).toHaveCount(0)
  await expect(page.locator('#ws-panel-preview').getByRole('region', { name: 'Document preview', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Profile details', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Profile details', exact: true })).toBeVisible()
})

test('Evidence wraps within Preview bounds across desktop, tab and stress widths without adding a scroll owner', async ({ page }) => {
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
  const axe = await new AxeBuilder({ page }).analyze()
  expect(axe.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
})

test('Export PDF still downloads a PDF from the report header', async ({ page }) => {
  await openAudit(page)
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click()
  const download = await pending
  expect(download.suggestedFilename()).toBe('sample-thesis-compliance-report.pdf')
  const bytes = fs.readFileSync((await download.path())!)
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
  expect(await download.failure()).toBeNull()
})
