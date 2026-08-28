/**
 * Exact citation highlighting (Build 6) — pure logic.
 *
 * Extracts citation evidence ONLY from the deterministic finding's own
 * fields (violation message, actual_value) — never from AI guidance text.
 * Matches the citation inside the already-mapped PDF page's text items
 * with normalization (NFKC, smart punctuation, whitespace, case) and
 * item-spanning search, then emits a normalized 0..1 page rectangle.
 *
 * Reliability: a single deterministic occurrence → rect; multiple
 * identical occurrences on the page → ambiguous → NO rect (never guess);
 * no occurrence → no rect. Callers navigate to the mapped page regardless
 * and surface a truthful message when the rect is missing.
 */
import {
  normalizeText,
  type BlockLike,
  type BlockMapping,
  type PageText,
  type TextItemLike,
} from './paragraph-mapping.ts'
import { measurePdfText, type MeasureText } from './pdf-measure.ts'

export interface CitationRect {
  page: number
  /** Normalized 0..1 PDF-page coordinates (x/y from bottom-left origin). */
  x: number
  y: number
  width: number
  height: number
}

export interface CitationHighlightResult {
  /** One normalized rect per visual line of the citation (usually one). */
  rects: CitationRect[] | null
  label: string | null
  /** Truthful message when the mapped page exists but no exact rect. */
  message: string | null
}

export const HIGHLIGHT_UNAVAILABLE_MESSAGE =
  'Citation text could not be highlighted exactly. Review the selected evidence in Finding Details.'

// Matches the deterministic sensor's message format:
//   Citation 'Garcia (2018)' was found in text, ...
const CITATION_IN_MESSAGE = /^citation '(.+?) \((\d{4}[a-z]?)\)'/i

export interface CitationEvidence {
  /**
   * The text to match in the PDF: the SOURCE-FAITHFUL matched span verbatim
   * when available (`(Garcia, 2018)`), otherwise the canonical narrative
   * variant (`Garcia (2018)`) — see `sourceFaithful`.
   */
  text: string
  /** Canonical identity — for reference matching and finding identity. */
  author: string
  year: string
  /** True when `text` is the exact matched source span (never reconstructed). */
  sourceFaithful: boolean
}

/**
 * Extract citation evidence from the deterministic finding's own fields.
 *
 * Data boundary: canonical identity (author/year, from the message) is for
 * reference matching and finding identity; SOURCE-FAITHFUL evidence is the
 * exact matched span (`(Garcia, 2018)`) for display and PDF highlighting.
 * When the exact span is already available (the sensor stores it in
 * actual_value), it is used VERBATIM — never reconstructed from author/year.
 * The message is only a compatibility fallback for old audits.
 */
export function extractCitationEvidence(
  message: string | null | undefined,
  actualValue: string | null | undefined,
): CitationEvidence | null {
  // Source-faithful span first — parenthetical AND narrative forms verbatim.
  const fromActual = citationSpan(actualValue)
  if (fromActual) return fromActual
  // Old-audit compatibility: canonical identity from the deterministic
  // message. Only the two explicit safe variants may be derived from it
  // (handled by the variant fallback in resolveCitationHighlight).
  const fromMessage = message ? CITATION_IN_MESSAGE.exec(message.trim()) : null
  if (fromMessage) {
    return {
      text: `${fromMessage[1]} (${fromMessage[2]})`,
      author: fromMessage[1],
      year: fromMessage[2],
      sourceFaithful: false,
    }
  }
  return null
}

/**
 * A source-faithful citation span: parenthetical `(Garcia, 2018)` (with
 * optional locator) or narrative `Garcia (2018)` — matched IN FULL so the
 * complete span including parentheses/comma is preserved verbatim.
 * Multi-author and suffix forms (e.g. `(Smith & Jones, 2020a, p. 12)`) are
 * kept as-is. Returns null when the value is not a complete citation.
 */
function citationSpan(value: string | null | undefined): CitationEvidence | null {
  if (value == null) return null
  const s = String(value).trim()
  if (!s) return null
  const paren = /^\((.+?), (\d{4}[a-z]?)(?:,.*)?\)$/.exec(s)
  if (paren) {
    return { text: s, author: paren[1], year: paren[2], sourceFaithful: true }
  }
  const narr = /^(.+?) \((\d{4}[a-z]?)(?:,.*)?\)$/.exec(s)
  if (narr) {
    return { text: s, author: narr[1], year: narr[2], sourceFaithful: true }
  }
  return null
}

/**
 * Resolve the full highlight decision for a selected finding.
 * Never throws; returns a truthful result the UI can render directly.
 *
 * Primary path: SOURCE-FAITHFUL evidence (the exact matched span) matched
 * on the mapped page. Old-audit compatibility: canonical author/year
 * derives ONLY the two explicit safe variants (`Garcia (2018)` and
 * `(Garcia, 2018)`), searched within the already mapped paragraph only.
 * Variant rules: exactly one candidate → highlight; multiple candidates →
 * no highlight; no candidate → truthful unavailable message. Never a
 * global PDF search, never fuzzy author-only matching.
 */
export function resolveCitationHighlight(
  finding: { id: string; ruleCode?: string | null; message?: string | null; actualValue?: string | null; location?: Record<string, unknown> | null },
  bundle: { byIndex: Map<number, BlockMapping>; pages: PageText[]; blocks?: BlockLike[] } | null | undefined,
): CitationHighlightResult {
  if (!bundle || finding.ruleCode !== 'CITATION_MISMATCH') {
    return { rects: null, label: null, message: null }
  }
  const paraIndex = getParagraphIndex(finding.location)
  if (paraIndex === null) return { rects: null, label: null, message: null }

  const mapped = bundle.byIndex.get(paraIndex)
  if (!mapped || mapped.pageNumber === null) {
    // Navigation falls back to Extracted Text — highlight is moot.
    return { rects: null, label: null, message: null }
  }

  const evidence = extractCitationEvidence(finding.message, finding.actualValue)
  if (!evidence) {
    return { rects: null, label: null, message: HIGHLIGHT_UNAVAILABLE_MESSAGE }
  }

  const page = bundle.pages.find((p) => p.pageNumber === mapped.pageNumber)
  if (!page) {
    return { rects: null, label: null, message: HIGHLIGHT_UNAVAILABLE_MESSAGE }
  }

  // Source-faithful path: the exact span, matched on the mapped page.
  if (evidence.sourceFaithful) {
    const rects = matchCitationOnPage(page, evidence.text)
    return {
      rects,
      label: rects ? evidence.text : null,
      message: rects ? null : HIGHLIGHT_UNAVAILABLE_MESSAGE,
    }
  }

  // Old-audit compatibility: safe variants within the mapped paragraph only.
  const blockText = bundle.blocks?.find((b) => b.index === paraIndex)?.text ?? null
  const variantMatch = matchCitationVariantsOnParagraph(
    page,
    blockText,
    evidence.author,
    evidence.year,
    page.pageWidth,
    page.pageHeight,
  )
  if (!variantMatch) {
    return { rects: null, label: null, message: HIGHLIGHT_UNAVAILABLE_MESSAGE }
  }
  return { rects: variantMatch.rects, label: variantMatch.variant, message: null }
}

/**
 * Match the citation inside a page's text items. Returns one normalized
 * 0..1 rectangle per visual line the citation spans (usually a single
 * rect), or null when unmatched or ambiguous (2+ identical occurrences —
 * never guess which one the finding means).
 *
 * Geometry uses MEASURED glyph-prefix widths (proportional fonts, kerning)
 * scaled by each item's real PDF advance width — never equal-character
 * interpolation.
 */
export function matchCitationOnPage(
  page: PageText,
  evidenceText: string,
  pageWidth?: number,
  pageHeight?: number,
  measure: MeasureText = measurePdfText,
): CitationRect[] | null {
  const target = normalizeText(evidenceText)
  if (!target) return null
  const items = page.items ?? []
  if (items.length === 0) return null

  const occurrences = findNonOverlappingOccurrences(items, target, measure, page.headerFooterItemIndices)
  if (occurrences.length !== 1) return null // 0 = unmatched, 2+ = ambiguous

  const width = pageWidth ?? page.pageWidth ?? 595
  const height = pageHeight ?? page.pageHeight ?? 842

  const rects: CitationRect[] = []
  for (const line of occurrences[0].lines) {
    const { x0, y0, x1, y1 } = line
    const rx = x0 / width
    const ry = y0 / height
    const rw = (x1 - x0) / width
    const rh = (y1 - y0) / height
    // Reject invalid geometry (zero/negative width, NaN, out of page).
    if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rw) || !Number.isFinite(rh)) continue
    if (rw <= 0 || rh <= 0) continue
    rects.push({
      page: page.pageNumber,
      x: clamp01(rx),
      y: clamp01(ry),
      width: clamp01(rw),
      height: clamp01(rh),
    })
  }
  return rects.length > 0 ? rects : null
}

/**
 * Old-audit compatibility fallback: from canonical author/year generate ONLY
 * the two explicit safe variants — `Garcia (2018)` and `(Garcia, 2018)` —
 * and search them within the ALREADY MAPPED PARAGRAPH only (its item
 * window on the page), never the whole PDF and never fuzzy author-only
 * matching. Exactly one candidate match across both variants → highlight;
 * multiple candidates → ambiguous, no highlight; none → null.
 */
export function matchCitationVariantsOnParagraph(
  page: PageText,
  blockText: string | null,
  author: string,
  year: string,
  pageWidth?: number,
  pageHeight?: number,
  measure: MeasureText = measurePdfText,
): { rects: CitationRect[]; variant: string } | null {
  const items = page.items ?? []
  if (items.length === 0 || !blockText) return null
  const window = paragraphItemWindow(items, blockText, page.headerFooterItemIndices)
  if (!window) return null

  const variants = [`${author} (${year})`, `(${author}, ${year})`]
  const width = pageWidth ?? page.pageWidth ?? 595
  const height = pageHeight ?? page.pageHeight ?? 842
  const candidates: Array<{ rects: CitationRect[]; variant: string }> = []
  for (const variant of variants) {
    const target = normalizeText(variant)
    if (!target) continue
    const occurrences = findNonOverlappingOccurrences(
      items,
      target,
      measure,
      page.headerFooterItemIndices,
      window.start,
      window.end,
    )
    if (occurrences.length !== 1) continue // 0 = no match, 2+ = ambiguous within the paragraph
    const rects = rectsFromLines(occurrences[0].lines, page.pageNumber, width, height)
    if (rects.length > 0) candidates.push({ rects, variant })
  }
  if (candidates.length !== 1) return null // multiple candidates → never guess
  return candidates[0]
}

/** Minimal contiguous item window whose squeezed text contains the block. */
function paragraphItemWindow(
  items: TextItemLike[],
  blockText: string,
  headerFooterItemIndices: ReadonlySet<number> = new Set(),
): { start: number; end: number } | null {
  const target = squeeze(normalizeText(blockText))
  if (!target) return null
  const idxs: number[] = []
  items.forEach((it, i) => {
    if (headerFooterItemIndices.has(i)) return
    if (squeeze(normalizeText(it.str)).length > 0) idxs.push(i)
  })
  for (let s = 0; s < idxs.length; s++) {
    let acc = ''
    for (let e = s; e < idxs.length; e++) {
      acc += squeeze(normalizeText(items[idxs[e]].str))
      if (acc.length >= target.length) {
        if (acc.includes(target)) return { start: idxs[s], end: idxs[e] }
        break
      }
    }
  }
  return null
}

function rectsFromLines(
  lines: Array<{ x0: number; y0: number; x1: number; y1: number }>,
  pageNumber: number,
  width: number,
  height: number,
): CitationRect[] {
  const rects: CitationRect[] = []
  for (const line of lines) {
    const rx = line.x0 / width
    const ry = line.y0 / height
    const rw = (line.x1 - line.x0) / width
    const rh = (line.y1 - line.y0) / height
    if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rw) || !Number.isFinite(rh)) continue
    if (rw <= 0 || rh <= 0) continue
    rects.push({
      page: pageNumber,
      x: clamp01(rx),
      y: clamp01(ry),
      width: clamp01(rw),
      height: clamp01(rh),
    })
  }
  return rects.length > 0 ? rects : []
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

// ---------------------------------------------------------------------------
// item-level search
// ---------------------------------------------------------------------------

function squeeze(s: string): string {
  return s.replace(/\s+/g, '')
}

interface Token {
  /** Squeezed-normalized text (matching space). */
  sq: string
  /** Original item text (measurement space, spaces preserved). */
  orig: string
  /** squeezed char index → original char index. */
  map: number[]
  it: TextItemLike
}

const LINE_Y_TOLERANCE = 2

/**
 * Private-use Unicode range (U+E000–U+F8FF). LibreOffice renders bullet
 * markers (•) from the Symbol font as \uF0B7 — a decorative glyph that is
 * NOT part of the paragraph's extracted text and must not participate in
 * evidence matching. Ignoring it here is purely a MATCHING concern: the
 * item's geometry (transform/width) is untouched, so highlight rectangles
 * keep their real positions.
 */
function isPrivateUse(ch: string): boolean {
  const cp = ch.codePointAt(0)
  return cp !== undefined && cp >= 0xe000 && cp <= 0xf8ff
}

function buildToken(it: TextItemLike): Token {
  const map: number[] = []
  let sq = ''
  for (let oi = 0; oi < it.str.length; oi++) {
    for (const ch of normalizeText(it.str[oi])) {
      if (isPrivateUse(ch)) continue
      if (/\s/.test(ch)) continue
      sq += ch
      map.push(oi)
    }
  }
  return { sq, orig: it.str, map, it }
}

/** Original-index of squeezed char `sqIndex` (0 → item start). */
function origIndexAt(tok: Token, sqIndex: number): number {
  if (sqIndex <= 0) return 0
  if (sqIndex >= tok.sq.length) return tok.orig.length
  return tok.map[sqIndex]
}

/**
 * Measured prefix width of a token's original text up to squeezed char
 * index `sqIndex`, as a FRACTION of the token's measured full width.
 * Measured glyph advances (proportional fonts, kerning) replace
 * equal-character interpolation; the fraction is scaled by the item's
 * real PDF width at the call site.
 */
function prefixFraction(tok: Token, sqIndex: number, measure: MeasureText): number {
  const end = origIndexAt(tok, sqIndex)
  const size = tok.it.height ?? 12
  const full = measure(tok.orig, size)
  if (full <= 0) return sqIndex / tok.sq.length // degenerate fallback
  return measure(tok.orig.slice(0, end), size) / full
}

/**
 * Rectangles for the matched token range, one per VISUAL line.
 *
 * A citation spanning a line break yields two separate rectangles — one
 * per line — instead of a single merged box whose x1 (next line's smaller
 * x) would collapse to zero width. Boundary tokens use MEASURED prefix
 * fractions; interior tokens contribute their full PDF advance width.
 */
function lineRects(
  toks: Token[],
  startTok: number,
  startOff: number,
  endTok: number,
  endOff: number,
  measure: MeasureText,
): Array<{ x0: number; y0: number; x1: number; y1: number }> {
  // Group matched tokens by visual line (y tolerance).
  const groups: Token[][] = []
  for (let i = startTok; i <= endTok; i++) {
    const t = toks[i]
    const group = groups.find((g) => Math.abs(g[0].it.transform[5] - t.it.transform[5]) < LINE_Y_TOLERANCE)
    if (group) group.push(t)
    else groups.push([t])
  }

  const rects: Array<{ x0: number; y0: number; x1: number; y1: number }> = []
  for (const group of groups) {
    const first = group[0]
    const last = group[group.length - 1]

    let x0: number
    if (first === toks[startTok]) {
      const frac = prefixFraction(first, startOff, measure)
      x0 = first.it.transform[4] + frac * (first.it.width ?? 0)
    } else {
      x0 = first.it.transform[4]
    }

    let x1: number
    if (last === toks[endTok]) {
      const frac = prefixFraction(last, endOff, measure)
      x1 = last.it.transform[4] + frac * (last.it.width ?? 0)
    } else {
      x1 = last.it.transform[4] + (last.it.width ?? 0)
    }

    const y0 = Math.min(...group.map((t) => t.it.transform[5]))
    const y1 = Math.max(...group.map((t) => (t.it.transform[5] ?? 0) + (t.it.height ?? 0)))
    rects.push({ x0, y0, x1: Math.max(x1, x0), y1 })
  }
  return rects
}

/** Try matching target starting at token s, char offset off. */
function tryMatch(
  toks: Token[],
  targetSq: string,
  s: number,
  off: number,
  measure: MeasureText,
): { rects: Array<{ x0: number; y0: number; x1: number; y1: number }>; endTok: number; endChar: number } | null {
  let acc = ''
  for (let i = s; i < toks.length; i++) {
    const piece = i === s ? toks[s].sq.slice(off) : toks[i].sq
    if (!piece) continue
    const before = acc.length
    acc += piece
    if (acc.length >= targetSq.length) {
      if (acc === targetSq) {
        const endOffset = (i === s ? off : 0) + piece.length
        return {
          rects: lineRects(toks, s, off, i, endOffset, measure),
          endTok: i,
          endChar: endOffset,
        }
      }
      if (acc.length > targetSq.length && before < targetSq.length && acc.startsWith(targetSq)) {
        const consumed = targetSq.length - before
        const endOffset = (i === s ? off : 0) + consumed
        return {
          rects: lineRects(toks, s, off, i, endOffset, measure),
          endTok: i,
          endChar: endOffset,
        }
      }
      return null
    }
    if (!targetSq.startsWith(acc)) return null
  }
  return null
}

/**
 * Non-overlapping occurrences of `target` across the page's text items.
 *
 * Character-level (token, offset) cursor scanning, so a citation may start
 * or end anywhere inside an item: prefix-in-item, split across adjacent
 * items, whitespace dropped between items, and MULTIPLE occurrences inside
 * a single item are all found. Items belonging to repeated header/footer
 * LINES (position-based indices) are excluded — they repeat on every page
 * and would poison ambiguity detection.
 */
function findNonOverlappingOccurrences(
  items: TextItemLike[],
  target: string,
  measure: MeasureText,
  headerFooterItemIndices: ReadonlySet<number> = new Set(),
  rangeStart?: number,
  rangeEnd?: number,
): Array<{ lines: Array<{ x0: number; y0: number; x1: number; y1: number }> }> {
  const targetSq = squeeze(target)
  const toks: Token[] = items
    .map((it, abs) => ({ t: buildToken(it), abs }))
    .filter((x) => x.t.sq.length > 0 && !headerFooterItemIndices.has(x.abs))
    .filter((x) => rangeStart === undefined || (x.abs >= rangeStart && x.abs <= (rangeEnd ?? items.length - 1)))
    .map((x) => x.t)
  const results: Array<{ lines: Array<{ x0: number; y0: number; x1: number; y1: number }> }> = []

  let s = 0
  let off = 0
  while (s < toks.length && results.length < 2) {
    const m = tryMatch(toks, targetSq, s, off, measure)
    if (m) {
      results.push({ lines: m.rects })
      s = m.endTok
      off = m.endChar
      if (off >= toks[s].sq.length) {
        s += 1
        off = 0
      }
    } else {
      off += 1
      if (off >= toks[s].sq.length) {
        s += 1
        off = 0
      }
    }
  }
  return results
}

function getParagraphIndex(location: Record<string, unknown> | null | undefined): number | null {
  const n = location?.paragraph_index
  return typeof n === 'number' && n >= 0 ? n : null
}
