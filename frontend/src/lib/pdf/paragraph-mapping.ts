/**
 * Paragraph-to-page mapping PoC (pure TypeScript, no DOM, no pdfjs).
 *
 * Maps persisted document blocks (the extracted-text preview source) to
 * pages of the exact rendered PDF, using PDF.js text content that is
 * extracted and reconstructed into lines BEFORE this module runs. This
 * module is deliberately pure so every matching rule is unit-testable
 * without a PDF.
 *
 * Rules:
 *  - blocks are mapped in original block.order sequence (monotonic —
 *    later blocks can never map before earlier confirmed ones);
 *  - duplicates are disambiguated by neighbours; when neighbours cannot
 *    agree, the block is UNAVAILABLE — never the first global match;
 *  - full-text containment = exact; word-coverage below threshold =
 *    approximate; nothing found = unavailable;
 *  - a paragraph whose text spans two pages reports pageRange.
 */
export type TextItemLike = {
  str: string
  transform: number[]
  hasEOL?: boolean
  /** PDF-unit dimensions (highlight coordinate evidence). */
  width?: number
  height?: number
}

export type PageLine = { text: string; y: number }

export type PageText = {
  pageNumber: number
  lines: PageLine[]
  /** Normalized line texts identified as repeated headers/footers. */
  headerFooterLines: Set<string>
  /** ITEM INDICES belonging to repeated header/footer lines (position-based
   *  exclusion for evidence matching — text equality would also remove
   *  legit body text that happens to repeat a header phrase). */
  headerFooterItemIndices?: Set<number>
  /** Raw text items (highlight coordinate evidence). Optional. */
  items?: TextItemLike[]
  /** Page dimensions in PDF units at scale 1 (highlight normalization). */
  pageWidth?: number
  pageHeight?: number
}

export type BlockLike = { index: number; text: string }

export type MappingConfidence = 'exact' | 'approximate' | 'unavailable'

export type BlockMapping = {
  index: number
  /** 1-based page, null when unmapped. */
  pageNumber: number | null
  /** [start, end] when the paragraph spans two pages. */
  pageRange: [number, number] | null
  /** Ordinal of this block among blocks mapped to the same page, 1-based. */
  paragraphOnPage: number | null
  confidence: MappingConfidence
}

export interface MapOptions {
  /** Minimum word-coverage fraction for an approximate match. */
  approximateThreshold?: number
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

const LIGATURES: Record<string, string> = {
  'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff', 'ﬃ': 'ffi', 'ﬄ': 'ffl',
  'ﬅ': 'st', 'ﬆ': 'st', 'Œ': 'OE', 'œ': 'oe', 'Æ': 'AE', 'æ': 'ae',
}

/** NFKC + ligature split + smart punctuation + whitespace/case folding. */
export function normalizeText(input: string): string {
  let out = ''
  for (const ch of (input ?? '').normalize('NFKC')) {
    out += LIGATURES[ch] ?? ch
  }
  return out
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Squeeze variant — matches when the PDF text layer dropped word spaces. */
function squeeze(s: string): string {
  return s.replace(/\s+/g, '')
}

function contains(haystack: string, needle: string): boolean {
  return haystack.includes(needle) || squeeze(haystack).includes(squeeze(needle))
}

// ---------------------------------------------------------------------------
// Line reconstruction from PDF.js TextItems
// ---------------------------------------------------------------------------

const LINE_Y_TOLERANCE = 3

/** Rebuild page lines from TextItems using y-coordinates and hasEOL. */
export function reconstructLines(items: TextItemLike[]): PageLine[] {
  const lines: PageLine[] = []
  let current: { texts: string[]; y: number } | null = null

  const flush = () => {
    if (current) {
      const text = normalizeText(current.texts.join(''))
      if (text.length > 0) lines.push({ text, y: current.y })
      current = null
    }
  }

  for (const item of items) {
    const y = item.transform[5] ?? 0
    if (!current) {
      current = { texts: [item.str], y }
    } else if (item.hasEOL) {
      flush()
      current = { texts: [item.str], y }
    } else if (Math.abs(y - current.y) > LINE_Y_TOLERANCE) {
      flush()
      current = { texts: [item.str], y }
    } else {
      current.texts.push(item.str)
    }
  }
  flush()
  return lines
}

// ---------------------------------------------------------------------------
// Repeated header/footer detection (conservative)
// ---------------------------------------------------------------------------

export interface RepeatedLineOptions {
  /** Minimum fraction of pages the line must appear on. */
  minFraction?: number
  /** y tolerance (PDF points) for the line to count as "the same position". */
  yTolerance?: number
}

/**
 * Identifies lines that repeat on many pages at a consistent position —
 * conservative: requires both a high page fraction AND stable y.
 */
export function findRepeatedLines(
  pages: PageText[],
  opts: RepeatedLineOptions = {},
): Map<number, Set<string>> {
  const minFraction = opts.minFraction ?? 0.5
  const yTolerance = opts.yTolerance ?? 6
  if (pages.length < 2) return new Map()

  const seen = new Map<string, { count: number; ys: number[] }>()
  for (const page of pages) {
    for (const line of page.lines) {
      if (line.text.length < 2) continue
      const record = seen.get(line.text) ?? { count: 0, ys: [] }
      record.count += 1
      record.ys.push(line.y)
      seen.set(line.text, record)
    }
  }

  const minPages = Math.max(2, Math.ceil(pages.length * minFraction))
  const repeated = new Set<string>()
  for (const [text, record] of seen) {
    if (record.count < minPages) continue
    const sorted = [...record.ys].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    if (sorted.every((y) => Math.abs(y - median) <= yTolerance)) {
      repeated.add(text)
    }
  }

  const result = new Map<number, Set<string>>()
  for (const page of pages) {
    result.set(
      page.pageNumber,
      new Set(page.lines.filter((l) => repeated.has(l.text)).map((l) => l.text)),
    )
  }
  return result
}

// ---------------------------------------------------------------------------
// Block -> page mapping
// ---------------------------------------------------------------------------

type Candidate = {
  pageNumber: number
  range: [number, number] | null
  kind: 'full' | 'cross' | 'partial'
}

function unavailable(index: number): BlockMapping {
  return { index, pageNumber: null, pageRange: null, paragraphOnPage: null, confidence: 'unavailable' }
}

export function mapBlocksToPages(
  blocks: BlockLike[],
  pages: PageText[],
  opts: MapOptions = {},
): BlockMapping[] {
  const threshold = opts.approximateThreshold ?? 0.8
  const clean = pages.map((p) => ({
    pageNumber: p.pageNumber,
    blob: p.lines.filter((l) => !p.headerFooterLines.has(l.text)).map((l) => l.text).join('\n'),
  }))

  const candidatesFor = (rawText: string): Candidate[] => {
    const text = normalizeText(rawText)
    if (!text) return []

    const out: Candidate[] = []
    for (const page of clean) {
      if (contains(page.blob, text)) {
        out.push({ pageNumber: page.pageNumber, range: null, kind: 'full' })
      }
    }
    if (out.length === 0) {
      // Paragraph split across pages: smallest window (2..4 pages) whose
      // joined text fully contains the paragraph. Cap is a PoC ceiling —
      // longer splits fall back to word coverage below.
      const maxWindow = Math.min(4, clean.length)
      for (let window = 2; window <= maxWindow; window++) {
        for (let i = 0; i + window <= clean.length; i++) {
          const joined = clean
            .slice(i, i + window)
            .map((p) => p.blob)
            .join('\n')
          if (contains(joined, text)) {
            out.push({
              pageNumber: clean[i].pageNumber,
              range: [clean[i].pageNumber, clean[i + window - 1].pageNumber],
              kind: 'cross',
            })
            break
          }
        }
        if (out.length > 0) break
      }
    }
    if (out.length === 0) {
      // approximate: word coverage against each page
      const words = text.split(' ')
      if (words.length > 0) {
        for (const page of clean) {
          const covered = words.filter((w) => page.blob.includes(w)).length / words.length
          if (covered >= threshold) {
            out.push({ pageNumber: page.pageNumber, range: null, kind: 'partial' })
          }
        }
      }
    }
    return out
  }

  const normalized = blocks.map((b) => normalizeText(b.text))
  const candidates = blocks.map((b) => candidatesFor(b.text))

  // Occurrence tracking for duplicate disambiguation.
  const textCounts = new Map<string, number>()
  for (const t of normalized) {
    if (!t) continue
    textCounts.set(t, (textCounts.get(t) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  const occurrenceOf = new Map<number, number>()
  normalized.forEach((t, i) => {
    if (!t) return
    const n = (seen.get(t) ?? 0) + 1
    seen.set(t, n)
    occurrenceOf.set(i, n)
  })

  const results: BlockMapping[] = new Array(blocks.length)
  const resolved: boolean[] = new Array(blocks.length).fill(false)
  const pageBlocks = new Map<number, number[]>()
  let cursorPage = 1 // monotonic lower bound

  const previousPage = (i: number): number | null => {
    for (let j = i - 1; j >= 0; j--) {
      const r = results[j]
      if (resolved[j] && r && r.pageNumber !== null) {
        // A cross-page paragraph ends at pageRange[1] — use that as the hint.
        return r.pageRange ? r.pageRange[1] : r.pageNumber
      }
    }
    return null
  }
  const nextPage = (i: number): number | null => {
    for (let j = i + 1; j < blocks.length; j++) {
      if (resolved[j] && results[j].pageNumber !== null) return results[j].pageNumber
    }
    return null
  }

  const choose = (i: number, cands: Candidate[]): Candidate | null => {
    const usable = cands.filter((c) => c.pageNumber >= cursorPage)
    if (usable.length === 0) return null
    const exact = usable.filter((c) => c.kind !== 'partial')
    const pool = exact.length > 0 ? exact : usable
    const pages = [...new Set(pool.map((c) => c.pageNumber))]
    if (pages.length === 1) return pool[0]

    const occurrence = occurrenceOf.get(i) ?? 1
    const total = textCounts.get(normalized[i]) ?? 1
    const prevPage = previousPage(i)
    const nextPageNum = nextPage(i)

    if (occurrence === 1 && total > 1) {
      // First instance of a duplicated block: the previous confirmed
      // neighbour decides.
      if (prevPage !== null && pages.includes(prevPage)) {
        return pool.find((c) => c.pageNumber === prevPage) ?? null
      }
      return null
    }
    if (occurrence > 1) {
      // Later instance: require prev AND next neighbours to agree on one
      // candidate page — otherwise ambiguous.
      if (
        prevPage !== null &&
        nextPageNum !== null &&
        prevPage === nextPageNum &&
        pages.includes(prevPage)
      ) {
        return pool.find((c) => c.pageNumber === prevPage) ?? null
      }
      return null
    }
    return null // single occurrence on multiple pages without a hint
  }

  // Fixpoint resolution: neighbours confirmed in earlier passes unlock
  // later duplicates; anything still ambiguous ends up unavailable.
  let progress = true
  let pass = 0
  while (progress && pass < 10) {
    progress = false
    pass += 1
    for (let i = 0; i < blocks.length; i++) {
      if (resolved[i]) continue
      if (!normalized[i]) {
        results[i] = unavailable(blocks[i].index)
        resolved[i] = true
        progress = true
        continue
      }
      const chosen = choose(i, candidates[i])
      if (!chosen) continue
      results[i] = {
        index: blocks[i].index,
        pageNumber: chosen.pageNumber,
        pageRange: chosen.range,
        paragraphOnPage: null,
        confidence: chosen.kind === 'partial' ? 'approximate' : 'exact',
      }
      resolved[i] = true
      progress = true
      if (chosen.kind !== 'partial') {
        cursorPage = chosen.range ? chosen.range[1] : chosen.pageNumber
      }
      const list = pageBlocks.get(chosen.pageNumber) ?? []
      list.push(blocks[i].index)
      pageBlocks.set(chosen.pageNumber, list)
    }
  }

  for (let i = 0; i < blocks.length; i++) {
    if (!resolved[i]) results[i] = unavailable(blocks[i].index)
  }

  // paragraphOnPage: ordinal among blocks mapped to the same page, by
  // original block order.
  for (const [page, indexes] of pageBlocks) {
    indexes.sort((a, b) => a - b)
    const byIndex = new Map(indexes.map((idx, pos) => [idx, pos + 1]))
    for (let i = 0; i < blocks.length; i++) {
      if (results[i].pageNumber === page && byIndex.has(blocks[i].index)) {
        results[i].paragraphOnPage = byIndex.get(blocks[i].index)!
      }
    }
  }

  return results
}
