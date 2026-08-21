/**
 * Upload-selector helpers (Build 6) — pure logic, testable without a
 * renderer or storage.
 *
 * - Namespaced selector identities: `builtin:<profile_id>` vs `custom:<uuid>`.
 * - Backward compatibility with an already-stored raw built-in id (e.g.
 *   "suc-academic-report") is retained.
 * - Merge built-ins + backend-confirmed custom profiles into one selector
 *   list; expose helpers to resolve the authoritative default, validate a
 *   persisted selection, and build an immutable submission request.
 */
import type { FormattingProfile } from '../types/api'
import type { StoredCustomProfile, StoreEnvelope } from './custom-profile-store/store.ts'
import { summarizeProfile } from './custom-profile-store/editor.ts'

// ---------------------------------------------------------------------------
// Selector identity: `builtin:<profile_id>` vs `custom:<uuid>`
// ---------------------------------------------------------------------------

export type SelectorKind = 'builtin' | 'custom'

export interface ParsedSelectorIdentity {
  kind: SelectorKind
  /** Built-in profile_id, or custom profile UUID. */
  id: string
}

const PREFIX_BUILTIN = 'builtin:'
const PREFIX_CUSTOM = 'custom:'

const RAW_BUILTIN_IDS = new Set<string>([
  'suc-academic-report',
  'apa7-student-paper',
])

function isWhitespaceOnly(s: string): boolean {
  return s.trim().length === 0
}
function hasWhitespace(s: string): boolean {
  return /\s/.test(s)
}
function hasControlChars(s: string): boolean {
  return /[\u0000-\u001F\u007f]/.test(s)
}

export function encodeSelectorIdentity(kind: SelectorKind, id: string): string {
  const trimmed = id.trim()
  if (trimmed.length === 0) {
    throw new Error('selector id must be non-empty')
  }
  if (hasWhitespace(trimmed) || hasControlChars(trimmed)) {
    throw new Error('selector id must not contain whitespace or control characters')
  }
  if (kind === 'builtin') return `${PREFIX_BUILTIN}${trimmed}`
  if (kind === 'custom') return `${PREFIX_CUSTOM}${trimmed}`
  throw new Error('unknown selector kind')
}

/**
 * Decode a persisted selector value.
 *
 * - `builtin:<id>` → `{kind:'builtin', id}` when suffix non-empty & sane.
 * - `custom:<id>`  → `{kind:'custom',  id}` when suffix non-empty & sane.
 * - bare-string with no colon that is a known raw built-in id → builtin.
 * - anything else → null (malformed — never interpreted as custom).
 */
export function decodeSelectorIdentity(raw: string): ParsedSelectorIdentity | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  if (isWhitespaceOnly(raw)) return null

  if (raw.startsWith(PREFIX_BUILTIN)) {
    const id = raw.slice(PREFIX_BUILTIN.length)
    if (id.length === 0 || hasWhitespace(id) || hasControlChars(id)) return null
    return { kind: 'builtin', id }
  }
  if (raw.startsWith(PREFIX_CUSTOM)) {
    const id = raw.slice(PREFIX_CUSTOM.length)
    if (id.length === 0 || hasWhitespace(id) || hasControlChars(id)) return null
    return { kind: 'custom', id }
  }
  if (RAW_BUILTIN_IDS.has(raw)) {
    return { kind: 'builtin', id: raw }
  }
  return null
}

// ---------------------------------------------------------------------------
// Merged selector: built-ins + backend-confirmed custom profiles only
// ---------------------------------------------------------------------------

export type SelectorOption = {
  /** Namespaced value consumed by the UI <Select> (never shown to the user). */
  value: string
  kind: SelectorKind
  /** Built-in profile_id or custom profile UUID (for lookups). */
  underlyingId: string
  displayName: string
  description: string
  /** Presentation-safe key requirements shown beneath the selector. */
  keyRequirements: string[]
  citationStyle: string
  /** Custom budgets use the summarizer; built-ins use the backend's text. */
  isBuiltIn: boolean
  isRecommended: boolean
  /** Only present for custom entries (used on submit). */
  sourceCustomId?: string
}

export function buildSelectorOptions(
  builtinProfiles: FormattingProfile[],
  confirmedCustomProfiles: readonly StoredCustomProfile[],
): SelectorOption[] {
  const opts: SelectorOption[] = []
  for (const p of builtinProfiles) {
    opts.push({
      value: encodeSelectorIdentity('builtin', p.profile_id),
      kind: 'builtin',
      underlyingId: p.profile_id,
      displayName: p.profile_name,
      description: p.description,
      keyRequirements: [...p.key_requirements],
      citationStyle: p.citation_style,
      isBuiltIn: true,
      isRecommended: p.recommended,
    })
  }
  for (const p of confirmedCustomProfiles) {
    // Only backend-confirmed custom profiles ever reach here — callers
    // must filter; defense-in-depth guard:
    if (p.validationState !== 'backend_confirmed') continue
    const summary = summarizeProfile(p.payload as Record<string, unknown>)
    // summary.lines already includes human terms; append a disabled line to
    // keyRequirements so the selector mirrors the editor's wording.
    const keyReqs = [
      ...summary.lines,
      `${summary.disabledCount} requirements will not be checked or included in the score.`,
    ]
    opts.push({
      value: encodeSelectorIdentity('custom', p.id),
      kind: 'custom',
      underlyingId: p.id,
      displayName: p.name,
      description: p.description,
      keyRequirements: keyReqs,
      citationStyle: 'APA 7',
      isBuiltIn: false,
      isRecommended: false,
      sourceCustomId: p.id,
    })
  }
  return opts
}

// ---------------------------------------------------------------------------
// Resolve the authoritative selected identity (pure)
// ---------------------------------------------------------------------------

export type ResolveUploadSelectionResult = {
  selectedValue: string | null
  stale: boolean
  /** The normalized identity to persist when differing from decodedRaw. */
  normalizedPersisted?: string
  /** Friendly message when stale and not a first visit. */
  friendlyMessage?: string
}

function isKnownBuiltin(builtinProfiles: FormattingProfile[], id: string): boolean {
  return builtinProfiles.some((p) => p.profile_id === id)
}

function recommendedBuiltinId(builtinProfiles: FormattingProfile[]): string | null {
  const rec = builtinProfiles.find((p) => p.recommended)
  if (rec) return rec.profile_id
  if (builtinProfiles.length > 0) return builtinProfiles[0].profile_id
  return null
}

/**
 * Resolve the persisted selection against the current merged identity set.
 *
 * Built-ins are authoritative: we prefer the backend-provided recommended
 * SUC profile whenever the persisted choice is no longer valid.
 */
export function resolveUploadSelection(
  builtinProfiles: FormattingProfile[],
  confirmedCustomProfiles: readonly StoredCustomProfile[],
  rawSelectedId: string | null,
  // Present for documentation parity; not currently branched on.
  _hasBuiltinsFailed: boolean,
  firstVisit: boolean,
): ResolveUploadSelectionResult {
  void _hasBuiltinsFailed
  const reco = recommendedBuiltinId(builtinProfiles)
  const recoValue = reco ? encodeSelectorIdentity('builtin', reco) : null

  // No previous selection — default to the authoritative recommended built-in
  // when available (no missing-selection toast on a genuine first visit).
  if (!rawSelectedId) {
    return { selectedValue: recoValue, stale: false }
  }

  const decoded = decodeSelectorIdentity(rawSelectedId)
  if (!decoded) {
    // Malformed → reset to recommended, this is considered stale since the
    // user had *something* stored that we cannot interpret.
    if (firstVisit) return { selectedValue: recoValue, stale: false }
    return {
      selectedValue: recoValue,
      stale: true,
      friendlyMessage: staleFriendlyMessage(),
    }
  }

  // Normalize legacy raw built-ins on resolution.
  const canonical = encodeSelectorIdentity(decoded.kind, decoded.id)
  const needsNormalization = canonical !== rawSelectedId

  if (decoded.kind === 'builtin') {
    if (isKnownBuiltin(builtinProfiles, decoded.id)) {
      if (needsNormalization && _hasBuiltinsFailed) {
        // Don't write while built-ins are still loading/failing — reflect
        // the normalized value only in selectedValue, not as an immediate write.
        return {
          selectedValue: canonical,
          stale: false,
          normalizedPersisted: canonical,
        }
      }
      return {
        selectedValue: canonical,
        stale: false,
        ...(needsNormalization ? { normalizedPersisted: canonical } : {}),
      }
    }
    // Unknown/stale built-in
    if (firstVisit) return { selectedValue: recoValue, stale: false }
    return {
      selectedValue: recoValue,
      stale: true,
      friendlyMessage: staleFriendlyMessage(),
    }
  }

  // decoded.kind === 'custom'
  const hit = confirmedCustomProfiles.find(
    (p) => p.id === decoded.id && p.validationState === 'backend_confirmed',
  )
  if (hit) {
    return { selectedValue: canonical, stale: false }
  }
  if (firstVisit) return { selectedValue: recoValue, stale: false }
  return {
    selectedValue: recoValue,
    stale: true,
    friendlyMessage: staleFriendlyMessage(),
  }
}

export function staleFriendlyMessage(): string {
  return 'Your selected document requirements were reset to the recommended profile because the previous selection is no longer available.'
}

// ---------------------------------------------------------------------------
// Submit-time revalidation + frozen in-flight request
// ---------------------------------------------------------------------------

export type FrozenSubmission =
  | {
      kind: 'builtin'
      identity: ParsedSelectorIdentity
      profileId: string
      envelopeRevision: number
    }
  | {
      kind: 'custom'
      identity: ParsedSelectorIdentity
      /** Deep-copied backend-normalized payload. */
      payload: Record<string, unknown>
      sourceCustomId: string
      envelopeRevision: number
    }
  | {
      /** No known profile available — backend will fall back to recommended SUC. */
      kind: 'fallback'
      rawStoredId: string | null
      envelopeRevision: number
    }

export type ValidateSubmissionResult =
  | { ok: true; frozen: FrozenSubmission }
  | {
      ok: false
      reason: 'stale' | 'missing' | 'fallback-unavailable'
      friendlyMessage: string
      resetToRecommended?: boolean
    }

function deepCopyRecord<T>(v: T): T {
  if (typeof structuredClone === 'function') return structuredClone(v)
  return JSON.parse(JSON.stringify(v)) as T
}

/**
 * Re-read the *latest* valid envelope + decode the frozen selection the user
 * picked, then build an immutable snapshot to send before upload begins.
 *
 * External storage events after this function returns must NOT mutate `frozen`.
 */
export function validateAndFreezeSubmission(
  envelope: StoreEnvelope,
  builtinProfiles: FormattingProfile[],
  selectedValue: string | null,
): ValidateSubmissionResult {
  if (!selectedValue) {
    const reco = recommendedBuiltinId(builtinProfiles)
    if (reco) {
      return {
        ok: true,
        frozen: { kind: 'fallback', rawStoredId: null, envelopeRevision: envelope.revision },
      }
    }
    return {
      ok: false,
      reason: 'fallback-unavailable',
      friendlyMessage: 'Document requirements could not be determined. Please try again.',
    }
  }

  const decoded = decodeSelectorIdentity(selectedValue)
  if (!decoded) {
    return {
      ok: false,
      reason: 'stale',
      friendlyMessage: staleFriendlyMessage(),
      resetToRecommended: true,
    }
  }

  if (decoded.kind === 'builtin') {
    if (!isKnownBuiltin(builtinProfiles, decoded.id)) {
      return {
        ok: false,
        reason: 'stale',
        friendlyMessage: staleFriendlyMessage(),
        resetToRecommended: true,
      }
    }
    return {
      ok: true,
      frozen: {
        kind: 'builtin',
        identity: decoded,
        profileId: decoded.id,
        envelopeRevision: envelope.revision,
      },
    }
  }

  // custom
  const profile = envelope.profiles.find(
    (p) => p.id === decoded.id,
  )
  if (!profile) {
    return {
      ok: false,
      reason: 'stale',
      friendlyMessage: staleFriendlyMessage(),
      resetToRecommended: true,
    }
  }
  if (profile.validationState !== 'backend_confirmed') {
    return {
      ok: false,
      reason: 'stale',
      friendlyMessage: staleFriendlyMessage(),
      resetToRecommended: true,
    }
  }
  return {
    ok: true,
    frozen: {
      kind: 'custom',
      identity: decoded,
      payload: deepCopyRecord(profile.payload as Record<string, unknown>),
      sourceCustomId: profile.id,
      envelopeRevision: envelope.revision,
    },
  }
}
