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
  /** 'before' = mark top boundary, 'after' = mark bottom boundary, null = no side marker. */
  spacingSide: 'before' | 'after' | null
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
    return { kind: 'none', pageRects: [], label: null, message: null, spacingSide: null }
  }
  const paraIndex = getParagraphIndex(finding.location)
  if (paraIndex === null) return { kind: 'none', pageRects: [], label: null, message: null, spacingSide: null }

  const mapped = bundle.byIndex.get(paraIndex)
  if (!mapped || mapped.pageNumber === null) {
    // No page mapping: navigation falls back to Extracted Text.
    return { kind: 'none', pageRects: [], label: null, message: null, spacingSide: null }
  }

  const page = bundle.pages.find((p) => p.pageNumber === mapped.pageNumber)
  if (!page) {
    return { kind: 'none', pageRects: [], label: null, message: null, spacingSide: null }
  }

  const rule = finding.ruleCode ?? ''
  // Spacing side: computed once from ruleCode, used by overlay renderer.
  const spacingSide = rule === 'SPACE_BEFORE' ? 'before' : rule === 'SPACE_AFTER' ? 'after' : null
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
        return { kind: 'run', pageRects: rects, label: runLabel, message: null, spacingSide }
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
          return { kind: 'run', pageRects: lineRects, label: runLabel, message: null, spacingSide }
        }
      }
    }
    // Run evidence unavailable/ambiguous → paragraph-level fallback.
    const fallback = paragraphRegion(bundle, paraIndex, measure)
    if (fallback) {
      return { kind: 'paragraph', pageRects: fallback, label: runLabel, message: RUN_FALLBACK_MESSAGE, spacingSide }
    }
    return { kind: 'paragraph', pageRects: [], label: runLabel, message: REGION_UNAVAILABLE_MESSAGE, spacingSide }
  }

  // Paragraph-level: enclosing region from the mapped paragraph text.
  const region = paragraphRegion(bundle, paraIndex, measure)
  if (region) {
    return { kind: 'paragraph', pageRects: region, label: runLabel, message: null, spacingSide }
  }
  return { kind: 'paragraph', pageRects: [], label: runLabel, message: REGION_UNAVAILABLE_MESSAGE, spacingSide }
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
 *
 * Fallback (Build 9): when the contiguous walk stalls because the rendered
 * text carries content the block text lacks — a Word SEQ field number
 * (block `Figure : ...` vs rendered `Figure 1: ...`) or wrapped/split
 * items — a UNIQUE prefix+suffix anchor on the MAPPED page resolves the
 * paragraph's real line(s): the line window that starts with the block's
 * first word and ends with its last word(s). Exactly one such window →
 * region; more than one → null (never guess).
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

  if (remaining.length > 0) {
    // Contiguous walk stalled (e.g. SEQ-field number only in the rendered
    // PDF). Unique prefix+suffix anchor on the MAPPED page is the last
    // truthful resort — it never spans pages and never guesses.
    const mappedPage = pages.find((p) => p.pageNumber === mapped.pageNumber)
    if (mappedPage) {
      const anchored = anchorRegionOnPage(
        mappedPage,
        paraText,
        mappedPage.pageWidth ?? 595,
        mappedPage.pageHeight ?? 842,
      )
      if (anchored) return [anchored]
    }
    return null // unmatched tail → no region
  }

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

const ANCHOR_LINE_Y_TOLERANCE = 3

function squeeze(s: string): string {
  return s.replace(/\s+/g, '')
}

/** Visual lines of a page: items grouped by y (header/footer excluded). */
function itemLines(page: PageText): Array<{ y: number; text: string; items: TextItemLike[] }> {
  const lines: Array<{ y: number; text: string; items: TextItemLike[] }> = []
  const items = page.items ?? []
  for (let i = 0; i < items.length; i++) {
    if (page.headerFooterItemIndices?.has(i)) continue
    const it = items[i]
    const sq = squeeze(normalizeText(it.str))
    if (!sq) continue
    const y = it.transform[5] ?? 0
    const line = lines.find((l) => Math.abs(l.y - y) < ANCHOR_LINE_Y_TOLERANCE)
    if (line) {
      line.items.push(it)
      line.text += sq
    } else {
      lines.push({ y, text: sq, items: [it] })
    }
  }
  return lines
}

/**
 * Unique prefix+suffix anchor on ONE page (fallback when the contiguous
 * text walk stalls — e.g. Word SEQ fields render a number the block text
 * lacks). The block's first word must start a visual line and its last
 * word(s) must end a visual line; exactly ONE contiguous line window may
 * satisfy both — otherwise null (never guess). Longest suffix wins (most
 * specific); a shorter suffix is only tried when no longer suffix matched.
 */
function anchorRegionOnPage(
  page: PageText,
  blockText: string,
  pageWidth: number,
  pageHeight: number,
): CitationRect | null {
  const words = normalizeText(blockText).split(/\s+/).filter(Boolean)
  if (words.length < 2) return null
  const prefix = squeeze(words[0])
  if (!prefix) return null
  const lines = itemLines(page)
  if (lines.length === 0) return null

  // Longest suffix first: the most specific evidence. Return the first
  // length with exactly one window. Zero matches → try a shorter suffix.
  // >1 matches → ambiguous at every shorter length too (those lines also
  // end with any suffix of this one) → never guess.
  for (let len = words.length - 1; len >= 1; len--) {
    const suffix = squeeze(words.slice(words.length - len).join(' '))
    if (!suffix) continue
    const matches: Array<{ start: number; end: number }> = []
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].text.startsWith(prefix)) continue
      for (let j = i; j < lines.length; j++) {
        if (lines[j].text.endsWith(suffix)) {
          matches.push({ start: i, end: j })
          break
        }
      }
    }
    if (matches.length === 1) {
      const { start, end } = matches[0]
      const items = lines.slice(start, end + 1).flatMap((l) => l.items)
      const rects: CitationRect[] = items.map((it) => ({
        page: page.pageNumber,
        x: (it.transform[4] ?? 0) / pageWidth,
        y: (it.transform[5] ?? 0) / pageHeight,
        width: (it.width ?? 0) / pageWidth,
        height: (it.height ?? 0) / pageHeight,
      }))
      return enclose(rects, pageWidth, pageHeight)
    }
    if (matches.length > 1) return null
  }
  return null
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

/** Fixed visual band thickness as a page-height fraction. */
export const SPACING_BAND_PCT = 0.02

/**
 * CSS `top` (percent of the page) for the spacing-boundary band.
 *
 * PDF rects are bottom-left origin; CSS top is measured from the top:
 *   paragraph top edge    = 1 - rect.y - rect.height
 *   paragraph bottom edge = 1 - rect.y
 * SPACE_BEFORE marks the TOP boundary (band above the paragraph);
 * SPACE_AFTER  marks the BOTTOM boundary (band below the paragraph).
 * The band is a fixed visual thickness — it never claims to represent the
 * actual point spacing.
 */
export function spacingBandTopPct(
  side: 'before' | 'after',
  rect: { y: number; height: number },
): number {
  if (side === 'before') {
    return (1 - rect.y - rect.height) * 100 - SPACING_BAND_PCT * 100
  }
  return (1 - rect.y) * 100
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
