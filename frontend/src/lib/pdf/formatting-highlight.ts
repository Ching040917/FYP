/**
 * Formatting evidence highlights (Build 7) — pure logic.
 *
 * Deterministic formatting findings get truthful evidence overlays in the
 * rendered PDF:
 *   - Run-level (FONT_CONSISTENCY / FONT_SIZE): exact run text highlight
 *     ONLY when run text evidence exists and matches unambiguously; never
 *     guessed. Without run evidence → paragraph-level marker + truthful
 *     message.
 *   - Paragraph-level (ALIGNMENT / LINE_SPACING / SPACE_BEFORE /
 *     SPACE_AFTER / HEADING_HIERARCHY): one enclosing region computed from
 *     the mapped paragraph's real line rectangles; paragraphs spanning two
 *     pages get one region per page portion.
 *
 * Never guesses: ambiguous or unmatched text yields no region, only a
 * truthful message. The caller keeps Rendered Pages whenever the paragraph
 * page mapping exists.
 */
import {
  normalizeText,
  type BlockMapping,
  type PageText,
  type TextItemLike,
} from './paragraph-mapping.ts'
import { measurePdfText, type MeasureText } from './pdf-measure.ts'
import { matchCitationOnPage, type CitationRect } from './citation-highlight.ts'

export type FormattingEvidenceKind = 'run' | 'paragraph' | 'none'

export interface FormattingHighlightResult {
  kind: FormattingEvidenceKind
  /** One normalized rect per page portion (envelope for paragraphs). */
  pageRects: CitationRect[]
  /** Chip label (rule + paragraph/run identity), or null. */
  label: string | null
  /** Truthful limitation message when exact geometry is unavailable. */
  message: string | null
}

export const RUN_FALLBACK_MESSAGE =
  'The exact text range could not be highlighted. The affected paragraph is marked instead.'
export const REGION_UNAVAILABLE_MESSAGE =
  'The finding is on this page, but an exact visual region is unavailable. Review the evidence in Finding Details.'

export const FORMATTING_RULES: ReadonlySet<string> = new Set([
  'FONT_CONSISTENCY',
  'FONT_SIZE',
  'ALIGNMENT',
  'LINE_SPACING',
  'SPACE_BEFORE',
  'SPACE_AFTER',
  'HEADING_HIERARCHY',
])

export const FORMATTING_LABELS: Record<string, string> = {
  FONT_CONSISTENCY: 'Font consistency',
  FONT_SIZE: 'Font size',
  ALIGNMENT: 'Alignment',
  LINE_SPACING: 'Line spacing',
  SPACE_BEFORE: 'Space before',
  SPACE_AFTER: 'Space after',
  HEADING_HIERARCHY: 'Heading hierarchy',
}

export type FindingLike = {
  id: string
  ruleCode?: string | null
  message?: string | null
  location?: Record<string, unknown> | null
}

export type EvidenceBundle = {
  byIndex: Map<number, BlockMapping>
  pages: PageText[]
  blocks?: Array<{ index: number; text: string }>
}

/** Overlay family for a rule: citation, formatting, or none. */
export function evidenceFamily(ruleCode: string | null | undefined): 'citation' | 'formatting' | 'none' {
  if (ruleCode === 'CITATION_MISMATCH') return 'citation'
  if (ruleCode && FORMATTING_RULES.has(ruleCode)) return 'formatting'
  return 'none'
}

/**
 * Resolve the formatting evidence decision for a selected finding.
 * Never throws; never guesses. `runText` is optional persisted/safely
 * derived run text — absent run evidence always falls back to the
 * paragraph marker.
 */
export function resolveFormattingHighlight(
  finding: FindingLike,
  bundle: EvidenceBundle | null | undefined,
  runText: string | null = null,
  measure: MeasureText = measurePdfText,
): FormattingHighlightResult {
  if (!bundle || evidenceFamily(finding.ruleCode) !== 'formatting') {
    return { kind: 'none', pageRects: [], label: null, message: null }
  }
  const paraIndex = getParagraphIndex(finding.location)
  if (paraIndex === null) return { kind: 'none', pageRects: [], label: null, message: null }

  const mapped = bundle.byIndex.get(paraIndex)
  if (!mapped || mapped.pageNumber === null) {
    // No page mapping: navigation falls back to Extracted Text.
    return { kind: 'none', pageRects: [], label: null, message: null }
  }

  const page = bundle.pages.find((p) => p.pageNumber === mapped.pageNumber)
  if (!page) {
    return { kind: 'none', pageRects: [], label: null, message: null }
  }

  const rule = finding.ruleCode ?? ''
  const isRunLevel = rule === 'FONT_CONSISTENCY' || rule === 'FONT_SIZE'
  const runIndex = getRunIndex(finding.location)
  const paragraphNumber = paraIndex + 1
  const runLabel = isRunLevel && runIndex !== null ? `${ruleLabel(rule)} · Paragraph ${paragraphNumber}, Run ${runIndex + 1}` : `${ruleLabel(rule)} · Paragraph ${paragraphNumber}`

  // Run-level: exact highlight only with unambiguous run text evidence.
  if (isRunLevel) {
    const runEvidence = runText && runText.trim() ? runText.trim() : null
    if (runEvidence) {
      const rects = matchCitationOnPage(page, runEvidence, page.pageWidth, page.pageHeight, measure)
      if (rects && rects.length > 0) {
        return { kind: 'run', pageRects: rects, label: runLabel, message: null }
      }
      // Ambiguous run evidence must NOT claim exactness — fall through to
      // the paragraph marker below.
    } else if (runText == null) {
      // NO run evidence at all: single-visible-line shortcut. A paragraph
      // rendered as exactly ONE visual line is a single text unit — the
      // complete paragraph text is safe run evidence (single-run
      // Title/Heading paragraphs). Multi-line paragraphs never take this.
      // An explicitly EMPTY run text is not eligible (nothing to show).
      const fullText = bundle.blocks?.find((b) => b.index === paraIndex)?.text?.trim()
      if (fullText) {
        const lineRects = matchCitationOnPage(page, fullText, page.pageWidth, page.pageHeight, measure)
        if (lineRects && lineRects.length === 1) {
          return { kind: 'run', pageRects: lineRects, label: runLabel, message: null }
        }
      }
    }
    // Run evidence unavailable/ambiguous → paragraph-level fallback.
    const fallback = paragraphRegion(bundle, paraIndex, measure)
    if (fallback) {
      return { kind: 'paragraph', pageRects: fallback, label: runLabel, message: RUN_FALLBACK_MESSAGE }
    }
    return { kind: 'paragraph', pageRects: [], label: runLabel, message: REGION_UNAVAILABLE_MESSAGE }
  }

  // Paragraph-level: enclosing region from the mapped paragraph text.
  const region = paragraphRegion(bundle, paraIndex, measure)
  if (region) {
    return { kind: 'paragraph', pageRects: region, label: runLabel, message: null }
  }
  return { kind: 'paragraph', pageRects: [], label: runLabel, message: REGION_UNAVAILABLE_MESSAGE }
}

/**
 * Enclosing region(s) for the mapped paragraph: one normalized rect per
 * page portion, derived from the paragraph's REAL line rectangles via its
 * own text — never a full-width guess.
 *
 * Pages are matched as a contiguous chain: the longest word-prefix of the
 * remaining paragraph text is matched on the mapped page, then the next
 * portion on the following page (paragraphs spanning two pages get one
 * region per portion). Ambiguity rules: an identical full-text match on a
 * second page returns null (never guess which instance), and any
 * paragraph portion that cannot be matched returns null.
 */
export function paragraphRegion(
  bundle: EvidenceBundle,
  paraIndex: number,
  measure: MeasureText = measurePdfText,
): CitationRect[] | null {
  const mapped = bundle.byIndex.get(paraIndex)
  if (!mapped || mapped.pageNumber === null) return null
  const paraText = bundle.blocks?.find((b) => b.index === paraIndex)?.text
  if (!paraText || !paraText.trim()) return null

  const pages = bundle.pages
  const candidates: PageText[] = []
  for (const n of [mapped.pageNumber, mapped.pageNumber + 1, mapped.pageNumber - 1]) {
    const p = pages.find((pp) => pp.pageNumber === n)
    if (p && !candidates.includes(p)) candidates.push(p)
  }

  let remaining = paraText.trim().split(/\s+/)
  const regions: CitationRect[] = []

  for (const p of candidates) {
    if (remaining.length === 0) break
    const { rects, consumed } = longestPrefixOnPage(p, remaining, measure)
    if (consumed === 0) continue
    const envelope = enclose(rects, p.pageWidth ?? 595, p.pageHeight ?? 842)
    if (envelope) regions.push(envelope)
    remaining = remaining.slice(consumed)
  }

  if (remaining.length > 0) return null // unmatched tail → no region

  // Ambiguity: a paragraph fully contained on the mapped page whose text
  // ALSO appears verbatim on another candidate page is ambiguous.
  if (regions.length === 1) {
    const full = paraText.trim()
    for (const p of candidates) {
      if (p.pageNumber === regions[0].page) continue
      const dup = matchCitationOnPage(p, full, p.pageWidth, p.pageHeight, measure)
      if (dup && dup.length > 0) return null
    }
  }
  return regions.length > 0 ? regions : null
}

/**
 * Longest contiguous word-prefix of `remaining` present on the page, with
 * its line rectangles. Returns consumed word count (0 = nothing matched).
 */
function longestPrefixOnPage(
  page: PageText,
  remaining: string[],
  measure: MeasureText,
): { rects: CitationRect[]; consumed: number } {
  for (let len = remaining.length; len >= 1; len--) {
    const candidate = remaining.slice(0, len).join(' ')
    const rects = matchCitationOnPage(page, candidate, page.pageWidth, page.pageHeight, measure)
    if (rects && rects.length > 0) return { rects, consumed: len }
  }
  return { rects: [], consumed: 0 }
}

/** Merge line rectangles into one padded envelope (per page). */
export function enclose(
  rects: CitationRect[],
  pageWidth: number,
  pageHeight: number,
  padPx = 3,
): CitationRect | null {
  if (rects.length === 0) return null
  const padX = padPx / pageWidth
  const padY = padPx / pageHeight
  const x0 = Math.min(...rects.map((r) => r.x))
  const y0 = Math.min(...rects.map((r) => r.y))
  const x1 = Math.max(...rects.map((r) => r.x + r.width))
  const y1 = Math.max(...rects.map((r) => r.y + r.height))
  const x = clamp01(x0 - padX)
  const y = clamp01(y0 - padY)
  const width = clamp01(x1 + padX - x)
  const height = clamp01(y1 + padY - y)
  if (width <= 0 || height <= 0) return null
  return { page: rects[0].page, x, y, width, height }
}

function ruleLabel(rule: string): string {
  return FORMATTING_LABELS[rule] ?? 'Formatting'
}

/**
 * Evidence-bar horizontal offset in CSS pixels from the overlay wrapper's
 * left edge (wrapper == highlighted text rectangle). A fixed gap keeps the
 * marker separate from the first glyph at EVERY zoom level (pixel-based,
 * scale-invariant by construction). Near the page's left edge the gap is
 * clamped so the bar stays visible inside the page and never scrolls.
 */
export function evidenceBarOffsetPx(x: number, pageWidthPx: number, gapPx = 4): number {
  if (pageWidthPx <= 0) return Math.max(0, gapPx)
  return Math.max(0, x * pageWidthPx - gapPx)
}

/** Shared evidence-bar vertical metrics (exact-run AND paragraph-level). */
export const EVIDENCE_BAR_METRICS = {
  widthPx: 3,
  topInsetPx: 2,
  bottomInsetPx: 3,
  /** Explicit transform — independent of PDF zoom / subpixel rounding. */
  translateYPx: 3,
  minHeightPx: 3,
} as const

/** CSS height for the bar: highlight height minus insets, floored positive. */
export function evidenceBarHeight(heightPct: number): string {
  const inset = EVIDENCE_BAR_METRICS.topInsetPx + EVIDENCE_BAR_METRICS.bottomInsetPx
  return `max(${EVIDENCE_BAR_METRICS.minHeightPx}px, calc(${heightPct}% - ${inset}px))`
}

function getParagraphIndex(location: Record<string, unknown> | null | undefined): number | null {
  const n = location?.paragraph_index
  return typeof n === 'number' && n >= 0 ? n : null
}

function getRunIndex(location: Record<string, unknown> | null | undefined): number | null {
  const n = location?.run_index
  return typeof n === 'number' && n >= 0 ? n : null
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

export { normalizeText, type TextItemLike }
