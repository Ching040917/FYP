import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

interface DownloadFixture {
  file: { name: string; mimeType: string; buffer: Buffer }
  profile: object
}

// Synthetic document; real audit, Review, Apply and one-use Download endpoints.
function fixture() {
  const backend = path.resolve(process.cwd(), '..', 'backend')
  const output = execFileSync(path.join(backend, '.venv', 'Scripts', 'python.exe'), ['-B', '-c', `
import base64, io, json
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from app.services.profile_schema import new_custom_profile
doc = Document()
doc.add_paragraph("Synthetic body paragraph.")
heading = doc.add_paragraph("References")
heading.alignment = WD_ALIGN_PARAGRAPH.LEFT
doc.add_paragraph("Smith, A. (2024). Entry. Press.")
out = io.BytesIO()
doc.save(out)
profile = new_custom_profile("Stale download regression")
profile.references.check_heading_alignment = True
profile.references.heading_alignment = "center"
print(json.dumps({"docx": base64.b64encode(out.getvalue()).decode(), "profile": profile.to_dict()}))
`], { cwd: backend, encoding: 'utf8' })
  const value = JSON.parse(output) as { docx: string; profile: object }
  return { file: { name: 'synthetic-download.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(value.docx, 'base64') }, profile: value.profile }
}

async function verifyCopy(page: Page, source: DownloadFixture) {
  await page.getByRole('button', { name: 'Guided Fixes', exact: false }).click()
  await page.getByRole('checkbox', { name: /Reference List heading alignment/ }).check()
  await page.getByRole('button', { name: /Review 1 selected change/ }).click()
  await page.locator('#guided-fixes-file-input').setInputFiles(source.file)
  await page.getByRole('button', { name: 'Review safety and locations' }).click()
  await expect(page.getByRole('button', { name: 'Apply and verify changes' })).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Apply and verify changes' }).click()
  await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed' })).toBeVisible({ timeout: 60_000 })
}

for (const transition of ['audit switch', 'close'] as const) {
  test(`delayed genuine Download is discarded after ${transition}; later valid download works`, async ({ page, baseURL }, testInfo) => {
    const origin = new URL(baseURL!).origin
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      return url.origin === origin ? route.continue() : route.abort('blockedbyclient')
    })
    const source = fixture()
    async function createAudit() {
      const response = await page.request.post('/api/audit', {
        multipart: { file: source.file, custom_profile: JSON.stringify(source.profile) }, timeout: 90_000,
      })
      expect(response.ok(), await response.text()).toBeTruthy()
      return (await response.json()).audit_id as string
    }
    const auditA = await createAudit()
    const auditB = await createAudit()
    await page.goto(`/audit/${auditA}`)
    await verifyCopy(page, source)
    const downloads: string[] = []
    page.on('download', download => { downloads.push(download.suggestedFilename()) })
    const received = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const downloadPattern = `**/api/audit/${auditA}/guided-fixes/download/*`
    await page.route(downloadPattern, async route => {
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      received.resolve()
      await release.promise
      await route.fulfill({ response })
    })
    try {
      await page.getByRole('button', { name: 'Download corrected document' }).click()
      await received.promise
      await expect(page.getByRole('status').filter({ hasText: /^Downloading…$/ })).toHaveCount(1)
      if (transition === 'audit switch') {
        await page.evaluate(id => {
          window.history.pushState({}, '', `/audit/${id}`)
          window.dispatchEvent(new PopStateEvent('popstate'))
        }, auditB)
        await expect(page).toHaveURL(new RegExp(`/audit/${auditB}$`))
        await expect(page.getByRole('dialog')).toHaveCount(0)
      } else {
        await page.getByRole('button', { name: 'Close', exact: true }).focus()
        await page.keyboard.press('Enter')
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Guided Fixes', exact: false })).toBeFocused()
      }
      const responseReady = page.waitForResponse(response => response.url().includes(`/api/audit/${auditA}/guided-fixes/download/`))
      release.resolve()
      await responseReady
      await page.waitForLoadState('networkidle')
      expect(downloads).toEqual([])
      await expect(page.getByText('Downloaded. The one-use link has expired.')).toHaveCount(0)
      await expect(page.getByRole('alert')).toHaveCount(0)
      await page.unroute(downloadPattern)
      await page.getByRole('button', { name: 'Guided Fixes', exact: false }).click()
      await expect(page.getByRole('button', { name: 'Review 0 selected changes', exact: true })).toBeDisabled()
      await expect(page.getByRole('status').filter({ hasText: /Downloading|Downloaded|Download is now available|re-audit passed/ })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await verifyCopy(page, source)
      await expect(page.getByRole('button', { name: 'Download corrected document' })).toBeEnabled()
      const downloadEvent = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Download corrected document' }).click()
      const download = await downloadEvent
      expect(download.suggestedFilename()).toContain('_ACA-fixed.docx')
      await expect(page.getByText('Downloaded. The one-use link has expired.')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Download corrected document' })).toBeDisabled()
      await expect(page.getByRole('status').filter({ hasText: /^Downloading…$/ })).toHaveCount(0)
      expect(downloads).toHaveLength(1)
      await page.screenshot({ path: testInfo.outputPath('verified-download.png') })
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Guided Fixes', exact: false })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: 'Close Guided Fixes', exact: true })).toBeFocused()
      await expect(page.getByRole('status').filter({ hasText: /Downloading|Downloaded|Download is now available|re-audit passed/ })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: 'Guided Fixes', exact: false })).toBeFocused()
    } finally {
      release.resolve()
      await page.unroute(downloadPattern)
    }
  })
}
