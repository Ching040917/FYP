/** Tab-scoped, complete unsaved editor recovery. Invalid evidence is retained. */
import { isProfileObject, type StoredCustomProfile } from './store.ts'
import type { BodyUiModel, HeadingUiModel, MarginsUiModel, ReferencesUiModel, CaptionUiModel, ListUiModel, CitationMatchingUiModel } from './editor.ts'

// Keep the key so older payload-only records can be disclosed, never silently lost.
export const PROFILE_DRAFT_RECOVERY_KEY = 'custom-profile-draft-recovery:v1'
export const PROFILE_DRAFT_RECOVERY_SCHEMA_VERSION = 2

export interface DraftUiState {
  body: BodyUiModel | null
  heading: HeadingUiModel | null
  margins: MarginsUiModel | null
  references: ReferencesUiModel | null
  captions: CaptionUiModel | null
  lists: ListUiModel | null
  citation: CitationMatchingUiModel | null
}

export interface ProfileDraftRecovery {
  schema_version: 2
  profile_id: string
  base_revision: number
  draft: StoredCustomProfile
  ui: DraftUiState
  updated_at: string
}

export interface DraftRecoveryStorageAdapter {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

export type DraftRecoveryLoadResult =
  | { status: 'empty' | 'invalid' | 'unsupported' | 'unavailable' }
  | { status: 'ready'; recovery: ProfileDraftRecovery }


function hasFields(value: unknown, booleans: string[], strings: string[]): boolean {
  return isProfileObject(value) && booleans.every((key) => typeof value[key] === 'boolean') && strings.every((key) => typeof value[key] === 'string')
}

function isUi(value: unknown): value is DraftUiState {
  if (!isProfileObject(value) || Object.keys(value).sort().join(',') !== 'body,captions,citation,heading,lists,margins,references') return false
  const pairs = (v: unknown): boolean => Array.isArray(v) && v.every((p) => hasFields(p, [], ['family', 'size']))
  if (value.body !== null && (!hasFields(value.body, ['fontEnabled', 'fontExactMode', 'alignmentEnabled', 'lineSpacingEnabled', 'spaceBeforeEnabled', 'spaceAfterEnabled'], ['alignment', 'lineSpacing', 'spaceBefore', 'spaceAfter']) || !pairs((value.body as Record<string, unknown>).pairs))) return false
  if (value.heading !== null) {
    const h = value.heading
    if (!hasFields(h, ['fontExactMode', 'alignmentEnabled', 'spaceBeforeEnabled', 'spaceAfterEnabled'], ['fontBehavior', 'alignment', 'spaceBefore', 'spaceAfter']) || !isProfileObject(h) || !pairs(h.pairs)) return false
    if (!['inherit', 'explicit', 'disabled'].includes(h.fontBehavior as string)) return false
    for (const key of ['level1', 'level2', 'level3']) if (!hasFields(h[key], ['alignmentEnabled', 'bold', 'italic'], ['alignment'])) return false
  }
  if (value.margins !== null) {
    if (!isProfileObject(value.margins)) return false
    for (const key of ['left', 'right', 'top', 'bottom']) if (!hasFields(value.margins[key], ['enabled'], ['value'])) return false
  }
  if (value.references !== null && !hasFields(value.references,
    ['headingTextEnabled', 'allowHeadingAliases', 'headingBoldEnabled', 'headingBold', 'headingAlignmentEnabled', 'startOnNewPageEnabled', 'hangingIndentEnabled', 'lineSpacingEnabled', 'spaceBeforeEnabled', 'spaceAfterEnabled', 'fontFamilyEnabled', 'fontSizeEnabled', 'alignmentEnabled', 'referenceOrderEnabled', 'doiFormatEnabled'],
    ['headingText', 'headingAlignment', 'hangingIndent', 'lineSpacing', 'spaceBefore', 'spaceAfter', 'fontFamily', 'fontSize', 'alignment'])) return false
  if (value.captions !== null && !hasFields(value.captions, ['spaceBeforeEnabled', 'spaceAfterEnabled'], ['spaceBefore', 'spaceAfter'])) return false
  if (value.lists !== null && !hasFields(value.lists, ['spaceAfterEnabled'], ['spaceAfter'])) return false
  if (value.citation !== null && !hasFields(value.citation, ['check_citations_have_references', 'check_references_are_cited', 'check_author_year_consistency', 'check_year_suffixes', 'check_duplicate_references', 'flag_ambiguous_matches', 'allow_personal_communication'], [])) return false
  return true
}

function isValidRecovery(v: unknown): v is ProfileDraftRecovery {
  if (!isProfileObject(v) || Object.keys(v).sort().join(',') !== 'base_revision,draft,profile_id,schema_version,ui,updated_at') return false
  if (v.schema_version !== 2 || typeof v.profile_id !== 'string' || !v.profile_id.trim()) return false
  if (!Number.isSafeInteger(v.base_revision) || (v.base_revision as number) < 0) return false
  const d = v.draft
  if (!isProfileObject(d) || d.id !== v.profile_id || typeof d.name !== 'string' || typeof d.description !== 'string' || !isProfileObject(d.payload)) return false
  if (d.sourceId !== undefined && typeof d.sourceId !== 'string') return false
  if (!['draft', 'locally_valid', 'backend_confirmed', 'invalid'].includes(d.validationState as string) || typeof d.updatedAt !== 'string') return false
  return isUi(v.ui) && typeof v.updated_at === 'string' && !Number.isNaN(Date.parse(v.updated_at))
}

export function serializeDraftRecovery(recovery: ProfileDraftRecovery): string {
  return JSON.stringify(recovery)
}

export function parseDraftRecovery(raw: string | null): ProfileDraftRecovery | null {
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    return isValidRecovery(value) ? value : null
  } catch { return null }
}

export function loadDraftRecoveryResult(adapter: DraftRecoveryStorageAdapter | null): DraftRecoveryLoadResult {
  if (!adapter) return { status: 'unavailable' }
  try {
    const raw = adapter.get(PROFILE_DRAFT_RECOVERY_KEY)
    if (raw === null) return { status: 'empty' }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return { status: 'invalid' } }
    if (isProfileObject(parsed) && typeof parsed.schema_version === 'number' && parsed.schema_version !== 2) return { status: 'unsupported' }
    return isValidRecovery(parsed) ? { status: 'ready', recovery: parsed } : { status: 'invalid' }
  } catch { return { status: 'unavailable' } }
}

export function saveDraftRecovery(adapter: DraftRecoveryStorageAdapter | null, recovery: ProfileDraftRecovery): boolean {
  if (!adapter || !isValidRecovery(recovery)) return false
  const existing = loadDraftRecoveryResult(adapter)
  if (existing.status === 'invalid' || existing.status === 'unsupported' || existing.status === 'unavailable') return false
  try {
    adapter.set(PROFILE_DRAFT_RECOVERY_KEY, serializeDraftRecovery(recovery))
    return true
  } catch { return false }
}

/** Only an explicit discard or completed persistent operation clears recovery. */
export function clearDraftRecovery(adapter: DraftRecoveryStorageAdapter | null): boolean {
  if (!adapter) return false
  try { adapter.remove(PROFILE_DRAFT_RECOVERY_KEY); return true } catch { return false }
}

export type DraftRecoveryDecision =
  | { action: 'apply' | 'conflict'; recovery: ProfileDraftRecovery }
  | { action: 'invalid'; reason: 'malformed' | 'different-profile' }

export function decideDraftRecovery(recovery: ProfileDraftRecovery | null, currentProfileId: string | null, currentEnvelopeRevision: number): DraftRecoveryDecision {
  if (!recovery || !isValidRecovery(recovery)) return { action: 'invalid', reason: 'malformed' }
  if (currentProfileId !== null && recovery.profile_id !== currentProfileId) return { action: 'invalid', reason: 'different-profile' }
  return { action: recovery.base_revision === currentEnvelopeRevision ? 'apply' : 'conflict', recovery }
}

export function createSessionDraftRecoveryAdapter(): DraftRecoveryStorageAdapter | null {
  try {
    if (typeof window === 'undefined') return null
    const storage = window.sessionStorage
    const probe = '__profile_draft_recovery_probe__'
    storage.setItem(probe, '1')
    storage.removeItem(probe)
    return { get: (k) => storage.getItem(k), set: (k, v) => storage.setItem(k, v), remove: (k) => storage.removeItem(k) }
  } catch { return null }
}

export function createMemoryDraftRecoveryAdapter(): DraftRecoveryStorageAdapter {
  const map = new Map<string, string>()
  return { get: (k) => map.get(k) ?? null, set: (k, v) => { map.set(k, v) }, remove: (k) => { map.delete(k) } }
}
