/**
 * Custom Profile Editor (Build 5) — editor shell, profile list, creation
 * paths, and backend-gated save.
 *
 * Scope:
 *   - view built-in and saved custom profiles;
 *   - duplicate SUC Academic Report / APA 7 Student Paper;
 *   - create a safe blank custom profile;
 *   - edit custom profile name + description;
 *   - Body, Headings, Margins, References, Captions, and Lists controls;
 *   - save ONLY after POST /api/formatting-profiles/validate succeeds;
 *   - return to the upload workflow.
 *
 * Deliberately deferred: deletion (Build 7) and upload-selector integration
 * (Build 6). The editor is a dedicated route — never a full-page modal.
 *
 * Accessibility: semantic heading, labelled fields, fieldsets, keyboard
 * reachable list, visible focus, inline field errors, aria-live status, focus
 * trap + restoration for the confirm dialog, no color-only status, and 44px
 * minimum action targets.
 */
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Copy,
  Plus,
  Pencil,
  Save,
  ArrowLeft,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Info,
  FileText,
  Trash2,
  ChevronsDownUp,
  ChevronsUpDown,
} from 'lucide-react'
import { AppNav } from '../components/layout/AppNav'
import { AppFooter } from '../components/layout/AppFooter'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { ConfirmDialog } from '../components/ui/confirm-dialog'
import { api } from '../services/api'
import { formatAuditDateTime } from '../lib/format-date'
import {
  clearDraftRecovery,
  createSessionDraftRecoveryAdapter,
  decideDraftRecovery,
  loadDraftRecovery,
  saveDraftRecovery,
  NEW_DRAFT_ID,
} from '../lib/custom-profile-store/draft-recovery'
import type { ProfileDraftRecovery } from '../lib/custom-profile-store/draft-recovery'
import {
  APA_BUILTIN_ID,
  SUC_BUILTIN_ID,
  CITATION_STYLE,
  CREATION_LABELS,
  DEFAULT_PROFILE_NAMES,
  MAX_DESCRIPTION_LENGTH,
  blankProfilePayload,
  copyProfilePayload,
  clientValidate,
  createMemoryStoreAdapter,
  deleteAndBump,
  friendlySourceName,
  generateProfileId,
  headingFromUiModel,
  headingToUiModel,
  isUnsavedDraft,
  loadEnvelope,
  marginsFromUiModel,
  marginsToUiModel,
  applyMarginPreset,
  MARGIN_PRESET_LABELS,
  MARGIN_SIDE_LABELS,
  mergeOpStatus,
  isSuccessOpStatus,
  OP_STATUS_SUCCESS_MS,
  type OpStatus,
  type MarginSide,
  type MarginPreset,
  persistEnvelope,
  resolveUniqueName,
  setPayloadGroup,
  bodyFromUiModel,
  bodyToUiModel,
  referencesFromUiModel,
  referencesToUiModel,
  captionsFromUiModel,
  captionsToUiModel,
  listsFromUiModel,
  listsToUiModel,
  summarizeProfile,
  upsertAndBump,
  type BodyUiModel,
  type HeadingUiModel,
  type MarginsUiModel,
  type ReferencesUiModel,
  type CaptionUiModel,
  type ListUiModel,
  type AlignmentValue,
  type CreationKind,
  type StoreAdapter,
  type StoreEnvelope,
  type StoredCustomProfile,
} from '../lib/custom-profile-store/editor'
import { createBrowserStoreAdapter } from '../lib/custom-profile-store/localstorage-adapter'
import { cn } from '../lib/utils'

// Known citation-style terms that may appear in profile names. We only warn;
// we do not block or auto-correct the name.
const CITATION_STYLE_NAME_HINTS = ['chicago', 'ama', 'mla', 'harvard']

/** Built-in profile ids — never deletable through any path. */
const BUILTIN_IDS = [SUC_BUILTIN_ID, APA_BUILTIN_ID] as const

interface BuiltinViewModel {
  profileId: string
  name: string
  description: string
  sourceName: string
}

/** Reusable On/Off requirement toggle with optional numeric input or select. */
function RequirementToggle({
  label,
  enabled,
  onToggle,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  isSelect,
  options,
  error,
  hint,
  fieldId,
}: {
  label: string
  enabled: boolean
  onToggle: () => void
  value: string
  onChange: (v: string) => void
  min?: number
  max?: number
  step?: number
  unit?: string
  isSelect?: boolean
  options?: { value: string; label: string }[]
  error?: string
  hint?: string
  fieldId: string
}) {
  return (
    <fieldset className="rounded-md border border-border p-3">
      <legend className="px-1 text-sm font-medium text-foreground">{label}</legend>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={onToggle}
          className={cn(
            'inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            enabled ? 'bg-primary border-transparent' : 'bg-input border-border',
          )}
        >
          <span className="sr-only">Check {label}</span>
          <span
            className={cn(
              'inline-block h-5 w-5 rounded-full bg-white transition-transform',
              enabled ? 'translate-x-5' : 'translate-x-0.5',
            )}
          />
        </button>
        <span className="text-sm text-foreground">{enabled ? 'On' : 'Off'}</span>
      </div>
      {enabled && !isSelect && (
        <div className="mt-2 flex items-center gap-2">
          <input
            id={fieldId}
            type="number"
            min={min}
            max={max}
            step={step ?? 0.1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-20 rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none"
            aria-describedby={hint ? `${fieldId}-hint` : undefined}
          />
          {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
        </div>
      )}
      {enabled && isSelect && options && (
        <select
          id={fieldId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-2 w-full rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none"
          aria-describedby={hint ? `${fieldId}-hint` : undefined}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )}
      {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
      {hint && <p id={`${fieldId}-hint`} className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </fieldset>
  )
}

type LoadStatus =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready' }

export function ProfileEditor() {
  const navigate = useNavigate()
  const adapterRef = React.useRef<StoreAdapter | null>(null)

  // Store + list state
  const [envelope, setEnvelope] = React.useState<StoreEnvelope | null>(null)
  const [builtins, setBuiltins] = React.useState<BuiltinViewModel[]>([])
  const [loadStatus, setLoadStatus] = React.useState<LoadStatus>({ state: 'loading' })
  const [creationBusy, setCreationBusy] = React.useState<CreationKind | null>(null)

  // Editor state
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState<StoredCustomProfile | null>(null)
  const [dirty, setDirty] = React.useState(false)
  const [fieldErrors, setFieldErrors] = React.useState<{ name?: string; description?: string }>({})
  // ONE active operation status for the whole editor (save + delete share it),
  // so a Save never shows alongside a stale Delete success and vice versa.
  const [opStatus, setOpStatus] = React.useState<OpStatus>({ kind: 'idle' })
  const setOpStatusSafe = React.useCallback((next: OpStatus) => {
    setOpStatus((prev) => mergeOpStatus(prev, next))
  }, [])
  // Success statuses auto-dismiss; errors persist until superseded/corrected.
  React.useEffect(() => {
    if (!isSuccessOpStatus(opStatus.kind)) return
    const t = setTimeout(() => {
      setOpStatus((prev) => (isSuccessOpStatus(prev.kind) ? { kind: 'idle' } : prev))
    }, OP_STATUS_SUCCESS_MS)
    return () => clearTimeout(t)
  }, [opStatus])
  const [pendingNavigation, setPendingNavigation] = React.useState<null | { to: string }>(null)

  // Requirement UI models — derived from draft.payload and the single source
  // of truth for every requirement control in this Build.
  const [bodyUi, setBodyUi] = React.useState<BodyUiModel | null>(null)
  const [headingUi, setHeadingUi] = React.useState<HeadingUiModel | null>(null)
  const [marginsUi, setMarginsUi] = React.useState<MarginsUiModel | null>(null)
  const [referencesUi, setReferencesUi] = React.useState<ReferencesUiModel | null>(null)
  const [captionsUi, setCaptionsUi] = React.useState<CaptionUiModel | null>(null)
  const [listsUi, setListsUi] = React.useState<ListUiModel | null>(null)

  // Inline field errors for requirement controls (mapped from backend/client).
  const [reqFieldErrors, setReqFieldErrors] = React.useState<Record<string, string>>({})

  // ---------------------------------------------------------------------
  // Unsaved draft recovery (sessionStorage, tab-scoped)
  // ---------------------------------------------------------------------
  const draftRecoveryAdapterRef = React.useRef(createSessionDraftRecoveryAdapter())
  const [recoveryNotice, setRecoveryNotice] = React.useState<string | null>(null)

  /** Persist the current unsaved draft for same-tab reload recovery. */
  const persistDraftRecovery = React.useCallback(
    (d: StoredCustomProfile | null, envRevision: number) => {
      if (!d) return
      const isNew = !envelope?.profiles.some((p) => p.id === d.id)
      const recovery: ProfileDraftRecovery = {
        schema_version: 1,
        profile_id: isNew ? NEW_DRAFT_ID : d.id,
        base_revision: envRevision,
        payload: d.payload,
        updated_at: new Date().toISOString(),
      }
      saveDraftRecovery(draftRecoveryAdapterRef.current, recovery)
    },
    [envelope],
  )

  // Save the unsaved draft whenever it changes (only while dirty).
  React.useEffect(() => {
    if (!dirty || !draft || !envelope) return
    persistDraftRecovery(draft, envelope.revision)
  }, [draft, dirty, envelope, persistDraftRecovery])

  // Clear the recovery record after successful Save / Discard / Delete.
  React.useEffect(() => {
    if (opStatus.kind === 'saved' || opStatus.kind === 'deleted') {
      clearDraftRecovery(draftRecoveryAdapterRef.current)
      setRecoveryNotice(null)
    }
  }, [opStatus.kind])

  // On mount (same-tab reload), restore a structurally valid recovery that
  // belongs to the selected profile or new draft and whose confirmed revision
  // has not changed. Stale/conflicting records are never applied silently.
  React.useEffect(() => {
    if (loadStatus.state !== 'ready' && loadStatus.state !== 'error') return
    if (!envelope) return
    const recovery = loadDraftRecovery(draftRecoveryAdapterRef.current)
    if (!recovery) return
    if (draft) return // an editor session is already active — nothing to do

    if (recovery.profile_id === NEW_DRAFT_ID) {
      // Fresh-draft recovery needs a user decision; surface a notice rather
      // than silently re-creating a profile.
      setRecoveryNotice(
        'Recovered unsaved changes — use one of the creation actions to start again, then re-apply your edits.',
      )
      return
    }

    const target = envelope.profiles.find((p) => p.id === recovery.profile_id)
    if (!target) {
      // Profile deleted elsewhere — remove stale recovery.
      clearDraftRecovery(draftRecoveryAdapterRef.current)
      setRecoveryNotice(null)
      return
    }
    const decision = decideDraftRecovery(recovery, target.id, envelope.revision)
    if (decision.action === 'apply') {
      openProfileFromRecovery(target, decision.recovery.payload)
      setRecoveryNotice('Recovered unsaved changes')
    } else if (decision.action === 'conflict') {
      setRecoveryNotice(
        'Recovered changes conflict with updates from another tab. The saved version is shown; your unsaved edits were not applied.',
      )
    } else {
      clearDraftRecovery(draftRecoveryAdapterRef.current)
      setRecoveryNotice(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadStatus.state, envelope])

  /** Restore an unsaved payload over a stored profile as a dirty draft. */
  const openProfileFromRecovery = React.useCallback(
    (profile: StoredCustomProfile, recoveredPayload: Record<string, unknown>) => {
      setDraft({ ...profile, payload: recoveredPayload })
      setEditingId(profile.id)
      setDirty(true)
      setFieldErrors({})
      setReqFieldErrors({})
      setOpStatusSafe({ kind: 'idle' })
      setBodyUi(recoveredPayload.body ? bodyToUiModel(recoveredPayload.body as Record<string, unknown>) : null)
      setHeadingUi(recoveredPayload.heading ? headingToUiModel(recoveredPayload.heading as Record<string, unknown>) : null)
      setMarginsUi(recoveredPayload.margins ? marginsToUiModel(recoveredPayload.margins as Record<string, unknown>) : null)
      setReferencesUi(recoveredPayload.references ? referencesToUiModel(recoveredPayload.references as Record<string, unknown>) : null)
      setCaptionsUi(recoveredPayload.captions ? captionsToUiModel(recoveredPayload.captions as Record<string, unknown>) : null)
      setListsUi(recoveredPayload.lists ? listsToUiModel(recoveredPayload.lists as Record<string, unknown>) : null)
    },
    [],
  )

  // Load once
  React.useEffect(() => {
    let cancelled = false
    let builtinCache: BuiltinViewModel[] = []
    void (async () => {
      const adapter = createBrowserStoreAdapter() ?? createMemoryStoreAdapter()
      adapterRef.current = adapter
      try {
        const [list] = await Promise.all([api.getFormattingProfiles()])
        builtinCache = list
          .filter((p) => p.profile_source === 'built_in')
          .map((p) => ({
            profileId: p.profile_id,
            name: p.profile_name,
            description: p.description,
            sourceName: p.profile_name,
          }))
        if (cancelled) return
        setBuiltins(builtinCache)
        const env = loadEnvelope(adapter)
        setEnvelope(env)
        setLoadStatus({ state: 'ready' })
      } catch {
        if (cancelled) return
        // Built-ins unavailable (backend down) — still show local profiles.
        const env = loadEnvelope(adapter)
        setEnvelope(env)
        setBuiltins([])
        setLoadStatus({ state: 'error' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Watch for external (other-tab) store changes and reload.
  React.useEffect(() => {
    if (!adapterRef.current) return
    const unsubscribe = adapterRef.current.onExternalChange(() => {
      const env = loadEnvelope(adapterRef.current!)
      setEnvelope(env)
    })
    return unsubscribe
  }, [loadStatus])

  const storedProfile = React.useMemo(() => {
    if (!envelope || !editingId) return null
    return envelope.profiles.find((p) => p.id === editingId) ?? null
  }, [envelope, editingId])

  // On external reload, keep the dirty draft only if the stored profile
  // still matches the one being edited; otherwise drop the draft.
  React.useEffect(() => {
    if (draft && !storedProfile) {
      // The profile was deleted or store replaced — drop draft.
      setDraft(null)
      setDirty(false)
      setEditingId(null)
    } else if (draft && storedProfile && draft.id !== storedProfile.id) {
      setDraft(null)
      setDirty(false)
    }
  }, [storedProfile, draft])

  // ---------------------------------------------------------------------
  // Creation paths
  // ---------------------------------------------------------------------

  const createFrom = React.useCallback(
    async (kind: CreationKind) => {
      if (!envelope) return
      setCreationBusy(kind)
      try {
        const name = resolveUniqueName(
          envelope.profiles.map((p) => p.name),
          DEFAULT_PROFILE_NAMES[kind],
        )
        const id = generateProfileId()
        const nowIso = new Date().toISOString()

        let payload: Record<string, unknown>
        if (kind === 'blank') {
          payload = blankProfilePayload(id, name)
        } else {
          const sourceId = kind === 'copy-suc' ? SUC_BUILTIN_ID : APA_BUILTIN_ID
          let sourcePayload: Record<string, unknown>
          try {
            sourcePayload = await api.getBuiltinProfilePayload(sourceId)
          } catch {
            // Fall back to a safe blank so creation never hard-fails.
            sourcePayload = blankProfilePayload(id, name)
          }
          payload = copyProfilePayload(sourcePayload, id, name)
        }

        const profile: StoredCustomProfile = {
          id,
          name,
          description: '',
          sourceId:
            kind === 'copy-suc'
              ? SUC_BUILTIN_ID
              : kind === 'copy-apa'
                ? APA_BUILTIN_ID
                : undefined,
          payload,
          validationState: 'locally_valid',
          updatedAt: nowIso,
        }
        const next = upsertAndBump(envelope, profile, nowIso)
        const result = persistEnvelope(adapterRef.current!, next, envelope.revision)
        if (!result.ok) {
          // Stale write — another tab won. Reload the store.
          setEnvelope(loadEnvelope(adapterRef.current!))
          return
        }
        setEnvelope(next)
        setDraft(profile)
        setEditingId(profile.id)
        setDirty(true)
        setFieldErrors({})
        setReqFieldErrors({})
        setOpStatusSafe({ kind: 'idle' })
        // Initialize requirement UI models from the newly created payload.
        if (profile.payload.body) setBodyUi(bodyToUiModel(profile.payload.body as Record<string, unknown>))
        if (profile.payload.heading) setHeadingUi(headingToUiModel(profile.payload.heading as Record<string, unknown>))
        if (profile.payload.margins) setMarginsUi(marginsToUiModel(profile.payload.margins as Record<string, unknown>))
        if (profile.payload.references) setReferencesUi(referencesToUiModel(profile.payload.references as Record<string, unknown>))
        if (profile.payload.captions) setCaptionsUi(captionsToUiModel(profile.payload.captions as Record<string, unknown>))
        if (profile.payload.lists) setListsUi(listsToUiModel(profile.payload.lists as Record<string, unknown>))
      } finally {
        setCreationBusy(null)
      }
    },
    [envelope],
  )

  // ---------------------------------------------------------------------
  // Draft editing
  // ---------------------------------------------------------------------

  const openProfile = React.useCallback(
    (id: string) => {
      if (!envelope) return
      const profile = envelope.profiles.find((p) => p.id === id)
      if (!profile) return
      setDraft({ ...profile })
      setEditingId(id)
      setDirty(false)
      setFieldErrors({})
      setReqFieldErrors({})
      setOpStatusSafe({ kind: 'idle' })
      setBodyUi(profile.payload.body ? bodyToUiModel(profile.payload.body as Record<string, unknown>) : null)
      setHeadingUi(profile.payload.heading ? headingToUiModel(profile.payload.heading as Record<string, unknown>) : null)
      setMarginsUi(profile.payload.margins ? marginsToUiModel(profile.payload.margins as Record<string, unknown>) : null)
      setReferencesUi(profile.payload.references ? referencesToUiModel(profile.payload.references as Record<string, unknown>) : null)
      setCaptionsUi(profile.payload.captions ? captionsToUiModel(profile.payload.captions as Record<string, unknown>) : null)
      setListsUi(profile.payload.lists ? listsToUiModel(profile.payload.lists as Record<string, unknown>) : null)
    },
    [envelope],
  )

  const updateDraft = (patch: Partial<Pick<StoredCustomProfile, 'name' | 'description'>>) => {
    setDraft((prev) => {
      if (!prev) return prev
      return { ...prev, ...patch }
    })
    setDirty(true)
    setOpStatusSafe({ kind: 'idle' })
  }

  // ---------------------------------------------------------------------
  // Requirement control handlers
  // ---------------------------------------------------------------------

  const updateBody = React.useCallback(
    (updater: (prev: BodyUiModel) => BodyUiModel) => {
      setBodyUi((prev) => {
        if (!prev) return prev
        const next = updater(prev)
        if (draft) {
          setDraft((d) => d ? { ...d, payload: setPayloadGroup(d.payload, 'body', bodyFromUiModel(next)) } : d)
        }
        setDirty(true)
        setOpStatusSafe({ kind: 'idle' })
        return next
      })
    },
    [draft],
  )

  const updateHeading = React.useCallback(
    (updater: (prev: HeadingUiModel) => HeadingUiModel) => {
      setHeadingUi((prev) => {
        if (!prev) return prev
        const next = updater(prev)
        if (draft) {
          const prevHeading = draft.payload.heading as Record<string, unknown> | undefined
          const prevAlignment = typeof prevHeading?.alignment === 'string' ? prevHeading.alignment : null
          setDraft((d) => d ? { ...d, payload: setPayloadGroup(d.payload, 'heading', headingFromUiModel(next, prevAlignment)) } : d)
        }
        setDirty(true)
        setOpStatusSafe({ kind: 'idle' })
        return next
      })
    },
    [draft],
  )

  const updateMargins = React.useCallback(
    (updater: (prev: MarginsUiModel) => MarginsUiModel) => {
      setMarginsUi((prev) => {
        if (!prev) return prev
        const next = updater(prev)
        if (draft) {
          setDraft((d) => d ? { ...d, payload: setPayloadGroup(d.payload, 'margins', marginsFromUiModel(next)) } : d)
        }
        setDirty(true)
        setOpStatusSafe({ kind: 'idle' })
        return next
      })
    },
    [draft],
  )

  const updateReferences = React.useCallback(
    (updater: (prev: ReferencesUiModel) => ReferencesUiModel) => {
      setReferencesUi((prev) => {
        if (!prev) return prev
        const next = updater(prev)
        if (draft) {
          const prevRefs = draft.payload.references as Record<string, unknown> | undefined
          const prevHanging = typeof prevRefs?.hanging_indent_in === 'number'
            ? prevRefs.hanging_indent_in
            : null
          setDraft((d) => d ? { ...d, payload: setPayloadGroup(d.payload, 'references', referencesFromUiModel(next, prevHanging)) } : d)
        }
        setDirty(true)
        setOpStatusSafe({ kind: 'idle' })
        return next
      })
    },
    [draft],
  )

  const updateCaptions = React.useCallback(
    (updater: (prev: CaptionUiModel) => CaptionUiModel) => {
      setCaptionsUi((prev) => {
        if (!prev) return prev
        const next = updater(prev)
        if (draft) {
          setDraft((d) => d ? { ...d, payload: setPayloadGroup(d.payload, 'captions', captionsFromUiModel(next)) } : d)
        }
        setDirty(true)
        setOpStatusSafe({ kind: 'idle' })
        return next
      })
    },
    [draft],
  )

  const updateLists = React.useCallback(
    (updater: (prev: ListUiModel) => ListUiModel) => {
      setListsUi((prev) => {
        if (!prev) return prev
        const next = updater(prev)
        if (draft) {
          setDraft((d) => d ? { ...d, payload: setPayloadGroup(d.payload, 'lists', listsFromUiModel(next)) } : d)
        }
        setDirty(true)
        setOpStatusSafe({ kind: 'idle' })
        return next
      })
    },
    [draft],
  )

  // ---------------------------------------------------------------------
  // Save (backend-gated)
  // ---------------------------------------------------------------------

  /** Map a backend/client error field to the DOM element id we focus. */
  const FIELD_TO_INPUT_ID: Record<string, string> = {
    'general.name': 'profile-name',
    'general.description': 'profile-description',
    'body.font_pairs': 'body-font-pairs-first-family',
    'body.alignment': 'body-alignment',
    'body.line_spacing': 'body-line-spacing',
    'body.space_before': 'body-space-before',
    'body.space_after': 'body-space-after',
    'headings.level_1.font': 'heading-font-behavior',
    'headings.level_1.alignment': 'heading-alignment',
    'headings.level_1.space_before': 'heading-space-before',
    'headings.level_1.space_after': 'heading-space-after',
    'margins.left': 'margin-left',
    'margins.right': 'margin-right',
    'margins.top': 'margin-top',
    'margins.bottom': 'margin-bottom',
    'references.line_spacing': 'references-line-spacing',
    'captions.space_before': 'captions-space-before',
    'captions.space_after': 'captions-space-after',
    'lists.space_after': 'lists-space-after',
  }

  const focusFirstError = React.useCallback((errors: { field: string; message: string }[]) => {
    const first = errors[0]?.field
    if (!first) return
    const id = FIELD_TO_INPUT_ID[first] ?? 'profile-name'
    const el = document.getElementById(id)
    if (el) el.focus()
  }, [])

  /** Build the final payload from the current UI models (never save partials). */
  const buildFinalPayload = React.useCallback((): Record<string, unknown> => {
    if (!draft) return {}
    let payload = draft.payload
    if (bodyUi) payload = setPayloadGroup(payload, 'body', bodyFromUiModel(bodyUi))
    if (headingUi) {
      const prevH = payload.heading as Record<string, unknown> | undefined
      const prevAlignment = typeof prevH?.alignment === 'string' ? prevH.alignment : null
      payload = setPayloadGroup(payload, 'heading', headingFromUiModel(headingUi, prevAlignment))
    }
    if (marginsUi) payload = setPayloadGroup(payload, 'margins', marginsFromUiModel(marginsUi))
    if (referencesUi) {
      const prevR = payload.references as Record<string, unknown> | undefined
      const prevHanging = typeof prevR?.hanging_indent_in === 'number' ? prevR.hanging_indent_in : null
      payload = setPayloadGroup(payload, 'references', referencesFromUiModel(referencesUi, prevHanging))
    }
    if (captionsUi) payload = setPayloadGroup(payload, 'captions', captionsFromUiModel(captionsUi))
    if (listsUi) payload = setPayloadGroup(payload, 'lists', listsFromUiModel(listsUi))
    return payload
  }, [draft, bodyUi, headingUi, marginsUi, referencesUi, captionsUi, listsUi])

  const saveProfile = React.useCallback(async () => {
    if (!draft || !envelope) return
    // Run general + requirements validation together.
    const allErrors = clientValidate(draft, envelope)
    if (allErrors.length > 0) {
      setFieldErrors({
        name: allErrors.some((e) => e.field === 'general.name')
          ? allErrors.find((e) => e.field === 'general.name')!.message
          : undefined,
        description: allErrors.some((e) => e.field === 'general.description')
          ? allErrors.find((e) => e.field === 'general.description')!.message
          : undefined,
      })
      setReqFieldErrors(
        Object.fromEntries(
          allErrors
            .filter((e) => e.field !== 'general.name' && e.field !== 'general.description')
            .map((e) => [e.field, e.message]),
        ),
      )
      setOpStatusSafe({ kind: 'error', message: 'Fix the highlighted fields and try again.' })
      focusFirstError(allErrors)
      return
    }
    setFieldErrors({})
    setReqFieldErrors({})
    setOpStatusSafe({ kind: 'validating' })
    try {
      const finalPayload = buildFinalPayload()
      const result = await api.validateCustomProfile({
        ...finalPayload,
        profile_name: draft.name.trim(),
        description: draft.description,
        profile_source: 'custom',
        citation_style: CITATION_STYLE,
      })
      if (result.valid) {
        const confirmed: StoredCustomProfile = {
          ...draft,
          name: draft.name.trim(),
          description: draft.description,
          payload: result.profile,
          validationState: 'backend_confirmed',
          updatedAt: new Date().toISOString(),
        }
        const next = upsertAndBump(envelope, confirmed, confirmed.updatedAt)
        const write = persistEnvelope(adapterRef.current!, next, envelope.revision)
        if (!write.ok) {
          setEnvelope(loadEnvelope(adapterRef.current!))
          setOpStatusSafe({
            kind: 'error',
            message: 'This profile was updated in another tab. Reload before saving.',
          })
          return
        }
        setEnvelope(next)
        setDraft(confirmed)
        // Re-derive UI models from the normalized backend payload.
        const confirmedBody = confirmed.payload.body
        const confirmedHeading = confirmed.payload.heading
        const confirmedMargins = confirmed.payload.margins
        const confirmedReferences = confirmed.payload.references
        const confirmedCaptions = confirmed.payload.captions
        const confirmedLists = confirmed.payload.lists
        setBodyUi(confirmedBody ? bodyToUiModel(confirmedBody as Record<string, unknown>) : null)
        setHeadingUi(confirmedHeading ? headingToUiModel(confirmedHeading as Record<string, unknown>) : null)
        setMarginsUi(confirmedMargins ? marginsToUiModel(confirmedMargins as Record<string, unknown>) : null)
        setReferencesUi(confirmedReferences ? referencesToUiModel(confirmedReferences as Record<string, unknown>) : null)
        setCaptionsUi(confirmedCaptions ? captionsToUiModel(confirmedCaptions as Record<string, unknown>) : null)
        setListsUi(confirmedLists ? listsToUiModel(confirmedLists as Record<string, unknown>) : null)
        setDirty(false)
        setOpStatusSafe({ kind: 'saved' })
      } else if ('errors' in result) {
        const nameErr = result.errors.find((e) => e.field === 'general.name')
        const descErr = result.errors.find((e) => e.field === 'general.description')
        setFieldErrors({
          name: nameErr?.message,
          description: descErr?.message,
        })
        setReqFieldErrors(
          Object.fromEntries(
            result.errors
              .filter((e) => e.field !== 'general.name' && e.field !== 'general.description')
              .map((e) => [e.field, e.message]),
          ),
        )
        setOpStatusSafe({
          kind: 'backend-error',
          errors: result.errors.map((e) => e.message),
        })
        focusFirstError(result.errors)
      } else {
        setOpStatusSafe({
          kind: 'error',
          message: 'The profile could not be validated. Please try again.',
        })
      }
    } catch {
      setOpStatusSafe({
        kind: 'error',
        message: 'The profile could not be validated. Please try again.',
      })
    }
  }, [draft, envelope, bodyUi, headingUi, marginsUi, referencesUi, captionsUi, listsUi, buildFinalPayload, focusFirstError])

  // ---------------------------------------------------------------------
  // Navigation safety
  // ---------------------------------------------------------------------

  const requestNavigation = React.useCallback(
    (to: string) => {
      if (dirty && draft) {
        setPendingNavigation({ to })
      } else {
        void navigate(to)
      }
    },
    [dirty, draft, navigate],
  )

  const discardAndGo = React.useCallback(() => {
    if (pendingNavigation) {
      setPendingNavigation(null)
      void navigate(pendingNavigation.to)
    }
  }, [pendingNavigation, navigate])

  const cancelLeave = React.useCallback(() => {
    setPendingNavigation(null)
  }, [])

  // ---------------------------------------------------------------------
  // Delete (saved custom profiles only)
  // ---------------------------------------------------------------------

  const [pendingDelete, setPendingDelete] = React.useState<StoredCustomProfile | null>(null)
  const [deleting, setDeleting] = React.useState(false)

  const requestDelete = React.useCallback(
    (profile: StoredCustomProfile) => {
      if (deleting) return
      setPendingDelete(profile)
    },
    [deleting],
  )

  const cancelDelete = React.useCallback(() => {
    if (deleting) return
    setPendingDelete(null)
  }, [])

  const confirmDelete = React.useCallback(async () => {
    if (!pendingDelete || !envelope || deleting) return
    // Safety: never delete a built-in identity through any path.
    if ((BUILTIN_IDS as readonly string[]).includes(pendingDelete.id)) {
      setPendingDelete(null)
      return
    }
    setDeleting(true)
    setOpStatusSafe({ kind: 'deleting' })
    try {
      // Re-read the live envelope: another tab may have changed it.
      const live = loadEnvelope(adapterRef.current!)
      const target = live.profiles.find((p) => p.id === pendingDelete.id)
      if (!target) {
        // Already removed in another tab — refresh and inform calmly.
        setEnvelope(live)
        clearEditorState()
        setPendingDelete(null)
        setOpStatusSafe({ kind: 'already-gone' })
        return
      }
      const result = deleteAndBump(live, pendingDelete.id, new Date().toISOString())
      if (!result.ok) {
        setOpStatusSafe({ kind: 'error', message: 'The profile could not be deleted. Please try again.' })
        return
      }
      const write = persistEnvelope(adapterRef.current!, result.envelope, live.revision)
      if (!write.ok) {
        setEnvelope(live)
        setOpStatusSafe({
          kind: 'error',
          message: 'This profile was updated in another tab. Reload before deleting.',
        })
        return
      }
      setEnvelope(result.envelope)
      clearDraftRecovery(draftRecoveryAdapterRef.current)
      setRecoveryNotice(null)
      clearEditorState()
      setPendingDelete(null)
      // Replaces any previous Save success — one active status at a time.
      setOpStatus({ kind: 'deleted' })
    } finally {
      setDeleting(false)
    }
  }, [pendingDelete, envelope, deleting])

  /** Discard an unsaved draft — never touches saved profiles. */
  const discardDraft = React.useCallback(() => {
    clearDraftRecovery(draftRecoveryAdapterRef.current)
    setRecoveryNotice(null)
    clearEditorState()
    setOpStatusSafe({ kind: 'idle' })
  }, [])

  /** Clear the editor draft + requirement models without touching storage. */
  const clearEditorState = React.useCallback(() => {
    setDraft(null)
    setEditingId(null)
    setDirty(false)
    setBodyUi(null)
    setHeadingUi(null)
    setMarginsUi(null)
    setReferencesUi(null)
    setCaptionsUi(null)
    setListsUi(null)
    setFieldErrors({})
    setReqFieldErrors({})
  }, [])

  // ---------------------------------------------------------------------
  // Requirements expand/collapse
  // ---------------------------------------------------------------------

  const [allExpanded, setAllExpanded] = React.useState(false)
  const requirementsRootRef = React.useRef<HTMLDivElement | null>(null)

  const setAllRequirementsExpanded = React.useCallback((open: boolean) => {
    setAllExpanded(open)
    const root = requirementsRootRef.current
    if (!root) return
    root.querySelectorAll<HTMLDetailsElement>('details').forEach((d) => {
      d.open = open
    })
  }, [])

  // ---------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------

  const hasCustomProfiles = (envelope?.profiles.length ?? 0) > 0
  const selectedBuiltin = builtins.find((b) => b.profileId === editingId)

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a className="skip-link" href="#custom-profile-main">
        Skip to custom profile editor
      </a>
      <AppNav
        current="dashboard"
        title="Custom Profiles"
        subtitle="Document Formatting Profiles"
        backTo="/dashboard"
      />

      <main
        id="custom-profile-main"
        className="mx-auto w-full max-w-[1440px] px-4 pt-20 pb-6 md:px-6 md:py-8"
      >
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="font-serif text-page-title leading-[34px] text-foreground">
              Custom Profile Editor
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-[21px] text-muted-foreground">
              View the built-in document requirements and create your own saved custom
              profiles. Custom profiles are stored only on this device and are saved
              only after backend validation.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="border-border text-foreground"
            onClick={() => requestNavigation('/dashboard')}
          >
            <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
            Return to upload
          </Button>
        </div>

        {/* Draft-recovery notice — shown after a same-tab reload restored
            (or declined to restore) unsaved edits. Dismissable, never a
            substitute for the Save/Delete status region below. */}
        {recoveryNotice && (
          <div className="mt-4 rounded-md border border-border bg-input/20 px-3 py-2.5">
            <p role="status" aria-live="polite" className="flex items-start gap-1.5 text-sm leading-[21px] text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {recoveryNotice}
            </p>
          </div>
        )}

        {/* Page-level operation status — ONE region, always mounted while a
            status is active. Lives OUTSIDE the conditional editor/action-bar
            subtrees so a success message survives editor unmount (e.g. the
            draft clearing after a successful delete). Only one status is
            active at a time, so exactly one live region renders here. */}
        {opStatus.kind !== 'idle' && (
          <div
            className={cn(
              'mt-4 rounded-md border px-3 py-2.5',
              opStatus.kind === 'error' || opStatus.kind === 'backend-error'
                ? 'border-destructive/30 bg-destructive/5'
                : isSuccessOpStatus(opStatus.kind)
                  ? 'border-secondary/30 bg-secondary/5'
                  : 'border-border bg-input/20',
            )}
          >
            {opStatus.kind === 'saved' && (
              <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm font-medium text-secondary">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                Custom profile saved
              </p>
            )}
            {opStatus.kind === 'deleted' && (
              <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm font-medium text-secondary">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                Custom profile deleted
              </p>
            )}
            {opStatus.kind === 'already-gone' && (
              <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
                This profile was already removed. Showing the recommended built-in.
              </p>
            )}
            {opStatus.kind === 'validating' && (
              <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden="true" />
                Validating…
              </p>
            )}
            {opStatus.kind === 'deleting' && (
              <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden="true" />
                Deleting…
              </p>
            )}
            {opStatus.kind === 'error' && (
              <p role="alert" className="flex items-start gap-1.5 text-sm leading-[21px] text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                {opStatus.message}
              </p>
            )}
            {opStatus.kind === 'backend-error' && (
              <div role="alert" className="text-sm leading-[21px] text-destructive">
                <p className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  The profile did not pass validation.
                </p>
                {(opStatus.errors?.length ?? 0) > 0 && (
                  <ul className="mt-1 list-disc space-y-1 pl-9 text-xs leading-[16px] text-muted-foreground">
                    {opStatus.errors!.map((msg, i) => (
                      <li key={i}>{msg}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {/* Layout: list + editor split on large screens, one column small */}
        <div className="mt-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-[5fr_7fr]">
          {/* ------------------------- Profile list ------------------------- */}
          <section aria-labelledby="profile-list-heading" className="min-w-0 space-y-6">
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle id="profile-list-heading" className="text-base font-semibold">
                  Document formatting profiles
                </CardTitle>
                <CardDescription>
                  Duplicate a built-in profile or start with no enabled requirements.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Creation actions */}
                <div className="flex flex-col gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-start border-border text-foreground"
                    disabled={creationBusy !== null}
                    onClick={() => void createFrom('copy-suc')}
                  >
                    {creationBusy === 'copy-suc' ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Copy className="h-4 w-4 text-primary" aria-hidden="true" />
                    )}
                    {CREATION_LABELS['copy-suc']}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-start border-border text-foreground"
                    disabled={creationBusy !== null}
                    onClick={() => void createFrom('copy-apa')}
                  >
                    {creationBusy === 'copy-apa' ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Copy className="h-4 w-4 text-primary" aria-hidden="true" />
                    )}
                    {CREATION_LABELS['copy-apa']}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-start border-border text-foreground"
                    disabled={creationBusy !== null}
                    onClick={() => void createFrom('blank')}
                  >
                    {creationBusy === 'blank' ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Plus className="h-4 w-4 text-primary" aria-hidden="true" />
                    )}
                    {CREATION_LABELS.blank}
                  </Button>
                </div>

                {loadStatus.state === 'error' && (
                  <div
                    role="alert"
                    aria-live="assertive"
                    className="rounded-md border border-border bg-input/30 px-3 py-2.5 text-xs leading-[16px] text-muted-foreground"
                  >
                    Built-in profiles could not be loaded. Local custom profiles remain
                    available, and saving still requires backend validation.
                  </div>
                )}

                <fieldset className="rounded-md border border-border p-3">
                  <legend className="px-1 text-sm font-semibold text-foreground">
                    Built-in profiles
                  </legend>
                  {builtins.length === 0 ? (
                    <p className="py-2 text-sm text-muted-foreground">Loading built-in profiles…</p>
                  ) : (
                    <ul className="space-y-2">
                      {builtins.map((b) => (
                        <li key={b.profileId}>
                          <div className="rounded-md border border-border bg-input/20 px-3 py-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="truncate text-sm font-medium text-foreground">
                                    {b.name}
                                  </span>
                                  <Badge variant="outline" className="border-border text-muted-foreground">
                                    Built-in
                                  </Badge>
                                </div>
                                <p className="mt-0.5 line-clamp-2 text-xs leading-[16px] text-muted-foreground">
                                  {b.description}
                                </p>
                              </div>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </fieldset>

                <fieldset className="rounded-md border border-border p-3">
                  <legend className="px-1 text-sm font-semibold text-foreground">
                    Custom profiles
                  </legend>
                  {!hasCustomProfiles ? (
                    <p className="py-2 text-sm leading-[21px] text-muted-foreground">
                      No custom profiles saved yet. Use one of the actions above to create
                      your first profile, then edit its name and description before saving.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {envelope!.profiles.map((p) => {
                        const isEditing = editingId === p.id
                        return (
                          <li key={p.id}>
                            <div
                              className={cn(
                                'rounded-md border px-3 py-2.5 transition-colors',
                                isEditing
                                  ? 'border-primary bg-primary/5'
                                  : 'border-border bg-input/20',
                              )}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="truncate text-sm font-medium text-foreground">
                                      {p.name}
                                    </span>
                                    <Badge variant="outline" className="border-border text-muted-foreground">
                                      Custom
                                    </Badge>
                                  </div>
                                  <p className="mt-0.5 line-clamp-2 text-xs leading-[16px] text-muted-foreground">
                                    {p.description || 'No description'}
                                  </p>
                                  <p className="mt-0.5 text-[11px] leading-[16px] text-muted-foreground">
                                    {friendlySourceName(p.sourceId)
                                      ? `From ${friendlySourceName(p.sourceId)}`
                                      : 'Custom profile'}
                                    {' · '}
                                    Saved on this device · Updated {formatAuditDateTime(p.updatedAt)}
                                  </p>
                                </div>
                              </div>
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="gap-1.5 border-border text-foreground min-h-[44px]"
                                  onClick={() => openProfile(p.id)}
                                  disabled={isEditing}
                                >
                                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                                  {isEditing ? 'Editing' : 'Edit'}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive min-h-[44px]"
                                  onClick={() => requestDelete(p)}
                                  disabled={deleting}
                                >
                                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                  Delete profile
                                </Button>
                              </div>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </fieldset>
              </CardContent>
            </Card>
          </section>

          {/* --------------------------- Editor --------------------------- */}
          <section aria-labelledby="editor-heading" className="min-w-0">
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle id="editor-heading" className="text-base font-semibold">
                  {selectedBuiltin
                    ? selectedBuiltin.name
                    : draft
                      ? draft.name
                      : 'Profile editor'}
                </CardTitle>
                <CardDescription>
                  {selectedBuiltin
                    ? 'Built-in profiles are read-only. Use the list actions to create a copy.'
                    : draft
                      ? 'Edit the profile name and description, then save after validation.'
                      : 'Select a custom profile to edit, or create a new one from the list.'}
                </CardDescription>
              </CardHeader>

              <CardContent className="space-y-5">
                {selectedBuiltin ? (
                  <div className="space-y-4">
                    <div className="rounded-md border border-border bg-input/20 px-3 py-3">
                      <p className="text-sm font-medium text-foreground">{selectedBuiltin.name}</p>
                      <p className="mt-1 text-sm leading-[21px] text-muted-foreground">
                        {selectedBuiltin.description}
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          Built-in
                        </Badge>
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          Citation style: {CITATION_STYLE}
                        </Badge>
                      </div>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                      <Button
                        type="button"
                        variant="outline"
                        className="gap-1.5 border-border text-foreground"
                        onClick={() => void createFrom(selectedBuiltin.profileId === SUC_BUILTIN_ID ? 'copy-suc' : 'copy-apa')}
                      >
                        <Copy className="h-4 w-4 text-primary" aria-hidden="true" />
                        Duplicate this profile
                      </Button>
                    </div>
                  </div>
                ) : draft ? (
                  <>
                    {/* General */}
                    <fieldset className="rounded-md border border-border p-3">
                      <legend className="px-1 text-sm font-semibold text-foreground">
                        General
                      </legend>
                      <div className="mt-2 space-y-4">
                        <div>
                          <label
                            htmlFor="profile-name"
                            className="text-sm font-medium text-foreground"
                          >
                            Profile name
                          </label>
                          <input
                            id="profile-name"
                            type="text"
                            value={draft.name}
                            onChange={(e) => updateDraft({ name: e.target.value })}
                            className={cn(
                              'mt-1 w-full rounded-md border bg-white px-3 py-2 text-sm text-foreground transition-colors focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none',
                              fieldErrors.name
                                ? 'border-destructive focus:border-destructive focus:ring-destructive'
                                : 'border-border',
                            )}
                            aria-describedby={fieldErrors.name ? 'profile-name-error' : undefined}
                            aria-invalid={Boolean(fieldErrors.name)}
                          />
                          {fieldErrors.name && (
                            <p
                              id="profile-name-error"
                              role="alert"
                              className="mt-1 text-xs leading-[16px] text-destructive"
                            >
                              {fieldErrors.name}
                            </p>
                          )}
                        </div>

                        <div>
                          <label
                            htmlFor="profile-description"
                            className="text-sm font-medium text-foreground"
                          >
                            Description
                          </label>
                          <textarea
                            id="profile-description"
                            value={draft.description}
                            onChange={(e) => updateDraft({ description: e.target.value })}
                            rows={3}
                            className={cn(
                              'mt-1 w-full rounded-md border bg-white px-3 py-2 text-sm text-foreground transition-colors focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none',
                              fieldErrors.description
                                ? 'border-destructive focus:border-destructive focus:ring-destructive'
                                : 'border-border',
                            )}
                            aria-describedby={
                              fieldErrors.description
                                ? 'profile-description-error'
                                : 'profile-description-hint'
                            }
                            aria-invalid={Boolean(fieldErrors.description)}
                          />
                          {fieldErrors.description ? (
                            <p
                              id="profile-description-error"
                              role="alert"
                              className="mt-1 text-xs leading-[16px] text-destructive"
                            >
                              {fieldErrors.description}
                            </p>
                          ) : (
                            <p
                              id="profile-description-hint"
                              className="mt-1 text-xs leading-[16px] text-muted-foreground"
                            >
                              {draft.description.length}/{MAX_DESCRIPTION_LENGTH} characters
                            </p>
                          )}
                        </div>

                        <div>
                          <span className="text-sm font-medium text-foreground">
                            Citation style
                          </span>
                          <div className="mt-1 rounded-md border border-border bg-input/20 px-3 py-2 text-sm text-muted-foreground">
                            {CITATION_STYLE}
                            <span className="ml-2 text-xs">(non-selectable)</span>
                          </div>
                          <p className="mt-1 text-[11px] leading-[16px] text-muted-foreground">
                            Custom profiles change document formatting requirements only. Citation
                            analysis remains APA 7.
                          </p>
                          {(() => {
                            const lowerName = draft.name.toLowerCase()
                            const hint = CITATION_STYLE_NAME_HINTS.find((h) => lowerName.includes(h))
                            if (!hint) return null
                            return (
                              <p
                                role="status"
                                className="mt-1 text-[11px] leading-[16px] text-warning"
                              >
                                This name may imply a citation style, but citation analysis remains APA 7.
                                Consider a name such as “My Course Formatting”.
                              </p>
                            )
                          })()}
                        </div>

                        <div>
                          <span className="text-sm font-medium text-foreground">
                            Validation state
                          </span>
                          <div className="mt-1 flex items-center gap-2">
                            {draft.validationState === 'backend_confirmed' ? (
                              <Badge className="bg-secondary/10 text-secondary">
                                <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                                Validated and saved
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="border-border text-muted-foreground">
                                <Info className="h-3 w-3" aria-hidden="true" />
                                Draft — not yet saved
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    </fieldset>

                    {/* ------------------------------------------------------------------ */}
                    {/* Requirements — expand/collapse + real controls (Build 4/5)           */}
                    {/* ------------------------------------------------------------------ */}
                    <div
                      ref={requirementsRootRef}
                      className="space-y-4"
                      aria-label="Document formatting requirements"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-semibold text-foreground">Requirements</h3>
                        <div className="flex gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="gap-1 text-xs text-muted-foreground hover:text-foreground min-h-[44px]"
                            onClick={() => setAllRequirementsExpanded(true)}
                          >
                            <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden="true" />
                            Expand all
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="gap-1 text-xs text-muted-foreground hover:text-foreground min-h-[44px]"
                            onClick={() => setAllRequirementsExpanded(false)}
                          >
                            <ChevronsDownUp className="h-3.5 w-3.5" aria-hidden="true" />
                            Collapse all
                          </Button>
                        </div>
                      </div>

                    {/* ------------------------------------------------------------------ */}
                    {/* Body text controls                                                   */}
                    {/* ------------------------------------------------------------------ */}
                    <details className="group rounded-md border border-border" open={allExpanded || undefined}>
                      <summary className="cursor-pointer list-none rounded-md px-3 py-2.5 text-sm font-semibold text-foreground select-none transition-colors hover:bg-input/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                        <div className="flex items-center justify-between">
                          <span>Body text</span>
                          <svg
                            className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90"
                            aria-hidden="true"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 5l7 7-7 7"
                            />
                          </svg>
                        </div>
                      </summary>
                      <div className="space-y-4 px-3 pb-3 pt-1">
                        <p className="text-xs leading-[16px] text-muted-foreground">
                          Turning off a requirement means it will not be checked or included in the score.
                        </p>

                        {/* Font and size pairs */}
                        <fieldset className="rounded-md border border-border p-3">
                          <legend className="px-1 text-sm font-medium text-foreground">
                            Font and size
                          </legend>
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              type="button"
                              role="switch"
                              aria-checked={bodyUi?.fontEnabled ?? false}
                              onClick={() => updateBody((u) => ({ ...u, fontEnabled: !u.fontEnabled }))}
                              className={cn(
                                'inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                                bodyUi?.fontEnabled
                                  ? 'bg-primary border-transparent'
                                  : 'bg-input border-border',
                              )}
                            >
                              <span className="sr-only">Check font and size</span>
                              <span
                                className={cn(
                                  'inline-block h-5 w-5 rounded-full bg-white transition-transform',
                                  bodyUi?.fontEnabled ? 'translate-x-5' : 'translate-x-0.5',
                                )}
                              />
                            </button>
                            <span className="text-sm text-foreground">
                              {bodyUi?.fontEnabled ? 'On' : 'Off'}
                            </span>
                          </div>
                          {bodyUi?.fontEnabled && (
                            <div className="mt-3 space-y-2" id="body-font-pairs" role="group" aria-label="Accepted font-and-size pairs">
                              {bodyUi.pairs.map((pair, idx) => (
                                <div key={idx} className="flex flex-wrap items-center gap-2">
                                  <input
                                    type="text"
                                    value={pair.family}
                                    onChange={(e) =>
                                      updateBody((u) => {
                                        const next = [...u.pairs]
                                        next[idx] = { ...next[idx], family: e.target.value }
                                        return { ...u, pairs: next }
                                      })
                                    }
                                    placeholder="Font family"
                                    className="w-40 rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none"
                                    aria-label={`Font family for pair ${idx + 1}`}
                                  />
                                  <input
                                    type="number"
                                    min={6}
                                    max={72}
                                    step={0.5}
                                    value={pair.size}
                                    onChange={(e) =>
                                      updateBody((u) => {
                                        const next = [...u.pairs]
                                        next[idx] = { ...next[idx], size: e.target.value }
                                        return { ...u, pairs: next }
                                      })
                                    }
                                    placeholder="Size"
                                    className="w-20 rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none"
                                    aria-label={`Font size in points for pair ${idx + 1}`}
                                  />
                                  <span className="text-xs text-muted-foreground">pt</span>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                                    onClick={() =>
                                      updateBody((u) => ({
                                        ...u,
                                        pairs: u.pairs.filter((_, i) => i !== idx),
                                      }))
                                    }
                                    aria-label={`Remove font pair ${idx + 1}`}
                                  >
                                    <span aria-hidden="true" className="text-lg leading-none">×</span>
                                  </Button>
                                </div>
                              ))}
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="mt-1 border-border text-foreground"
                                onClick={() =>
                                  updateBody((u) => ({
                                    ...u,
                                    pairs: [...u.pairs, { family: '', size: '' }],
                                  }))
                                }
                              >
                                Add font pair
                              </Button>
                              {reqFieldErrors['body.font_pairs'] && (
                                <p
                                  role="alert"
                                  id="body-font-pairs-error"
                                  className="mt-1 text-xs leading-[16px] text-destructive"
                                >
                                  {reqFieldErrors['body.font_pairs']}
                                </p>
                              )}
                            </div>
                          )}
                        </fieldset>

                        {/* Alignment */}
                        <fieldset className="rounded-md border border-border p-3">
                          <legend className="px-1 text-sm font-medium text-foreground">
                            Alignment
                          </legend>
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              type="button"
                              role="switch"
                              aria-checked={bodyUi?.alignmentEnabled ?? false}
                              onClick={() => updateBody((u) => ({ ...u, alignmentEnabled: !u.alignmentEnabled }))}
                              className={cn(
                                'inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                                bodyUi?.alignmentEnabled
                                  ? 'bg-primary border-transparent'
                                  : 'bg-input border-border',
                              )}
                            >
                              <span className="sr-only">Check alignment</span>
                              <span
                                className={cn(
                                  'inline-block h-5 w-5 rounded-full bg-white transition-transform',
                                  bodyUi?.alignmentEnabled ? 'translate-x-5' : 'translate-x-0.5',
                                )}
                              />
                            </button>
                            <span className="text-sm text-foreground">{bodyUi?.alignmentEnabled ? 'On' : 'Off'}</span>
                          </div>
                          {bodyUi?.alignmentEnabled && (
                            <select
                              id="body-alignment"
                              value={bodyUi.alignment}
                              onChange={(e) => updateBody((u) => ({ ...u, alignment: e.target.value as AlignmentValue }))}
                              className="mt-2 w-full rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none"
                              aria-describedby="body-alignment-hint"
                            >
                              <option value="left">Left</option>
                              <option value="center">Center</option>
                              <option value="right">Right</option>
                              <option value="justify">Justified</option>
                            </select>
                          )}
                          {reqFieldErrors['body.alignment'] && (
                            <p role="alert" className="mt-1 text-xs text-destructive">{reqFieldErrors['body.alignment']}</p>
                          )}
                          <p id="body-alignment-hint" className="mt-1 text-[11px] text-muted-foreground">
                            Off means no deterministic alignment check.
                          </p>
                        </fieldset>

                        {/* Line spacing */}
                        <fieldset className="rounded-md border border-border p-3">
                          <legend className="px-1 text-sm font-medium text-foreground">
                            Line spacing
                          </legend>
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              type="button"
                              role="switch"
                              aria-checked={bodyUi?.lineSpacingEnabled ?? false}
                              onClick={() => updateBody((u) => ({ ...u, lineSpacingEnabled: !u.lineSpacingEnabled }))}
                              className={cn(
                                'inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                                bodyUi?.lineSpacingEnabled
                                  ? 'bg-primary border-transparent'
                                  : 'bg-input border-border',
                              )}
                            >
                              <span className="sr-only">Check line spacing</span>
                              <span
                                className={cn(
                                  'inline-block h-5 w-5 rounded-full bg-white transition-transform',
                                  bodyUi?.lineSpacingEnabled ? 'translate-x-5' : 'translate-x-0.5',
                                )}
                              />
                            </button>
                            <span className="text-sm text-foreground">{bodyUi?.lineSpacingEnabled ? 'On' : 'Off'}</span>
                          </div>
                          {bodyUi?.lineSpacingEnabled && (
                            <div className="mt-2 flex items-center gap-2">
                              <input
                                id="body-line-spacing"
                                type="number"
                                min={1}
                                max={4}
                                step={0.1}
                                value={bodyUi.lineSpacing}
                                onChange={(e) => updateBody((u) => ({ ...u, lineSpacing: e.target.value }))}
                                className="w-20 rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none"
                                aria-describedby="body-line-spacing-hint"
                              />
                              <span className="text-sm text-muted-foreground">× (multiplier)</span>
                            </div>
                          )}
                          {reqFieldErrors['body.line_spacing'] && (
                            <p role="alert" className="mt-1 text-xs text-destructive">{reqFieldErrors['body.line_spacing']}</p>
                          )}
                          <p id="body-line-spacing-hint" className="mt-1 text-[11px] text-muted-foreground">
                            Range: 1.0–4.0. Off means no deterministic check.
                          </p>
                        </fieldset>

                        {/* Space before */}
                        <RequirementToggle
                          label="Space before"
                          enabled={bodyUi?.spaceBeforeEnabled ?? false}
                          onToggle={() => updateBody((u) => ({ ...u, spaceBeforeEnabled: !u.spaceBeforeEnabled }))}
                          value={bodyUi?.spaceBefore ?? ''}
                          onChange={(v) => updateBody((u) => ({ ...u, spaceBefore: v }))}
                          min={0}
                          max={240}
                          unit="pt"
                          error={reqFieldErrors['body.space_before']}
                          hint="Range: 0–240 pt. Off means no deterministic check."
                          fieldId="body-space-before"
                        />

                        {/* Space after */}
                        <RequirementToggle
                          label="Space after"
                          enabled={bodyUi?.spaceAfterEnabled ?? false}
                          onToggle={() => updateBody((u) => ({ ...u, spaceAfterEnabled: !u.spaceAfterEnabled }))}
                          value={bodyUi?.spaceAfter ?? ''}
                          onChange={(v) => updateBody((u) => ({ ...u, spaceAfter: v }))}
                          min={0}
                          max={240}
                          unit="pt"
                          error={reqFieldErrors['body.space_after']}
                          hint="Range: 0–240 pt. Off means no deterministic check."
                          fieldId="body-space-after"
                        />

                        {/* First-line indent — unavailable */}
                        <div className="rounded-md border border-dashed border-border bg-input/10 px-3 py-2.5">
                          <p className="text-sm text-muted-foreground">
                            First-line indentation
                          </p>
                          <p className="mt-0.5 text-xs leading-[16px] text-muted-foreground">
                            First-line indentation checking is not available in this version.
                          </p>
                        </div>
                      </div>
                    </details>

                    {/* ------------------------------------------------------------------ */}
                    {/* Heading controls                                                     */}
                    {/* ------------------------------------------------------------------ */}
                    <details className="group mt-4 rounded-md border border-border" open={allExpanded || undefined}>
                      <summary className="cursor-pointer list-none rounded-md px-3 py-2.5 text-sm font-semibold text-foreground select-none transition-colors hover:bg-input/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                        <div className="flex items-center justify-between">
                          <span>Headings</span>
                          <svg
                            className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90"
                            aria-hidden="true"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </div>
                      </summary>
                      <div className="space-y-4 px-3 pb-3 pt-1">
                        <p className="text-xs leading-[16px] text-muted-foreground">
                          Turning off a requirement means it will not be checked or included in the score.
                        </p>

                        {/* Font behavior — shared across all heading levels */}
                        <fieldset className="rounded-md border border-border p-3">
                          <legend className="px-1 text-sm font-medium text-foreground">
                            Font behavior
                          </legend>
                          <p className="mb-2 text-[11px] leading-[16px] text-muted-foreground">
                            Applies to all heading levels.
                          </p>
                          <div className="mt-2 space-y-2" role="radiogroup" aria-label="Heading font behavior">
                            {[
                              { value: 'inherit' as const, label: 'Use the body font and size' },
                              { value: 'explicit' as const, label: 'Use separate accepted font and size' },
                              { value: 'disabled' as const, label: 'No heading font requirement' },
                            ].map(({ value, label }) => (
                              <label key={value} className="flex cursor-pointer items-center gap-2 text-sm">
                                <input
                                  type="radio"
                                  name="heading-font-behavior"
                                  value={value}
                                  checked={headingUi?.fontBehavior === value}
                                  onChange={() =>
                                    updateHeading((u) => ({ ...u, fontBehavior: value }))
                                  }
                                  className="h-4 w-4 accent-primary"
                                />
                                {label}
                              </label>
                            ))}
                          </div>
                          {headingUi?.fontBehavior === 'inherit' && !bodyUi?.fontEnabled && (
                            <p role="alert" className="mt-2 text-xs leading-[16px] text-destructive">
                              Heading 1 cannot inherit the body font when no body font is enabled.
                            </p>
                          )}
                          {headingUi?.fontBehavior === 'explicit' && (
                            <div className="mt-3 space-y-2">
                              {headingUi.pairs.map((pair, idx) => (
                                <div key={idx} className="flex flex-wrap items-center gap-2">
                                  <input
                                    type="text"
                                    value={pair.family}
                                    onChange={(e) =>
                                      updateHeading((u) => {
                                        const next = [...u.pairs]
                                        next[idx] = { ...next[idx], family: e.target.value }
                                        return { ...u, pairs: next }
                                      })
                                    }
                                    placeholder="Font family"
                                    className="w-40 rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none"
                                    aria-label={`Font family for heading pair ${idx + 1}`}
                                  />
                                  <input
                                    type="number"
                                    min={6}
                                    max={72}
                                    step={0.5}
                                    value={pair.size}
                                    onChange={(e) =>
                                      updateHeading((u) => {
                                        const next = [...u.pairs]
                                        next[idx] = { ...next[idx], size: e.target.value }
                                        return { ...u, pairs: next }
                                      })
                                    }
                                    placeholder="Size"
                                    className="w-20 rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none"
                                    aria-label={`Font size in points for heading pair ${idx + 1}`}
                                  />
                                  <span className="text-xs text-muted-foreground">pt</span>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                                    onClick={() =>
                                      updateHeading((u) => ({
                                        ...u,
                                        pairs: u.pairs.filter((_, i) => i !== idx),
                                      }))
                                    }
                                    aria-label={`Remove heading font pair ${idx + 1}`}
                                  >
                                    <span aria-hidden="true" className="text-lg leading-none">×</span>
                                  </Button>
                                </div>
                              ))}
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="border-border text-foreground"
                                onClick={() =>
                                  updateHeading((u) => ({
                                    ...u,
                                    pairs: [...u.pairs, { family: '', size: '' }],
                                  }))
                                }
                              >
                                Add font pair
                              </Button>
                              {reqFieldErrors['headings.level_1.font'] && (
                                <p role="alert" className="mt-1 text-xs text-destructive">{reqFieldErrors['headings.level_1.font']}</p>
                              )}
                            </div>
                          )}
                        </fieldset>

                        {/* Alignment — shared across all heading levels */}
                        <RequirementToggle
                          label="Alignment (applies to all heading levels)"
                          enabled={headingUi?.alignmentEnabled ?? false}
                          onToggle={() => updateHeading((u) => ({ ...u, alignmentEnabled: !u.alignmentEnabled }))}
                          value={headingUi?.alignment ?? ''}
                          onChange={(v) => updateHeading((u) => ({ ...u, alignment: v as AlignmentValue }))}
                          isSelect
                          options={[
                            { value: '', label: 'Disabled' },
                            { value: 'left', label: 'Left' },
                            { value: 'center', label: 'Center' },
                            { value: 'right', label: 'Right' },
                            { value: 'justify', label: 'Justified' },
                          ]}
                          error={reqFieldErrors['headings.level_1.alignment']}
                          hint="Off means no deterministic alignment check."
                          fieldId="heading-alignment"
                        />

                        {/* Space before/after — shared across all heading levels */}
                        <RequirementToggle
                          label="Space before (applies to all heading levels)"
                          enabled={headingUi?.spaceBeforeEnabled ?? false}
                          onToggle={() => updateHeading((u) => ({ ...u, spaceBeforeEnabled: !u.spaceBeforeEnabled }))}
                          value={headingUi?.spaceBefore ?? ''}
                          onChange={(v) => updateHeading((u) => ({ ...u, spaceBefore: v }))}
                          min={0}
                          max={240}
                          unit="pt"
                          error={reqFieldErrors['headings.level_1.space_before']}
                          hint="Range: 0–240 pt. Off means no deterministic check."
                          fieldId="heading-space-before"
                        />

                        <RequirementToggle
                          label="Space after (applies to all heading levels)"
                          enabled={headingUi?.spaceAfterEnabled ?? false}
                          onToggle={() => updateHeading((u) => ({ ...u, spaceAfterEnabled: !u.spaceAfterEnabled }))}
                          value={headingUi?.spaceAfter ?? ''}
                          onChange={(v) => updateHeading((u) => ({ ...u, spaceAfter: v }))}
                          min={0}
                          max={240}
                          unit="pt"
                          error={reqFieldErrors['headings.level_1.space_after']}
                          hint="Range: 0–240 pt. Off means no deterministic check."
                          fieldId="heading-space-after"
                        />

                        {/* Per-level groups (H1/H2/H3) — independent sections */}
                        <p className="text-[11px] leading-[16px] text-muted-foreground">
                          Each heading level below is an independent section.
                        </p>
                        {[
                          { label: 'Heading 1', ui: headingUi?.level1, idx: 0 },
                          { label: 'Heading 2', ui: headingUi?.level2, idx: 1 },
                          { label: 'Heading 3', ui: headingUi?.level3, idx: 2 },
                        ].map(({ label, ui, idx }) => (
                          <details key={idx} className="rounded-md border border-border" open={allExpanded || undefined}>
                            <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-foreground select-none hover:bg-input/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                              {label}
                            </summary>
                            <div className="space-y-3 px-3 pb-3 pt-1">
                              <p className="text-[11px] leading-[16px] text-muted-foreground">
                                Bold and italic are stored with the profile for APA-style
                                differentiation; not audited in this release.
                              </p>
                              <label className="flex items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  checked={ui?.bold ?? false}
                                  onChange={(e) =>
                                    updateHeading((u) => {
                                      const setBold = (v: boolean) =>
                                        idx === 0 ? { ...u, level1: { ...u.level1, bold: v } }
                                          : idx === 1 ? { ...u, level2: { ...u.level2, bold: v } }
                                            : { ...u, level3: { ...u.level3, bold: v } }
                                      return setBold(e.target.checked)
                                    })
                                  }
                                  className="h-4 w-4 accent-primary"
                                />
                                Bold
                              </label>
                              <label className="flex items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  checked={ui?.italic ?? false}
                                  onChange={(e) =>
                                    updateHeading((u) => {
                                      const setItalic = (v: boolean) =>
                                        idx === 0 ? { ...u, level1: { ...u.level1, italic: v } }
                                          : idx === 1 ? { ...u, level2: { ...u.level2, italic: v } }
                                            : { ...u, level3: { ...u.level3, italic: v } }
                                      return setItalic(e.target.checked)
                                    })
                                  }
                                  className="h-4 w-4 accent-primary"
                                />
                                Italic
                              </label>
                            </div>
                          </details>
                        ))}
                      </div>
                    </details>
                    </div>{/* end requirements wrapper */}

                    {/* ------------------------------------------------------------------ */}
                    {/* Margin controls                                                      */}
                    {/* ------------------------------------------------------------------ */}
                    <details className="group mt-4 rounded-md border border-border" open={allExpanded || undefined}>
                      <summary className="cursor-pointer list-none rounded-md px-3 py-2.5 text-sm font-semibold text-foreground select-none transition-colors hover:bg-input/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                        <div className="flex items-center justify-between">
                          <span>Margins</span>
                          <svg className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </div>
                      </summary>
                      <div className="space-y-4 px-3 pb-3 pt-1">
                        <p className="text-xs leading-[16px] text-muted-foreground">
                          Turning off a requirement means it will not be checked or included in the score.
                        </p>

                        {/* Presets */}
                        <div className="flex flex-wrap gap-2">
                          {(Object.keys(MARGIN_PRESET_LABELS) as MarginPreset[]).map((preset) => (
                            <Button
                              key={preset}
                              type="button"
                              variant="outline"
                              size="sm"
                              className="border-border text-foreground min-h-[44px]"
                              onClick={() => setMarginsUi((prev) => prev ? { ...prev, ...applyMarginPreset(preset) } : prev)}
                            >
                              {MARGIN_PRESET_LABELS[preset]}
                            </Button>
                          ))}
                        </div>

                        {/* Four sides */}
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          {(['left', 'right', 'top', 'bottom'] as MarginSide[]).map((side) => {
                            const m = marginsUi?.[side] ?? { enabled: false, value: '' }
                            return (
                              <fieldset key={side} className="rounded-md border border-border p-3">
                                <legend className="px-1 text-sm font-medium text-foreground">
                                  {MARGIN_SIDE_LABELS[side]} margin
                                </legend>
                                <div className="mt-2 flex items-center gap-2">
                                  <button
                                    type="button"
                                    role="switch"
                                    aria-checked={m.enabled}
                                    onClick={() =>
                                      updateMargins((u) => ({
                                        ...u,
                                        [side]: { enabled: !u[side].enabled, value: !u[side].enabled ? '1' : '' },
                                      }))
                                    }
                                    className={cn(
                                      'inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                                      m.enabled ? 'bg-primary border-transparent' : 'bg-input border-border',
                                    )}
                                  >
                                    <span className="sr-only">Check {MARGIN_SIDE_LABELS[side]} margin</span>
                                    <span className={cn('inline-block h-5 w-5 rounded-full bg-white transition-transform', m.enabled ? 'translate-x-5' : 'translate-x-0.5')} />
                                  </button>
                                  <span className="text-sm text-foreground">{m.enabled ? 'On' : 'Off'}</span>
                                </div>
                                {m.enabled && (
                                  <div className="mt-2 flex items-center gap-2">
                                    <input
                                      id={`margin-${side}`}
                                      type="number"
                                      min={0.25}
                                      max={4}
                                      step={0.25}
                                      value={m.value}
                                      onChange={(e) =>
                                        updateMargins((u) => ({
                                          ...u,
                                          [side]: { ...u[side], value: e.target.value },
                                        }))
                                      }
                                      className="w-20 rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none"
                                      aria-describedby={`margin-${side}-hint`}
                                    />
                                    <span className="text-sm text-muted-foreground">in</span>
                                  </div>
                                )}
                                {reqFieldErrors[`margins.${side}`] && (
                                  <p role="alert" className="mt-1 text-xs text-destructive">{reqFieldErrors[`margins.${side}`]}</p>
                                )}
                                <p id={`margin-${side}-hint`} className="mt-1 text-[11px] text-muted-foreground">
                                  {m.enabled ? 'Range: 0.25–4.0 in. Disabled = null.' : 'Off means no deterministic check.'}
                                </p>
                              </fieldset>
                            )
                          })}
                        </div>
                      </div>
                    </details>

                    {/* ------------------------------------------------------------------ */}
                    {/* References controls                                                  */}
                    {/* ------------------------------------------------------------------ */}
                    <details className="group mt-4 rounded-md border border-border" open={allExpanded || undefined}>
                      <summary className="cursor-pointer list-none rounded-md px-3 py-2.5 text-sm font-semibold text-foreground select-none transition-colors hover:bg-input/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                        <div className="flex items-center justify-between">
                          <span>References</span>
                          <svg
                            className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90"
                            aria-hidden="true"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </div>
                      </summary>
                      <div className="space-y-4 px-3 pb-3 pt-1">
                        <p className="text-xs leading-[16px] text-muted-foreground">
                          Turning off a requirement means it will not be checked or included in the score.
                        </p>

                        <RequirementToggle
                          label="Reference line spacing"
                          enabled={referencesUi?.lineSpacingEnabled ?? false}
                          onToggle={() => updateReferences((u) => ({ ...u, lineSpacingEnabled: !u.lineSpacingEnabled }))}
                          value={referencesUi?.lineSpacing ?? ''}
                          onChange={(v) => updateReferences((u) => ({ ...u, lineSpacing: v }))}
                          min={1}
                          max={4}
                          step={0.1}
                          unit="× (multiplier)"
                          error={reqFieldErrors['references.line_spacing']}
                          hint="Off means reference line spacing is not checked."
                          fieldId="references-line-spacing"
                        />

                        <div className="rounded-md border border-dashed border-border bg-input/10 px-3 py-2.5">
                          <p className="text-sm text-muted-foreground">Hanging indentation</p>
                          <p className="mt-0.5 text-xs leading-[16px] text-muted-foreground">
                            Hanging indentation checking is not available in this version.
                          </p>
                        </div>
                      </div>
                    </details>

                    {/* ------------------------------------------------------------------ */}
                    {/* Captions controls                                                     */}
                    {/* ------------------------------------------------------------------ */}
                    <details className="group mt-4 rounded-md border border-border" open={allExpanded || undefined}>
                      <summary className="cursor-pointer list-none rounded-md px-3 py-2.5 text-sm font-semibold text-foreground select-none transition-colors hover:bg-input/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                        <div className="flex items-center justify-between">
                          <span>Captions</span>
                          <svg
                            className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90"
                            aria-hidden="true"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </div>
                      </summary>
                      <div className="space-y-4 px-3 pb-3 pt-1">
                        <p className="text-xs leading-[16px] text-muted-foreground">
                          Turning off a requirement means it will not be checked or included in the score.
                        </p>

                        <RequirementToggle
                          label="Space before captions"
                          enabled={captionsUi?.spaceBeforeEnabled ?? false}
                          onToggle={() => updateCaptions((u) => ({ ...u, spaceBeforeEnabled: !u.spaceBeforeEnabled }))}
                          value={captionsUi?.spaceBefore ?? ''}
                          onChange={(v) => updateCaptions((u) => ({ ...u, spaceBefore: v }))}
                          min={0}
                          max={240}
                          unit="pt"
                          error={reqFieldErrors['captions.space_before']}
                          hint="Range: 0–240 pt. Off means no deterministic check."
                          fieldId="captions-space-before"
                        />

                        <RequirementToggle
                          label="Space after captions"
                          enabled={captionsUi?.spaceAfterEnabled ?? false}
                          onToggle={() => updateCaptions((u) => ({ ...u, spaceAfterEnabled: !u.spaceAfterEnabled }))}
                          value={captionsUi?.spaceAfter ?? ''}
                          onChange={(v) => updateCaptions((u) => ({ ...u, spaceAfter: v }))}
                          min={0}
                          max={240}
                          unit="pt"
                          error={reqFieldErrors['captions.space_after']}
                          hint="Range: 0–240 pt. Off means no deterministic check."
                          fieldId="captions-space-after"
                        />

                        <p className="text-[11px] leading-[16px] text-muted-foreground">
                          Caption spacing applies only to detected academic captions. Administrative,
                          layout, rubric, and unknown tables are not checked for captions.
                        </p>
                      </div>
                    </details>

                    {/* ------------------------------------------------------------------ */}
                    {/* Lists controls                                                         */}
                    {/* ------------------------------------------------------------------ */}
                    <details className="group mt-4 rounded-md border border-border" open={allExpanded || undefined}>
                      <summary className="cursor-pointer list-none rounded-md px-3 py-2.5 text-sm font-semibold text-foreground select-none transition-colors hover:bg-input/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                        <div className="flex items-center justify-between">
                          <span>Lists</span>
                          <svg
                            className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90"
                            aria-hidden="true"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </div>
                      </summary>
                      <div className="space-y-4 px-3 pb-3 pt-1">
                        <p className="text-xs leading-[16px] text-muted-foreground">
                          Turning off a requirement means it will not be checked or included in the score.
                        </p>

                        <RequirementToggle
                          label="Space after list items"
                          enabled={listsUi?.spaceAfterEnabled ?? false}
                          onToggle={() => updateLists((u) => ({ ...u, spaceAfterEnabled: !u.spaceAfterEnabled }))}
                          value={listsUi?.spaceAfter ?? ''}
                          onChange={(v) => updateLists((u) => ({ ...u, spaceAfter: v }))}
                          min={0}
                          max={240}
                          unit="pt"
                          error={reqFieldErrors['lists.space_after']}
                          hint="Range: 0–240 pt. Off means no deterministic check."
                          fieldId="lists-space-after"
                        />

                        <div className="rounded-md border border-dashed border-border bg-input/10 px-3 py-2.5">
                          <p className="text-sm text-muted-foreground">Space before list items</p>
                          <p className="mt-0.5 text-xs leading-[16px] text-muted-foreground">
                            Space before list items is not checked in this version.
                          </p>
                        </div>
                      </div>
                    </details>

                    {/* ------------------------------------------------------------------ */}
                    {/* Profile summary                                                      */}
                    {/* ------------------------------------------------------------------ */}
                    {draft && (() => {
                      const currentPayload = bodyUi
                        ? setPayloadGroup(draft.payload, 'body', bodyFromUiModel(bodyUi))
                        : draft.payload
                      const summary = summarizeProfile(currentPayload)
                      return (
                        <div className="mt-4 rounded-md border border-border bg-input/20 px-3 py-3">
                          <p className="text-sm font-semibold text-foreground">
                            Profile summary
                          </p>
                          <ul className="mt-2 space-y-1 text-xs leading-[16px] text-muted-foreground">
                            {summary.lines.map((line, i) => (
                              <li key={i} className="font-mono">{line}</li>
                            ))}
                            <li aria-live="polite" className="font-mono text-muted-foreground">
                              {summary.disabledCount} requirements will not be checked or included in the score.
                            </li>
                          </ul>
                        </div>
                      )
                    })()}

                    {/* Action bar — in flow (never floats over content) */}
                    {draft && (
                      <div className="mt-4 rounded-md border border-border bg-input/20 px-3 py-3">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            {/* Operation messages render in the page-level
                                status region above — this bar only shows the
                                draft-state indicator and actions. */}
                            {opStatus.kind === 'idle' && !dirty && (
                              <span className="text-xs text-muted-foreground">No unsaved changes</span>
                            )}
                            {dirty && opStatus.kind !== 'validating' && opStatus.kind !== 'deleting' && (
                              <span className="text-xs font-medium text-warning">Unsaved changes</span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {/* Discard for unsaved drafts; Delete for saved custom profiles only. */}
                            {isUnsavedDraft(draft, envelope) ? (
                              <Button
                                type="button"
                                variant="outline"
                                onClick={discardDraft}
                                disabled={deleting || opStatus.kind === 'validating'}
                                className="border-border text-foreground min-h-[44px]"
                              >
                                Discard draft
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                variant="destructive"
                                onClick={() => requestDelete(draft)}
                                disabled={deleting || opStatus.kind === 'validating'}
                                className="min-h-[44px]"
                              >
                                <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                                Delete profile
                              </Button>
                            )}
                            <Button
                              type="button"
                              onClick={() => void saveProfile()}
                              disabled={opStatus.kind === 'validating' || !dirty}
                              className="bg-primary text-primary-foreground hover:bg-primary/90 min-h-[44px]"
                            >
                              {opStatus.kind === 'validating' ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                              ) : (
                                <Save className="mr-2 h-4 w-4" aria-hidden="true" />
                              )}
                              Save custom profile
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex flex-col items-start gap-3 rounded-md border border-border bg-input/20 px-4 py-6">
                    <FileText className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
                    <p className="text-sm leading-[21px] text-muted-foreground">
                      Select a custom profile from the list to edit it, or create a new one
                      using the actions on the left.
                    </p>
                    {envelope && envelope.profiles.length === 0 && (
                      <Button
                        type="button"
                        variant="outline"
                        className="border-border text-foreground"
                        onClick={() => void createFrom('blank')}
                      >
                        <Plus className="mr-2 h-4 w-4 text-primary" aria-hidden="true" />
                        Start with no enabled requirements
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </section>
        </div>
      </main>

      <AppFooter />

      {/* Unsaved-changes confirmation */}
      {pendingNavigation && (
        <ConfirmDialog
          title="Unsaved changes"
          description="You have unsaved changes to this custom profile. Discard them and continue?"
          confirmLabel="Discard changes"
          cancelLabel="Continue editing"
          confirmVariant="destructive"
          onConfirm={discardAndGo}
          onCancel={cancelLeave}
        />
      )}

      {/* Delete confirmation — saved custom profiles only */}
      {pendingDelete && (
        <ConfirmDialog
          title="Delete custom profile?"
          description={`“${pendingDelete.name}” will be removed from this device. Completed audits that used this profile will not be changed.`}
          confirmLabel="Delete profile"
          cancelLabel="Cancel"
          confirmVariant="destructive"
          busy={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={cancelDelete}
        />
      )}
    </div>
  )
}
