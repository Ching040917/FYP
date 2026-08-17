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
  blocks?: Array<{ index: number; text: string }>
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
    const page = captionPage(bundle, 'table', tableIndex)
    if (page !== null) {
      return { targetType: 'table', targetIndex: tableIndex, pageNumber: page, bbox: null, confidence: 'exact', evidenceMethod: 'caption', ambiguityReason: null }
    }
    return { targetType: 'table', targetIndex: tableIndex, pageNumber: null, bbox: null, confidence: 'unavailable', evidenceMethod: 'caption', ambiguityReason: 'no-caption-evidence' }
  }

  if (imageIndex !== null) {
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
 */
export function getObjectNavigation(
  auditId: string | null,
  finding: { ruleCode?: string | null; location?: Record<string, unknown> | null },
  bundle: BundleLike | null | undefined,
): ObjectNavigationDecision {
  if (!auditId || !bundle) return { mode: 'none', pageNumber: null, label: null, chipLabel: null, message: null, evidenceMethod: null }
  const key = objectKey(finding)
  const cacheKey = key ? `${auditId}|${key}` : null
  if (cacheKey) {
    const hit = objectNavCache.get(cacheKey)
    if (hit) return hit
  }
  const mapping = mapObjectFromBundle(finding, bundle)
  const decision = resolveObjectNavigation(mapping)
  if (cacheKey && decision.mode !== 'none') objectNavCache.set(cacheKey, decision)
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
