/**
 * Unsaved Custom Profile editor draft recovery (sessionStorage, tab-scoped).
 *
 * A page reload during editing previously lost unsaved edits. This module
 * persists ONLY an unsaved editor draft recovery record so the Profile
 * Editor can restore it after a same-tab refresh.
 *
 * Persisted shape (presentation-safe — never document data):
 *   schema_version, profile_id ('new' for a fresh unsaved draft),
 *   base_revision (last-confirmed envelope revision the draft was edited on),
 *   payload (editable profile payload), updated_at.
 *
 * Never persisted: document text, filename, DOCX bytes, Audit data,
 * findings, credentials, API keys, filesystem paths.
 */

export const PROFILE_DRAFT_RECOVERY_KEY = 'custom-profile-draft-recovery:v1'
export const PROFILE_DRAFT_RECOVERY_SCHEMA_VERSION = 1

/** Sentinel identity for a freshly created (never-persisted) draft. */
export const NEW_DRAFT_ID = 'new'

export interface ProfileDraftRecovery {
  schema_version: number
  /** Custom profile id, or 'new' for a fresh unsaved draft. */
  profile_id: string
  /** Envelope revision the draft was being edited against. */
  base_revision: number
  /** The editable profile payload as left by the user. */
  payload: Record<string, unknown>
  updated_at: string
}

export interface DraftRecoveryStorageAdapter {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

const ALLOWED_KEYS = new Set<string>([
  'schema_version',
  'profile_id',
  'base_revision',
  'payload',
  'updated_at',
])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isValidRecovery(v: unknown): v is ProfileDraftRecovery {
  if (!isRecord(v)) return false
  for (const k of Object.keys(v)) {
    if (!ALLOWED_KEYS.has(k)) return false
  }
  if (typeof v.schema_version !== 'number' || v.schema_version !== PROFILE_DRAFT_RECOVERY_SCHEMA_VERSION) return false
  if (typeof v.profile_id !== 'string' || v.profile_id.trim().length === 0) return false
  if (typeof v.base_revision !== 'number' || !Number.isFinite(v.base_revision) || !Number.isInteger(v.base_revision) || v.base_revision < 0) return false
  if (!isRecord(v.payload)) return false
  if (typeof v.updated_at !== 'string' || Number.isNaN(Date.parse(v.updated_at))) return false
  return true
}

export function serializeDraftRecovery(recovery: ProfileDraftRecovery): string {
  return JSON.stringify(recovery)
}

export function parseDraftRecovery(raw: string | null): ProfileDraftRecovery | null {
  if (raw === null || raw.trim().length === 0) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isValidRecovery(parsed)) return parsed
    return null
  } catch {
    return null
  }
}

export function saveDraftRecovery(
  adapter: DraftRecoveryStorageAdapter | null,
  recovery: ProfileDraftRecovery,
): boolean {
  if (!adapter) return false
  if (!isValidRecovery(recovery)) return false
  try {
    adapter.set(PROFILE_DRAFT_RECOVERY_KEY, serializeDraftRecovery(recovery))
    return true
  } catch {
    return false
  }
}

/**
 * Load and structurally validate the recovery record. Malformed or
 * future-version records are removed so they cannot linger.
 */
export function loadDraftRecovery(
  adapter: DraftRecoveryStorageAdapter | null,
): ProfileDraftRecovery | null {
  if (!adapter) return null
  try {
    const raw = adapter.get(PROFILE_DRAFT_RECOVERY_KEY)
    if (raw === null) return null
    const parsed = parseDraftRecovery(raw)
    if (!parsed) {
      try { adapter.remove(PROFILE_DRAFT_RECOVERY_KEY) } catch { /* ignore */ }
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function clearDraftRecovery(adapter: DraftRecoveryStorageAdapter | null): void {
  if (!adapter) return
  try { adapter.remove(PROFILE_DRAFT_RECOVERY_KEY) } catch { /* ignore */ }
}

/**
 * Decide whether a recovery record can be applied to the current editor
 * state. Returns a discriminated result; never throws.
 *
 * - `apply`   → same profile (or new draft) AND unchanged confirmed revision.
 * - `conflict`→ same profile but another tab changed the confirmed revision;
 *               do NOT apply automatically — surface a conflict notice.
 * - `invalid` → malformed / future version / different profile — remove it.
 */
export type DraftRecoveryDecision =
  | { action: 'apply'; recovery: ProfileDraftRecovery }
  | { action: 'conflict'; recovery: ProfileDraftRecovery }
  | { action: 'invalid'; reason: 'malformed' | 'future-version' | 'stale-revision' | 'different-profile' }

export function decideDraftRecovery(
  recovery: ProfileDraftRecovery | null,
  currentProfileId: string | null,
  currentEnvelopeRevision: number,
): DraftRecoveryDecision {
  if (!recovery) return { action: 'invalid', reason: 'malformed' }
  const targetId = currentProfileId ?? NEW_DRAFT_ID
  if (recovery.profile_id !== targetId) {
    return { action: 'invalid', reason: 'different-profile' }
  }
  if (recovery.base_revision === currentEnvelopeRevision) {
    return { action: 'apply', recovery }
  }
  // Another tab advanced the confirmed revision — stale draft must not be
  // applied silently.
  return { action: 'conflict', recovery }
}

export function createSessionDraftRecoveryAdapter(): DraftRecoveryStorageAdapter | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null
    const probe = '__profile_draft_recovery_probe__'
    window.sessionStorage.setItem(probe, '1')
    window.sessionStorage.removeItem(probe)
    return {
      get: (k) => window.sessionStorage.getItem(k),
      set: (k, v) => window.sessionStorage.setItem(k, v),
      remove: (k) => window.sessionStorage.removeItem(k),
    }
  } catch {
    return null
  }
}

export function createMemoryDraftRecoveryAdapter(): DraftRecoveryStorageAdapter {
  const map = new Map<string, string>()
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => { map.set(k, v) },
    remove: (k) => { map.delete(k) },
  }
}
