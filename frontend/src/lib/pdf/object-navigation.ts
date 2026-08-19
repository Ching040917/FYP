/**
 * Table/Figure page-navigation integration (no bounding overlays yet).
 *
 * Object identity comes from authoritative locations: table_index for
 * tables, image_index for figures, paragraph_index only as supporting
 * evidence (host paragraph). Evidence families stay mutually exclusive —
 * object selection clears citation and formatting overlays and shows
 * page navigation + compact status only.
 *
 * Evidence sources:
 *   - PoC-grade ObjectMappingResult (fixture-verified, docx-order based);
 *   - production bundle fallback: semantic captions (caption paragraphs
 *     live in the document blocks) and the host paragraph mapping.
 *
 * Navigation semantics: exact → navigate once; approximate → navigate +
 * truthful boundary message; unavailable → keep the view stable, never
 * force Extracted Text. One-shot page commands are owned by the viewer.
 */
import { normalizeText, type BlockMapping, type PageText } from './paragraph-mapping.ts'
import type { ObjectMappingResult } from './object-mapping.ts'
import type { PageGeometry } from './pdf-text-extract.ts'
import { figurePageForIndex } from './figure-bbox.ts'

export const OBJECT_RULES: ReadonlySet<string> = new Set([
  'TABLE_CAPTION_MISSING',
  'IMAGE_CAPTION_MISSING',
  'MANUAL_CAPTION',
  'IMAGE_ALT_TEXT_MISSING',
])

export const OBJECT_APPROX_MESSAGE =
  'This object begins on this page. Its exact boundary is not marked yet.'
export const OBJECT_UNAVAILABLE_MESSAGE =
  'Exact page location is unavailable. Review the object location in Finding Details.'

export type ObjectNavigationMode = 'rendered' | 'stable' | 'none'

export interface ObjectNavigationDecision {
  mode: ObjectNavigationMode
  pageNumber: number | null
  /** One-based user-facing label: `Page N · Table M` / `Table M · Page unavailable`. */
  label: string | null
  /** Compact viewer chip text: `Table M · Page N` / `Table M begins on Page N` /
   *  `Table M · Page unavailable`. */
  chipLabel: string | null
  message: string | null
  evidenceMethod: string | null
}

export type BundleLike = {
  byIndex: Map<number, BlockMapping>
  pages: PageText[]
  blocks?: Array<{ index: number; text: string; styleName?: string | null }>
  /** Operator-list page geometry (Build 8F) — authoritative figure pages. */
  geometry?: PageGeometry[] | null
}

const objectLabel = (type: 'table' | 'figure', index: number) =>
  `${type === 'table' ? 'Table' : 'Figure'} ${index + 1}`

/** Unify any object mapping result into a navigation decision. */
export function resolveObjectNavigation(
  mapping: ObjectMappingResult | null | undefined,
): ObjectNavigationDecision {
  if (!mapping) return { mode: 'none', pageNumber: null, label: null, chipLabel: null, message: null, evidenceMethod: null }
  const label = objectLabel(mapping.targetType, mapping.targetIndex)
  if (mapping.pageNumber !== null) {
    const approximate = mapping.confidence === 'approximate'
    return {
      mode: 'rendered',
      pageNumber: mapping.pageNumber,
      label: `Page ${mapping.pageNumber} · ${label}`,
      chipLabel: approximate
        ? `${label} begins on Page ${mapping.pageNumber}`
        : `${label} · Page ${mapping.pageNumber}`,
      message: approximate ? OBJECT_APPROX_MESSAGE : null,
      evidenceMethod: mapping.evidenceMethod,
    }
  }
  return {
    mode: 'stable',
    pageNumber: null,
    label: `${label} · Page unavailable`,
    chipLabel: `${label} · Page unavailable`,
    message: OBJECT_UNAVAILABLE_MESSAGE,
    evidenceMethod: mapping.evidenceMethod,
  }
}

// ---------------------------------------------------------------------------
// production evidence (blocks + paragraph mapping only)
// ---------------------------------------------------------------------------

/**
 * Derive an object mapping from the session bundle when PoC-grade docx
 * metadata is unavailable. Never guesses:
 *   - table: a semantic/manual caption paragraph `Table N` that maps → exact;
 *   - figure: caption paragraph `Figure N` that maps → exact; otherwise the
 *     host paragraph's mapped page → exact; otherwise unavailable.
 */
export function mapObjectFromBundle(
  finding: { ruleCode?: string | null; location?: Record<string, unknown> | null },
  bundle: BundleLike | null | undefined,
): ObjectMappingResult | null {
  if (!bundle) return null
  // Defensive: accept both the FindingLike camelCase and the raw API
  // Violation snake_case (`rule_code`) so callers can pass either shape.
  const ruleCode = finding.ruleCode ?? (finding as { rule_code?: string | null }).rule_code ?? null
  if (!ruleCode || !OBJECT_RULES.has(ruleCode)) return null
  const location = finding.location ?? {}

  const tableIndex = typeof location.table_index === 'number' ? location.table_index : null
  const imageIndex = typeof location.image_index === 'number' ? location.image_index : null

  if (tableIndex !== null) {
    // MANUAL_CAPTION carries the caption paragraph index (backend XML-
    // adjacency association). Identity-first: the typed number may
    // legitimately differ from the authoritative table ordinal, so it is
    // never required to match. Captions above or below the object are both
    // supported — position is proven by the detector, not by the block
    // stream. Legacy audits without the index keep the text-rule path.
    const captionIndex = typeof location.paragraph_index === 'number' ? location.paragraph_index : null
    if (captionIndex !== null) {
      const page = bundle.byIndex.get(captionIndex)?.pageNumber ?? null
      if (page !== null) {
        return { targetType: 'table', targetIndex: tableIndex, pageNumber: page, bbox: null, confidence: 'exact', evidenceMethod: 'caption-identity', ambiguityReason: null }
      }
      return { targetType: 'table', targetIndex: tableIndex, pageNumber: null, bbox: null, confidence: 'unavailable', evidenceMethod: 'caption-identity', ambiguityReason: 'caption-block-unmapped' }
    }
    // TABLE_CAPTION_MISSING: caption is absent by definition — visible
    // caption numbering is NEVER authoritative for it (a "Table 3" caption
    // elsewhere belongs to another table). Map from DOCX object order and
    // surrounding mapped blocks only.
    if (ruleCode === 'TABLE_CAPTION_MISSING') {
      const page = surroundingPage(bundle, captionAnchors(bundle), tableIndex, 0)
      if (page !== null) {
        return { targetType: 'table', targetIndex: tableIndex, pageNumber: page, bbox: null, confidence: 'exact', evidenceMethod: 'surrounding-blocks', ambiguityReason: null }
      }
      return { targetType: 'table', targetIndex: tableIndex, pageNumber: null, bbox: null, confidence: 'unavailable', evidenceMethod: 'surrounding-blocks', ambiguityReason: 'no-surrounding-evidence' }
    }
    const page = captionPage(bundle, 'table', tableIndex)
    if (page !== null) {
      return { targetType: 'table', targetIndex: tableIndex, pageNumber: page, bbox: null, confidence: 'exact', evidenceMethod: 'caption', ambiguityReason: null }
    }
    return { targetType: 'table', targetIndex: tableIndex, pageNumber: null, bbox: null, confidence: 'unavailable', evidenceMethod: 'caption', ambiguityReason: 'no-caption-evidence' }
  }

  if (imageIndex !== null) {
    // Operator geometry is the authoritative figure identity: the real page
    // of the body-figure paint for this image_index. It wins over the
    // caption and host-paragraph pages (identity rule 9) — a host paragraph
    // or caption text that flowed to another page never moves the figure.
    const hasGeometry = bundle.geometry !== null && bundle.geometry !== undefined && bundle.geometry.length > 0
    const opPage = hasGeometry ? figurePageForIndex(bundle.geometry, imageIndex) : null
    if (hasGeometry) {
      // When operator geometry is available it is the ONLY authority. A
      // missing op (order disagreement / index beyond the body ops) is
      // UNAVAILABLE — never guessed from caption or adjacent prose.
      if (opPage !== null) {
        return { targetType: 'figure', targetIndex: imageIndex, pageNumber: opPage, bbox: null, confidence: 'exact', evidenceMethod: 'image-op-order', ambiguityReason: null }
      }
      return { targetType: 'figure', targetIndex: imageIndex, pageNumber: null, bbox: null, confidence: 'unavailable', evidenceMethod: 'image-op-order', ambiguityReason: 'op-order-mismatch' }
    }
    const caption = captionPage(bundle, 'figure', imageIndex)
    if (caption !== null) {
      return { targetType: 'figure', targetIndex: imageIndex, pageNumber: caption, bbox: null, confidence: 'exact', evidenceMethod: 'caption', ambiguityReason: null }
    }
    const hostIndex = typeof location.paragraph_index === 'number' ? location.paragraph_index : null
    if (hostIndex !== null) {
      const page = bundle.byIndex.get(hostIndex)?.pageNumber ?? null
      if (page !== null) {
        return { targetType: 'figure', targetIndex: imageIndex, pageNumber: page, bbox: null, confidence: 'exact', evidenceMethod: 'host-paragraph', ambiguityReason: null }
      }
    }
    return { targetType: 'figure', targetIndex: imageIndex, pageNumber: null, bbox: null, confidence: 'unavailable', evidenceMethod: hostIndex !== null ? 'host-paragraph' : 'caption', ambiguityReason: hostIndex !== null ? 'image-only-host' : 'no-caption-evidence' }
  }
  return null
}

function captionPage(bundle: BundleLike, type: 'table' | 'figure', index: number): number | null {
  const prefix = type === 'table' ? 'table' : 'figure'
  const labelRe = new RegExp(`^${prefix}\\s+${index + 1}(?![\\d])`, 'i')
  for (const block of bundle.blocks ?? []) {
    const text = normalizeText(block.text)
    if (labelRe.test(text)) {
      const page = bundle.byIndex.get(block.index)?.pageNumber ?? null
      if (page !== null) return page
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// surrounding-block evidence for uncaptioned tables (collision-safe)
// ---------------------------------------------------------------------------

/** Caption-styled paragraphs (Word Caption style — SEQ fields). */
const CAPTION_STYLE_RE = /caption/i

/** Manual caption text: label + number, then colon/period/dash or EOL —
 *  excludes prose like "Table 1 has Caption style…" (visible caption
 *  numbers in prose are NEVER authoritative identity). */
const TABLE_CAPTION_TEXT_RE = /^\s*(?:table|tab\.|jadual|表)\s*\d+(?:\s*[:.\-–—]|$)/i

/** Table-label start — caption-styled SEQ captions may render without the
 *  number in the extracted block text ("Table  testing"). */
const TABLE_LABEL_START_RE = /^\s*(?:table|tab\.|jadual|表)(?:\s|\d)/i

/**
 * Caption-anchor block indexes (positional evidence for uncaptioned tables).
 * A block anchors when it is EITHER:
 *   - caption-styled (Word Caption style, SEQ fields may hide the number)
 *     AND starts with a table label; or
 *   - a visible manual caption ("Table N:" / "Table N." / "Table N" alone).
 * Prose that merely contains "Table N" (checklist text, body copy) is never
 * an anchor — visible caption numbers are not identity.
 */
export function captionAnchors(bundle: BundleLike): number[] {
  const anchors: number[] = []
  for (const block of bundle.blocks ?? []) {
    const text = normalizeText(block.text)
    const isCaptionStyled =
      typeof block.styleName === 'string' && CAPTION_STYLE_RE.test(block.styleName)
    const isAnchor = isCaptionStyled
      ? TABLE_LABEL_START_RE.test(text)
      : TABLE_CAPTION_TEXT_RE.test(text)
    if (isAnchor) anchors.push(block.index)
  }
  return anchors.sort((a, b) => a - b)
}

/**
 * Page of an UNCAPTIONED table from DOCX object order + surrounding mapped
 * blocks. `missingBefore` = number of uncaptioned tables before it (from the
 * finding set), so the caption bracket follows table order, not caption
 * numbering. Window = mapped blocks strictly between the bracketing caption
 * anchors:
 *   - all window blocks on one page → that page;
 *   - a window spanning a page boundary → anchor to the previous caption's
 *     page (the table directly follows the previous captioned table);
 *   - otherwise (no anchor, no consensus, empty window) → null = unavailable.
 * Never guesses; never borrows another table's caption page.
 */
export function surroundingPage(
  bundle: BundleLike,
  captions: number[],
  tableIndex: number,
  missingBefore: number,
): number | null {
  const m = captions.length
  const cLt = tableIndex - missingBefore // captioned tables before this one
  const left = m === 0 ? -1 : cLt > 0 ? (cLt <= m ? captions[cLt - 1] : captions[m - 1]) : -1
  const right = cLt < m ? captions[cLt] : Number.POSITIVE_INFINITY
  const windowPages: number[] = []
  for (const block of bundle.blocks ?? []) {
    if (block.index > left && block.index < right) {
      const page = bundle.byIndex.get(block.index)?.pageNumber
      if (page !== null && page !== undefined) windowPages.push(page)
    }
  }
  if (windowPages.length === 0) return null
  const unique = new Set(windowPages)
  if (unique.size === 1) {
    const [only] = unique
    return only
  }
  if (cLt > 0 && cLt <= m) {
    const prevPage = bundle.byIndex.get(captions[cLt - 1])?.pageNumber
    if (prevPage !== null && prevPage !== undefined && unique.has(prevPage)) return prevPage
  }
  return null
}

// ---------------------------------------------------------------------------
// batch table resolution (collision-safe, production path)
// ---------------------------------------------------------------------------

export interface TableFindingLike {
  id?: string
  ruleCode?: string | null
  rule_code?: string | null
  location?: Record<string, unknown> | null
}

function tableIndexOf(finding: TableFindingLike): number | null {
  const idx = (finding.location ?? {})?.table_index
  return typeof idx === 'number' ? idx : null
}

function tableRuleOf(finding: TableFindingLike): string | null {
  return (finding.ruleCode ?? (finding as { rule_code?: string | null }).rule_code ?? '').toUpperCase()
}

function decisionForTable(
  tableIndex: number,
  page: number | null,
  evidenceMethod: string | null,
): ObjectNavigationDecision {
  const label = `Table ${tableIndex + 1}`
  if (page !== null) {
    return {
      mode: 'rendered',
      pageNumber: page,
      label: `Page ${page} · ${label}`,
      chipLabel: `${label} · Page ${page}`,
      message: null,
      evidenceMethod,
    }
  }
  return {
    mode: 'stable',
    pageNumber: null,
    label: `${label} · Page unavailable`,
    chipLabel: `${label} · Page unavailable`,
    message: OBJECT_UNAVAILABLE_MESSAGE,
    evidenceMethod,
  }
}

/**
 * Resolve ALL table findings of an audit as one batch so object identity
 * stays collision-free:
 *
 *   - `location.table_index` is the authoritative identity; visible caption
 *     numbering is never authoritative.
 *   - MANUAL_CAPTION: persisted caption paragraph identity first, then
 *     (legacy audits) the caption-text rule.
 *   - TABLE_CAPTION_MISSING: caption absent by definition — surrounding
 *     mapped blocks only, never another table's caption.
 *   - Collision protection: if two different table indexes resolve from the
 *     SAME caption identity/evidence block, the authoritative-adjacency one
 *     (persisted identity) is retained and the other is recomputed from
 *     independent surrounding-block evidence; insufficient evidence →
 *     unavailable. Two indexes are never silently assigned one physical
 *     object.
 */
export function resolveTableNavigations(
  auditId: string | null,
  findings: TableFindingLike[],
  bundle: BundleLike | null | undefined,
): Map<number, ObjectNavigationDecision> {
  const result = new Map<number, ObjectNavigationDecision>()
  if (!auditId || !bundle || findings.length === 0) return result

  const captions = captionAnchors(bundle)
  const indexed = findings
    .map((f) => ({ f, idx: tableIndexOf(f) }))
    .filter((x): x is { f: TableFindingLike; idx: number } => x.idx !== null)
    .sort((a, b) => a.idx - b.idx)

  // uncaptioned-table counts before each index (document order, not caption
  // numbering)
  const missingBefore = new Map<number, number>()
  let missingSeen = 0
  for (const { f, idx } of indexed) {
    missingBefore.set(idx, missingSeen)
    if (tableRuleOf(f) === 'TABLE_CAPTION_MISSING') missingSeen += 1
  }

  // first pass: per-finding evidence (block identity + page)
  const evidence = new Map<number, { block: number | null; page: number | null; method: string | null; hasIdentity: boolean }>()
  for (const { f, idx } of indexed) {
    const rule = tableRuleOf(f)
    const loc = f.location ?? {}
    const pidx = typeof loc.paragraph_index === 'number' ? loc.paragraph_index : null
    if (rule === 'MANUAL_CAPTION' && pidx !== null) {
      const page = bundle.byIndex.get(pidx)?.pageNumber ?? null
      evidence.set(idx, { block: pidx, page, method: 'caption-identity', hasIdentity: true })
    } else if (rule === 'MANUAL_CAPTION') {
      const block = captionBlockFor(bundle, captions, idx)
      const page = block !== null ? (bundle.byIndex.get(block)?.pageNumber ?? null) : null
      evidence.set(idx, { block, page, method: 'caption', hasIdentity: false })
    } else if (rule === 'TABLE_CAPTION_MISSING') {
      const page = surroundingPage(bundle, captions, idx, missingBefore.get(idx) ?? 0)
      evidence.set(idx, { block: null, page, method: 'surrounding-blocks', hasIdentity: false })
    }
  }

  // collision pass: shared evidence blocks (identity-backed wins; the other
  // is recomputed from independent surrounding-block evidence)
  const byBlock = new Map<number, number[]>()
  for (const [idx, ev] of evidence) {
    if (ev.block === null) continue
    const list = byBlock.get(ev.block) ?? []
    list.push(idx)
    byBlock.set(ev.block, list)
  }
  for (const [, indexes] of byBlock) {
    if (indexes.length < 2) continue
    const identityIdx = indexes.find((i) => evidence.get(i)?.hasIdentity)
    const victims = identityIdx !== undefined ? indexes.filter((i) => i !== identityIdx) : indexes.slice(1)
    for (const victim of victims) {
      const page = surroundingPage(bundle, captions, victim, missingBefore.get(victim) ?? 0)
      evidence.set(victim, { block: null, page, method: 'surrounding-blocks', hasIdentity: false })
    }
  }

  for (const [idx, ev] of evidence) {
    result.set(idx, decisionForTable(idx, ev.page, ev.method))
  }
  return result
}

/** First caption block whose VISIBLE text carries `Table {index+1}`. */
function captionBlockFor(
  bundle: BundleLike,
  captions: number[],
  tableIndex: number,
): number | null {
  const labelRe = new RegExp(`^table\\s+${tableIndex + 1}(?![\\d])`, 'i')
  for (const block of bundle.blocks ?? []) {
    if (captions.includes(block.index) && labelRe.test(normalizeText(block.text))) {
      return block.index
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// session cache (successes only)
// ---------------------------------------------------------------------------

const objectNavCache = new Map<string, ObjectNavigationDecision>()

function objectKey(finding: { ruleCode?: string | null; location?: Record<string, unknown> | null }): string | null {
  const ruleCode = finding.ruleCode ?? (finding as { rule_code?: string | null }).rule_code ?? null
  const location = finding.location ?? {}
  const index = typeof location.table_index === 'number' ? location.table_index : typeof location.image_index === 'number' ? location.image_index : null
  return index !== null && ruleCode ? `${ruleCode}|${index}` : null
}

/**
 * Resolve (with session caching) the object navigation for a finding.
 * Only successful decisions are cached — temporary loading states (no
 * bundle) are never cached.
 *
 * Stale-cache guard: a FIGURE decision cached while operator geometry was
 * NOT yet ready (caption/host-paragraph based) must never be served once
 * geometry arrives — the operator page is authoritative. When the bundle
 * carries geometry, the cache is bypassed for figure findings entirely
 * (recomputed from the operator list, never reused across PDF changes).
 */
export function getObjectNavigation(
  auditId: string | null,
  finding: { ruleCode?: string | null; location?: Record<string, unknown> | null },
  bundle: BundleLike | null | undefined,
): ObjectNavigationDecision {
  if (!auditId || !bundle) return { mode: 'none', pageNumber: null, label: null, chipLabel: null, message: null, evidenceMethod: null }
  const key = objectKey(finding)
  const cacheKey = key ? `${auditId}|${key}` : null
  const hasGeometry = bundle.geometry !== null && bundle.geometry !== undefined && bundle.geometry.length > 0
  const isFigureFinding = typeof (finding.location ?? {}).image_index === 'number'
  // Geometry-ready figure findings are ALWAYS recomputed (authoritative
  // operator evidence; cached caption-based decisions are stale).
  const geometryReady = isFigureFinding && hasGeometry
  if (cacheKey && !geometryReady) {
    const hit = objectNavCache.get(cacheKey)
    if (hit) return hit
  }
  const mapping = mapObjectFromBundle(finding, bundle)
  const decision = resolveObjectNavigation(mapping)
  if (cacheKey && !geometryReady && decision.mode !== 'none') objectNavCache.set(cacheKey, decision)
  return decision
}

/** Drop cached object navigation for an audit (audit change/deletion). */
export function dropObjectNavCache(auditId: string): void {
  for (const key of objectNavCache.keys()) {
    if (key.startsWith(`${auditId}|`)) objectNavCache.delete(key)
  }
}

// ---------------------------------------------------------------------------
// production selection (the exact shape AuditPage consumes)
// ---------------------------------------------------------------------------

export interface ObjectSelection {
  /** Viewer chip state (label/message) — null when nothing to show. */
  status: { label: string | null; message: string | null } | null
  /** Page to navigate to (one-based) or null to keep the view stable. */
  navigatePage: number | null
}

/**
 * One-call selection helper used verbatim by AuditPage: resolves the object
 * navigation (cached), shapes the viewer chip, and reports the one-shot page
 * command. Accepts either FindingLike (ruleCode) or raw API Violation
 * (rule_code). Unavailable / not-ready selections keep the view stable and
 * show nothing — never a guessed page.
 */
export function resolveObjectSelection(
  auditId: string | null,
  finding: {
    ruleCode?: string | null
    rule_code?: string | null
    location?: Record<string, unknown> | null
  },
  bundle: BundleLike | null | undefined,
): ObjectSelection {
  const nav = getObjectNavigation(auditId, finding, bundle)
  if (nav.mode === 'none') return { status: null, navigatePage: null }
  return {
    status: { label: nav.chipLabel, message: nav.message },
    navigatePage: nav.mode === 'rendered' && nav.pageNumber !== null ? nav.pageNumber : null,
  }
}
