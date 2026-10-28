/**
 * Guided Fixes — selection, server review, verification and one-use download.
 * Synthetic fixtures only; backend proves document identity via SHA-256.
 */
import { test, expect, chromium, type Page, type Locator, type TestInfo } from '@playwright/test'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { AxeBuilder } from '@axe-core/playwright'
import { createSyntheticAudit, annotate } from './helpers'

const networkEvidence = new Map<string, { origin: string; externalAttempts: string[]; externalResponses: string[]; failedRequests: { url: string; error: string | undefined }[] }>()

test.beforeEach(async ({ context, baseURL }, testInfo) => {
  const origin = new URL(baseURL!).origin
  const evidence = { origin, externalAttempts: [] as string[], externalResponses: [] as string[],
    failedRequests: [] as { url: string; error: string | undefined }[] }
  networkEvidence.set(testInfo.testId, evidence)
  context.on('request', request => {
    const url = new URL(request.url())
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && url.origin !== origin) evidence.externalAttempts.push(request.url())
  })
  context.on('response', response => {
    const url = new URL(response.url())
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) evidence.externalResponses.push(response.url())
  })
  context.on('requestfailed', request => evidence.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }))
  await context.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort('blockedbyclient'))
})

test.afterEach(async ({}, testInfo) => {
  const evidence = networkEvidence.get(testInfo.testId)
  if (evidence) {
    await testInfo.attach('network-events.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
    expect(evidence.externalResponses).toEqual([])
    networkEvidence.delete(testInfo.testId)
  }
})

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
  missing?: 'before' | 'after'
  inherited?: boolean
  structure?: 'field' | 'section' | 'bookmark-id' | 'bookmark-unpaired' | 'bookmark-reversed'
  grouped?: boolean
}

type SpacingFixture = {
  docx: string
  profile: object
  backendDir: string
  python: string
  file: { name: string; mimeType: string; buffer: Buffer }
}

function spacingFixture(options: SpacingCase): SpacingFixture {
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
if options.get("missing"):
    p._p.pPr.spacing.attrib.pop(qn("w:" + options["missing"]), None)
    if options.get("inherited"):
        style = doc.styles.add_style("InheritedSpacingEvidence", WD_STYLE_TYPE.PARAGRAPH)
        style.base_style = doc.styles["Normal"]
        setattr(style.paragraph_format, "space_" + options["missing"], Pt(20))
        p.style = style
structure = options.get("structure")
if structure == "field":
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), "DATE")
    p._p.append(field)
elif structure == "section":
    p._p.get_or_add_pPr().append(OxmlElement("w:sectPr"))
elif structure and structure.startswith("bookmark"):
    start, end = OxmlElement("w:bookmarkStart"), OxmlElement("w:bookmarkEnd")
    start.set(qn("w:id"), "bad" if structure == "bookmark-id" else "42")
    start.set(qn("w:name"), "Evidence")
    end.set(qn("w:id"), "42")
    if structure == "bookmark-reversed":
        p._p.append(end)
        p._p.append(start)
    else:
        p._p.append(start)
        if structure != "bookmark-unpaired":
            p._p.append(end)
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
if options.get("grouped"):
    from copy import deepcopy
    p._p.addnext(deepcopy(p._p))
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

async function openPointAudit(page: Page, fixture: SpacingFixture) {
  const response = await page.request.post('/api/audit', {
    multipart: { file: fixture.file, custom_profile: JSON.stringify(fixture.profile) }, timeout: 90_000,
  })
  expect(response.ok(), await response.text()).toBe(true)
  const auditId = (await response.json()).audit_id as string
  const before = await (await page.request.get(`/api/audit/${auditId}`)).json()
  await page.goto(`/audit/${auditId}`)
  return { auditId, before }
}

async function pointReportText(page: Page, auditId: string, fixture: { python: string; backendDir: string }) {
  const report = await page.request.get(`/api/audit/${auditId}/export-pdf`)
  expect(report.ok(), await report.text()).toBe(true)
  return execFileSync(fixture.python, ['-B', '-c', `
import io, sys
from pypdf import PdfReader
reader = PdfReader(io.BytesIO(sys.stdin.buffer.read()))
print("\\n".join(page.extract_text() or "" for page in reader.pages))
`], { cwd: fixture.backendDir, encoding: 'utf8', input: await report.body() })
}

function semanticPointValue(value: string) {
  const token = value.replace(/^Required and proposed:\s*/, '').trim()
  const match = /^([0-9]+)(?:\.([0-9]+))?\s*pt$/i.exec(token)
  if (!match) throw new Error(`Invalid point value: ${value}`)
  const whole = match[1].replace(/^0+(?=\d)/, '')
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

async function reviewPointSelection(
  page: Page, fixture: SpacingFixture,
  targets: { side: 'before' | 'after'; paragraph: number }[],
) {
  await openGuidedFixes(page)
  for (const { side, paragraph } of targets) {
    await page.getByRole('checkbox', {
      name: new RegExp(`Space ${side} the paragraph does not match, .*paragraph ${paragraph}`, 'i'),
    }).check()
  }
  await page.getByRole('button', {
    name: `Review ${targets.length} selected chang${targets.length === 1 ? 'e' : 'es'}`, exact: true,
  }).click()
  await page.locator('#guided-fixes-file-input').setInputFiles(fixture.file)
  await page.getByRole('button', { name: 'Review safety and locations', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Guided Fixes — review confirmed changes' })).toBeVisible({ timeout: 60_000 })
}

type FontCase = {
  family?: boolean
  size?: number
  pointBefore?: number
  justify?: boolean
  grouped?: boolean
  unsafe?: 'character' | 'paragraph' | 'base' | 'defaults' | 'theme' | 'script' | 'mixed-slots' | 'non-ascii'
}

type FontFixture = {
  docx: string
  profile: object
  backendDir: string
  python: string
  file: { name: string; mimeType: string; buffer: Buffer }
}

type FontAuditSnapshot = {
  weighted_score: number
  violations: { rule_code: string; severity: string; location: unknown; expected_value: string | null; actual_value: string | null }[]
  score_breakdown: { category: string; deduction: number }[]
}

/** Only these newly constructed synthetic documents have inherited font evidence
 * removed. Uploaded originals are never normalized to manufacture eligibility. */
function fontFixture(options: FontCase = { family: true }) {
  const backendDir = path.resolve(process.cwd(), '..', 'backend')
  const python = path.join(backendDir, '.venv', 'Scripts', 'python.exe')
  const fixture = JSON.parse(execFileSync(python, ['-B', '-c', `
import base64, io, json, sys
from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt
from app.services.profile_schema import new_custom_profile
options = json.load(sys.stdin)
doc = Document()
for properties in doc.styles.element.iter():
    if properties.tag in {qn("w:rPr"), qn("w:pPr")}:
        for child in list(properties):
            if child.tag in {qn("w:" + name) for name in ("rFonts", "sz", "szCs", "cs", "rtl", "bidi", "lang", "eastAsianLayout", "oMath")}:
                properties.remove(child)
p = doc.add_paragraph()
texts = ["Ordinary ASCII academic prose with direct font evidence."]
if options.get("grouped"):
    texts = ["Ordinary ASCII academic prose ", "with a second directly formatted run."]
for text in texts:
    run = p.add_run(text)
    run.font.name = "Calibri"
    run.font.size = Pt(11)
    run._r.rPr.rFonts.set(qn("w:eastAsia"), "Calibri")
if options.get("pointBefore") is not None:
    p.paragraph_format.space_before = Pt(20)
if options.get("justify"):
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
sibling = doc.add_paragraph("An unselected paragraph retains every original property.")
sibling.runs[0].font.name = "Times New Roman"
sibling.runs[0].font.size = Pt(options.get("size") or 12)
sibling.runs[0].font.italic = True
unsafe = options.get("unsafe")
run = p.runs[-1]
if unsafe in {"character", "paragraph", "base", "defaults"}:
    if unsafe == "character":
        style = doc.styles.add_style("FontEvidenceCharacter", WD_STYLE_TYPE.CHARACTER)
        run.style = style
        properties = style.element.get_or_add_rPr()
    elif unsafe in {"paragraph", "base"}:
        style = doc.styles.add_style("FontEvidenceParagraph", WD_STYLE_TYPE.PARAGRAPH)
        style.base_style = doc.styles["Normal"]
        p.style = style
        if unsafe == "base":
            base = doc.styles.add_style("FontEvidenceBase", WD_STYLE_TYPE.PARAGRAPH)
            base.base_style = doc.styles["Normal"]
            style.base_style = base
            style = base
        properties = style.element.get_or_add_rPr()
    else:
        defaults = doc.styles.element.find(qn("w:docDefaults"))
        holder = defaults.find(qn("w:rPrDefault"))
        properties = holder.find(qn("w:rPr"))
    fonts = OxmlElement("w:rFonts")
    fonts.set(qn("w:cs"), "Courier New")
    properties.append(fonts)
    for name, value in (("cs", "1"), ("szCs", "44")):
        element = OxmlElement("w:" + name)
        element.set(qn("w:val"), value)
        properties.append(element)
elif unsafe == "theme":
    run._r.rPr.rFonts.set(qn("w:cstheme"), "majorBidi")
elif unsafe == "script":
    flag = OxmlElement("w:cs")
    flag.set(qn("w:val"), "0")
    run._r.rPr.append(flag)
elif unsafe == "mixed-slots":
    run._r.rPr.rFonts.set(qn("w:hAnsi"), "Arial")
elif unsafe == "non-ascii":
    run.text += " café"
profile = new_custom_profile("Strict direct font browser proof")
if options.get("family"):
    profile.body.font_family = "Times New Roman"
if options.get("size") is not None:
    profile.body.font_size_pt = options["size"]
if options.get("pointBefore") is not None:
    profile.body.space_before_pt = options["pointBefore"]
if options.get("justify"):
    profile.body.alignment = "justify"
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
      name: 'direct-font-evidence.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from(fixture.docx, 'base64'),
    },
  }
}

async function openFontAudit(page: Page, fixture = fontFixture()) {
  const response = await page.request.post('/api/audit', {
    multipart: { file: fixture.file, custom_profile: JSON.stringify(fixture.profile) }, timeout: 90_000,
  })
  expect(response.ok(), await response.text()).toBe(true)
  const auditId = (await response.json()).audit_id as string
  const auditBefore = await (await page.request.get(`/api/audit/${auditId}`)).json() as FontAuditSnapshot
  await page.goto(`/audit/${auditId}`)
  return { auditId, fixture, auditBefore }
}

async function fontScreenshot(page: Page) {
  if (page.viewportSize() !== null) return page.screenshot()
  // Native zoom needs the physical browser viewport, not a CSS-sized capture clip.
  const cdp = await page.context().newCDPSession(page)
  try {
    await page.bringToFront()
    const viewport = await page.evaluate(() => ({ innerWidth, innerHeight, devicePixelRatio }))
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png', fromSurface: false, captureBeyondViewport: false,
    })
    const image = Buffer.from(data, 'base64')
    expect(Math.abs(image.readUInt32BE(16) - viewport.innerWidth * viewport.devicePixelRatio)).toBeLessThanOrEqual(1)
    expect(Math.abs(image.readUInt32BE(20) - viewport.innerHeight * viewport.devicePixelRatio)).toBeLessThanOrEqual(1)
    return image
  } finally {
    await cdp.detach()
  }
}

async function fontEvidence(page: Page, testInfo: TestInfo, state: string) {
  const axe = await new AxeBuilder({ page }).analyze()
  const bounds = await page.getByRole('dialog').evaluate(dialog => ({
    innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    focus: document.activeElement?.outerHTML,
    controls: Array.from(dialog.querySelectorAll('button,input')).filter(node => node.getClientRects().length).map(node => {
      const rect = node.getBoundingClientRect()
      return { name: node.getAttribute('aria-label') || node.textContent?.trim(),
        left: rect.left, right: rect.right, textFits: node.scrollWidth <= node.clientWidth + 1 }
    }),
    scrollContainers: Array.from(dialog.querySelectorAll('*')).filter(node => /auto|scroll/.test(getComputedStyle(node).overflowY))
      .map(node => ({ tag: node.tagName, className: node.className, tabIndex: (node as HTMLElement).tabIndex,
        label: node.getAttribute('aria-label'), overflowY: getComputedStyle(node).overflowY,
        clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop,
        clientWidth: node.clientWidth, scrollWidth: node.scrollWidth })),
    announcements: Array.from(dialog.querySelectorAll('[role="status"],[role="alert"],[aria-live]')).map(node => node.textContent),
  }))
  const renderedContrast = await page.getByRole('dialog').evaluate(dialog => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const pixels = context.getImageData(0, 0, 1, 1).data
      return [pixels[0], pixels[1], pixels[2], pixels[3] / 255]
    }
    const composite = (front: number[], back: number[]) => {
      const alpha = front[3] + back[3] * (1 - front[3])
      return [0, 1, 2].map(index => alpha === 0 ? 0 :
        (front[index] * front[3] + back[index] * back[3] * (1 - front[3])) / alpha).concat(alpha)
    }
    const luminance = (color: number[]) => {
      const channels = color.slice(0, 3).map(value => {
        const normalized = value / 255
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
      })
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
    }
    return Array.from(dialog.querySelectorAll<HTMLElement>('*'))
      .filter(node => node.getClientRects().length && Array.from(node.childNodes).some(child => child.nodeType === Node.TEXT_NODE && child.textContent?.trim()))
      .map(node => {
        const style = getComputedStyle(node)
        const layers = []
        for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
          const computed = getComputedStyle(ancestor)
          layers.push({ color: computed.backgroundColor, opacity: computed.opacity, image: computed.backgroundImage })
        }
        let background = [0, 0, 0, 0], foreground = rgba(style.color)
        for (const layer of layers) {
          const color = rgba(layer.color)
          background = composite(background, color)
          foreground = composite(foreground, color)
          background[3] *= Number(layer.opacity)
          foreground[3] *= Number(layer.opacity)
        }
        background = composite(background, [255, 255, 255, 1]).slice(0, 3)
        foreground = composite(foreground, [255, 255, 255, 1]).slice(0, 3)
        const light = luminance(foreground), dark = luminance(background)
        const rect = node.getBoundingClientRect()
        const fontSize = parseFloat(style.fontSize), fontWeight = parseFloat(style.fontWeight)
        const minimum = fontSize >= 24 || (fontSize >= 18.6667 && fontWeight >= 700) ? 3 : 4.5
        return { text: node.textContent?.trim(), tag: node.tagName, disabled: Boolean(node.closest(':disabled,[aria-disabled="true"]')),
          foregroundCss: style.color, foreground, background, layers, fontSize, fontWeight,
          contrastRatio: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05), minimum,
          visibleInViewport: rect.bottom > 0 && rect.top < innerHeight,
          bounds: rect.toJSON(),
          fullyResolved: layers.every(layer => layer.image === 'none'),
          method: 'Browser-resolved CSS colors sampled through canvas sRGB; ancestor background alpha and group opacity composited; screenshot paired. Background images recorded, axe remains authoritative.' }
      })
  })
  await testInfo.attach(`${state}-rendered-contrast.json`, {
    body: JSON.stringify({ samples: renderedContrast, screenshot: `${state}.png` }, null, 2), contentType: 'application/json',
  })
  await testInfo.attach(`${state}-accessibility.json`, {
    body: JSON.stringify({ bounds, violations: axe.violations, incomplete: axe.incomplete,
      contrast: { violations: axe.violations.filter(item => item.id === 'color-contrast'),
        incomplete: axe.incomplete.filter(item => item.id === 'color-contrast') } }, null, 2),
    contentType: 'application/json',
  })
  await testInfo.attach(`${state}.png`, { body: await fontScreenshot(page), contentType: 'image/png' })
  expect(axe.violations.filter(item => item.impact === 'critical' || item.impact === 'serious')).toEqual([])
  expect(axe.violations.filter(item => item.id === 'scrollable-region-focusable')).toEqual([])
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1)
  for (const control of bounds.controls) {
    expect(control.left).toBeGreaterThanOrEqual(-1)
    expect(control.right).toBeLessThanOrEqual(bounds.clientWidth + 1)
    expect(control.textFits).toBe(true)
  }
  return bounds
}

async function selectFontChanges(page: Page, fixture: FontFixture, options: FontCase, testInfo?: TestInfo) {
  await tabTo(page, page.getByRole('button', { name: 'Guided Fixes' }))
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: /Review .* selected chang(e|es)/ })).toBeVisible()
  for (const label of [options.family && 'Font family does not match', options.size !== undefined && 'Font size does not match'].filter(Boolean)) {
    const checkbox = page.getByRole('checkbox', { name: new RegExp(`${label}, .*paragraph 1`, 'i') })
    await tabTo(page, checkbox)
    await page.keyboard.press('Space')
    await expect(checkbox).toBeChecked()
  }
  if (testInfo) await fontEvidence(page, testInfo, `font-${options.family ? 'family' : 'size'}${options.grouped ? '-grouped' : ''}-candidate`)
  await tabTo(page, page.getByRole('button', { name: /Review [12] selected chang/ }))
  await page.keyboard.press('Enter')
  await page.locator('#guided-fixes-file-input').setInputFiles(fixture.file)
  await tabTo(page, page.getByRole('button', { name: 'Review safety and locations', exact: true }))
}

async function proveFontDownload(page: Page, testInfo: TestInfo, auditId: string, fixture: FontFixture, options: FontCase, originalAudit: FontAuditSnapshot) {
  const downloads: string[] = []
  const requests: string[] = []
  page.on('download', event => downloads.push(event.suggestedFilename()))
  page.on('request', request => {
    if (request.url().includes(`/api/audit/${auditId}/guided-fixes/download/`)) requests.push(request.url())
  })
  const downloadButton = page.getByRole('button', { name: 'Download corrected document', exact: true })
  const downloadRoute = new RegExp(`/api/audit/${auditId}/guided-fixes/download/`)
  await page.route(downloadRoute, async route => {
    const response = await route.fetch()
    await expect(page.getByRole('button', { name: 'Downloading…', exact: true })).toBeDisabled()
    await testInfo.attach('font-download-pending.png', { body: await fontScreenshot(page), contentType: 'image/png' })
    await route.fulfill({ response })
  })
  await tabTo(page, downloadButton)
  const pending = page.waitForEvent('download')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  const download = await pending
  await page.unroute(downloadRoute)
  const stream = await download.createReadStream()
  if (!stream) throw new Error('Verified font output was not readable')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  const corrected = Buffer.concat(chunks)
  await expect(downloadButton).toBeDisabled()
  expect(downloads).toEqual(['direct-font-evidence_ACA-fixed.docx'])
  expect(requests).toHaveLength(1)
  expect((await page.request.get(requests[0])).status()).toBe(410)
  await testInfo.attach('font-download-completed.png', { body: await fontScreenshot(page), contentType: 'image/png' })
  const inspected = JSON.parse(execFileSync(fixture.python, ['-B', '-c', `
import base64, hashlib, io, json, sys, zipfile
from decimal import Decimal
from lxml import etree
data = json.load(sys.stdin)
source, output = [base64.b64decode(data[key]) for key in ("source", "output")]
ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
options = data["options"]
with zipfile.ZipFile(io.BytesIO(source)) as a, zipfile.ZipFile(io.BytesIO(output)) as b:
    assert set(a.namelist()) == set(b.namelist())
    changed = [name for name in a.namelist() if a.read(name) != b.read(name)]
    assert set(changed) <= {"word/document.xml", "docProps/core.xml", "docProps/app.xml"}
    old, new = [etree.fromstring(z.read("word/document.xml")) for z in (a, b)]
    old_runs, new_runs = [root.findall("w:body/w:p", ns)[0].findall("w:r", ns) for root in (old, new)]
    assert len(old_runs) == len(new_runs) == (2 if options.get("grouped") else 1)
    raw = []
    for original, saved in zip(old_runs, new_runs):
        properties = {}
        if options.get("family"):
            old_fonts, new_fonts = [run.find("w:rPr/w:rFonts", ns) for run in (original, saved)]
            for slot in ("ascii", "hAnsi", "eastAsia"):
                attr = "{%s}%s" % (ns["w"], slot)
                assert new_fonts.get(attr) == "Times New Roman"
                properties[slot] = new_fonts.get(attr)
                new_fonts.set(attr, old_fonts.get(attr))
        if options.get("size") is not None:
            old_size, new_size = [run.find("w:rPr/w:sz", ns) for run in (original, saved)]
            attr = "{%s}val" % ns["w"]
            expected = Decimal(str(options["size"])) * 2
            assert expected == expected.to_integral_value()
            assert new_size.get(attr) == str(int(expected))
            properties["sz"] = new_size.get(attr)
            new_size.set(attr, old_size.get(attr))
        raw.append(properties)
    assert etree.tostring(old, method="c14n") == etree.tostring(new, method="c14n")
print(json.dumps({"source_sha256": hashlib.sha256(source).hexdigest(),
 "corrected_sha256": hashlib.sha256(output).hexdigest(), "runs": raw, "changed_parts": changed}))
`], { cwd: fixture.backendDir, encoding: 'utf8', input: JSON.stringify({
    source: fixture.docx, output: corrected.toString('base64'), options,
  }) }))
  expect(inspected.source_sha256).toBe(createHash('sha256').update(fixture.file.buffer).digest('hex'))
  expect(inspected.corrected_sha256).not.toBe(inspected.source_sha256)
  await testInfo.attach('font-package-proof.json', { body: JSON.stringify(inspected, null, 2), contentType: 'application/json' })
  await testInfo.attach('font-download-log.json', { body: JSON.stringify({ downloads, requests, oneUseStatus: 410 }, null, 2), contentType: 'application/json' })
  await testInfo.attach('font-original.docx', { body: fixture.file.buffer, contentType: fixture.file.mimeType })
  await testInfo.attach('font-corrected.docx', { body: corrected, contentType: fixture.file.mimeType })
  expect(await (await page.request.get(`/api/audit/${auditId}`)).json()).toEqual(originalAudit)
  const reaudit = await page.request.post('/api/audit', {
    multipart: { file: { ...fixture.file, buffer: corrected }, custom_profile: JSON.stringify(fixture.profile) }, timeout: 90_000,
  })
  expect(reaudit.ok(), await reaudit.text()).toBe(true)
  const result = await reaudit.json()
  const codes = [options.family && 'FONT_CONSISTENCY', options.size !== undefined && 'FONT_SIZE']
  expect(result.physical_layout_errors.filter((finding: { rule_code: string }) => codes.includes(finding.rule_code))).toEqual([])
  const saved = await (await page.request.get(`/api/audit/${result.audit_id}`)).json() as FontAuditSnapshot
  const untouched = [saved, originalAudit].map(audit => audit.violations.filter(finding => !codes.includes(finding.rule_code))
    .map(({ rule_code, severity, location, expected_value, actual_value }) =>
      JSON.stringify({ rule_code, severity, location, expected_value, actual_value })).sort())
  expect(untouched[0]).toEqual(untouched[1])
  expect(saved.weighted_score).toBeGreaterThanOrEqual(originalAudit.weighted_score)
  for (const row of saved.score_breakdown) {
    expect(row.deduction).toBeLessThanOrEqual(originalAudit.score_breakdown.find(before => before.category === row.category)?.deduction ?? 0)
  }
  await testInfo.attach('font-independent-reaudit.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
}

async function tabTo(page: Page, target: Locator, keyLog?: object[]) {
  for (let i = 0; i < 100; i++) {
    if ((!keyLog || i > 0) && await target.evaluate(element => element === document.activeElement)) {
      await expect(target).toBeVisible()
      expect(await target.evaluate(element => element.matches(':focus-visible'))).toBe(true)
      return
    }
    await page.keyboard.press('Tab')
    if (keyLog) keyLog.push(await page.evaluate(() => ({
      key: 'Tab', active: document.activeElement?.outerHTML,
      inDialog: Boolean(document.activeElement?.closest('[role="dialog"]')),
      visible: Boolean(document.activeElement?.getClientRects().length),
    })))
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

type ReviewScrollState = {
  overflowY: string
  clientHeight: number
  scrollHeight: number
  scrollTop: number
  maximum: number
  focused: boolean
  active: string | undefined
}

const reviewScrollSelector = '[role="dialog"][aria-label="Guided Fixes — review confirmed changes"] > div.overflow-y-auto'

async function reviewKeyboardEvidence(page: Page, testInfo: TestInfo, state: string, requireOverflow = false) {
  const dialog = page.getByRole('dialog', { name: 'Guided Fixes — review confirmed changes', exact: true })
  const body = page.locator(reviewScrollSelector)
  const cancelSafety = dialog.getByRole('button', { name: 'Cancel safety review', exact: true })
  const cancel = dialog.getByRole('button', { name: 'Cancel review', exact: true })
  const apply = dialog.getByRole('button', { name: 'Apply and verify changes', exact: true })
  const snapshot = (): Promise<ReviewScrollState> => body.evaluate(element => ({
    overflowY: getComputedStyle(element).overflowY, clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight, scrollTop: element.scrollTop,
    maximum: element.scrollHeight - element.clientHeight,
    focused: element === document.activeElement,
    active: document.activeElement?.outerHTML,
  }))
  const keys: object[] = []
  const press = async (key: string, assertion: (before: ReviewScrollState) => Promise<void>) => {
    const before = await snapshot()
    await page.keyboard.press(key)
    // Observe the native scroll finishing, rather than replacing it with a DOM scroll.
    await body.evaluate(element => new Promise<void>(resolve => {
      let previous = element.scrollTop, stable = 0, frames = 0
      const frame = () => {
        stable = element.scrollTop === previous ? stable + 1 : 0
        previous = element.scrollTop
        if ((stable >= 4 && frames >= 12) || frames++ >= 120) resolve()
        else requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    }))
    const entry = { key, before, after: await snapshot(), passed: false }
    keys.push(entry)
    await assertion(before)
    entry.passed = true
  }
  try {
    const dimensions = await snapshot()
    expect(['auto', 'scroll']).toContain(dimensions.overflowY)
    if (requireOverflow) expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight)
    await testInfo.attach(`${state}-review-initial.png`, { body: await fontScreenshot(page), contentType: 'image/png' })
    await tabTo(page, cancelSafety)
    await press('Tab', async () => { await expect(body).toBeFocused() })
    const ring = await body.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      const ancestors = []
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const computed = getComputedStyle(ancestor)
        if (/(hidden|clip|auto|scroll)/.test(`${computed.overflowX} ${computed.overflowY}`)) {
          const bounds = ancestor.getBoundingClientRect()
          clip.left = Math.max(clip.left, bounds.left)
          clip.top = Math.max(clip.top, bounds.top)
          clip.right = Math.min(clip.right, bounds.right)
          clip.bottom = Math.min(clip.bottom, bounds.bottom)
          ancestors.push({ tag: ancestor.tagName, overflow: computed.overflow, bounds: bounds.toJSON() })
        }
      }
      return { focusVisible: element.matches(':focus-visible'), shadow: style.boxShadow,
        ringColor: style.getPropertyValue('--tw-ring-color'), rect: rect.toJSON(), clip, ancestors }
    })
    await testInfo.attach(`${state}-review-focus-ring.json`, { body: JSON.stringify(ring, null, 2), contentType: 'application/json' })
    await testInfo.attach(`${state}-review-body-focused.png`, { body: await fontScreenshot(page), contentType: 'image/png' })
    expect(ring.focusVisible).toBe(true)
    expect(ring.shadow).toContain('inset')
    expect(ring.shadow).not.toBe('none')
    expect(ring.shadow).toMatch(/(?:2px[^,]*inset|inset[^,]*2px)/)
    expect(ring.ringColor.trim()).not.toBe('')
    expect(ring.ringColor).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/)
    expect(ring.rect.left).toBeGreaterThanOrEqual(ring.clip.left - 1)
    expect(ring.rect.top).toBeGreaterThanOrEqual(ring.clip.top - 1)
    expect(ring.rect.right).toBeLessThanOrEqual(ring.clip.right + 1)
    expect(ring.rect.bottom).toBeLessThanOrEqual(ring.clip.bottom + 1)
    if (dimensions.maximum > 0) {
      await press('Home', async () => { expect((await snapshot()).scrollTop).toBe(0) })
      await press('ArrowDown', async before => { expect((await snapshot()).scrollTop).toBeGreaterThan(before.scrollTop) })
      await press('Home', async () => { expect((await snapshot()).scrollTop).toBe(0) })
      await press('PageDown', async before => { expect((await snapshot()).scrollTop).toBeGreaterThan(before.scrollTop) })
      await press('End', async () => { const after = await snapshot(); expect(Math.abs(after.scrollTop - after.maximum)).toBeLessThanOrEqual(1) })
      await press('ArrowUp', async before => { expect((await snapshot()).scrollTop).toBeLessThan(before.scrollTop) })
      await press('End', async () => { const after = await snapshot(); expect(Math.abs(after.scrollTop - after.maximum)).toBeLessThanOrEqual(1) })
      await press('PageUp', async before => { expect((await snapshot()).scrollTop).toBeLessThan(before.scrollTop) })
      await press('Home', async () => { expect((await snapshot()).scrollTop).toBe(0) })
    }
    await press('Tab', async () => { await expect(cancel).toBeFocused() })
    await press('Shift+Tab', async () => { await expect(body).toBeFocused() })
    await press('Tab', async () => { await expect(cancel).toBeFocused() })
    await press('Tab', async () => { await expect(apply).toBeFocused() })
    await press('Tab', async () => { await expect(cancelSafety).toBeFocused() })
    await press('Shift+Tab', async () => { await expect(apply).toBeFocused() })
    const axe = await new AxeBuilder({ page }).analyze()
    await testInfo.attach(`${state}-review-keyboard-axe.json`, { body: JSON.stringify(axe, null, 2), contentType: 'application/json' })
    expect(axe.violations.filter(item => item.id === 'scrollable-region-focusable')).toEqual([])
    expect(axe.violations.filter(item => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
    return dimensions
  } finally {
    await testInfo.attach(`${state}-review-key-log.json`, {
      body: JSON.stringify({ selector: reviewScrollSelector, final: await snapshot(), keys }, null, 2), contentType: 'application/json',
    })
  }
}

test.describe('guided fixes workflow @guided-fixes', () => {
  test('Review scroll body keyboard access preserves dialog workflow @review-scroll-accessibility', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 768, height: 600 })
    const options: FontCase = { family: true, size: 12, grouped: true }
    const fixture = fontFixture(options)
    const { auditId, auditBefore } = await openFontAudit(page, fixture)
    const opener = page.getByRole('button', { name: /^Guided Fixes/ })
    await selectFontChanges(page, fixture, options)
    let reviewEntry = 0
    const openReview = async () => {
      await tabTo(page, page.getByRole('button', { name: 'Review safety and locations', exact: true }))
      await page.keyboard.press('Enter')
      await expect(page.getByRole('dialog', { name: 'Guided Fixes — review confirmed changes', exact: true })).toBeVisible({ timeout: 60_000 })
      const entry = ++reviewEntry
      const initial = await page.evaluate(() => ({
        active: document.activeElement?.outerHTML,
        inDialog: Boolean(document.activeElement?.closest('[role="dialog"]')),
      }))
      await testInfo.attach(`review-entry-${entry}-initial-focus.json`, {
        body: JSON.stringify(initial, null, 2), contentType: 'application/json',
      })
      const cancelSafety = page.getByRole('button', { name: 'Cancel safety review', exact: true })
      if (!initial.inDialog) {
        await page.keyboard.press('Tab')
        const firstTab = await page.evaluate(() => ({
          key: 'Tab', active: document.activeElement?.outerHTML,
          inDialog: Boolean(document.activeElement?.closest('[role="dialog"]')),
        }))
        await testInfo.attach(`review-entry-${entry}-first-tab.json`, {
          body: JSON.stringify(firstTab, null, 2), contentType: 'application/json',
        })
        expect(firstTab.inDialog).toBe(true)
        await expect(cancelSafety).toBeFocused()
      }
      await tabTo(page, cancelSafety)
    }
    await openReview()
    await reviewKeyboardEvidence(page, testInfo, 'overflow', true)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Review safety and locations', exact: true })).toBeVisible()
    await openReview()
    await tabTo(page, page.getByRole('button', { name: 'Cancel review', exact: true }))
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Review safety and locations', exact: true })).toBeVisible()
    await tabTo(page, page.getByRole('button', { name: 'Back to findings', exact: true }).last())
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Review 2 selected changes', exact: true })).toBeEnabled()
    await page.keyboard.press('Escape')
    await expect(opener).toBeFocused()
    await page.setViewportSize({ width: 1920, height: 1080 })
    await selectFontChanges(page, fixture, options)
    await openReview()
    const desktop = await reviewKeyboardEvidence(page, testInfo, 'desktop')
    expect(desktop.scrollHeight).toBeLessThanOrEqual(desktop.clientHeight)
    await page.setViewportSize({ width: 768, height: 600 })
    await tabTo(page, page.getByRole('button', { name: 'Apply and verify changes', exact: true }))
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed', exact: true })).toBeVisible({ timeout: 60_000 })
    await fontEvidence(page, testInfo, 'keyboard-regression-verified')
    await proveFontDownload(page, testInfo, auditId, fixture, options, auditBefore)
    await tabTo(page, page.getByRole('button', { name: 'Close', exact: true }))
    await page.keyboard.press('Enter')
    await expect(opener).toBeFocused()
  })

  for (const options of [{ before: 6 }, { after: 0 }, { before: 6, after: 0 }, { before: 0 }, { before: 6.05 }, { after: 6.05 }, { before: 6.1 }, { after: 6.1 }, { before: 6.05, after: 6.1 }]) {
    test(`point decimal ${JSON.stringify(options)} completes keyboard Review Apply Download with exact package proof`, async ({ page, baseURL }, testInfo) => {
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
      const historyBefore = await (await page.request.get('/api/audits')).json()
      const reportBefore = await pointReportText(page, auditId, fixture)
      await page.goto(`/audit/${auditId}`)
      const opener = page.getByRole('button', { name: /^Guided Fixes/ })
      await tabTo(page, opener)
      await page.keyboard.press('Enter')
      const sides = Object.keys(options) as ('before' | 'after')[]
      const selected = page.getByRole('button', { name: `Review ${sides.length} selected chang${sides.length === 1 ? 'e' : 'es'}`, exact: true })
      for (const side of sides) {
        const checkbox = page.getByRole('checkbox', { name: new RegExp(`Space ${side} the paragraph does not match, .*paragraph 1`, 'i') })
        await tabTo(page, checkbox)
        await page.keyboard.press('Space')
        await expect(checkbox).toBeChecked()
      }
      await tabTo(page, page.getByRole('button', { name: 'Clear selection', exact: true }))
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: 'Review 0 selected changes', exact: true })).toBeDisabled()
      for (const side of sides) {
        await tabTo(page, page.getByRole('checkbox', { name: new RegExp(`Space ${side} the paragraph does not match, .*paragraph 1`, 'i') }))
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
      if (options.before === 6.05 && sides.length === 1) {
        await page.locator('#guided-fixes-file-input').setInputFiles(spacingFixture({ before: 6, structure: 'field' }).file)
        const pending = page.waitForResponse(response => new URL(response.url()).pathname === `/api/audit/${auditId}/guided-fixes/review`)
        await page.getByRole('button', { name: 'Review safety and locations', exact: true }).click()
        const rejected = await pending
        expect(rejected.status()).toBe(409)
        const body = await rejected.json()
        expect(body).not.toHaveProperty('review_id')
        expect(body).not.toHaveProperty('download_token')
        await expect(page.getByRole('alert')).toContainText(MISMATCH_TEXT)
        await expect(page.getByRole('button', { name: 'Apply and verify changes', exact: true })).toHaveCount(0)
        await testInfo.attach('point-decimal-wrong-original.png', { body: await page.screenshot(), contentType: 'image/png' })
        expect(await (await page.request.get(`/api/audit/${auditId}`)).json()).toEqual(before)
      }
      await page.locator('#guided-fixes-file-input').setInputFiles(fixture.file)
      await tabTo(page, page.getByRole('button', { name: 'Review safety and locations', exact: true }))
      await page.keyboard.press('Enter')
      const review = page.getByRole('dialog', { name: 'Guided Fixes — review confirmed changes' })
      await expect(review).toBeVisible({ timeout: 60_000 })
      const persistedExpected: string[] = []
      for (const side of sides) {
        await expect(review.getByText(`Property to change: space ${side}`, { exact: true })).toBeVisible()
        const finding = before.violations.find((item: { rule_code: string }) => item.rule_code === `SPACE_${side.toUpperCase()}`)
        expect(finding?.expected_value).toBeTruthy()
        persistedExpected.push(finding.expected_value)
      }
      const proposedValues = review.getByText(/^Required and proposed:/)
      await expect(proposedValues).toHaveCount(sides.length)
      for (const value of await proposedValues.all()) await expect(value).toBeVisible()
      expect((await proposedValues.allTextContents()).map(semanticPointValue).sort())
        .toEqual(persistedExpected.map(semanticPointValue).sort())
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
from decimal import Decimal
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
        numerator, denominator = Decimal(str(points)).as_integer_ratio()
        twips, remainder = divmod(numerator * 20, denominator)
        assert remainder == 0
        assert saved.get(name) == str(twips)
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
      expect(await (await page.request.get('/api/audits')).json()).toEqual(historyBefore)
      expect(await pointReportText(page, auditId, fixture)).toBe(reportBefore)
      const reaudit = await page.request.post('/api/audit', {
        multipart: { file: { ...fixture.file, buffer: corrected }, custom_profile: JSON.stringify(fixture.profile) }, timeout: 90_000,
      })
      expect(reaudit.ok(), await reaudit.text()).toBe(true)
      const after = await reaudit.json()
      const codes = sides.map(side => `SPACE_${side.toUpperCase()}`)
      expect(after.physical_layout_errors.filter((finding: { rule_code: string }) => codes.includes(finding.rule_code))).toEqual([])
      const reauditSaved = await (await page.request.get(`/api/audit/${after.audit_id}`)).json() as FontAuditSnapshot
      const untouched = [reauditSaved, before as FontAuditSnapshot].map(audit => audit.violations
        .filter(finding => !codes.includes(finding.rule_code))
        .map(({ rule_code, severity, location, expected_value, actual_value }) =>
          JSON.stringify({ rule_code, severity, location, expected_value, actual_value })).sort())
      expect(untouched[0]).toEqual(untouched[1])
      expect(reauditSaved.weighted_score).toBeGreaterThanOrEqual(before.weighted_score)
      for (const row of reauditSaved.score_breakdown) {
        expect(row.deduction).toBeLessThanOrEqual(before.score_breakdown.find((prior: { category: string }) => prior.category === row.category)?.deduction ?? 0)
      }
      await testInfo.attach('point-decimal-independent-reaudit.json', { body: JSON.stringify(after, null, 2), contentType: 'application/json' })
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

  test('point decimal supported mixed spacing font and alignment selection', async ({ page }, testInfo) => {
    const options = { family: true, size: 12, pointBefore: 6.05, justify: true }
    const fixture = fontFixture(options)
    const digest = createHash('sha256').update(fixture.file.buffer).digest('hex')
    const { auditId, auditBefore } = await openFontAudit(page, fixture)
    const historyBefore = await (await page.request.get('/api/audits')).json()
    const reportBefore = await pointReportText(page, auditId, fixture)
    const codes = ['SPACE_BEFORE', 'FONT_SIZE', 'FONT_CONSISTENCY', 'ALIGNMENT']
    expect(auditBefore.violations.filter(finding => codes.includes(finding.rule_code))).toHaveLength(4)
    await openGuidedFixes(page)
    for (const label of [
      'Space before the paragraph does not match', 'Font size does not match',
      'Font family does not match', 'Paragraph alignment does not match',
    ]) {
      await page.getByRole('checkbox', { name: new RegExp(`${label}, .*paragraph 1`, 'i') }).check()
    }
    await page.getByRole('button', { name: 'Review 4 selected changes', exact: true }).click()
    await page.locator('#guided-fixes-file-input').setInputFiles(fixture.file)
    await page.getByRole('button', { name: 'Review safety and locations', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Guided Fixes — review confirmed changes' })).toBeVisible({ timeout: 60_000 })
    const pending = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/audit/${auditId}/guided-fixes`)
    await page.getByRole('button', { name: 'Apply and verify changes', exact: true }).click()
    const applied = await (await pending).json()
    expect(applied.status).toBe('passed')
    await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed', exact: true })).toBeVisible({ timeout: 60_000 })
    const downloading = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download corrected document', exact: true }).click()
    const stream = await (await downloading).createReadStream()
    if (!stream) throw new Error('Mixed corrected copy was not readable')
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    const corrected = Buffer.concat(chunks)
    const proof = JSON.parse(execFileSync(fixture.python, ['-B', '-c', `
import base64, hashlib, io, json, sys, zipfile
from decimal import Decimal
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from app.services.docx_preservation import compare_preservation
data = json.load(sys.stdin)
source, output = [base64.b64decode(data[key]) for key in ("source", "output")]
with zipfile.ZipFile(io.BytesIO(source)) as old, zipfile.ZipFile(io.BytesIO(output)) as new:
    assert set(old.namelist()) == set(new.namelist())
    assert old.read("word/_rels/document.xml.rels") == new.read("word/_rels/document.xml.rels")
original, corrected = [Document(io.BytesIO(value)) for value in (source, output)]
p, result = original.paragraphs[0], corrected.paragraphs[0]
numerator, denominator = Decimal(str(data["required"])).as_integer_ratio()
twips, remainder = divmod(numerator * 20, denominator)
assert remainder == 0 and result._p.pPr.find(qn("w:spacing")).get(qn("w:before")) == str(twips)
assert result.runs[0].font.name == "Times New Roman" and result.runs[0].font.size.pt == 12
assert result.alignment == WD_ALIGN_PARAGRAPH.JUSTIFY
assert p.text == result.text and [run.text for run in p.runs] == [run.text for run in result.runs]
compare_preservation(source, output, {(0, None, "SPACE_BEFORE"), (0, None, "ALIGNMENT"),
                                      (0, 0, "FONT_SIZE"), (0, 0, "FONT_CONSISTENCY")})
print(json.dumps({"source_sha256": hashlib.sha256(source).hexdigest(), "raw_before": str(twips)}))
`], { cwd: fixture.backendDir, encoding: 'utf8', input: JSON.stringify({
      source: fixture.docx, output: corrected.toString('base64'), required: options.pointBefore,
    }) }))
    expect(proof.source_sha256).toBe(digest)
    expect(proof.raw_before).toBe('121')
    expect(await (await page.request.get(`/api/audit/${auditId}`)).json()).toEqual(auditBefore)
    expect(await (await page.request.get('/api/audits')).json()).toEqual(historyBefore)
    expect(await pointReportText(page, auditId, fixture)).toBe(reportBefore)
    const reaudit = await page.request.post('/api/audit', {
      multipart: { file: { ...fixture.file, buffer: corrected }, custom_profile: JSON.stringify(fixture.profile) }, timeout: 90_000,
    })
    expect(reaudit.ok(), await reaudit.text()).toBe(true)
    const after = await reaudit.json()
    expect(after.physical_layout_errors.filter((finding: { rule_code: string }) => codes.includes(finding.rule_code))).toEqual([])
    await testInfo.attach('point-decimal-mixed-proof.json', { body: JSON.stringify(proof), contentType: 'application/json' })
  })

  test('point decimal grouped two paragraphs and combined before after exact output', async ({ page }, testInfo) => {
    const fixture = spacingFixture({ before: 6.05, after: 6.1, grouped: true })
    const digest = createHash('sha256').update(fixture.file.buffer).digest('hex')
    const created = await page.request.post('/api/audit', {
      multipart: { file: fixture.file, custom_profile: JSON.stringify(fixture.profile) }, timeout: 90_000,
    })
    expect(created.ok(), await created.text()).toBe(true)
    const auditId = (await created.json()).audit_id as string
    const before = await (await page.request.get(`/api/audit/${auditId}`)).json()
    const historyBefore = await (await page.request.get('/api/audits')).json()
    const reportBefore = await pointReportText(page, auditId, fixture)
    for (const side of ['before', 'after']) {
      expect(before.violations.filter((item: { rule_code: string }) => item.rule_code === `SPACE_${side.toUpperCase()}`)).toHaveLength(2)
    }
    await page.goto(`/audit/${auditId}`)
    await openGuidedFixes(page)
    for (const side of ['before', 'after']) {
      for (const paragraph of [1, 2]) {
        await page.getByRole('checkbox', { name: new RegExp(`Space ${side} the paragraph does not match, .*paragraph ${paragraph}`, 'i') }).check()
      }
    }
    await page.getByRole('button', { name: 'Review 4 selected changes', exact: true }).click()
    await page.locator('#guided-fixes-file-input').setInputFiles(fixture.file)
    await page.getByRole('button', { name: 'Review safety and locations', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Guided Fixes — review confirmed changes' })).toBeVisible({ timeout: 60_000 })
    const pending = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/audit/${auditId}/guided-fixes`)
    await page.getByRole('button', { name: 'Apply and verify changes', exact: true }).click()
    const applied = await (await pending).json()
    expect(applied.status).toBe('passed')
    await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed', exact: true })).toBeVisible({ timeout: 60_000 })
    const downloading = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download corrected document', exact: true }).click()
    const stream = await (await downloading).createReadStream()
    if (!stream) throw new Error('Grouped corrected copy was not readable')
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    const corrected = Buffer.concat(chunks)
    expect((await page.request.get(`/api/audit/${auditId}/guided-fixes/download/${applied.download_token}`)).status()).toBe(410)
    const proof = JSON.parse(execFileSync(fixture.python, ['-B', '-c', `
import base64, io, json, sys, zipfile
from decimal import Decimal
from lxml import etree
data = json.load(sys.stdin)
ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
with zipfile.ZipFile(io.BytesIO(base64.b64decode(data["source"]))) as a, zipfile.ZipFile(io.BytesIO(base64.b64decode(data["output"]))) as b:
    assert set(a.namelist()) == set(b.namelist())
    changed = [name for name in a.namelist() if a.read(name) != b.read(name)]
    assert set(changed) <= {"word/document.xml", "docProps/core.xml", "docProps/app.xml"}
    old, new = [etree.fromstring(z.read("word/document.xml")) for z in (a, b)]
    originals, saved = [root.findall("w:body/w:p", ns) for root in (old, new)]
    assert len(originals) == len(saved) == 2
    for original, result in zip(originals, saved):
        old_spacing = original.find("w:pPr/w:spacing", ns)
        new_spacing = result.find("w:pPr/w:spacing", ns)
        for side, value in data["required"].items():
            numerator, denominator = Decimal(str(value)).as_integer_ratio()
            twips, remainder = divmod(numerator * 20, denominator)
            assert remainder == 0
            key = "{%s}%s" % (ns["w"], side)
            assert old_spacing.get(key) == "400"
            assert new_spacing.get(key) == str(twips)
            new_spacing.set(key, old_spacing.get(key))
    assert etree.tostring(old, method="c14n") == etree.tostring(new, method="c14n")
print(json.dumps({"changed_parts": changed, "paragraphs": len(saved)}))
`], { cwd: fixture.backendDir, encoding: 'utf8', input: JSON.stringify({
      source: fixture.docx, output: corrected.toString('base64'), required: { before: 6.05, after: 6.1 },
    }) }))
    await testInfo.attach('point-decimal-grouped-proof.json', { body: JSON.stringify(proof), contentType: 'application/json' })
    expect(createHash('sha256').update(fixture.file.buffer).digest('hex')).toBe(digest)
    expect(await (await page.request.get(`/api/audit/${auditId}`)).json()).toEqual(before)
    expect(await (await page.request.get('/api/audits')).json()).toEqual(historyBefore)
    expect(await pointReportText(page, auditId, fixture)).toBe(reportBefore)
    const reaudit = await page.request.post('/api/audit', {
      multipart: { file: { ...fixture.file, buffer: corrected }, custom_profile: JSON.stringify(fixture.profile) }, timeout: 90_000,
    })
    expect(reaudit.ok(), await reaudit.text()).toBe(true)
    const after = await reaudit.json()
    expect(after.physical_layout_errors.filter((item: { rule_code: string }) => ['SPACE_BEFORE', 'SPACE_AFTER'].includes(item.rule_code))).toEqual([])
  })

  for (const side of ['before', 'after'] as const) {
    const cases: { name: string; options: SpacingCase; mayBeAbsent?: boolean }[] = [
      ...[6.00000000001, 6.025, 6.001, 0.01, 0.025, 1.333].map(value => ({
        name: `inexact ${value}`, options: { before: 6, after: 6, [side]: value },
      })),
      ...(['field', 'section', 'bookmark-id', 'bookmark-unpaired', 'bookmark-reversed'] as const).map(structure => ({
        name: structure, options: { before: 6, after: 6, structure },
      })),
      { name: 'missing direct', options: { before: 6, after: 6, missing: side }, mayBeAbsent: true },
      { name: 'inherited only', options: { before: 6, after: 6, missing: side, inherited: true }, mayBeAbsent: true },
    ]
    for (const scenario of cases) {
      test(`point decimal ${side} ${scenario.name} refuses genuine findings atomically`, async ({ page }, testInfo) => {
        const fixture = spacingFixture(scenario.options)
        const digest = createHash('sha256').update(fixture.file.buffer).digest('hex')
        const created = await page.request.post('/api/audit', {
          multipart: { file: fixture.file, custom_profile: JSON.stringify(fixture.profile) }, timeout: 90_000,
        })
        expect(created.ok(), await created.text()).toBe(true)
        const auditId = (await created.json()).audit_id as string
        const before = await (await page.request.get(`/api/audit/${auditId}`)).json()
        const selected = before.violations.filter((item: { rule_code: string }) =>
          item.rule_code === `SPACE_${side.toUpperCase()}`)
        if (scenario.mayBeAbsent && selected.length === 0) {
          expect(selected).toEqual([])
          await page.goto(`/audit/${auditId}`)
          await openGuidedFixes(page)
          await expect(page.getByRole('checkbox', { name: new RegExp(`Space ${side} the paragraph does not match`, 'i') })).toHaveCount(0)
          await testInfo.attach('point-decimal-no-finding.json', {
            body: JSON.stringify({ side, scenario: scenario.name, auditId, selected }, null, 2),
            contentType: 'application/json',
          })
          await testInfo.attach('point-decimal-no-finding.png', { body: await page.screenshot(), contentType: 'image/png' })
          expect(createHash('sha256').update(fixture.file.buffer).digest('hex')).toBe(digest)
          expect(await (await page.request.get(`/api/audit/${auditId}`)).json()).toEqual(before)
          return
        }
        expect(selected).toHaveLength(1)
        await page.goto(`/audit/${auditId}`)
        await openGuidedFixes(page)
        const sides = scenario.options.structure ? [side] : ['before', 'after']
        for (const selectedSide of sides) {
          await page.getByRole('checkbox', { name: new RegExp(`Space ${selectedSide} the paragraph does not match, .*paragraph 1`, 'i') }).check()
        }
        await page.getByRole('button', { name: `Review ${sides.length} selected chang${sides.length === 1 ? 'e' : 'es'}`, exact: true }).click()
        await page.locator('#guided-fixes-file-input').setInputFiles(fixture.file)
        let applyRequests = 0
        const downloads: string[] = []
        page.on('download', event => downloads.push(event.suggestedFilename()))
        page.on('request', request => {
          if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/audit/${auditId}/guided-fixes`) applyRequests++
        })
        const reviewing = page.waitForResponse(response =>
          response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/audit/${auditId}/guided-fixes/review`)
        await page.getByRole('button', { name: 'Review safety and locations', exact: true }).click()
        const response = await reviewing
        expect(response.status()).toBe(422)
        const rejected = await response.json()
        expect(rejected).not.toHaveProperty('review_id')
        expect(rejected).not.toHaveProperty('download_token')
        await expect(page.getByRole('alert')).toContainText('Fix cannot be applied safely.')
        await expect(page.getByRole('button', { name: 'Apply and verify changes', exact: true })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Download corrected document', exact: true })).toHaveCount(0)
        if (side === 'before' && scenario.name === 'inexact 6.00000000001') {
          await spacingStateEvidence(page, testInfo, 'point-decimal-manual')
        }
        expect(applyRequests).toBe(0)
        expect(downloads).toEqual([])
        expect(createHash('sha256').update(fixture.file.buffer).digest('hex')).toBe(digest)
        expect(await (await page.request.get(`/api/audit/${auditId}`)).json()).toEqual(before)
      })
    }
  }

  for (const fault of [
    'minus-one', 'plus-one', 'rounded', 'missing', 'partial', 'wrong-last',
    'sibling', 'line', 'lineRule', 'preservation', 'reaudit', 'storage',
  ]) {
    test(`point decimal genuine ${fault} fault publishes no output`, async ({ page }, testInfo) => {
      test.skip(process.env.ACA_POINT_FAULT_APP !== '1', 'Requires the isolated synthetic fault wrapper.')
      const grouped = fault === 'partial' || fault === 'wrong-last'
      const fixture = spacingFixture({ before: 6.05, grouped })
      const digest = createHash('sha256').update(fixture.file.buffer).digest('hex')
      const { auditId, before } = await openPointAudit(page, fixture)
      const stateURL = `/api/__aca-point-evidence/${auditId}`
      const baselineResponse = await page.request.get(stateURL)
      expect(baselineResponse.ok()).toBe(true)
      const baseline = await baselineResponse.json()
      expect(baseline.output_tokens).toBe(0)
      await reviewPointSelection(page, fixture, grouped
        ? [{ side: 'before', paragraph: 1 }, { side: 'before', paragraph: 2 }]
        : [{ side: 'before', paragraph: 1 }])
      const endpoint = `**/api/audit/${auditId}/guided-fixes`
      await page.route(endpoint, route => route.continue({
        headers: { ...route.request().headers(), 'x-aca-synthetic-point-fault': fault },
      }))
      const downloads: string[] = []
      page.on('download', download => downloads.push(download.suggestedFilename()))
      const pending = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/api/audit/${auditId}/guided-fixes`)
      await page.getByRole('button', { name: 'Apply and verify changes', exact: true }).click()
      const response = await pending
      expect(response.status()).toBe(fault === 'storage' ? 503 : 422)
      const rejected = await response.json()
      expect(rejected).not.toHaveProperty('download_token')
      expect(rejected).not.toHaveProperty('output_filename')
      await expect(page.getByRole('alert')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Download corrected document', exact: true })).toHaveCount(0)
      const after = await (await page.request.get(stateURL)).json()
      expect(after.output_tokens).toBe(0)
      expect(after.all_output_file_count).toBe(baseline.all_output_file_count)
      expect(after.fault_events.length).toBeGreaterThan(0)
      expect(after.fault_events.every((event: { fault: string }) => event.fault === fault)).toBe(true)
      expect(downloads).toEqual([])
      expect(await (await page.request.get(`/api/audit/${auditId}`)).json()).toEqual(before)
      expect(createHash('sha256').update(fixture.file.buffer).digest('hex')).toBe(digest)
      await testInfo.attach(`point-decimal-${fault}-failure.json`, {
        body: JSON.stringify({ fault, status: response.status(), rejected, baseline, after, downloads }, null, 2),
        contentType: 'application/json',
      })
      if (fault === 'plus-one') await fontEvidence(page, testInfo, 'point-decimal-fault-no-output')
      await page.unroute(endpoint)
    })
  }

  for (const transition of ['audit switch', 'close and reopen'] as const) {
    test(`point decimal delayed Download after ${transition} is suppressed`, async ({ page }, testInfo) => {
      const fixture = spacingFixture({ before: 6.05 })
      const first = await openPointAudit(page, fixture)
      const second = await openPointAudit(page, fixture)
      await page.goto(`/audit/${first.auditId}`)
      await reviewPointSelection(page, fixture, [{ side: 'before', paragraph: 1 }])
      await page.getByRole('button', { name: 'Apply and verify changes', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed', exact: true })).toBeVisible({ timeout: 60_000 })
      const downloads: string[] = []
      const requests: string[] = []
      const received = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const pattern = `**/api/audit/${first.auditId}/guided-fixes/download/*`
      const endpoint = `/api/audit/${first.auditId}/guided-fixes/download/`
      page.on('download', download => downloads.push(download.suggestedFilename()))
      page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith(endpoint)) requests.push(request.url())
      })
      await page.route(pattern, async route => {
        const response = await route.fetch()
        expect(response.status()).toBe(200)
        received.resolve()
        await release.promise
        await route.fulfill({ response })
      })
      try {
        await page.getByRole('button', { name: 'Download corrected document', exact: true }).click()
        await received.promise
        await expect(page.getByRole('button', { name: 'Downloading…', exact: true })).toBeDisabled()
        if (transition === 'audit switch') {
          await page.evaluate(id => {
            window.history.pushState({}, '', `/audit/${id}`)
            window.dispatchEvent(new PopStateEvent('popstate'))
          }, second.auditId)
          await expect(page).toHaveURL(new RegExp(`/audit/${second.auditId}$`))
        } else {
          await page.getByRole('button', { name: 'Close', exact: true }).click()
        }
        await expect(page.getByRole('dialog')).toHaveCount(0)
        const responseReady = page.waitForResponse(response => new URL(response.url()).pathname.startsWith(endpoint))
        release.resolve()
        await responseReady
        await page.waitForLoadState('networkidle')
        expect(downloads).toEqual([])
        expect(requests).toHaveLength(1)
        await page.unroute(pattern)
        await openGuidedFixes(page)
        await expect(page.getByRole('button', { name: 'Download corrected document', exact: true })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Review 0 selected changes', exact: true })).toBeDisabled()
        await testInfo.attach(`point-decimal-stale-${transition}.png`, { body: await page.screenshot(), contentType: 'image/png' })
        expect(await (await page.request.get(`/api/audit/${first.auditId}`)).json()).toEqual(first.before)
        expect(await (await page.request.get(`/api/audit/${second.auditId}`)).json()).toEqual(second.before)
        await testInfo.attach('point-decimal-stale-events.json', {
          body: JSON.stringify({ transition, downloads, requests, genuineResponse: 200 }, null, 2),
          contentType: 'application/json',
        })
      } finally {
        release.resolve()
        await page.unroute(pattern)
      }
    })
  }

  test('point decimal native 100 and 200 percent Review keyboard evidence', async ({ baseURL }, testInfo) => {
    const extension = process.env.ACA_FONT_ZOOM_EXTENSION
    test.skip(!extension, 'Requires the task-owned Manifest V3 native zoom extension.')
    test.setTimeout(600_000)
    const context = await chromium.launchPersistentContext(testInfo.outputPath('point-native-profile'), {
      channel: 'chromium', headless: false, viewport: null, baseURL,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        '--force-device-scale-factor=1',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
    })
    let controller: Page | undefined
    try {
      const origin = new URL(baseURL!).origin
      await context.route('**/*', route => new URL(route.request().url()).origin === origin
        ? route.continue() : route.abort('blockedbyclient'))
      const page = context.pages()[0] || await context.newPage()
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')
      const extensionOrigin = `chrome-extension://${new URL(worker.url()).hostname}`
      expect(new URL(worker.url()).protocol).toBe('chrome-extension:')
      await context.route(`${extensionOrigin}/**`, route => route.continue())
      controller = await context.newPage()
      await controller.goto(`${extensionOrigin}/control.html`)
      await page.bringToFront()
      const fixture = spacingFixture({ before: 6.05, after: 6.1 })
      const created = await page.request.post('/api/audit', {
        multipart: { file: fixture.file, custom_profile: JSON.stringify(fixture.profile) }, timeout: 90_000,
      })
      expect(created.ok(), await created.text()).toBe(true)
      const auditId = (await created.json()).audit_id as string
      await page.goto(`/audit/${auditId}`)
      await openGuidedFixes(page)
      for (const side of ['before', 'after']) {
        await page.getByRole('checkbox', { name: new RegExp(`Space ${side} the paragraph does not match, .*paragraph 1`, 'i') }).check()
      }
      await page.getByRole('button', { name: 'Review 2 selected changes', exact: true }).click()
      await page.locator('#guided-fixes-file-input').setInputFiles(fixture.file)
      await page.getByRole('button', { name: 'Review safety and locations', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Guided Fixes — review confirmed changes' })).toBeVisible({ timeout: 60_000 })
      const cdp = await context.newCDPSession(page)
      const { windowId } = await cdp.send('Browser.getWindowForTarget')
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', width: 1366, height: 768 } })
      await expect.poll(async () => (await cdp.send('Browser.getWindowBounds', { windowId })).bounds).toMatchObject({ width: 1366, height: 768 })
      let baseline: { width: number; height: number; dpr: number } | undefined
      for (const zoom of [1, 2]) {
        const actual = await controller.evaluate(`(async () => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find(tab => tab.url === ${JSON.stringify(page.url())});
          if (!tab || tab.id === undefined) throw new Error("Native zoom tab was not found");
          await chrome.tabs.setZoom(tab.id, ${zoom});
          return chrome.tabs.getZoom(tab.id);
        })()`)
        expect(actual).toBe(zoom)
        await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(zoom)
        const bounds = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, outerWidth, outerHeight }))
        if (baseline) {
          expect(bounds.dpr / baseline.dpr).toBe(2)
          expect(Math.abs(bounds.width * 2 - baseline.width)).toBeLessThanOrEqual(2)
          expect(Math.abs(bounds.height * 2 - baseline.height)).toBeLessThanOrEqual(2)
        } else baseline = bounds
        await page.evaluate(async () => {
          const { promise, resolve } = Promise.withResolvers<void>()
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          await promise
        })
        await reviewKeyboardEvidence(page, testInfo, `point-decimal-native-${zoom * 100}`, zoom === 2)
        await fontEvidence(page, testInfo, `point-decimal-native-${zoom * 100}-contrast`)
        const axe = await new AxeBuilder({ page }).analyze()
        await testInfo.attach(`point-decimal-native-${zoom * 100}.json`, {
          body: JSON.stringify({ zoom: actual, bounds, window: (await cdp.send('Browser.getWindowBounds', { windowId })).bounds,
            violations: axe.violations, incomplete: axe.incomplete }, null, 2), contentType: 'application/json',
        })
        await testInfo.attach(`point-decimal-native-${zoom * 100}.png`, { body: await fontScreenshot(page), contentType: 'image/png' })
        expect(axe.violations.filter(item => item.impact === 'critical' || item.impact === 'serious')).toEqual([])
      }
    } finally {
      try {
        if (controller) {
          const restored = await controller.evaluate(`(async () => {
            const tabs = await chrome.tabs.query({});
            const owned = tabs.filter(tab => tab.id !== undefined && tab.url && new URL(tab.url).origin === ${JSON.stringify(new URL(baseURL!).origin)});
            return Promise.all(owned.map(async tab => {
              await chrome.tabs.setZoom(tab.id, 1);
              return chrome.tabs.getZoom(tab.id);
            }));
          })()`) as number[]
          await testInfo.attach('point-native-restored.json', { body: JSON.stringify(restored), contentType: 'application/json' })
          expect(restored.length).toBeGreaterThan(0)
          expect(restored.every(value => value === 1)).toBe(true)
        }
      } finally {
        await context.close()
      }
    }
  })

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
            await page.getByRole('checkbox', { name: new RegExp(`Space ${selectedSide} the paragraph does not match, .*paragraph 1`, 'i') }).check()
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
    const summary = await openFontAudit(page)
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
    await testInfo.attach('wrong-original-rejection.png', { body: await page.screenshot(), contentType: 'image/png' })

    // Selection survives the error and the file can be replaced (dialog
    // stays open — never closed automatically on error).
    await page.getByRole('button', { name: 'Back to findings' }).last().click()
    await expect(page.getByText(/selected · .*candidates for safety review · Maximum 20/)).toBeVisible()
    await page.getByRole('button', { name: /Review .* selected chang(e|es)/ }).click()

    // Replace with the EXACT original bytes used for the audit.
    await wrong.setInputFiles(summary.fixture.file)
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

  test('synthetic verification-error presentation offers re-review but no download', async ({ page }) => {
    const { fixture } = await openFontAudit(page)
    await openGuidedFixes(page)
    await page.locator('input[type="checkbox"][aria-label]').first().check()
    await page.getByRole('button', { name: /Review .* selected chang(e|es)/ }).click()
    await page.locator('#guided-fixes-file-input').setInputFiles(fixture.file)
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
    const { fixture } = await openFontAudit(page)
    await openGuidedFixes(page)
    await page.locator('input[type="checkbox"][aria-label]').first().check()
    await page.getByRole('button', { name: /Review .* selected chang(e|es)/ }).click()
    await page.locator('#guided-fixes-file-input').setInputFiles(fixture.file)
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

  test('emulated 195px zoom stress keeps Review safety and completion reachable', async ({ page }) => {
    // Viewport-only regression; genuine native zoom is proved separately.
    await page.setViewportSize({ width: 195, height: 390 })
    const { fixture } = await openFontAudit(page)
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
    await page.locator('#guided-fixes-file-input').setInputFiles(fixture.file)
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

test.describe('strict direct font evidence @font-slot', () => {

  for (const options of [
    { family: true },
    { size: 12.5 },
    { family: true, grouped: true },
    { family: true, size: 12, grouped: true },
  ] as FontCase[]) {
    test(`supported direct font ${JSON.stringify(options)} completes keyboard Review Apply Download with exact slots`, async ({ page }, testInfo) => {
      const fixture = fontFixture(options)
      const { auditId, auditBefore } = await openFontAudit(page, fixture)
      await selectFontChanges(page, fixture, options, testInfo)
      await page.keyboard.press('Enter')
      const review = page.getByRole('dialog', { name: 'Guided Fixes — review confirmed changes' })
      await expect(review).toBeVisible({ timeout: 60_000 })
      if (options.family) {
        await expect(review.getByText('Current: Calibri', { exact: true })).toBeVisible()
        await expect(review.getByText('Required and proposed: Times New Roman', { exact: true })).toBeVisible()
      }
      if (options.size !== undefined) {
        await expect(review.getByText(/^Current: 11(?:\.0)?pt$/)).toBeVisible()
        await expect(review.getByText(new RegExp(`^Required and proposed: ${options.size}(?:\\.0)?pt$`))).toBeVisible()
      }
      await fontEvidence(page, testInfo, `font-${options.family ? 'family' : 'size'}${options.grouped ? '-grouped' : ''}-review`)
      if (options.family && options.size !== undefined) {
        for (const [width, height] of [[1366, 768], [1280, 800], [1024, 768], [960, 768], [768, 768]]) {
          await page.setViewportSize({ width, height })
          await fontEvidence(page, testInfo, `font-review-${width}`)
          await tabTo(page, page.getByRole('button', { name: 'Apply and verify changes', exact: true }))
        }
      }
      await tabTo(page, page.getByRole('button', { name: 'Apply and verify changes', exact: true }))
      await page.keyboard.press('Enter')
      await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed', exact: true })).toBeVisible({ timeout: 60_000 })
      await fontEvidence(page, testInfo, `font-${options.family ? 'family' : 'size'}${options.grouped ? '-grouped' : ''}-verified`)
      if (options.family && options.size !== undefined) {
        for (const [width, height] of [[1366, 768], [1280, 800], [1024, 768], [960, 768], [768, 768]]) {
          await page.setViewportSize({ width, height })
          await fontEvidence(page, testInfo, `font-verified-${width}`)
          await tabTo(page, page.getByRole('button', { name: 'Download corrected document', exact: true }))
        }
      }
      await proveFontDownload(page, testInfo, auditId, fixture, options, auditBefore)
      await tabTo(page, page.getByRole('button', { name: 'Close', exact: true }))
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: 'Guided Fixes' })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: 'Review 0 selected changes', exact: true })).toBeDisabled()
      await expect(page.getByRole('button', { name: 'Download corrected document', exact: true })).toHaveCount(0)
    })
  }

  for (const operation of ['family', 'size'] as const) {
    for (const unsafe of ['character', 'paragraph', 'base', 'defaults', 'theme', 'script', 'mixed-slots', 'non-ascii'] as const) {
      test(`unavailable font ${operation} ${unsafe} refuses safe and unsafe grouped runs atomically`, async ({ page }, testInfo) => {
        const options: FontCase = { family: operation === 'family', size: operation === 'size' ? 12 : undefined, grouped: true, unsafe }
        const fixture = fontFixture(options)
        const { auditId } = await openFontAudit(page, fixture)
        const before = await (await page.request.get(`/api/audit/${auditId}`)).json()
        const downloads: string[] = []
        let applyRequests = 0
        page.on('download', event => downloads.push(event.suggestedFilename()))
        page.on('request', request => {
          if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/audit/${auditId}/guided-fixes`) applyRequests++
        })
        await selectFontChanges(page, fixture, options)
        const pending = page.waitForResponse(response => new URL(response.url()).pathname === `/api/audit/${auditId}/guided-fixes/review`)
        await page.keyboard.press('Enter')
        const response = await pending
        expect(response.status()).toBe(422)
        const rejected = await response.json()
        expect(rejected).not.toHaveProperty('review_id')
        expect(rejected).not.toHaveProperty('download_token')
        await expect(page.getByRole('alert')).toContainText('Fix cannot be applied safely. Correct the selected findings manually.')
        await expect(page.getByRole('button', { name: 'Apply and verify changes', exact: true })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Download corrected document', exact: true })).toHaveCount(0)
        await testInfo.attach(`font-${operation}-${unsafe}-manual.png`, { body: await page.screenshot(), contentType: 'image/png' })
        if (operation === 'family' && unsafe === 'character') {
          for (const [width, height] of [[1366, 768], [1280, 800], [1024, 768], [960, 768], [768, 768]]) {
            await page.setViewportSize({ width, height })
            await fontEvidence(page, testInfo, `font-manual-${width}`)
          }
        }
        await tabTo(page, page.getByRole('button', { name: 'Back to findings', exact: true }).last())
        await page.keyboard.press('Enter')
        expect(downloads).toEqual([])
        expect(applyRequests).toBe(0)
        expect(await (await page.request.get(`/api/audit/${auditId}`)).json()).toEqual(before)
        await testInfo.attach('manual-review-response.json', { body: JSON.stringify(rejected, null, 2), contentType: 'application/json' })
      })
    }
  }

  for (const size of [12.005, 12.25]) {
    test(`unrepresentable saved size ${size} rejects a combined family and size selection before Apply`, async ({ page }, testInfo) => {
      const options: FontCase = { family: true, size }
      const fixture = fontFixture(options)
      const { auditId } = await openFontAudit(page, fixture)
      await selectFontChanges(page, fixture, options)
      const pending = page.waitForResponse(response => new URL(response.url()).pathname === `/api/audit/${auditId}/guided-fixes/review`)
      await page.keyboard.press('Enter')
      const response = await pending
      expect(response.status()).toBe(422)
      expect(await response.json()).not.toHaveProperty('review_id')
      await expect(page.getByRole('alert')).toContainText('Fix cannot be applied safely.')
      await expect(page.getByRole('button', { name: 'Apply and verify changes', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Download corrected document', exact: true })).toHaveCount(0)
      await testInfo.attach(`font-size-${size}-manual.png`, { body: await page.screenshot(), contentType: 'image/png' })
    })
  }

  for (const manual of [false, true]) {
    test(`native Chrome 100 and 200 percent fixed-window font ${manual ? 'manual' : 'combined success'} evidence @font-native`, async ({ baseURL }, testInfo) => {
      const extension = process.env.ACA_FONT_ZOOM_EXTENSION
      test.skip(!extension, 'Native zoom requires the isolated external launcher and its task-owned Chrome extension.')
      test.setTimeout(600_000)
      const context = await chromium.launchPersistentContext(testInfo.outputPath('native-browser-profile'), {
        channel: 'chromium', headless: false, viewport: null, baseURL,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
          `--log-net-log=${testInfo.outputPath('native-netlog.json')}`, '--net-log-capture-mode=Default',
          '--force-device-scale-factor=1',
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
        acceptDownloads: true,
      })
      let zoomControl: Page | undefined
      try {
        const origin = new URL(baseURL!).origin
        const evidence = networkEvidence.get(testInfo.testId)!
        context.on('request', request => {
          const url = new URL(request.url())
          if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && url.origin !== origin) evidence.externalAttempts.push(request.url())
        })
        context.on('response', response => {
          const url = new URL(response.url())
          if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) evidence.externalResponses.push(response.url())
        })
        context.on('requestfailed', request => evidence.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }))
        await context.route('**/*', route => new URL(route.request().url()).origin === origin
          ? route.continue() : route.abort('blockedbyclient'))
        const page = context.pages()[0] || await context.newPage()
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')
        const workerURL = new URL(worker.url())
        expect(workerURL.protocol).toBe('chrome-extension:')
        const extensionOrigin = `chrome-extension://${workerURL.hostname}`
        // Only this task-owned extension may bypass the external-network guard.
        await context.route(`${extensionOrigin}/**`, route => route.continue())
        zoomControl = await context.newPage()
        await zoomControl.goto(`${extensionOrigin}/control.html`)
        const controller = zoomControl
        await page.bringToFront()
        await testInfo.attach('native-zoom-controller.json', {
          body: JSON.stringify({ kind: 'extension-page', workerURL: worker.url(),
            controllerURL: controller.url(), routeException: `${extensionOrigin}/**` }, null, 2),
          contentType: 'application/json',
        })
        const options: FontCase = { family: true, size: 12, grouped: true, unsafe: manual ? 'character' : undefined }
        const fixture = fontFixture(options)
        const { auditId, auditBefore } = await openFontAudit(page, fixture)
        const cdp = await context.newCDPSession(page)
        const { windowId } = await cdp.send('Browser.getWindowForTarget')
        const nativeEvidence = async (state: string, primary: string) => {
          for (const [width, height] of [[1366, 768], [1280, 800], [1024, 768], [960, 768], [768, 768]]) {
            await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', width, height } })
            await expect.poll(async () => (await cdp.send('Browser.getWindowBounds', { windowId })).bounds).toMatchObject({ width, height })
            await expect.poll(() => page.evaluate(() => ({ width: outerWidth, height: outerHeight }))).toEqual({ width, height })
            let baseline: { innerWidth: number; innerHeight: number; outerWidth: number; outerHeight: number; devicePixelRatio: number } | undefined
            for (const zoom of [1, 2]) {
              const actual = await controller.evaluate(`(async () => {
                const tabs = await chrome.tabs.query({});
                const tab = tabs.find(tab => tab.url === ${JSON.stringify(page.url())});
                if (!tab || tab.id === undefined) throw new Error("Native zoom tab was not found");
                await chrome.tabs.setZoom(tab.id, ${zoom});
                return chrome.tabs.getZoom(tab.id);
              })()`)
              expect(actual).toBe(zoom)
              await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
              await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(zoom)
              if (zoom === 2) {
                await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(baseline!.devicePixelRatio * 2)
              }
              const evidenceState = `${state}-window-${width}-${height}-native-${zoom * 100}`
              if (state === 'font-review') await reviewKeyboardEvidence(page, testInfo, evidenceState)
              const primaryKeys: object[] = []
              const primaryControl = page.getByRole('button', { name: primary, exact: true }).last()
              await tabTo(page, primaryControl, primaryKeys)
              await testInfo.attach(`${evidenceState}-primary-key-log.json`, {
                body: JSON.stringify({ primary, keys: primaryKeys,
                  focused: await primaryControl.evaluate(element => element === document.activeElement),
                  focusVisible: await primaryControl.evaluate(element => element.matches(':focus-visible')),
                  passed: true }, null, 2), contentType: 'application/json',
              })
              const bounds = await fontEvidence(page, testInfo, evidenceState)
              await testInfo.attach(`${state}-${width}-${height}-native-${zoom * 100}-zoom-proof.json`, {
                body: JSON.stringify({ requestedWindow: { width, height }, actualWindow: (await cdp.send('Browser.getWindowBounds', { windowId })).bounds,
                  launchDeviceScaleFactor: 1, requestedZoom: zoom, chromeTabsZoom: actual, observedBounds: bounds,
                  screenshotCapture: { method: 'CDP Page.captureScreenshot', fromSurface: false, captureBeyondViewport: false } }, null, 2),
                contentType: 'application/json',
              })
              if (zoom === 1) baseline = bounds
              else {
                expect(bounds.outerWidth).toBe(baseline!.outerWidth)
                expect(bounds.outerHeight).toBe(baseline!.outerHeight)
                expect(bounds.devicePixelRatio / baseline!.devicePixelRatio).toBe(2)
                expect(Math.abs(bounds.innerWidth * 2 - baseline!.innerWidth)).toBeLessThanOrEqual(2)
                expect(Math.abs(bounds.innerHeight * 2 - baseline!.innerHeight)).toBeLessThanOrEqual(2)
              }
            }
          }
        }
        await selectFontChanges(page, fixture, options)
        await nativeEvidence('font-upload', 'Review safety and locations')
        await page.getByRole('button', { name: 'Review safety and locations', exact: true }).click()
        if (manual) {
          await expect(page.getByRole('alert')).toContainText('Fix cannot be applied safely.')
          await nativeEvidence('font-manual', 'Back to findings')
          await expect(page.getByRole('button', { name: 'Apply and verify changes', exact: true })).toHaveCount(0)
          await expect(page.getByRole('button', { name: 'Download corrected document', exact: true })).toHaveCount(0)
        } else {
          await expect(page.getByRole('button', { name: 'Apply and verify changes', exact: true })).toBeVisible({ timeout: 60_000 })
          await nativeEvidence('font-review', 'Apply and verify changes')
          await page.getByRole('button', { name: 'Apply and verify changes', exact: true }).click()
          await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed', exact: true })).toBeVisible({ timeout: 60_000 })
          await nativeEvidence('font-verified', 'Download corrected document')
          await proveFontDownload(page, testInfo, auditId, fixture, options, auditBefore)
        }
      } finally {
        try {
          if (zoomControl) {
            const restored = await zoomControl.evaluate(`(async () => {
              const tabs = await chrome.tabs.query({});
              const owned = tabs.filter(tab => tab.id !== undefined && tab.url && new URL(tab.url).origin === ${JSON.stringify(new URL(baseURL!).origin)});
              return Promise.all(owned.map(async tab => {
                const before = await chrome.tabs.getZoom(tab.id);
                await chrome.tabs.setZoom(tab.id, 1);
                return { tabId: tab.id, before, after: await chrome.tabs.getZoom(tab.id) };
              }));
            })()`) as { tabId: number; before: number; after: number }[]
            await testInfo.attach('native-finally-restored-100.json', {
              body: JSON.stringify({ restoration: restored }, null, 2), contentType: 'application/json',
            })
            expect(restored.length).toBeGreaterThan(0)
            for (const tab of restored) expect(tab.after).toBe(1)
          }
        } finally {
          await context.close()
        }
      }
    })
  }
})

test.describe('font publication fault gates @font-slot @font-fault', () => {
  for (const fault of ['preservation', 'reaudit', 'storage']) {
    test(`genuine backend ${fault} injected failure publishes no output and later valid font recovery works`, async ({ page }, testInfo) => {
      test.skip(process.env.ACA_FONT_FAULT_APP !== '1', 'Requires the isolated external fault wrapper, never a production application.')
      const options: FontCase = { family: true, size: 12 }
      const fixture = fontFixture(options)
      const { auditId, auditBefore } = await openFontAudit(page, fixture)
      const stateURL = `/api/__aca-evidence/${auditId}`
      const baselineResponse = await page.request.get(stateURL)
      expect(baselineResponse.ok()).toBe(true)
      const baseline = await baselineResponse.json()
      expect(baseline.output_tokens).toBe(0)
      await selectFontChanges(page, fixture, options)
      await page.keyboard.press('Enter')
      const apply = page.getByRole('button', { name: 'Apply and verify changes', exact: true })
      await expect(apply).toBeVisible({ timeout: 60_000 })
      const endpoint = `**/api/audit/${auditId}/guided-fixes`
      await page.route(endpoint, route => route.continue({
        headers: { ...route.request().headers(), 'x-aca-synthetic-fault': fault },
      }))
      const downloads: string[] = []
      let requests = 0
      page.on('download', download => downloads.push(download.suggestedFilename()))
      page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/audit/${auditId}/guided-fixes`) requests++
      })
      const pending = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/api/audit/${auditId}/guided-fixes`)
      await tabTo(page, apply)
      await page.keyboard.press('Enter')
      const response = await pending
      expect(response.status()).toBe(fault === 'storage' ? 503 : 422)
      const rejected = await response.json()
      expect(rejected).not.toHaveProperty('download_token')
      expect(rejected).not.toHaveProperty('output_filename')
      await expect(page.getByRole('alert')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Download corrected document', exact: true })).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed', exact: true })).toHaveCount(0)
      expect(downloads).toEqual([])
      expect(requests).toBe(1)
      const failedState = await (await page.request.get(stateURL)).json()
      expect(failedState.output_tokens).toBe(0)
      expect(failedState.all_output_file_count).toBe(baseline.all_output_file_count)
      expect(failedState.fault_events.length).toBeGreaterThan(0)
      expect(failedState.fault_events.every((event: { fault: string }) => event.fault === fault)).toBe(true)
      expect(await (await page.request.get(`/api/audit/${auditId}`)).json()).toEqual(auditBefore)
      await testInfo.attach(`${fault}-genuine-backend-failure.json`, {
        body: JSON.stringify({ injectedFault: fault, status: response.status(), response: rejected,
          baseline, afterFailure: failedState, downloads, requests }, null, 2), contentType: 'application/json',
      })
      await fontEvidence(page, testInfo, `font-${fault}-unavailable`)
      await page.unroute(endpoint)
      await tabTo(page, page.getByRole('button', { name: 'Review safety and locations', exact: true }))
      await page.keyboard.press('Enter')
      await expect(apply).toBeVisible({ timeout: 60_000 })
      await tabTo(page, apply)
      await page.keyboard.press('Enter')
      await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed', exact: true })).toBeVisible({ timeout: 60_000 })
      await proveFontDownload(page, testInfo, auditId, fixture, options, auditBefore)
      expect(downloads).toHaveLength(1)
    })
  }
})

test.describe('font genuine stale responses @font-slot @font-stale', () => {
  for (const stage of ['Review', 'Apply'] as const) {
    for (const transition of ['audit switch', 'route close'] as const) {
      test(`delayed genuine font ${stage} is discarded after ${transition}; pending is non-dismissible and later valid download works`, async ({ page }, testInfo) => {
        const options: FontCase = { family: true, size: 12 }
        const fixture = fontFixture(options)
        const { auditId: auditA, auditBefore } = await openFontAudit(page, fixture)
        const { auditId: auditB, auditBefore: auditBeforeB } = await openFontAudit(page, fixture)
        await page.goto(`/audit/${auditA}`)
        await selectFontChanges(page, fixture, options)
        if (stage === 'Apply') {
          await page.keyboard.press('Enter')
          await expect(page.getByRole('button', { name: 'Apply and verify changes', exact: true })).toBeVisible({ timeout: 60_000 })
        }
        const endpointPath = `/api/audit/${auditA}/guided-fixes${stage === 'Review' ? '/review' : ''}`
        const pattern = `**${endpointPath}`
        const received = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const downloads: string[] = []
        let requests = 0
        page.on('download', download => downloads.push(download.suggestedFilename()))
        page.on('request', request => {
          if (request.method() === 'POST' && new URL(request.url()).pathname === endpointPath) requests++
        })
        await page.route(pattern, async route => {
          const response = await route.fetch()
          expect(response.status()).toBe(200)
          received.resolve()
          await release.promise
          await route.fulfill({ response })
        })
        try {
          const primary = page.getByRole('button', { name: stage === 'Review' ? 'Review safety and locations' : 'Apply and verify changes', exact: true })
          await tabTo(page, primary)
          await page.keyboard.press('Enter')
          await received.promise
          await page.keyboard.press('Enter')
          const pending = page.getByRole('dialog', { name: stage === 'Review' ? 'Checking safety and locations' : 'Applying and verifying', exact: true })
          await expect(pending).toBeVisible()
          await page.keyboard.press('Escape')
          await expect(pending).toBeVisible()
          await expect(pending.getByRole('button', { name: /^Close/ })).toHaveCount(0)
          expect(requests).toBe(1)
          await fontEvidence(page, testInfo, `font-${stage.toLowerCase()}-pending`)
          // Pending Review/Apply deliberately have no Close action. A route
          // close means actual workspace unmount, not a fabricated modal button.
          const target = transition === 'audit switch' ? `/audit/${auditB}` : '/history'
          await page.evaluate(url => {
            window.history.pushState({}, '', url)
            window.dispatchEvent(new PopStateEvent('popstate'))
          }, target)
          await expect(page).toHaveURL(new RegExp(`${target}$`))
          await expect(page.getByRole('dialog')).toHaveCount(0)
          const responseReady = page.waitForResponse(response => response.request().method() === 'POST'
            && new URL(response.url()).pathname === endpointPath)
          release.resolve()
          await responseReady
          await page.waitForLoadState('networkidle')
          expect(downloads).toEqual([])
          expect(requests).toBe(1)
          await expect(page.getByRole('dialog')).toHaveCount(0)
          await expect(page.getByText(/Safety review passed for|Fix applied; re-audit passed|Download is now available/)).toHaveCount(0)
          await testInfo.attach('genuine-stale-response.json', {
            body: JSON.stringify({ stage, transition, endpointPath, realResponseStatus: 200,
              pendingClosePolicy: 'non-dismissible; Escape preserved pending dialog; route close unmounts workspace',
              duplicatePendingRequests: requests, staleDownloads: downloads }, null, 2), contentType: 'application/json',
          })
        } finally {
          release.resolve()
          await page.unroute(pattern)
        }
        const laterId = transition === 'audit switch' ? auditB : auditA
        await page.goto(`/audit/${laterId}`)
        await selectFontChanges(page, fixture, options)
        await page.keyboard.press('Enter')
        await expect(page.getByRole('button', { name: 'Apply and verify changes', exact: true })).toBeVisible({ timeout: 60_000 })
        await tabTo(page, page.getByRole('button', { name: 'Apply and verify changes', exact: true }))
        await page.keyboard.press('Enter')
        await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed', exact: true })).toBeVisible({ timeout: 60_000 })
        await proveFontDownload(page, testInfo, laterId, fixture, options, transition === 'audit switch' ? auditBeforeB : auditBefore)
        expect(downloads).toHaveLength(1)
        await page.getByRole('button', { name: 'Close', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Guided Fixes' })).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(page.getByRole('button', { name: 'Review 0 selected changes', exact: true })).toBeDisabled()
        await expect(page.getByRole('button', { name: 'Download corrected document', exact: true })).toHaveCount(0)
        await expect(page.getByRole('status').filter({ hasText: /Downloading|Downloaded|Download is now available|re-audit passed/ })).toHaveCount(0)
      })
    }
  }
})

test.describe('font stale Download screenshot journeys @font-slot @font-stale-download', () => {
  for (const transition of ['audit switch', 'close and reopen'] as const) {
    test(`delayed genuine font Download after ${transition} discards stale output and preserves later verified download screenshots`, async ({ page }, testInfo) => {
      const options: FontCase = { family: true, size: 12 }
      const fixture = fontFixture(options)
      const { auditId: auditA, auditBefore } = await openFontAudit(page, fixture)
      const { auditId: auditB, auditBefore: auditBeforeB } = await openFontAudit(page, fixture)
      await page.goto(`/audit/${auditA}`)
      await selectFontChanges(page, fixture, options)
      await page.keyboard.press('Enter')
      const apply = page.getByRole('button', { name: 'Apply and verify changes', exact: true })
      await expect(apply).toBeVisible({ timeout: 60_000 })
      await tabTo(page, apply)
      await page.keyboard.press('Enter')
      await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed', exact: true })).toBeVisible({ timeout: 60_000 })
      const downloads: { filename: string; url: string }[] = []
      const requests: { method: string; url: string }[] = []
      const received = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const pattern = `**/api/audit/${auditA}/guided-fixes/download/*`
      const endpoint = `/api/audit/${auditA}/guided-fixes/download/`
      let realResponseStatus: number | undefined
      let staleDownloads: { filename: string; url: string }[] | undefined
      let completed = false
      page.on('download', download => downloads.push({ filename: download.suggestedFilename(), url: download.url() }))
      page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith(endpoint)) requests.push({ method: request.method(), url: request.url() })
      })
      await page.route(pattern, async route => {
        const response = await route.fetch()
        realResponseStatus = response.status()
        expect(realResponseStatus).toBe(200)
        received.resolve()
        await release.promise
        await route.fulfill({ response })
      })
      try {
        const download = page.getByRole('button', { name: 'Download corrected document', exact: true })
        await tabTo(page, download)
        await page.keyboard.press('Enter')
        await received.promise
        await expect(page.getByRole('status').filter({ hasText: /^Downloading…$/ })).toHaveCount(1)
        await expect(page.getByRole('button', { name: 'Downloading…', exact: true })).toBeDisabled()
        await testInfo.attach('stale-download-pending.png', { body: await page.screenshot(), contentType: 'image/png' })
        if (transition === 'audit switch') {
          await page.evaluate(id => {
            window.history.pushState({}, '', `/audit/${id}`)
            window.dispatchEvent(new PopStateEvent('popstate'))
          }, auditB)
          await expect(page).toHaveURL(new RegExp(`/audit/${auditB}$`))
        } else {
          await tabTo(page, page.getByRole('button', { name: 'Close', exact: true }))
          await page.keyboard.press('Enter')
          await expect(page.getByRole('button', { name: /^Guided Fixes/ })).toBeFocused()
        }
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await testInfo.attach('stale-download-transition.png', { body: await page.screenshot(), contentType: 'image/png' })
        const responseReady = page.waitForResponse(response => new URL(response.url()).pathname.startsWith(endpoint))
        release.resolve()
        await responseReady
        await page.waitForLoadState('networkidle')
        staleDownloads = [...downloads]
        expect(staleDownloads).toEqual([])
        expect(requests).toHaveLength(1)
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(page.getByText('Downloaded. The one-use link has expired.', { exact: true })).toHaveCount(0)
        await expect(page.getByRole('alert')).toHaveCount(0)
        await testInfo.attach('stale-download-discarded.png', { body: await page.screenshot(), contentType: 'image/png' })
        await page.unroute(pattern)
        const opener = page.getByRole('button', { name: /^Guided Fixes/ })
        await tabTo(page, opener)
        await page.keyboard.press('Enter')
        await expect(page.getByRole('button', { name: 'Close Guided Fixes', exact: true })).toBeFocused()
        await expect(page.getByRole('button', { name: 'Review 0 selected changes', exact: true })).toBeDisabled()
        await expect(page.getByRole('button', { name: 'Download corrected document', exact: true })).toHaveCount(0)
        await expect(page.getByRole('status').filter({ hasText: /Downloading|Downloaded|Download is now available|re-audit passed/ })).toHaveCount(0)
        await testInfo.attach('stale-download-reopened-reset.png', { body: await page.screenshot(), contentType: 'image/png' })
        await page.keyboard.press('Escape')
        await expect(opener).toBeFocused()
        const laterId = transition === 'audit switch' ? auditB : auditA
        await selectFontChanges(page, fixture, options)
        await page.keyboard.press('Enter')
        await expect(apply).toBeVisible({ timeout: 60_000 })
        await tabTo(page, apply)
        await page.keyboard.press('Enter')
        await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed', exact: true })).toBeVisible({ timeout: 60_000 })
        await expect(download).toBeEnabled()
        await testInfo.attach('stale-download-later-verified.png', { body: await page.screenshot(), contentType: 'image/png' })
        await proveFontDownload(page, testInfo, laterId, fixture, options, transition === 'audit switch' ? auditBeforeB : auditBefore)
        expect(downloads).toHaveLength(1)
        await expect(download).toBeDisabled()
        await expect(page.getByRole('status').filter({ hasText: /^Downloading…$/ })).toHaveCount(0)
        await testInfo.attach('stale-download-later-downloaded.png', { body: await page.screenshot(), contentType: 'image/png' })
        await tabTo(page, page.getByRole('button', { name: 'Close', exact: true }))
        await page.keyboard.press('Enter')
        await expect(opener).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(page.getByRole('button', { name: 'Close Guided Fixes', exact: true })).toBeFocused()
        await expect(page.getByRole('button', { name: 'Review 0 selected changes', exact: true })).toBeDisabled()
        await expect(page.getByRole('status').filter({ hasText: /Downloading|Downloaded|Download is now available|re-audit passed/ })).toHaveCount(0)
        await testInfo.attach('stale-download-final-reopened-reset.png', { body: await page.screenshot(), contentType: 'image/png' })
        await page.keyboard.press('Escape')
        await expect(opener).toBeFocused()
        expect(await (await page.request.get(`/api/audit/${auditA}`)).json()).toEqual(auditBefore)
        expect(await (await page.request.get(`/api/audit/${auditB}`)).json()).toEqual(auditBeforeB)
        completed = true
      } finally {
        release.resolve()
        await page.unroute(pattern)
        await testInfo.attach('stale-download-events.json', {
          body: JSON.stringify({ transition, auditA, auditB, realResponseStatus, requests, staleDownloads,
            downloads, completed, source: 'Playwright Download events only; genuine delayed backend response' }, null, 2),
          contentType: 'application/json',
        })
      }
    })
  }
})

type LineCase = {
  required?: number
  raw?: number
  rule?: 'auto' | 'exact' | 'atLeast' | 'missing'
  count?: number
  reference?: boolean
  appendix?: boolean
  pageEvidence?: boolean
  unsafe?: 'inherited' | 'inherited-only' | 'grid' | 'snap' | 'bookmark' | 'numbered'
}

function lineFixture(options: LineCase = {}): LineFixture {
  const backendDir = path.resolve(process.cwd(), '..', 'backend')
  const python = path.join(backendDir, '.venv', 'Scripts', 'python.exe')
  const fixture = JSON.parse(execFileSync(python, ['-B', '-c', `
import base64, io, json, sys
from decimal import Decimal
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from app.services.profile_schema import new_custom_profile
options = json.load(sys.stdin)
doc = Document()
# Fixture construction only: remove stock-template inherited line declarations
# and grids, rather than manufacturing eligibility during a product operation.
for spacing in doc.styles.element.iter(qn("w:spacing")):
    for attr in ("line", "lineRule"):
        spacing.attrib.pop(qn("w:" + attr), None)
for grid in list(doc.element.iter(qn("w:docGrid"))):
    grid.getparent().remove(grid)
profile = new_custom_profile("LINE direct-auto browser evidence")
required = options.get("required", 1.5)
profile.body.line_spacing = required
selected = []
if options.get("appendix"):
    doc.add_paragraph("APPENDIX A", style="Heading 1")
for index in range(options.get("count", 1)):
    p = doc.add_paragraph("This synthetic academic body paragraph provides ordinary prose for exact line spacing evidence. ")
    p.add_run("Its second physical run must retain the original boundary and text.")
    spacing = OxmlElement("w:spacing")
    spacing.set(qn("w:line"), str(options.get("raw", 240)))
    if options.get("rule") != "missing":
        spacing.set(qn("w:lineRule"), options.get("rule", "auto"))
    spacing.set(qn("w:before"), "120")
    spacing.set(qn("w:after"), "160")
    p._p.get_or_add_pPr().append(spacing)
    selected.append({"index": len(doc.paragraphs) - 1, "required": str(required)})
    if index == options.get("count", 1) - 1:
        unsafe = options.get("unsafe")
        if unsafe in ("inherited", "inherited-only"):
            inherited = OxmlElement("w:spacing")
            inherited.set(qn("w:line"), "276")
            inherited.set(qn("w:lineRule"), "auto")
            doc.styles["Normal"].element.get_or_add_pPr().append(inherited)
            if unsafe == "inherited-only":
                spacing.attrib.pop(qn("w:line"))
                spacing.attrib.pop(qn("w:lineRule"), None)
        elif unsafe == "grid":
            grid = OxmlElement("w:docGrid")
            grid.set(qn("w:linePitch"), "360")
            doc.sections[0]._sectPr.append(grid)
        elif unsafe == "snap":
            p._p.get_or_add_pPr().append(OxmlElement("w:snapToGrid"))
        elif unsafe == "bookmark":
            bookmark = OxmlElement("w:bookmarkStart")
            bookmark.set(qn("w:id"), "123")
            bookmark.set(qn("w:name"), "SyntheticLine")
            p._p.insert(1, bookmark)
            end = OxmlElement("w:bookmarkEnd")
            end.set(qn("w:id"), "123")
            p._p.append(end)
        elif unsafe == "numbered":
            p.style = doc.styles["List Number"]
if options.get("reference"):
    doc.add_paragraph("References")
    p = doc.add_paragraph("Smith, A. (2024). Synthetic line evidence reference. Academic Press.")
    p.paragraph_format.line_spacing = 1.0
    profile.references.line_spacing = 2.0
    profile.references.check_line_spacing = True
    profile.references.check_start_on_new_page = options.get("pageEvidence", False)
    selected.append({"index": len(doc.paragraphs) - 1, "required": "2.0"})
out = io.BytesIO()
doc.save(out)
print(json.dumps({"docx": base64.b64encode(out.getvalue()).decode(), "profile": profile.to_dict(), "selected": selected}))
`], { cwd: backendDir, encoding: 'utf8', input: JSON.stringify(options),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })) as {
      docx: string; profile: object; selected: { index: number; required: string }[]
    }
  return { ...fixture, backendDir, python,
    file: { name: 'line-spacing-evidence.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from(fixture.docx, 'base64') } }
}

type LineFixture = {
  docx: string
  profile: object
  selected: { index: number; required: string }[]
  backendDir: string
  python: string
  file: { name: string; mimeType: string; buffer: Buffer }
  historical?: { audit: unknown; history: unknown; pdf: string; pdfPages: unknown }
}

async function openLineAudit(page: Page, fixture: LineFixture) {
  const response = await page.request.post('/api/audit', {
    multipart: { file: fixture.file, custom_profile: JSON.stringify(fixture.profile) }, timeout: 90_000,
  })
  expect(response.ok(), await response.text()).toBe(true)
  const auditId = (await response.json()).audit_id as string
  const before = await (await page.request.get(`/api/audit/${auditId}`)).json() as FontAuditSnapshot
  fixture.historical = await lineHistoricalWitness(page, auditId, fixture)
  await page.goto(`/audit/${auditId}`)
  return { auditId, before }
}

async function lineHistoricalWitness(page: Page, auditId: string, fixture: LineFixture) {
  const audit = await (await page.request.get(`/api/audit/${auditId}`)).json()
  const history = (await (await page.request.get('/api/audits?limit=100')).json() as { id: string }[])
    .find(row => row.id === auditId)
  expect(history).toBeDefined()
  const response = await page.request.get(`/api/audit/${auditId}/export-pdf`)
  expect(response.ok()).toBe(true)
  const pdf = await response.body()
  const pdfPages = JSON.parse(execFileSync(fixture.python, ['-B', '-c', `
import base64, hashlib, io, json, sys
from pypdf import PdfReader
reader = PdfReader(io.BytesIO(base64.b64decode(sys.stdin.read())))
print(json.dumps([{"text": page.extract_text(), "content_sha256": hashlib.sha256(page.get_contents().get_data()).hexdigest()} for page in reader.pages]))
`], { cwd: fixture.backendDir, encoding: 'utf8', input: pdf.toString('base64') }))
  return { audit, history, pdf: pdf.toString('base64'), pdfPages }
}

async function selectLineChanges(page: Page, fixture: LineFixture) {
  await tabTo(page, page.getByRole('button', { name: /^Guided Fixes/ }))
  await page.keyboard.press('Enter')
  const boxes = page.getByRole('checkbox', { name: /line spacing/i })
  await expect(boxes).toHaveCount(fixture.selected.length)
  for (let i = 0; i < fixture.selected.length; i++) {
    await tabTo(page, boxes.nth(i))
    await page.keyboard.press('Space')
    await expect(boxes.nth(i)).toBeChecked()
  }
  await tabTo(page, page.getByRole('button', { name: new RegExp(`^Review ${fixture.selected.length} selected change`) }))
  await page.keyboard.press('Enter')
  await page.locator('#guided-fixes-file-input').setInputFiles(fixture.file)
  await tabTo(page, page.getByRole('button', { name: 'Review safety and locations', exact: true }))
}

async function proveLineDownload(page: Page, testInfo: TestInfo, auditId: string, fixture: LineFixture, before: FontAuditSnapshot) {
  const downloads: string[] = []
  const requests: string[] = []
  page.on('download', download => downloads.push(download.suggestedFilename()))
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith(`/api/audit/${auditId}/guided-fixes/download/`)) requests.push(request.url())
  })
  const button = page.getByRole('button', { name: 'Download corrected document', exact: true })
  await tabTo(page, button)
  const pending = page.waitForEvent('download')
  await page.keyboard.press('Enter')
  const download = await pending
  const stream = await download.createReadStream()
  if (!stream) throw new Error('Verified LINE output was not readable')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  const corrected = Buffer.concat(chunks)
  await expect(button).toBeDisabled()
  expect(downloads).toEqual(['line-spacing-evidence_ACA-fixed.docx'])
  expect(requests).toHaveLength(1)
  expect((await page.request.get(requests[0])).status()).toBe(410)
  const proof = JSON.parse(execFileSync(fixture.python, ['-B', '-c', `
import base64, hashlib, io, json, sys, zipfile
from decimal import Decimal
from lxml import etree
data = json.load(sys.stdin)
source, corrected = [base64.b64decode(data[key]) for key in ("source", "corrected")]
ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
with zipfile.ZipFile(io.BytesIO(source)) as a, zipfile.ZipFile(io.BytesIO(corrected)) as b:
    assert set(a.namelist()) == set(b.namelist())
    changed = [name for name in a.namelist() if a.read(name) != b.read(name)]
    assert set(changed) <= {"word/document.xml", "docProps/core.xml", "docProps/app.xml"}
    metadata_changes = {}
    for name in a.namelist():
        if name == "word/document.xml":
            continue
        if name not in {"docProps/core.xml", "docProps/app.xml"}:
            assert a.read(name) == b.read(name), name
            continue
        trees = [etree.parse(io.BytesIO(z.read(name)), etree.XMLParser(resolve_entities=False, no_network=True)) for z in (a, b)]
        roots = [tree.getroot() for tree in trees]
        assert roots[0].tag == roots[1].tag
        allowed = ({"{http://purl.org/dc/terms/}modified"} if name == "docProps/core.xml" else
          {"{http://schemas.openxmlformats.org/officeDocument/2006/extended-properties}" + field
           for field in ("TotalTime", "Pages", "Words", "Characters", "CharactersWithSpaces", "Lines", "Paragraphs")})
        metadata_changes[name] = [
            {"tag": child.tag, "source_text": child.text, "output_text": saved.text}
            for child, saved in zip(roots[0], roots[1])
            if child.tag == saved.tag and child.tag in allowed and child.text != saved.text
        ]
        for root in roots:
            for child in root:
                if child.tag in allowed:
                    assert len(child) == 0, "Complex save metadata is not authorized"
                    child.text = None
        assert etree.tostring(trees[0], method="c14n") == etree.tostring(trees[1], method="c14n"), name
    old, new = [etree.fromstring(z.read("word/document.xml")) for z in (a, b)]
    old_p, new_p = [root.findall("w:body/w:p", ns) for root in (old, new)]
    assert len(old_p) == len(new_p)
    raw = []
    for selected in data["selected"]:
        index = selected["index"]
        required = Decimal(selected["required"]) * 240
        assert required == required.to_integral_value()
        original, saved = [paras[index].find("w:pPr/w:spacing", ns) for paras in (old_p, new_p)]
        line, rule = ["{%s}%s" % (ns["w"], attr) for attr in ("line", "lineRule")]
        assert saved.get(line) == str(int(required))
        assert saved.get(rule) == "auto"
        raw.append({"index": index, "line": saved.get(line), "lineRule": saved.get(rule)})
        for attr in (line, rule):
            if attr in original.attrib: saved.set(attr, original.get(attr))
            else: saved.attrib.pop(attr, None)
    assert etree.tostring(old, method="c14n") == etree.tostring(new, method="c14n")
    witnesses = {name: name in a.namelist() for name in ["word/styles.xml", "word/numbering.xml", "word/header1.xml", "word/footer1.xml"]}
print(json.dumps({"source_sha256": hashlib.sha256(source).hexdigest(), "corrected_sha256": hashlib.sha256(corrected).hexdigest(),
 "changed_parts": changed, "selected_raw": raw, "package_witnesses": witnesses, "bounded_metadata_changes": metadata_changes,
 "unchanged_after_exact_two_attribute_mask": True}))
`], { cwd: fixture.backendDir, encoding: 'utf8', input: JSON.stringify({
    source: fixture.docx, corrected: corrected.toString('base64'), selected: fixture.selected,
  }) }))
  expect(proof.source_sha256).toBe(createHash('sha256').update(fixture.file.buffer).digest('hex'))
  expect(proof.corrected_sha256).not.toBe(proof.source_sha256)
  for (const [name, body, contentType] of [
    ['line-original.docx', fixture.file.buffer, fixture.file.mimeType],
    ['line-corrected.docx', corrected, fixture.file.mimeType],
    ['line-package-proof.json', JSON.stringify(proof, null, 2), 'application/json'],
    ['line-download-events.json', JSON.stringify({ downloads, requests, oneUseStatus: 410 }), 'application/json'],
  ] as const) await testInfo.attach(name, { body, contentType })
  expect(await (await page.request.get(`/api/audit/${auditId}`)).json()).toEqual(before)
  const historical = await lineHistoricalWitness(page, auditId, fixture)
  expect(historical.audit).toEqual(fixture.historical?.audit)
  expect(historical.history).toEqual(fixture.historical?.history)
  expect(historical.pdfPages).toEqual(fixture.historical?.pdfPages)
  await testInfo.attach('line-original-audit-before.pdf', { body: Buffer.from(fixture.historical!.pdf, 'base64'), contentType: 'application/pdf' })
  await testInfo.attach('line-original-audit-after.pdf', { body: Buffer.from(historical.pdf, 'base64'), contentType: 'application/pdf' })
  await testInfo.attach('line-history-pdf-proof.json', { body: JSON.stringify({
    before: fixture.historical, after: historical, comparison: 'persisted API/History and extracted PDF page text/decoded streams; PDF metadata is not treated as historical content',
  }, null, 2), contentType: 'application/json' })
  const reaudit = await page.request.post('/api/audit', {
    multipart: { file: { ...fixture.file, buffer: corrected }, custom_profile: JSON.stringify(fixture.profile) }, timeout: 90_000,
  })
  expect(reaudit.ok(), await reaudit.text()).toBe(true)
  const result = await reaudit.json()
  expect(result.physical_layout_errors.filter((v: { rule_code: string }) => v.rule_code === 'LINE_SPACING')).toEqual([])
  const saved = await (await page.request.get(`/api/audit/${result.audit_id}`)).json() as FontAuditSnapshot
  const untouched = [saved, before].map(audit => audit.violations.filter(v => v.rule_code !== 'LINE_SPACING')
    .map(({ rule_code, severity, location, actual_value, expected_value }) =>
      JSON.stringify({ rule_code, severity, location, actual_value, expected_value })).sort())
  expect(untouched[0]).toEqual(untouched[1])
  expect(saved.weighted_score).toBeGreaterThanOrEqual(before.weighted_score)
  for (const row of saved.score_breakdown) {
    expect(row.deduction).toBeLessThanOrEqual(before.score_breakdown.find(item => item.category === row.category)?.deduction ?? 0)
  }
  await testInfo.attach('line-independent-reaudit.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
}

test.describe('direct auto LINE evidence @line-spacing', () => {
  for (const options of [
    { raw: 240, required: 1.5 }, { raw: 360, required: 2 }, { raw: 480, required: 1.5 },
    { raw: 276, required: 1.5 }, { raw: 241, required: 1.5 }, { raw: 480, required: 1 },
    { raw: 480, required: 1.15 }, { raw: 480, required: 1.0125 }, { raw: 360, required: 1.0125 }, { raw: 240, required: 4 },
    { count: 3 }, { reference: true }, { appendix: true },
  ] satisfies LineCase[]) {
    test(`supported line ${JSON.stringify(options)} completes keyboard Review Apply Download with exact raw proof`, async ({ page }, testInfo) => {
      const fixture = lineFixture(options)
      const { auditId, before } = await openLineAudit(page, fixture)
      if (options.raw === 360 && options.required === 1.0125) {
        expect(before.violations.filter(v => v.rule_code === 'LINE_SPACING')).toHaveLength(1)
      }
      await selectLineChanges(page, fixture)
      const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/guided-fixes/review'))
      await page.keyboard.press('Enter')
      const reviewed = await response
      expect(reviewed.status()).toBe(200)
      const review = await reviewed.json()
      if (options.reference) {
        const expected = before.violations.filter(v => v.rule_code === 'LINE_SPACING').map(v => v.expected_value).sort()
        expect(expected).toHaveLength(fixture.selected.length)
        const after = review.items.map((item: { after: string }) => item.after).sort()
        expect(after).toEqual(expected)
        await testInfo.attach('line-review-values.json', { body: JSON.stringify({ expected, after }), contentType: 'application/json' })
      } else {
        expect(review.items.map((item: { after: string }) => item.after).sort()).toEqual(fixture.selected.map(item => item.required).sort())
      }
      await expect(page.getByRole('button', { name: 'Apply and verify changes', exact: true })).toBeVisible()
      await fontEvidence(page, testInfo, 'line-confirmed-review')
      await tabTo(page, page.getByRole('button', { name: 'Apply and verify changes', exact: true }))
      await page.keyboard.press('Enter')
      await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed', exact: true })).toBeVisible({ timeout: 60_000 })
      await proveLineDownload(page, testInfo, auditId, fixture, before)
      await tabTo(page, page.getByRole('button', { name: 'Close', exact: true }))
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: /^Guided Fixes/ })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: 'Review 0 selected changes', exact: true })).toBeDisabled()
    })
  }

  for (const options of [
    { rule: 'exact' }, { rule: 'atLeast' }, { rule: 'missing' },
    { required: 1.501 }, { required: 1.333 },
    { count: 2, unsafe: 'inherited' }, { count: 2, unsafe: 'grid' }, { count: 2, unsafe: 'snap' },
    { count: 2, unsafe: 'bookmark' }, { count: 2, unsafe: 'numbered' },
  ] satisfies LineCase[]) {
    test(`unsupported line ${JSON.stringify(options)} refuses confirmed Review atomically`, async ({ page }, testInfo) => {
      const fixture = lineFixture(options)
      const { auditId, before } = await openLineAudit(page, fixture)
      const downloads: string[] = []
      page.on('download', event => downloads.push(event.suggestedFilename()))
      await selectLineChanges(page, fixture)
      const pending = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/guided-fixes/review'))
      await page.keyboard.press('Enter')
      const response = await pending
      expect(response.status()).toBe(422)
      const rejected = await response.json()
      expect(rejected).not.toHaveProperty('review_id')
      expect(rejected).not.toHaveProperty('download_token')
      await expect(page.getByRole('alert')).toContainText('Fix cannot be applied safely.')
      await expect(page.getByRole('button', { name: 'Apply and verify changes', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Download corrected document', exact: true })).toHaveCount(0)
      expect(downloads).toEqual([])
      expect(await (await page.request.get(`/api/audit/${auditId}`)).json()).toEqual(before)
      await fontEvidence(page, testInfo, 'line-manual-refusal')
      await testInfo.attach('line-review-refusal.json', { body: JSON.stringify(rejected), contentType: 'application/json' })
    })
  }

  test('inherited-only spacing has no invented LINE finding or selectable candidate', async ({ page }, testInfo) => {
    const fixture = lineFixture({ unsafe: 'inherited-only' })
    const { before } = await openLineAudit(page, fixture)
    expect(before.violations.filter(v => v.rule_code === 'LINE_SPACING')).toEqual([])
    await expect(page.getByRole('checkbox', { name: /line spacing/i })).toHaveCount(0)
    await testInfo.attach('line-inherited-no-finding.json', { body: JSON.stringify(before), contentType: 'application/json' })
    await testInfo.attach('line-inherited-no-candidate.png', { body: await page.screenshot(), contentType: 'image/png' })
  })

  test('wrong original is refused before confirmed LINE Review', async ({ page }, testInfo) => {
    const fixture = lineFixture()
    const { auditId, before } = await openLineAudit(page, fixture)
    await selectLineChanges(page, fixture)
    await page.locator('#guided-fixes-file-input').setInputFiles(lineFixture({ raw: 480 }).file)
    const pending = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/guided-fixes/review'))
    await tabTo(page, page.getByRole('button', { name: 'Review safety and locations', exact: true }))
    await page.keyboard.press('Enter')
    const rejected = await pending
    expect(rejected.status()).toBe(409)
    await expect(page.getByRole('alert')).toContainText(MISMATCH_TEXT)
    await expect(page.getByRole('button', { name: 'Apply and verify changes', exact: true })).toHaveCount(0)
    expect(await (await page.request.get(`/api/audit/${auditId}`)).json()).toEqual(before)
    await testInfo.attach('line-wrong-original.json', { body: await rejected.body(), contentType: 'application/json' })
  })

  test('required Reference page evidence refuses publication when owned renderer is unavailable', async ({ page }, testInfo) => {
    test.skip(process.env.ACA_LINE_FAULT_APP !== '1' || process.env.ACA_LINE_RENDERER_UNAVAILABLE !== '1',
      'Requires the isolated renderer-denying external fault wrapper.')
    const fixture = lineFixture({ reference: true, pageEvidence: true })
    const { auditId, before } = await openLineAudit(page, fixture)
    const preview = await page.request.get(`/api/audit/${auditId}/rendered-preview`)
    expect(preview.status()).toBe(409)
    const stateURL = `/api/__aca-line-evidence/${auditId}`
    const baselineResponse = await page.request.get(stateURL)
    expect(baselineResponse.ok()).toBe(true)
    const baseline = await baselineResponse.json()
    expect(baseline.output_tokens).toBe(0)
    const originalSha = createHash('sha256').update(fixture.file.buffer).digest('hex')
    const downloads: string[] = []
    const downloadRequests: string[] = []
    page.on('download', event => downloads.push(event.suggestedFilename()))
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith(`/api/audit/${auditId}/guided-fixes/download/`)) downloadRequests.push(request.url())
    })
    await selectLineChanges(page, fixture)
    await page.keyboard.press('Enter')
    const apply = page.getByRole('button', { name: 'Apply and verify changes', exact: true })
    await expect(apply).toBeVisible({ timeout: 60_000 })
    const pending = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/audit/${auditId}/guided-fixes`)
    await tabTo(page, apply)
    await page.keyboard.press('Enter')
    const response = await pending
    expect(response.status()).toBe(422)
    const rejected = await response.json()
    expect(rejected).not.toHaveProperty('download_token')
    expect(rejected).not.toHaveProperty('output_filename')
    await expect(page.getByRole('button', { name: 'Download corrected document', exact: true })).toHaveCount(0)
    expect(downloads).toEqual([])
    expect(downloadRequests).toEqual([])
    expect(createHash('sha256').update(fixture.file.buffer).digest('hex')).toBe(originalSha)
    const afterState = await (await page.request.get(stateURL)).json()
    expect(afterState).toEqual(baseline)
    expect(await (await page.request.get(`/api/audit/${auditId}`)).json()).toEqual(before)
    await testInfo.attach('line-required-renderer-refusal.json', {
      body: JSON.stringify({ rejected, baseline, afterState, downloads, downloadRequests, originalSha }), contentType: 'application/json',
    })
  })

  for (const transition of ['audit switch', 'close'] as const) {
    test(`delayed genuine LINE Download after ${transition} is suppressed and later valid Download succeeds`, async ({ page }, testInfo) => {
      const fixture = lineFixture({ reference: true })
      const first = await openLineAudit(page, fixture)
      const second = await openLineAudit(page, fixture)
      await page.goto(`/audit/${first.auditId}`)
      await selectLineChanges(page, fixture)
      await page.keyboard.press('Enter')
      const apply = page.getByRole('button', { name: 'Apply and verify changes', exact: true })
      await expect(apply).toBeVisible({ timeout: 60_000 })
      await tabTo(page, apply)
      await page.keyboard.press('Enter')
      await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed', exact: true })).toBeVisible({ timeout: 60_000 })
      const received = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const downloads: string[] = []
      page.on('download', event => downloads.push(event.suggestedFilename()))
      const pattern = `**/api/audit/${first.auditId}/guided-fixes/download/*`
      await page.route(pattern, async route => {
        const response = await route.fetch()
        expect(response.status()).toBe(200)
        received.resolve()
        await release.promise
        await route.fulfill({ response })
      })
      try {
        await tabTo(page, page.getByRole('button', { name: 'Download corrected document', exact: true }))
        await page.keyboard.press('Enter')
        await received.promise
        await expect(page.getByRole('status').filter({ hasText: /^Downloading…$/ })).toHaveCount(1)
        if (transition === 'audit switch') {
          await page.evaluate(id => {
            window.history.pushState({}, '', `/audit/${id}`)
            window.dispatchEvent(new PopStateEvent('popstate'))
          }, second.auditId)
        } else {
          await tabTo(page, page.getByRole('button', { name: 'Close', exact: true }))
          await page.keyboard.press('Enter')
        }
        await expect(page.getByRole('dialog')).toHaveCount(0)
        const settled = page.waitForResponse(r => new URL(r.url()).pathname.startsWith(`/api/audit/${first.auditId}/guided-fixes/download/`))
        release.resolve()
        await settled
        await page.waitForLoadState('networkidle')
        expect(downloads).toEqual([])
        await expect(page.getByText('Downloaded. The one-use link has expired.', { exact: true })).toHaveCount(0)
        await page.unroute(pattern)
        await testInfo.attach(`line-stale-${transition}-suppressed.png`, { body: await page.screenshot(), contentType: 'image/png' })
        await selectLineChanges(page, fixture)
        await page.keyboard.press('Enter')
        await expect(apply).toBeVisible({ timeout: 60_000 })
        await tabTo(page, apply)
        await page.keyboard.press('Enter')
        await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed', exact: true })).toBeVisible({ timeout: 60_000 })
        const later = transition === 'audit switch' ? second : first
        fixture.historical = await lineHistoricalWitness(page, later.auditId, fixture)
        await proveLineDownload(page, testInfo, later.auditId, fixture, later.before)
        expect(downloads).toHaveLength(1)
      } finally {
        release.resolve()
        await page.unroute(pattern)
        await testInfo.attach(`line-stale-${transition}-events.json`, { body: JSON.stringify({ transition, downloads }), contentType: 'application/json' })
      }
    })
  }

  for (const fault of ['raw-plus-one', 'missing-rule', 'wrong-rule', 'absolute-alias', 'group-last337', 'unchanged-last',
    'text', 'run-boundary', 'preservation', 'reaudit', 'storage']) {
    test(`synthetic line ${fault} fails publication then permits later genuine recovery`, async ({ page }, testInfo) => {
      test.skip(process.env.ACA_LINE_FAULT_APP !== '1', 'Requires task-owned external synthetic fault app')
      const fixture = lineFixture({ count: 2, required: fault === 'absolute-alias' ? 2 : 1.5 })
      const { auditId, before } = await openLineAudit(page, fixture)
      const stateURL = `/api/__aca-line-evidence/${auditId}`
      const baselineResponse = await page.request.get(stateURL)
      expect(baselineResponse.ok()).toBe(true)
      const baseline = await baselineResponse.json()
      await selectLineChanges(page, fixture)
      await page.keyboard.press('Enter')
      const apply = page.getByRole('button', { name: 'Apply and verify changes', exact: true })
      await expect(apply).toBeVisible({ timeout: 60_000 })
      const endpoint = `**/api/audit/${auditId}/guided-fixes`
      await page.route(endpoint, route => route.continue({ headers: {
        ...route.request().headers(), 'x-aca-synthetic-line-fault': fault,
      } }))
      const downloads: string[] = []
      page.on('download', event => downloads.push(event.suggestedFilename()))
      const pending = page.waitForResponse(r => r.request().method() === 'POST'
        && new URL(r.url()).pathname === `/api/audit/${auditId}/guided-fixes`)
      await tabTo(page, apply)
      await page.keyboard.press('Enter')
      const response = await pending
      expect(response.status()).toBe(fault === 'storage' ? 503 : 422)
      const rejected = await response.json()
      expect(rejected).not.toHaveProperty('download_token')
      expect(rejected).not.toHaveProperty('output_filename')
      await expect(page.getByRole('alert')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Download corrected document', exact: true })).toHaveCount(0)
      const after = await (await page.request.get(stateURL)).json()
      expect(after.record_sha256).toBe(baseline.record_sha256)
      expect(after.output_tokens).toBe(0)
      expect(after.all_output_file_count).toBe(baseline.all_output_file_count)
      expect(after.fault_events.length).toBeGreaterThan(0)
      expect(downloads).toEqual([])
      expect(await (await page.request.get(`/api/audit/${auditId}`)).json()).toEqual(before)
      const historical = await lineHistoricalWitness(page, auditId, fixture)
      expect(historical.history).toEqual(fixture.historical?.history)
      expect(historical.pdfPages).toEqual(fixture.historical?.pdfPages)
      await testInfo.attach(`line-${fault}-original-report.pdf`, { body: Buffer.from(historical.pdf, 'base64'), contentType: 'application/pdf' })
      await testInfo.attach(`line-${fault}-publication.json`, {
        body: JSON.stringify({ fault, status: response.status(), rejected, baseline, after, downloads }, null, 2), contentType: 'application/json',
      })
      await fontEvidence(page, testInfo, `line-${fault}-failure`)
      await page.unroute(endpoint)
      await tabTo(page, page.getByRole('button', { name: 'Review safety and locations', exact: true }))
      await page.keyboard.press('Enter')
      await expect(apply).toBeVisible({ timeout: 60_000 })
      await tabTo(page, apply)
      await page.keyboard.press('Enter')
      await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed', exact: true })).toBeVisible({ timeout: 60_000 })
      await proveLineDownload(page, testInfo, auditId, fixture, before)
      expect(downloads).toHaveLength(1)
    })
  }

  test('native 100/200 percent LINE Review supports overflow keyboard, Back, Apply and Download @line-native', async ({}, testInfo) => {
    const controller = process.env.ACA_LINE_NATIVE_CONTROLLER
    test.skip(!controller, 'Requires external task-owned native Chrome controller')
    test.setTimeout(600_000)
    // External runtime-selected controller exists only in the authorized evidence root.
    const { launchNative } = await import(controller!)
    const native = await launchNative(testInfo.outputPath('line-native'))
    const page = native.page as Page
    try {
      const fixture = lineFixture({ count: 12, reference: true })
      const { auditId, before } = await openLineAudit(page, fixture)
      await selectLineChanges(page, fixture)
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: 'Apply and verify changes', exact: true })).toBeVisible({ timeout: 60_000 })
      for (const [width, height] of [[1366, 768], [1280, 800], [1024, 768], [960, 768], [768, 768]]) {
        await native.setWindow(width, height)
        let baseline: { outerWidth: number; outerHeight: number; innerWidth: number; innerHeight: number; devicePixelRatio: number } | undefined
        for (const zoom of [1, 2]) {
          const actualZoom = await native.setZoom(zoom)
          const state = `line-review-${width}-${height}-native-${zoom * 100}`
          const dimensions = await fontEvidence(page, testInfo, state)
          expect(actualZoom).toBe(zoom)
          if (zoom === 1) baseline = dimensions
          else {
            expect(dimensions.outerWidth).toBe(baseline!.outerWidth)
            expect(dimensions.outerHeight).toBe(baseline!.outerHeight)
            expect(dimensions.devicePixelRatio).toBe(baseline!.devicePixelRatio * 2)
            expect(Math.abs(dimensions.innerWidth * 2 - baseline!.innerWidth)).toBeLessThanOrEqual(2)
            expect(Math.abs(dimensions.innerHeight * 2 - baseline!.innerHeight)).toBeLessThanOrEqual(2)
          }
          await reviewKeyboardEvidence(page, testInfo, state, zoom === 2)
          const scroll = page.locator(reviewScrollSelector)
          await scroll.focus()
          await page.keyboard.press('End')
          await native.capture(`${state}-review-scrolled-bottom`, scroll)
          await tabTo(page, page.getByRole('button', { name: 'Apply and verify changes', exact: true }))
          await testInfo.attach(`${state}-native-zoom.json`, { body: JSON.stringify({ actualZoom, dimensions }), contentType: 'application/json' })
        }
      }
      await native.setZoom(1)
      await tabTo(page, page.getByRole('button', { name: 'Cancel review', exact: true }))
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: 'Review safety and locations', exact: true })).toBeVisible()
      await tabTo(page, page.getByRole('button', { name: 'Review safety and locations', exact: true }))
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: 'Apply and verify changes', exact: true })).toBeVisible()
      await tabTo(page, page.getByRole('button', { name: 'Apply and verify changes', exact: true }))
      await page.keyboard.press('Enter')
      await expect(page.getByRole('heading', { name: 'Fix applied; re-audit passed', exact: true })).toBeVisible({ timeout: 60_000 })
      await proveLineDownload(page, testInfo, auditId, fixture, before)
      await tabTo(page, page.getByRole('button', { name: 'Close', exact: true }))
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: /^Guided Fixes/ })).toBeFocused()
      const manual = lineFixture({ rule: 'exact' })
      const manualAudit = await openLineAudit(page, manual)
      await selectLineChanges(page, manual)
      await page.keyboard.press('Enter')
      await expect(page.getByRole('alert')).toContainText('Fix cannot be applied safely.')
      for (const [width, height] of [[1366, 768], [1280, 800], [1024, 768], [960, 768], [768, 768]]) {
        await native.setWindow(width, height)
        for (const zoom of [1, 2]) {
          await native.setZoom(zoom)
          await fontEvidence(page, testInfo, `line-manual-${width}-${height}-native-${zoom * 100}`)
          await tabTo(page, page.getByRole('button', { name: 'Back to findings', exact: true }).last())
          await native.capture(`line-manual-${width}-${height}-native-${zoom * 100}`)
        }
      }
      await expect(page.getByRole('button', { name: 'Apply and verify changes', exact: true })).toHaveCount(0)
      expect(await (await page.request.get(`/api/audit/${manualAudit.auditId}`)).json()).toEqual(manualAudit.before)
    } finally {
      await native.close()
    }
  })
})
