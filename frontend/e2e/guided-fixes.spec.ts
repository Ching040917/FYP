/**
 * Guided Fixes — selection, server review, verification and one-use download.
 * Synthetic fixtures only; backend proves document identity via SHA-256.
 */
import { test, expect, type Page, type Locator, type TestInfo } from '@playwright/test'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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

type SpacingCase = {
  before?: number
  after?: number
  override?: { side: 'before' | 'after'; layer: 'direct' | 'style' | 'base' | 'defaults'; kind: 'lines' | 'auto' | 'contextual' }
}

function spacingFixture(options: SpacingCase) {
  const backendDir = path.resolve(process.cwd(), '..', 'backend')
  const python = path.join(backendDir, '.venv', 'Scripts', 'python.exe')
  const fixture = JSON.parse(execFileSync(python, ['-B', '-c', `
import base64, io, json, sys
from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt
from app.services.profile_schema import new_custom_profile
options = json.load(sys.stdin)
doc = Document()
p = doc.add_paragraph("A body paragraph with independently verified before and after spacing.")
p.paragraph_format.space_before = Pt(20)
p.paragraph_format.space_after = Pt(20)
p.paragraph_format.line_spacing = 1.5
p.runs[0].font.name = "Times New Roman"
p.runs[0].font.size = Pt(12)
control = options.get("override")
if control:
    layer = control["layer"]
    if layer == "direct":
        properties = p._p.get_or_add_pPr()
    elif layer in {"style", "base"}:
        style = doc.styles.add_style("SpacingEvidence", WD_STYLE_TYPE.PARAGRAPH)
        style.base_style = doc.styles["Normal"]
        p.style = style
        if layer == "base":
            base = doc.styles.add_style("SpacingEvidenceBase", WD_STYLE_TYPE.PARAGRAPH)
            base.base_style = doc.styles["Normal"]
            style.base_style = base
            style = base
        properties = style.element.get_or_add_pPr()
    else:
        styles = doc.styles.element
        defaults = styles.find(qn("w:docDefaults"))
        if defaults is None:
            defaults = OxmlElement("w:docDefaults")
            styles.insert(0, defaults)
        holder = defaults.find(qn("w:pPrDefault"))
        if holder is None:
            holder = OxmlElement("w:pPrDefault")
            defaults.append(holder)
        properties = holder.find(qn("w:pPr"))
        if properties is None:
            properties = OxmlElement("w:pPr")
            holder.append(properties)
    if control["kind"] == "contextual":
        flag = OxmlElement("w:contextualSpacing")
        flag.set(qn("w:val"), "1")
        properties.append(flag)
    else:
        spacing = properties.find(qn("w:spacing"))
        if spacing is None:
            spacing = OxmlElement("w:spacing")
            properties.append(spacing)
        attr = control["side"] + ("Lines" if control["kind"] == "lines" else "Autospacing")
        spacing.set(qn("w:" + attr), "100" if control["kind"] == "lines" else "1")
profile = new_custom_profile("Point spacing browser proof")
profile.body.space_before_pt = options.get("before")
profile.body.space_after_pt = options.get("after")
out = io.BytesIO()
doc.save(out)
print(json.dumps({"docx": base64.b64encode(out.getvalue()).decode(), "profile": profile.to_dict()}))
`], {
    cwd: backendDir, encoding: 'utf8', input: JSON.stringify(options),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })) as { docx: string; profile: object }
  return {
    ...fixture, backendDir, python,
    file: {
      name: 'point-spacing.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from(fixture.docx, 'base64'),
    },
  }
}

async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 100; i++) {
    if (await target.evaluate(element => element === document.activeElement)) {
      await expect(target).toBeVisible()
      expect(await target.evaluate(element => element.matches(':focus-visible'))).toBe(true)
      return
    }
    await page.keyboard.press('Tab')
    if (await page.getByRole('dialog').count()) {
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true)
      expect(await page.evaluate(() => Boolean(document.activeElement?.getClientRects().length))).toBe(true)
    }
  }
  throw new Error('Control was not reachable using the keyboard')
}

async function spacingStateEvidence(page: Page, testInfo: TestInfo, state: string) {
  for (const [width, height] of [[1366, 768], [1280, 800], [1024, 768], [960, 768], [768, 768]]) {
    await page.setViewportSize({ width, height })
    const axe = await new AxeBuilder({ page }).analyze()
    const bounds = await page.getByRole('dialog').evaluate(dialog => ({
      viewport: { width: innerWidth, height: innerHeight },
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      controls: Array.from(dialog.querySelectorAll('button,input')).filter(element => element.getClientRects().length).map(element => {
        const rect = element.getBoundingClientRect()
        return { name: element.getAttribute('aria-label') || element.textContent?.trim(),
          left: rect.left, right: rect.right, width: rect.width,
          textFits: element.scrollWidth <= element.clientWidth + 1 }
      }),
      liveRegions: Array.from(dialog.querySelectorAll('[role="status"],[role="alert"],[aria-live]')).map(element => element.textContent),
    }))
    await testInfo.attach(`${state}-${width}-accessibility.json`, {
      body: JSON.stringify({ violations: axe.violations, incomplete: axe.incomplete, bounds }, null, 2),
      contentType: 'application/json',
    })
    await testInfo.attach(`${state}-${width}.png`, { body: await page.screenshot(), contentType: 'image/png' })
    expect(axe.violations.filter(item => item.impact === 'critical' || item.impact === 'serious')).toEqual([])
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1)
    for (const control of bounds.controls) {
      expect(control.left).toBeGreaterThanOrEqual(-1)
      expect(control.right).toBeLessThanOrEqual(bounds.clientWidth + 1)
      expect(control.textFits).toBe(true)
    }
  }
}

test.describe('guided fixes workflow @guided-fixes', () => {
  for (const options of [{ before: 6 }, { after: 0 }, { before: 6, after: 0 }]) {
    test(`point spacing ${JSON.stringify(options)} completes keyboard Review Apply Download with exact package proof`, async ({ page, baseURL }, testInfo) => {
      const origin = new URL(baseURL!).origin
      await page.route('**/*', route => new URL(route.request().url()).origin === origin
        ? route.continue() : route.abort('blockedbyclient'))
      const fixture = spacingFixture(options)
      const digest = createHash('sha256').update(fixture.file.buffer).digest('hex')
      const created = await page.request.post('/api/audit', {
        multipart: { file: fixture.file, custom_profile: JSON.stringify(fixture.profile) }, timeout: 90_000,
      })
      expect(created.ok(), await created.text()).toBe(true)
      const auditId = (await created.json()).audit_id as string
      const before = await (await page.request.get(`/api/audit/${auditId}`)).json()
      await page.goto(`/audit/${auditId}`)
      const opener = page.getByRole('button', { name: /^Guided Fixes/ })
      await tabTo(page, opener)
      await page.keyboard.press('Enter')
      const sides = Object.keys(options) as ('before' | 'after')[]
      const selected = page.getByRole('button', { name: `Review ${sides.length} selected chang${sides.length === 1 ? 'e' : 'es'}`, exact: true })
      for (const side of sides) {
        const checkbox = page.getByRole('checkbox', { name: new RegExp(`Space ${side} the paragraph does not match, .*Paragraph 1`) })
        await tabTo(page, checkbox)
        await page.keyboard.press('Space')
        await expect(checkbox).toBeChecked()
      }
      await tabTo(page, page.getByRole('button', { name: 'Clear selection', exact: true }))
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: 'Review 0 selected changes', exact: true })).toBeDisabled()
      for (const side of sides) {
        await tabTo(page, page.getByRole('checkbox', { name: new RegExp(`Space ${side} the paragraph does not match, .*Paragraph 1`) }))
        await page.keyboard.press('Space')
      }
      await tabTo(page, selected)
      await page.keyboard.press('Enter')
      await tabTo(page, page.getByRole('button', { name: 'Back to findings', exact: true }).last())
      await page.keyboard.press('Enter')
      await expect(selected).toBeEnabled()
      await tabTo(page, selected)
      await page.keyboard.press('Enter')
      // The native file chooser is represented by Playwright's file-upload seam;
      // every dialog action before and after it uses actual keyboard navigation.
      await tabTo(page, page.locator('#guided-fixes-file-input'))
      await page.locator('#guided-fixes-file-input').setInputFiles(fixture.file)
      await tabTo(page, page.getByRole('button', { name: 'Review safety and locations', exact: true }))
      await page.keyboard.press('Enter')
      const review = page.getByRole('dialog', { name: 'Guided Fixes — review confirmed changes' })
      await expect(review).toBeVisible({ timeout: 60_000 })
      for (const side of sides) {
        await expect(review.getByText(`Property to change: space ${side}`, { exact: true })).toBeVisible()
        await expect(review.getByText(new RegExp(`^Required and proposed: ${options[side]}(?:\\.0)?pt$`))).toBeVisible()
      }
      await expect(review.getByText(/^Current: 20(?:\.0)?pt$/)).toHaveCount(sides.length)
      await spacingStateEvidence(page, testInfo, 'point-spacing-review')
      const applyResponse = page.waitForResponse(response =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/audit/${auditId}/guided-fixes`)
      await tabTo(page, page.getByRole('button', { name: 'Apply and verify changes', exact: true }))
      await page.keyboard.press('Enter')
      const applied = await (await applyResponse).json()
      expect(applied.status).toBe('passed')
      await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed', exact: true })).toBeVisible({ timeout: 60_000 })
      await spacingStateEvidence(page, testInfo, 'point-spacing-verified')
      const events: string[] = []
      let downloadRequests = 0
      page.on('download', event => events.push(event.suggestedFilename()))
      page.on('request', request => {
        if (new URL(request.url()).pathname.includes(`/api/audit/${auditId}/guided-fixes/download/`)) downloadRequests++
      })
      const downloadButton = page.getByRole('button', { name: 'Download corrected document', exact: true })
      await tabTo(page, downloadButton)
      const downloading = page.waitForEvent('download')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Enter')
      const download = await downloading
      const stream = await download.createReadStream()
      if (!stream) throw new Error('Verified spacing copy was not readable')
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.from(chunk))
      const corrected = Buffer.concat(chunks)
      await expect(downloadButton).toBeDisabled()
      expect(events).toEqual(['point-spacing_ACA-fixed.docx'])
      expect(downloadRequests).toBe(1)
      expect((await page.request.get(`/api/audit/${auditId}/guided-fixes/download/${applied.download_token}`)).status()).toBe(410)
      const inspected = JSON.parse(execFileSync(fixture.python, ['-B', '-c', `
import base64, hashlib, io, json, sys, zipfile
from lxml import etree
data = json.load(sys.stdin)
source, output = [base64.b64decode(data[key]) for key in ("source", "output")]
ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
with zipfile.ZipFile(io.BytesIO(source)) as a, zipfile.ZipFile(io.BytesIO(output)) as b:
    assert set(a.namelist()) == set(b.namelist())
    changed = [name for name in a.namelist() if a.read(name) != b.read(name)]
    assert set(changed) <= {"word/document.xml", "docProps/core.xml", "docProps/app.xml"}
    old, new = [etree.fromstring(z.read("word/document.xml")) for z in (a, b)]
    original = old.find("w:body/w:p/w:pPr/w:spacing", ns)
    saved = new.find("w:body/w:p/w:pPr/w:spacing", ns)
    raw = {}
    for side, points in data["required"].items():
        name = "{%s}%s" % (ns["w"], side)
        assert original.get(name) == "400"
        assert saved.get(name) == str(points * 20)
        raw[side] = saved.get(name)
        saved.set(name, original.get(name))
    assert etree.tostring(old, method="c14n") == etree.tostring(new, method="c14n")
print(json.dumps({"source_sha256": hashlib.sha256(source).hexdigest(),
 "corrected_sha256": hashlib.sha256(output).hexdigest(), "raw_twips": raw, "changed_parts": changed}))
`], { cwd: fixture.backendDir, encoding: 'utf8', input: JSON.stringify({
        source: fixture.docx, output: corrected.toString('base64'), required: options,
      }) }))
      expect(inspected.source_sha256).toBe(digest)
      expect(inspected.corrected_sha256).not.toBe(digest)
      expect(createHash('sha256').update(fixture.file.buffer).digest('hex')).toBe(digest)
      await testInfo.attach('point-spacing-package-proof.json', { body: JSON.stringify(inspected, null, 2), contentType: 'application/json' })
      await testInfo.attach('point-spacing-original.docx', { body: fixture.file.buffer, contentType: fixture.file.mimeType })
      await testInfo.attach('point-spacing-corrected.docx', { body: corrected, contentType: fixture.file.mimeType })
      expect(await (await page.request.get(`/api/audit/${auditId}`)).json()).toEqual(before)
      const reaudit = await page.request.post('/api/audit', {
        multipart: { file: { ...fixture.file, buffer: corrected }, custom_profile: JSON.stringify(fixture.profile) }, timeout: 90_000,
      })
      expect(reaudit.ok(), await reaudit.text()).toBe(true)
      const after = await reaudit.json()
      const codes = sides.map(side => `SPACE_${side.toUpperCase()}`)
      expect(after.physical_layout_errors.filter((finding: { rule_code: string }) => codes.includes(finding.rule_code))).toEqual([])
      await tabTo(page, page.getByRole('button', { name: 'Close', exact: true }))
      await page.keyboard.press('Enter')
      await expect(opener).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: 'Download corrected document', exact: true })).toHaveCount(0)
      await tabTo(page, page.getByRole('button', { name: 'Close Guided Fixes', exact: true }))
      await page.keyboard.press('Enter')
      await expect(opener).toBeFocused()
    })
  }

  for (const side of ['before', 'after'] as const) {
    for (const layer of ['direct', 'style', 'base', 'defaults'] as const) {
      for (const kind of ['lines', 'auto', 'contextual'] as const) {
        test(`unsafe spacing ${side} ${layer} ${kind} rejects the whole selected set without a Download`, async ({ page, baseURL }, testInfo) => {
          const origin = new URL(baseURL!).origin
          await page.route('**/*', route => new URL(route.request().url()).origin === origin
            ? route.continue() : route.abort('blockedbyclient'))
          // Both sides selected: one side is safe for line/auto cases, proving
          // that Review cannot silently drop the unsafe side or partially apply.
          const fixture = spacingFixture({ before: 6, after: 0, override: { side, layer, kind } })
          const digest = createHash('sha256').update(fixture.file.buffer).digest('hex')
          const created = await page.request.post('/api/audit', {
            multipart: { file: fixture.file, custom_profile: JSON.stringify(fixture.profile) }, timeout: 90_000,
          })
          expect(created.ok(), await created.text()).toBe(true)
          const auditId = (await created.json()).audit_id as string
          const before = await (await page.request.get(`/api/audit/${auditId}`)).json()
          const events: string[] = []
          let applyRequests = 0
          page.on('download', event => events.push(event.suggestedFilename()))
          page.on('request', request => {
            if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/audit/${auditId}/guided-fixes`) applyRequests++
          })
          await page.goto(`/audit/${auditId}`)
          await openGuidedFixes(page)
          for (const selectedSide of ['before', 'after']) {
            await page.getByRole('checkbox', { name: new RegExp(`Space ${selectedSide} the paragraph does not match, .*Paragraph 1`) }).check()
          }
          await page.getByRole('button', { name: 'Review 2 selected changes', exact: true }).click()
          await page.locator('#guided-fixes-file-input').setInputFiles(fixture.file)
          const reviewing = page.waitForResponse(response =>
            response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/audit/${auditId}/guided-fixes/review`)
          await page.getByRole('button', { name: 'Review safety and locations', exact: true }).click()
          const response = await reviewing
          expect(response.status()).toBe(422)
          const rejected = await response.json()
          expect(rejected).not.toHaveProperty('review_id')
          expect(rejected).not.toHaveProperty('download_token')
          await expect(page.getByRole('alert')).toContainText('Fix cannot be applied safely. Correct the selected findings manually.')
          await expect(page.getByRole('button', { name: 'Apply and verify changes', exact: true })).toHaveCount(0)
          await expect(page.getByRole('button', { name: 'Download corrected document', exact: true })).toHaveCount(0)
          if (layer === 'direct' && side === 'before' && kind === 'lines') {
            await spacingStateEvidence(page, testInfo, 'unsafe-spacing-manual')
          }
          await tabTo(page, page.getByRole('button', { name: 'Back to findings', exact: true }).last())
          await page.keyboard.press('Enter')
          await expect(page.getByRole('button', { name: 'Review 2 selected changes', exact: true })).toBeEnabled()
          expect(events).toEqual([])
          expect(applyRequests).toBe(0)
          expect(createHash('sha256').update(fixture.file.buffer).digest('hex')).toBe(digest)
          expect(await (await page.request.get(`/api/audit/${auditId}`)).json()).toEqual(before)
        })
      }
    }
  }

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

  for (const { required, segmented } of [
    { required: true, segmented: false },
    { required: false, segmented: false },
    { required: true, segmented: true },
  ]) {
    test(`Reference heading bold ${required ? 'on' : 'off'}${segmented ? ' across all text runs' : ''} preserves the original and downloads a verified copy`, async ({ page, baseURL }) => {
      const origin = new URL(baseURL!).origin
      await page.route('**/*', route => new URL(route.request().url()).origin === origin
        ? route.continue() : route.abort('blockedbyclient'))
      const backendDir = path.resolve(process.cwd(), '..', 'backend')
      const python = path.join(backendDir, '.venv', 'Scripts', 'python.exe')
      const fixture = JSON.parse(execFileSync(python, ['-B', '-c', `
import base64, json
from tests.test_guided_fix_reference_heading import _bold_doc, _bold_bytes
from app.services.profile_schema import new_custom_profile
required = ${required ? 'True' : 'False'}
source = _bold_bytes(_bold_doc(not required, segmented=${segmented ? 'True' : 'False'}, rich=True))
profile = new_custom_profile("Reference heading bold E2E")
profile.references.check_heading_bold = True
profile.references.heading_bold = required
print(json.dumps({"docx": base64.b64encode(source).decode(), "profile": profile.to_dict()}))
`], { cwd: backendDir, encoding: 'utf8' })) as { docx: string; profile: object }
      const buffer = Buffer.from(fixture.docx, 'base64')
      const file = { name: 'reference-bold.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer }
      const created = await page.request.post('/api/audit', {
        multipart: { file, custom_profile: JSON.stringify(fixture.profile) }, timeout: 90_000,
      })
      expect(created.ok(), await created.text()).toBeTruthy()
      const auditId = (await created.json()).audit_id as string
      const before = await (await page.request.get(`/api/audit/${auditId}`)).json()
      await page.goto(`/audit/${auditId}`)
      await page.getByRole('button', { name: 'Guided Fixes' }).click()
      await page.getByRole('checkbox', { name: /Reference List heading bold \(all heading text\).*Paragraph 2/ }).check()
      await expect(page.getByText(required
        ? 'Make the Reference List heading bold'
        : 'Use regular (not bold) text for the Reference List heading')).toBeVisible()
      await page.getByRole('button', { name: 'Review 1 selected change', exact: true }).click()
      await page.locator('#guided-fixes-file-input').setInputFiles(file)
      await page.getByRole('button', { name: 'Review safety and locations' }).click()
      await expect(page.getByText('Property to change: Reference List heading bold (all heading text)', { exact: true })).toBeVisible({ timeout: 60_000 })
      await expect(page.getByText(`Current: ${required ? 'Not bold' : 'Bold'}`, { exact: true })).toBeVisible()
      await expect(page.getByText(`Required and proposed: ${required ? 'Bold' : 'Not bold'}`, { exact: true })).toBeVisible()
      await expect(page.getByText(/^1 affected location: Reference List heading "References ?".*Paragraph 2$/)).toBeVisible()
      await page.getByRole('button', { name: 'Apply and verify changes' }).click()
      await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed' })).toBeVisible({ timeout: 60_000 })
      await expect(page.getByRole('dialog').getByText('Reference List heading bold (all heading text): 1')).toBeVisible()
      const events: string[] = []
      page.on('download', event => events.push(event.suggestedFilename()))
      const downloading = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Download corrected document', exact: true }).click()
      const download = await downloading
      const stream = await download.createReadStream()
      if (!stream) throw new Error('Verified download did not provide readable output')
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.from(chunk))
      const corrected = Buffer.concat(chunks)
      await expect(page.getByText('Downloaded. The one-use link has expired.', { exact: true })).toBeVisible()
      expect(events).toEqual(['reference-bold_ACA-fixed.docx'])
      const inspected = JSON.parse(execFileSync(python, ['-B', '-c', `
import base64, io, json, sys, zipfile
from docx import Document
from app.services.docx_preservation import compare_preservation
data = json.load(sys.stdin)
source, output = (base64.b64decode(data[key]) for key in ("source", "output"))
original, corrected = Document(io.BytesIO(source)), Document(io.BytesIO(output))
before, after = original.paragraphs[1], corrected.paragraphs[1]
indexes = [i for i, run in enumerate(before.runs) if run.text != ""]
assert before.text == after.text and before.alignment == after.alignment
assert all(after.runs[i].font.bold is data["required"] for i in indexes)
assert [(r.text, r.font.italic, r.font.name, r.font.size) for r in before.runs] == [(r.text, r.font.italic, r.font.name, r.font.size) for r in after.runs]
assert all(after.runs[i]._r.xml == run._r.xml for i, run in enumerate(before.runs) if run.text == "")
compare_preservation(source, output, {(1, i, "REFERENCE_HEADING_BOLD") for i in indexes})
with zipfile.ZipFile(io.BytesIO(source)) as a, zipfile.ZipFile(io.BytesIO(output)) as b:
    assert set(a.namelist()) == set(b.namelist())
    assert all(a.read(name) == b.read(name) for name in a.namelist() if name not in {"word/document.xml", "docProps/core.xml", "docProps/app.xml"})
print(json.dumps({"verified_text_runs": len(indexes), "package_preserved": True}))
`], { cwd: backendDir, encoding: 'utf8', input: JSON.stringify({
        source: fixture.docx, output: corrected.toString('base64'), required,
      }) })) as { verified_text_runs: number; package_preserved: boolean }
      expect(inspected).toEqual({ verified_text_runs: segmented ? 3 : 1, package_preserved: true })
      expect(await (await page.request.get(`/api/audit/${auditId}`)).json()).toEqual(before)
      const reaudit = await page.request.post('/api/audit', {
        multipart: { file: { ...file, buffer: corrected }, custom_profile: JSON.stringify(fixture.profile) }, timeout: 90_000,
      })
      expect(reaudit.ok(), await reaudit.text()).toBeTruthy()
      const findings = (await reaudit.json()).physical_layout_errors as { rule_code: string }[]
      expect(findings.filter(finding => finding.rule_code === 'REFERENCE_HEADING_BOLD')).toEqual([])
    })
  }

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
