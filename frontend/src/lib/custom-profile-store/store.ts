/**
 * Custom Document Formatting Profile store — Build 1 PoC.
 *
 * Pure persistence layer for local custom profiles. No editor UI, no
 * backend calls. Stored profile payloads are treated as LOCALLY well-formed
 * (structure validated here); authoritative backend validation is a later
 * Build and gates submission, never the local store.
 *
 * Storage adapter is injected so core logic stays deterministic and
 * testable without touching `window`/`localStorage`.
 */
import type { FormattingProfile } from '../../types/api'

export const CUSTOM_STORE_SCHEMA_VERSION = 1

export const RECOMMENDED_BUILTIN_ID = 'suc-academic-report'

/**
 * Validation lifecycle state of a stored custom profile.
 * Only `backend_confirmed` profiles may later be submitted to an Audit.
 */
export type ProfileValidationState =
  | 'draft'
  | 'locally_valid'
  | 'backend_confirmed'
  | 'invalid'

export interface StoredCustomProfile {
  /** Immutable internal ID (generated, never user-edited). */
  id: string
  /** User-editable display name. */
  name: string
  description: string
  /** Source profile id the custom profile was derived from, when known. */
  sourceId?: string
  /** The locally well-formed payload shaped like a DocumentFormattingProfile. */
  payload: Record<string, unknown>
  validationState: ProfileValidationState
  updatedAt: string
}

export interface StoreEnvelope {
  schema_version: number
  /** Monotonic revision — bumped on every confirmed write. */
  revision: number
  updated_at: string
  profiles: StoredCustomProfile[]
  selected_id: string | null
}

export type StoreLoadResult =
  | {
      ok: true
      envelope: StoreEnvelope
      /** True when the active key was unusable and recovery was used. */
      recovered: boolean
      /** True when this is a fresh store (no active, no recovery). */
      firstRun: boolean
      /** True when the loaded envelope is from a future schema version. */
      readonly: boolean
      /** An unreadable sibling copy is retained until a deliberate mutation/reset. */
      damagedCopies?: Array<'active' | 'recovery'>
    }
  | {
      ok: false
      reason: 'both-corrupted' | 'unavailable' | 'unsupported-version'
      /** Raw active value preserved for optional local export. */
      corruptedActive: string | null
      /** Raw recovery value preserved for optional local export. */
      corruptedRecovery: string | null
    }

export type WriteResult =
  | { ok: true; envelope: StoreEnvelope }
  | { ok: false; reason: 'stale-revision' | 'invalid-envelope' | 'readonly' | 'unavailable' | 'corrupted' | 'not-persistent' | 'locking-unavailable' | 'write-failed' }

/** Minimal injected adapter — keeps core logic free of globals. */
export interface StoreAdapter {
  readonly persistent: boolean
  /** Origin-scoped serialization; the live revision is checked inside it. */
  readonly withExclusiveWrite?: <T>(write: () => T | Promise<T>) => Promise<T>
  get(key: string): string | null
  set(key: string, value: string): void
  /** Subscribe to external (other-tab) key changes; returns unsubscribe. */
  onExternalChange(cb: (key: string) => void): () => void
}

export interface StorageEventPayload {
  key: string | null
  newValue: string | null
}

/** Well-known key names. Recovery is a SEPARATE key, never nested. */
export const ACTIVE_KEY = 'custom-profiles:active'
export const RECOVERY_KEY = 'custom-profiles:recovery'

// ---------------------------------------------------------------------------
// Primitive identity
// ---------------------------------------------------------------------------

/** Generate an immutable internal profile ID (uuid-ish, CSP-safe). */
export function generateProfileId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const rand = (): string =>
    Math.random().toString(16).slice(2, 10).padStart(8, '0')
  return `c-${rand()}${rand()}-${Date.now().toString(36)}`
}

// ---------------------------------------------------------------------------
// Envelope structure validation (local well-formedness only)
// ---------------------------------------------------------------------------

export function isProfileObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStoredProfile(v: unknown): v is StoredCustomProfile {
  if (!isProfileObject(v)) return false
  if (typeof v.id !== 'string' || v.id.trim().length === 0) return false
  if (typeof v.name !== 'string' || v.name.trim().length === 0) return false
  if (typeof v.description !== 'string') return false
  if (v.sourceId !== undefined && typeof v.sourceId !== 'string') return false
  if (!isProfileObject(v.payload)) return false
  const state = v.validationState
  if (state !== 'draft' && state !== 'locally_valid' && state !== 'backend_confirmed' && state !== 'invalid') {
    return false
  }
  if (typeof v.updatedAt !== 'string') return false
  return true
}

/** Locally validate envelope structure. NOT authoritative backend validation. */
export function isWellFormedEnvelope(v: unknown): v is StoreEnvelope {
  if (!isProfileObject(v)) return false
  if (typeof v.schema_version !== 'number' || !Number.isInteger(v.schema_version) || v.schema_version < 1) return false
  if (typeof v.revision !== 'number' || !Number.isSafeInteger(v.revision) || v.revision < 0) return false
  if (typeof v.updated_at !== 'string' || v.updated_at.length === 0) return false
  if (!Array.isArray(v.profiles)) return false
  for (const p of v.profiles) {
    if (!isStoredProfile(p)) return false
  }
  if (v.selected_id !== null && typeof v.selected_id !== 'string') return false
  return true
}

/** True when the envelope uses a schema version this build understands. */
export function isCurrentSchemaVersion(v: unknown): boolean {
  return isProfileObject(v) && v.schema_version === CUSTOM_STORE_SCHEMA_VERSION
}

/** True when the envelope predates (is older than) this build's schema. */
export function isLegacySchemaVersion(v: unknown): boolean {
  return isProfileObject(v) && typeof v.schema_version === 'number' && v.schema_version < CUSTOM_STORE_SCHEMA_VERSION
}

// ---------------------------------------------------------------------------
// Fresh / default state
// ---------------------------------------------------------------------------

export function emptyEnvelope(): StoreEnvelope {
  return {
    schema_version: CUSTOM_STORE_SCHEMA_VERSION,
    revision: 0,
    updated_at: new Date(0).toISOString(),
    profiles: [],
    selected_id: null,
  }
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export function findProfile(
  envelope: StoreEnvelope,
  id: string,
): StoredCustomProfile | undefined {
  return envelope.profiles.find((p) => p.id === id)
}

export function findProfileByName(
  envelope: StoreEnvelope,
  name: string,
): StoredCustomProfile | undefined {
  const lower = name.trim().toLowerCase()
  return envelope.profiles.find((p) => p.name.trim().toLowerCase() === lower)
}

/** Case-insensitive name uniqueness check (excludes the profile itself). */
export function isNameTaken(
  envelope: StoreEnvelope,
  name: string,
  excludeId?: string,
): boolean {
  const existing = findProfileByName(envelope, name)
  return existing !== undefined && existing.id !== excludeId
}

/** Deterministic envelope serialization (no object-identity drift). */
export function serializeEnvelope(envelope: StoreEnvelope): string {
  return JSON.stringify(envelope)
}

// ---------------------------------------------------------------------------
// Core operations (pure — operate on a given envelope, return a new one)
// ---------------------------------------------------------------------------

function cloneProfile(p: StoredCustomProfile): StoredCustomProfile {
  return {
    ...p,
    payload: structuredCloneSafe(p.payload),
  }
}

function structuredCloneSafe<T>(v: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(v)
  }
  return JSON.parse(JSON.stringify(v)) as T
}

function cloneEnvelope(envelope: StoreEnvelope): StoreEnvelope {
  return {
    ...envelope,
    profiles: envelope.profiles.map(cloneProfile),
  }
}

/** Add or update a profile. Enforces case-insensitive unique display names. */
export function upsertProfile(
  envelope: StoreEnvelope,
  profile: StoredCustomProfile,
): { ok: true; envelope: StoreEnvelope } | { ok: false; reason: 'duplicate-name' | 'duplicate-id' } {
  const trimmed = profile.name.trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: 'duplicate-name' }
  }
  const nameClash = envelope.profiles.some(
    (p) => p.id !== profile.id && p.name.trim().toLowerCase() === trimmed.toLowerCase(),
  )
  if (nameClash) {
    return { ok: false, reason: 'duplicate-name' }
  }
  const next = cloneEnvelope(envelope)
  const idx = next.profiles.findIndex((p) => p.id === profile.id)
  const stored = {
    ...cloneProfile(profile),
    name: trimmed,
    payload: structuredCloneSafe(profile.payload),
  }
  if (idx >= 0) {
    next.profiles[idx] = stored
  } else {
    next.profiles.push(stored)
  }
  return { ok: true, envelope: next }
}

export function renameProfile(
  envelope: StoreEnvelope,
  id: string,
  newName: string,
): { ok: true; envelope: StoreEnvelope } | { ok: false; reason: 'not-found' | 'duplicate-name' } {
  const existing = findProfile(envelope, id)
  if (!existing) return { ok: false, reason: 'not-found' }
  const trimmed = newName.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'duplicate-name' }
  if (isNameTaken(envelope, trimmed, id)) return { ok: false, reason: 'duplicate-name' }
  const next = cloneEnvelope(envelope)
  const idx = next.profiles.findIndex((p) => p.id === id)
  next.profiles[idx] = {
    ...next.profiles[idx], name: trimmed,
    payload: { ...next.profiles[idx].payload, profile_name: trimmed },
  }
  return { ok: true, envelope: next }
}

/**
 * Duplicate an existing profile into a new immutable id.
 * Works for both stored custom profiles and built-in listings.
 */
export function duplicateProfile(
  envelope: StoreEnvelope,
  source: StoredCustomProfile | FormattingProfile,
  newName: string,
  now = new Date().toISOString(),
): { ok: true; envelope: StoreEnvelope; profile: StoredCustomProfile } | { ok: false; reason: 'duplicate-name' } {
  const trimmed = newName.trim()
  if (trimmed.length === 0 || isNameTaken(envelope, trimmed)) {
    return { ok: false, reason: 'duplicate-name' }
  }
  const isBuiltIn = 'profile_source' in source && source.profile_source === 'built_in'
  const payload: Record<string, unknown> =
    'payload' in source && isProfileObject(source.payload)
      ? structuredCloneSafe(source.payload)
      : {
          profile_name: trimmed,
          citation_style: 'APA 7',
          profile_source: 'custom',
        }
  const profile: StoredCustomProfile = {
    id: generateProfileId(),
    name: trimmed,
    description: 'description' in source && typeof source.description === 'string' ? source.description : '',
    // Both stored custom profiles (`id`) and built-in listings (`profile_id`)
    // expose the source identity under one of these keys.
    sourceId: 'id' in source && typeof source.id === 'string' ? source.id
      : 'profile_id' in source && typeof source.profile_id === 'string' ? source.profile_id
      : undefined,
    payload,
    validationState: 'locally_valid',
    updatedAt: now,
  }
  profile.payload.profile_id = profile.id
  profile.payload.profile_name = profile.name
  profile.payload.description = profile.description
  profile.payload.profile_source = 'custom'
  if (isBuiltIn && !('payload' in source)) {
    // Built-in listings have no payload in this build — mark as needing a
    // source-copy payload from the backend before it can be submitted.
    profile.validationState = 'draft'
  }
  const next = cloneEnvelope(envelope)
  next.profiles.push(profile)
  return { ok: true, envelope: next, profile }
}

export function deleteProfile(
  envelope: StoreEnvelope,
  id: string,
): { ok: true; envelope: StoreEnvelope } | { ok: false; reason: 'not-found' } {
  if (!findProfile(envelope, id)) return { ok: false, reason: 'not-found' }
  const next = cloneEnvelope(envelope)
  next.profiles = next.profiles.filter((p) => p.id !== id)
  if (next.selected_id === `custom:${id}`) {
    next.selected_id = `builtin:${RECOMMENDED_BUILTIN_ID}`
  }
  return { ok: true, envelope: next }
}

export function setSelectedProfile(
  envelope: StoreEnvelope,
  id: string | null,
): StoreEnvelope {
  return { ...envelope, selected_id: id }
}

export function markValidationState(
  envelope: StoreEnvelope,
  id: string,
  state: ProfileValidationState,
): { ok: true; envelope: StoreEnvelope } | { ok: false; reason: 'not-found' } {
  if (!findProfile(envelope, id)) return { ok: false, reason: 'not-found' }
  const next = cloneEnvelope(envelope)
  const idx = next.profiles.findIndex((p) => p.id === id)
  next.profiles[idx] = { ...next.profiles[idx], validationState: state }
  return { ok: true, envelope: next }
}

/** Only `backend_confirmed` profiles may be submitted to an Audit. */
export function canSubmitProfile(profile: StoredCustomProfile | undefined): boolean {
  return profile !== undefined && profile.validationState === 'backend_confirmed'
}

// ---------------------------------------------------------------------------
// Load / recover / persist
// ---------------------------------------------------------------------------

/**
 * Load the best envelope from active + recovery.
 * - Validates both independently; never merges partially valid data.
 * - Chooses the valid envelope with the HIGHEST revision.
 * - A fresh store (neither key set) returns a first-run empty envelope.
 * - Both invalid → corrupted state with raw values preserved for export.
 */
export function loadStore(adapter: StoreAdapter): StoreLoadResult {
  let rawActive: string | null
  let rawRecovery: string | null
  try {
    rawActive = adapter.get(ACTIVE_KEY)
    rawRecovery = adapter.get(RECOVERY_KEY)
  } catch {
    return { ok: false, reason: 'unavailable', corruptedActive: null, corruptedRecovery: null }
  }

  if (rawActive === null && rawRecovery === null) {
    return { ok: true, envelope: emptyEnvelope(), recovered: false, firstRun: true, readonly: false }
  }

  let activeValue: unknown = null
  let recoveryValue: unknown = null
  try { if (rawActive !== null) activeValue = JSON.parse(rawActive) } catch { /* retained below */ }
  try { if (rawRecovery !== null) recoveryValue = JSON.parse(rawRecovery) } catch { /* retained below */ }
  const active = isWellFormedEnvelope(activeValue) ? activeValue : null
  const recovery = isWellFormedEnvelope(recoveryValue) ? recoveryValue : null
  if ([activeValue, recoveryValue].some((value) =>
    isProfileObject(value) && typeof value.schema_version === 'number' &&
    value.schema_version > CUSTOM_STORE_SCHEMA_VERSION && !isWellFormedEnvelope(value))) {
    return { ok: false, reason: 'unsupported-version', corruptedActive: rawActive, corruptedRecovery: rawRecovery }
  }

  // Unsupported FUTURE schema versions are read-only.
  if ((active && !isCurrentSchemaVersion(active)) || (recovery && !isCurrentSchemaVersion(recovery))) {
    const future = active && !isCurrentSchemaVersion(active) ? active : recovery!
    return { ok: true, envelope: future, recovered: future === recovery, firstRun: false, readonly: true }
  }

  if (active && recovery) {
    return {
      ok: true,
      envelope: active.revision >= recovery.revision ? active : recovery,
      recovered: recovery.revision > active.revision,
      firstRun: false,
      readonly: false,
    }
  }
  if (active) {
    return { ok: true, envelope: active, recovered: false, firstRun: false, readonly: false,
      ...(rawRecovery !== null ? { damagedCopies: ['recovery'] as Array<'active' | 'recovery'> } : {}) }
  }
  if (recovery) {
    return { ok: true, envelope: recovery, recovered: true, firstRun: false, readonly: false,
      ...(rawActive !== null ? { damagedCopies: ['active'] as Array<'active' | 'recovery'> } : {}) }
  }

  return { ok: false, reason: 'both-corrupted', corruptedActive: rawActive, corruptedRecovery: rawRecovery }
}

function parseEnvelope(raw: string | null): StoreEnvelope | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isWellFormedEnvelope(parsed)) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/**
 * All persistent mutations are serialized by the adapter's origin-scoped lock.
 * Validation may happen before acquiring it; the baseline is rechecked here.
 */
export async function saveStore(
  adapter: StoreAdapter,
  envelope: StoreEnvelope,
  expectedRevision: number,
): Promise<WriteResult> {
  if (!adapter.persistent) return { ok: false, reason: 'not-persistent' }
  if (!adapter.withExclusiveWrite) return { ok: false, reason: 'locking-unavailable' }
  try {
    return await adapter.withExclusiveWrite(() => {
      const loaded = loadStore(adapter)
      if (!loaded.ok) return { ok: false, reason: loaded.reason === 'unsupported-version' ? 'readonly' : loaded.reason === 'unavailable' ? 'unavailable' : 'corrupted' } as WriteResult
      if (loaded.readonly) return { ok: false, reason: 'readonly' } as WriteResult
      const current = loaded.envelope
      if (current.revision !== expectedRevision) return { ok: false, reason: 'stale-revision' } as WriteResult
      if (!isWellFormedEnvelope(envelope) || envelope.revision !== expectedRevision + 1) {
        return { ok: false, reason: 'invalid-envelope' } as WriteResult
      }
      if (!isCurrentSchemaVersion(envelope)) return { ok: false, reason: 'readonly' } as WriteResult
      // Retain the last usable committed copy before replacing active. A failed
      // recovery write never touches active; a failed active write leaves recovery.
      const previous = serializeEnvelope(current)
      const serialized = serializeEnvelope(envelope)
      try {
        if (!loaded.firstRun) adapter.set(RECOVERY_KEY, previous)
        adapter.set(ACTIVE_KEY, serialized)
      } catch {
        return { ok: false, reason: 'write-failed' } as WriteResult
      }
      return { ok: true, envelope: structuredCloneSafe(envelope) } as WriteResult
    })
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

/**
 * Detect a multi-tab conflict: compare an externally observed revision
 * against the caller's known revision.
 */
export function hasNewerExternalRevision(
  knownRevision: number,
  observedEnvelope: StoreEnvelope | null,
): boolean {
  return observedEnvelope !== null && observedEnvelope.revision > knownRevision
}

/** Handle a storage event payload for the active/recovery keys. */
export function handleStorageEvent(
  adapter: StoreAdapter,
  event: StorageEventPayload,
): { conflict: boolean; envelope: StoreEnvelope | null } {
  if (event.key === null) return { conflict: false, envelope: null }
  const current = parseEnvelope(adapter.get(ACTIVE_KEY))
  if (event.key === ACTIVE_KEY || event.key === RECOVERY_KEY) {
    const fresh = parseEnvelope(event.newValue)
    const loaded = loadStore(adapter)
    if (loaded.ok) {
      // Prefer the event's parsed value — it is the authoritative external
      // write that triggered the other tab's storage event.
      const best = fresh ?? loaded.envelope
      if (current && fresh) {
        return { conflict: fresh.revision > current.revision, envelope: best }
      }
      return { conflict: false, envelope: best }
    }
  }
  return { conflict: false, envelope: null }
}

/** Explicit user-confirmed reset only; never downgrades unsupported data. */
export async function acceptReset(adapter: StoreAdapter): Promise<WriteResult> {
  if (!adapter.persistent) return { ok: false, reason: 'not-persistent' }
  if (!adapter.withExclusiveWrite) return { ok: false, reason: 'locking-unavailable' }
  try {
    return await adapter.withExclusiveWrite(() => {
      const loaded = loadStore(adapter)
      if (loaded.ok) return { ok: false, reason: loaded.readonly ? 'readonly' : 'stale-revision' } as WriteResult
      if (loaded.reason !== 'both-corrupted') return { ok: false, reason: loaded.reason === 'unsupported-version' ? 'readonly' : 'unavailable' } as WriteResult
      const clean = emptyEnvelope()
      clean.selected_id = `builtin:${RECOMMENDED_BUILTIN_ID}`
      clean.revision = 1
      clean.updated_at = new Date().toISOString()
      try {
        adapter.set(ACTIVE_KEY, serializeEnvelope(clean))
        adapter.set(RECOVERY_KEY, serializeEnvelope(clean))
        return { ok: true, envelope: clean } as WriteResult
      } catch { return { ok: false, reason: 'write-failed' } as WriteResult }
    })
  } catch { return { ok: false, reason: 'unavailable' } }
}
