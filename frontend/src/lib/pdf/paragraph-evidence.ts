/**
 * General paragraph-evidence resolver — ONE contract for every
 * paragraph-based finding that is not covered by exact span highlighting.
 *
 * Tier policy (locked):
 * - Citation span overlay: only the four CITATION_* codes in
 *   CITATION_SPAN_CODES, only with a source-faithful snippet, only on a
 *   single on-page occurrence (see citation-highlight.ts).
 * - Paragraph envelope: every other paragraph-scoped finding, including
 *   all REFERENCE_* findings. Long Reference entry text NEVER enters the
 *   span matcher — the enclosing paragraph region from real line geometry
 *   is the truthful unit.
 * - Document-level root findings (`missing_references_section === true`)
 *   are explicitly denied an overlay even when they carry a valid
 *   paragraph_index: that index anchors the first citation for navigation
 *   context, but it is NOT evidence for the document-wide cause.
 *
 * Pure logic: no I/O, no network, no storage. Never throws, never guesses.
 */
import { REGION_UNAVAILABLE_MESSAGE, enclose } from './formatting-highlight.ts'
import { friendlyParagraphLocation } from './finding-navigation.ts'
import { friendlyRuleTitle } from '../friendly-finding.ts'
import { normalizeText, type BlockLike, type BlockMapping, type PageText, type TextItemLike } from './paragraph-mapping.ts'
import type { CitationRect } from './citation-highlight.ts'

export interface ParagraphFindingLike {
  id: string
  ruleCode?: string | null
  message?: string | null
  location?: Record<string, unknown> | null
}

export interface ParagraphEvidenceBundle {
  byIndex: Map<number, BlockMapping>
  pages: PageText[]
  blocks?: BlockLike[]
}

export interface ParagraphEvidenceResult {
  /** 'paragraph' with rects, or 'none' when no overlay is truthful. */
  kind: 'paragraph' | 'none'
  pageRects: CitationRect[]
  label: string | null
  /** Truthful message when navigation succeeds but no region exists. */
  message: string | null
  /** True only when the text provably occurs more than once without order proof. */
  ambiguous: boolean
}

/** Document-level root findings never receive an overlay. */
export const DOCUMENT_ROOT_NO_OVERLAY_MESSAGE =
  'This finding covers the whole document: add a References section. No single paragraph is highlighted as evidence.'

/** True for the document-level missing-References root finding. */
export function isDocumentLevelRoot(location: Record<string, unknown> | null | undefined): boolean {
  return (location ?? {}).missing_references_section === true
}

function getParagraphIndex(location: Record<string, unknown> | null | undefined): number | null {
  const n = location?.paragraph_index
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null
}

/** Proven multiplicity without order proof: ambiguous, never guessed. */
export const AMBIGUOUS_REGION_MESSAGE =
  'The evidence text occurs more than once on this page and cannot be matched to one paragraph. Review the selected evidence in Finding Details.'

export type OverlayLifecycleState =
  | 'idle'
  | 'waiting_for_mapping'
  | 'waiting_for_page_text'
  | 'resolved'
  | 'unavailable'
  | 'ambiguous';

export interface OverlayLifecycleInput {
  hasSelection: boolean
  isParagraphTarget: boolean
  previewRendered: boolean
  mappingReady: boolean
  pagesReady: boolean
  hasRects: boolean
  ambiguous: boolean
  hasMessage: boolean
}

/**
 * Explicit overlay resolution states (pure classifier).
 *
 * waiting_* states are TRANSIENT: callers must re-resolve when the
 * dependency arrives and must never persist an unavailable result from
 * them. Only a final evidence failure becomes unavailable/ambiguous.
 * Stale async results are rejected by the caller's generation token
 * (see AuditPage overlay derivation).
 */
export function classifyOverlayLifecycle(input: OverlayLifecycleInput): OverlayLifecycleState {
  if (!input.hasSelection || !input.isParagraphTarget || !input.previewRendered) return 'idle'
  if (!input.mappingReady) return 'waiting_for_mapping'
  if (!input.pagesReady) return 'waiting_for_page_text'
  if (input.hasRects) return 'resolved'
  if (input.ambiguous) return 'ambiguous'
  if (input.hasMessage) return 'unavailable'
  return 'unavailable'
}

/**
 * Resolve the paragraph-envelope overlay for a selected finding.
 * Consolidated findings resolve to the primary (first) paragraph only —
 * `paragraph_indexes` never fans out into simultaneous overlays.
 */
export function resolveParagraphEvidence(
  finding: ParagraphFindingLike,
  bundle: ParagraphEvidenceBundle | null | undefined,
): ParagraphEvidenceResult {
  const none = (message: string | null, ambiguous = false): ParagraphEvidenceResult => ({
    kind: 'none',
    pageRects: [],
    label: null,
    message,
    ambiguous,
  })
  if (!bundle) return none(null)
  // Root denial FIRST: a valid paragraph_index on a document-level finding
  // is navigation context, never overlay evidence.
  if (isDocumentLevelRoot(finding.location)) {
    return none(DOCUMENT_ROOT_NO_OVERLAY_MESSAGE)
  }
  const paraIndex = getParagraphIndex(finding.location)
  if (paraIndex === null) return none(null)

  const mapped = bundle.byIndex.get(paraIndex)
  if (!mapped || mapped.pageNumber === null) return none(null)

  const page = bundle.pages.find((p) => p.pageNumber === mapped.pageNumber)
  if (!page) return none(null)

  const locPart = friendlyParagraphLocation(paraIndex, mapped) ?? ''
  const label = `${friendlyRuleTitle(finding.ruleCode) ?? 'Finding'} · ${locPart}`
  const blockText = bundle.blocks?.find((b) => b.index === paraIndex)?.text ?? null
  if (!blockText || !blockText.trim()) {
    return { kind: 'paragraph', pageRects: [], label, message: REGION_UNAVAILABLE_MESSAGE, ambiguous: false }
  }
  const region = orderedParagraphRegion(bundle, paraIndex, mapped.pageNumber, page, blockText)
  if (region && region.length > 0) {
    return { kind: 'paragraph', pageRects: region, label, message: null, ambiguous: false }
  }
  // Proven multiplicity (non-duplicate text, order-proof absent) is
  // ambiguous rather than merely unavailable.
  const items = page.items ?? []
  const hf = page.headerFooterItemIndices ?? new Set<number>()
  const surplus = findBlockWindows(items, blockText, hf, 0, items.length - 1, 2)
  if (surplus.length >= 2) {
    return { kind: 'paragraph', pageRects: [], label, message: AMBIGUOUS_REGION_MESSAGE, ambiguous: true }
  }
  return { kind: 'paragraph', pageRects: [], label, message: REGION_UNAVAILABLE_MESSAGE, ambiguous: false }
}

function squeeze(s: string): string {
  return s.replace(/\s+/g, '')
}

export interface ItemWindow {
  start: number
  end: number
}

/**
 * All minimal contiguous item windows (up to `max`, in document order,
 * never overlapping) whose squeezed text contains the squeezed block text,
 * searched within [lo, hi]. Empty block text never matches.
 */
export function findBlockWindows(
  items: TextItemLike[],
  blockText: string,
  headerFooterItemIndices: ReadonlySet<number> = new Set(),
  lo = 0,
  hi?: number,
  max = 2,
): ItemWindow[] {
  const target = squeeze(normalizeText(blockText))
  if (!target) return []
  const end = Math.min(hi ?? items.length - 1, items.length - 1)
  const idxs: number[] = []
  for (let i = Math.max(0, lo); i <= end; i++) {
    if (headerFooterItemIndices.has(i)) continue
    if (squeeze(normalizeText(items[i].str)).length > 0) idxs.push(i)
  }
  const wins: ItemWindow[] = []
  let s = 0
  while (s < idxs.length && wins.length < max) {
    let acc = ''
    let found = false
    for (let e = s; e < idxs.length; e++) {
      acc += squeeze(normalizeText(items[idxs[e]].str))
      if (acc.length >= target.length) {
        if (acc.includes(target)) {
          // Shrink from the left: accumulation is ordered, so leading
          // tokens are dropped while the remainder still contains the
          // target. Without this, a window starting at a preceding
          // paragraph's items would be accepted whenever the tail still
          // covers the target — poisoning anchor bounds and admitting
          // wrong-paragraph regions.
          let t = s
          let rem = acc
          while (t < e) {
            const tok = squeeze(normalizeText(items[idxs[t]].str))
            if (!rem.startsWith(tok)) break
            const trial = rem.slice(tok.length)
            if (!trial.includes(target)) break
            rem = trial
            t += 1
          }
          wins.push({ start: idxs[t], end: idxs[e] })
          s = e + 1
          found = true
        }
        break
      }
    }
    if (!found) s += 1
  }
  return wins
}

/**
 * Identity-validated paragraph region on the mapped page.
 *
 * Paragraph identity is NOT established by text alone: the target block's
 * text must occur exactly once between its same-page mapped neighbors
 * (nearest previous / next blocks in document order whose own text is
 * itself unambiguous on the page). An ambiguous or unusable neighbor
 * simply widens that side to the page edge — the target itself must still
 * be unique in the resulting window. A final containment check rejects
 * regions whose covered text does not contain the block text, so a nearby
 * wrong paragraph (heading, label, expected-result line) can never be
 * highlighted. Two identical candidates that neighbors cannot separate
 * yield null: navigate to the page, draw nothing, say so truthfully.
 * Identical same-page paragraphs (duplicate entries) are aligned by
 * occurrence rank in document order instead of blind first-occurrence.
 *
 * Only the mapped page is searched in this version: a paragraph spanning
 * two pages resolves no overlay (truthful message) rather than a guess.
 */
export function orderedParagraphRegion(
  bundle: ParagraphEvidenceBundle,
  paraIndex: number,
  pageNumber: number,
  page: PageText,
  blockText: string,
): CitationRect[] | null {
  const items = page.items ?? []
  if (items.length === 0) return null
  const hf = page.headerFooterItemIndices ?? new Set<number>()
  const width = page.pageWidth ?? 595
  const height = page.pageHeight ?? 842

  // Same-page mapped peers in document order (non-empty text only).
  const peers = (bundle.blocks ?? [])
    .filter((b) => b.index !== paraIndex && (b.text ?? '').trim().length > 0)
    .map((b) => ({ index: b.index, page: bundle.byIndex.get(b.index)?.pageNumber ?? null, text: b.text as string }))
    .filter((p) => p.page === pageNumber)
    .sort((a, b) => a.index - b.index)
  const squeezedTarget = squeeze(normalizeText(blockText))
  // Identical-text peers (duplicates): aligned by occurrence rank, never by
  // blind first-occurrence. Non-identical neighbors provide anchor bounds.
  const group = peers.filter((p) => squeeze(normalizeText(p.text)) === squeezedTarget)
  const rank = group.filter((p) => p.index < paraIndex).length
  const before = [...peers].filter((p) => p.index < paraIndex && squeeze(normalizeText(p.text)) !== squeezedTarget).pop() ?? null
  const after = peers.find((p) => p.index > paraIndex && squeeze(normalizeText(p.text)) !== squeezedTarget) ?? null

  // Anchor bounds: a neighbor constrains only when its own text is
  // unambiguous on the page; otherwise that side stays at the page edge.
  let lo = 0
  let hi = items.length - 1
  if (before) {
    const w = findBlockWindows(items, before.text, hf, 0, items.length - 1, 2)
    if (w.length === 1) lo = w[0].end + 1
  }
  if (after) {
    const w = findBlockWindows(items, after.text, hf, 0, items.length - 1, 2)
    if (w.length === 1) hi = w[0].start - 1
  }
  if (lo > hi) return null

  // The target's occurrence rank among identical same-page paragraphs must
  // match the rendered occurrence count exactly; any mismatch (drift,
  // page spill, missing text) yields no overlay rather than a guess.
  // One extra window is requested so surplus occurrences are detected.
  const need = group.length + 1
  const wins = findBlockWindows(items, blockText, hf, lo, hi, need + 1)
  if (wins.length !== need) return null
  const { start, end } = wins[rank]

  // Identity post-check: the covered text must contain the block text —
  // a region over another paragraph is rejected, never drawn.
  let covered = ''
  for (let i = start; i <= end; i++) {
    if (hf.has(i)) continue
    covered += squeeze(normalizeText(items[i]?.str ?? ''))
  }
  if (!covered.includes(squeeze(normalizeText(blockText)))) return null

  const rects: CitationRect[] = []
  for (let i = start; i <= end; i++) {
    if (hf.has(i)) continue // header/footer glyphs never join evidence geometry
    const it = items[i]
    if (!it) continue
    const rx = (it.transform[4] ?? 0) / width
    const ry = (it.transform[5] ?? 0) / height
    const rw = (it.width ?? 0) / width
    const rh = (it.height ?? 0) / height
    if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rw) || !Number.isFinite(rh)) continue
    if (rw <= 0 || rh <= 0) continue
    rects.push({ page: pageNumber, x: rx, y: ry, width: rw, height: rh })
  }
  const envelope = enclose(rects, width, height)
  return envelope ? [envelope] : null
}
