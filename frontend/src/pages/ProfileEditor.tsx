/** Browser-local grouped editor. Dirty drafts are isolated from confirmed saves. */
import * as React from 'react'
import { useBlocker, useNavigate } from 'react-router-dom'
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
  loadDraftRecoveryResult,
  saveDraftRecovery,
} from '../lib/custom-profile-store/draft-recovery'
import type { DraftUiState, ProfileDraftRecovery } from '../lib/custom-profile-store/draft-recovery'
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
  buildSavePayload,
  headingToUiModel,
  isUnsavedDraft,
  marginsToUiModel,
  applyMarginPreset,
  MARGIN_PRESET_LABELS,
  MARGIN_SIDE_LABELS,
  mergeOpStatus,
  isSuccessOpStatus,
  type OpStatus,
  type MarginSide,
  type MarginPreset,
  persistEnvelope,
  resolveUniqueName,
  bodyToUiModel,
  referencesToUiModel,
  captionsToUiModel,
  listsToUiModel,
  applyPageElementsUiPatch,
  pageElementsToUiModel,
  summarizeProfile,
  upsertAndBump,
  citationMatchingToUiModel,
  DEFAULT_CITATION_MATCHING,
  type CitationMatchingField,
  type CitationMatchingUiModel,
  type BodyUiModel,
  type HeadingUiModel,
  type MarginsUiModel,
  type ReferencesUiModel,
  type CaptionUiModel,
  type ListUiModel,
  type PageElementsUiModel,
  type AlignmentValue,
  type CreationKind,
  type StoreAdapter,
  type StoreEnvelope,
  type StoredCustomProfile,
} from '../lib/custom-profile-store/editor'
import {
  REFERENCE_HEADING_TEXT_OPTIONS,
  REFERENCE_HEADING_TEXT_LABELS,
  type ReferenceHeadingText,
} from '../lib/custom-profile-store/editor'
import { createBrowserStoreAdapter } from '../lib/custom-profile-store/localstorage-adapter'
import { acceptReset, emptyEnvelope, loadStore, type StoreLoadResult } from '../lib/custom-profile-store/store'
import { PAGE_ELEMENTS_HELP_TEXT, recordedRoleLabel, RECORDED_ROLE_POLICY_NOTICE } from '../lib/audit/enabled-checks-wording'
import { cn } from '../lib/utils'

// Known citation-style terms that may appear in profile names. We only warn;
// we do not block or auto-correct the name.
const CITATION_STYLE_NAME_HINTS = ['chicago', 'ama', 'mla', 'harvard']

/** Reader-facing alignment options shared by the Reference List selects. */
const ALIGNMENT_SELECT_OPTIONS = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
  { value: 'justify', label: 'Justified' },
] as const

/** Neutral Reference List model, shown before a draft is loaded. */
const EMPTY_REFERENCES_UI: ReferencesUiModel = referencesToUiModel({})

function focusProfileList() {
  const heading = document.getElementById('profile-list-heading')
  heading?.scrollIntoView({ block: 'center', behavior: 'instant' })
  heading?.focus({ preventScroll: true })
}

function focusDraftName() {
  const input = document.getElementById('profile-name')
  input?.scrollIntoView({ block: 'center', behavior: 'instant' })
  input?.focus({ preventScroll: true })
}

/** DOM ids for the citation-controls checkboxes (error-focus targets). */
const CITATION_INPUT_IDS: Record<CitationMatchingField, string> = {
  check_citations_have_references: 'citation-check-citations-have-references',
  check_references_are_cited: 'citation-check-references-are-cited',
  check_author_year_consistency: 'citation-check-author-year-consistency',
  check_year_suffixes: 'citation-check-year-suffixes',
  check_duplicate_references: 'citation-check-duplicate-references',
  flag_ambiguous_matches: 'citation-flag-ambiguous-matches',
  allow_personal_communication: 'citation-allow-personal-communication',
}

const PAGE_ELEMENT_CONTROLS: {
  field: 'headerEnabled' | 'footerEnabled' | 'pageNumberEnabled'
  label: string
  toggleLabel: string
  inputId: string
  errorField: string
  notChecked: string
}[] = [
  {
    field: 'headerEnabled',
    label: 'Header',
    toggleLabel: 'Check Header requirements',
    inputId: 'headers-check-requirements',
    errorField: 'headers.check_header_requirements',
    notChecked: 'Headers: Not checked',
  },
  {
    field: 'footerEnabled',
    label: 'Footer',
    toggleLabel: 'Check Footer requirements',
    inputId: 'footers-check-requirements',
    errorField: 'footers.check_footer_requirements',
    notChecked: 'Footers: Not checked',
  },
  {
    field: 'pageNumberEnabled',
    label: 'Page numbers',
    toggleLabel: 'Check Page Number requirements',
    inputId: 'page-numbers-check-requirements',
    errorField: 'page_numbers.check_page_number_requirements',
    notChecked: 'Page numbers: Not checked',
  },
]

/** The citation-controls rows, in display order (7 switches, no free text). */
const CITATION_CONTROL_ROWS: {
  field: CitationMatchingField
  label: string
  hint: string
  dependent?: boolean
}[] = [
  {
    field: 'check_citations_have_references',
    label: 'Check in-text citations against the Reference List',
    hint: 'Flags in-text citations whose source is missing from the Reference List.',
  },
  {
    field: 'check_references_are_cited',
    label: 'Check Reference List entries are cited in the text',
    hint: 'Flags Reference List entries with no matching in-text citation.',
  },
  {
    field: 'check_author_year_consistency',
    label: 'Check author and year consistency',
    hint: 'Flags a citation whose year differs from its Reference List entry.',
    dependent: true,
  },
  {
    field: 'check_year_suffixes',
    label: 'Check same-author, same-year suffixes (2024a/2024b)',
    hint: 'Flags a citation missing the year suffix used by its entry.',
    dependent: true,
  },
  {
    field: 'check_duplicate_references',
    label: 'Check for duplicate Reference List entries',
    hint: 'Flags the same source listed more than once.',
  },
  {
    field: 'flag_ambiguous_matches',
    label: 'Flag ambiguous matches for manual review',
    hint: 'Configured ambiguous-match review is unscored and runs only while in-text citations are checked against the Reference List.',
  },
  {
    field: 'allow_personal_communication',
    label: 'Allow personal-communication citations',
    hint: 'Personal communications are exempt from the Reference List check.',
  },
]

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
  const groupLabel = fieldId.startsWith('body-') ? 'Body text' : fieldId.startsWith('heading-') ? 'Headings' : fieldId.startsWith('captions-') ? 'Captions' : 'Lists'
  const accessibleLabel = `${groupLabel}: ${label}`
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
          <span className="sr-only">Check {accessibleLabel}</span>
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
            aria-label={`${accessibleLabel}${unit ? ` (${unit})` : ''}`}
            aria-invalid={Boolean(error)}
            type="text"
            inputMode="decimal"
            min={min}
            max={max}
            step={step ?? 0.1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-20 rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none"
            aria-describedby={[hint ? `${fieldId}-hint` : '', error ? `${fieldId}-error` : ''].filter(Boolean).join(' ') || undefined}
          />
          {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
        </div>
      )}
      {enabled && isSelect && options && (
        <select
          id={fieldId}
          aria-label={accessibleLabel}
          aria-invalid={Boolean(error)}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-2 w-full rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none"
          aria-describedby={[hint ? `${fieldId}-hint` : '', error ? `${fieldId}-error` : ''].filter(Boolean).join(' ') || undefined}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )}
      {error && <p id={`${fieldId}-error`} role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
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
  React.useEffect(() => () => {
    // Only editor departures: do not install an app-wide navigation policy.
    requestAnimationFrame(() => {
      if (document.getElementById('custom-profile-main') || document.activeElement !== document.body) return
      const main = document.querySelector<HTMLElement>('main')
      if (!main) return
      if (!main.hasAttribute('tabindex')) main.tabIndex = -1
      main.scrollIntoView({ block: 'start', behavior: 'instant' })
      main.focus({ preventScroll: true })
    })
  }, [])
  const adapterRef = React.useRef<StoreAdapter | null>(null)

  // Store + list state
  const [envelope, setEnvelope] = React.useState<StoreEnvelope | null>(null)
  const [builtins, setBuiltins] = React.useState<BuiltinViewModel[]>([])
  const [loadStatus, setLoadStatus] = React.useState<LoadStatus>({ state: 'loading' })
  const [adapterVersion, setAdapterVersion] = React.useState(0)
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
  // Results remain available until the next action; a focused status must
  // never disappear on a timer.
  const [pendingNavigation, setPendingNavigation] = React.useState<null | (() => void)>(null)
  const transitionAllowed = React.useRef(false)
  const baseRevisionRef = React.useRef(0)
  const replacementConsentRef = React.useRef(false)
  const deleteRevisionRef = React.useRef(0)
  const editingExistingRef = React.useRef(false)
  const savingRef = React.useRef(false)
  const [storeHealth, setStoreHealth] = React.useState<StoreLoadResult | null>(null)
  const [externalConflict, setExternalConflict] = React.useState(false)
  const [saveBusy, setSaveBusy] = React.useState(false)
  const summaryRef = React.useRef<HTMLDivElement>(null)
  const statusRef = React.useRef<HTMLDivElement>(null)
  const blocker = useBlocker(() => dirty && !transitionAllowed.current)

  // Requirement UI models — derived from draft.payload and the single source
  // of truth for every requirement control in this Build.
  const [bodyUi, setBodyUi] = React.useState<BodyUiModel | null>(null)
  const [headingUi, setHeadingUi] = React.useState<HeadingUiModel | null>(null)
  const [marginsUi, setMarginsUi] = React.useState<MarginsUiModel | null>(null)
  const [referencesUi, setReferencesUi] = React.useState<ReferencesUiModel | null>(null)
  const [captionsUi, setCaptionsUi] = React.useState<CaptionUiModel | null>(null)
  const [listsUi, setListsUi] = React.useState<ListUiModel | null>(null)
  const [citationUi, setCitationUi] = React.useState<CitationMatchingUiModel | null>(null)

  // Inline field errors for requirement controls (mapped from backend/client).
  const [reqFieldErrors, setReqFieldErrors] = React.useState<Record<string, string>>({})

  const draftRecoveryAdapterRef = React.useRef(createSessionDraftRecoveryAdapter())
  const [recoveryNotice, setRecoveryNotice] = React.useState<string | null>(null)
  const [pendingRecovery, setPendingRecovery] = React.useState<ProfileDraftRecovery | null>(null)
  const [recoveryBlocked, setRecoveryBlocked] = React.useState(false)
  const recoveryChecked = React.useRef(false)
  const uiState: DraftUiState = {
    body: bodyUi, heading: headingUi, margins: marginsUi, references: referencesUi,
    captions: captionsUi, lists: listsUi, citation: citationUi,
  }

  const hydrateUi = React.useCallback((profile: StoredCustomProfile, ui?: DraftUiState) => {
    const payload = profile.payload
    const group = (key: string): Record<string, unknown> =>
      typeof payload[key] === 'object' && payload[key] !== null && !Array.isArray(payload[key])
        ? payload[key] as Record<string, unknown> : {}
    setBodyUi(ui ? ui.body : bodyToUiModel(group('body')))
    setHeadingUi(ui ? ui.heading : headingToUiModel(group('heading')))
    setMarginsUi(ui ? ui.margins : marginsToUiModel(group('margins')))
    setReferencesUi(ui ? ui.references : referencesToUiModel(group('references')))
    setCaptionsUi(ui ? ui.captions : captionsToUiModel(group('captions')))
    setListsUi(ui ? ui.lists : listsToUiModel(group('lists')))
    setCitationUi(ui ? ui.citation : citationMatchingToUiModel(payload.citation_matching))
  }, [])

  const readStore = React.useCallback((adapter: StoreAdapter) => {
    const result = loadStore(adapter)
    setStoreHealth(result)
    // Empty is an explicitly unpersisted drafting container, not a healthy load.
    setEnvelope(result.ok ? result.envelope : emptyEnvelope())
    return result
  }, [])

  React.useEffect(() => {
    let cancelled = false
    const adapter = createBrowserStoreAdapter() ?? createMemoryStoreAdapter()
    adapterRef.current = adapter
    readStore(adapter)
    const recovery = loadDraftRecoveryResult(draftRecoveryAdapterRef.current)
    recoveryChecked.current = true
    if (recovery.status === 'ready') {
      setRecoveryBlocked(true)
      setPendingRecovery(recovery.recovery)
      setRecoveryNotice('An unsaved draft is available. Restore it or explicitly discard it before starting another draft.')
    } else if (recovery.status !== 'empty') {
      setRecoveryBlocked(recovery.status !== 'unavailable')
      setRecoveryNotice(recovery.status === 'unsupported'
        ? 'This draft recovery version cannot be restored losslessly (older records lack identity and metadata). Its bytes have been retained; discard explicitly to start again.'
        : recovery.status === 'invalid'
          ? 'The draft recovery is invalid. Its bytes have been retained; discard explicitly to start again.'
          : 'Draft recovery storage is unavailable. Keep this tab open to retain your work.')
    }
    void api.getFormattingProfiles().then((list) => {
      if (cancelled) return
      setBuiltins(list.filter((p) => p.profile_source === 'built_in').map((p) => ({
        profileId: p.profile_id, name: p.profile_name, description: p.description, sourceName: p.profile_name,
      })))
      setLoadStatus({ state: 'ready' })
    }).catch(() => { if (!cancelled) setLoadStatus({ state: 'error' }) })
    return () => {
      cancelled = true
      const currentAdapter = adapterRef.current
      if (currentAdapter && 'destroy' in currentAdapter && typeof currentAdapter.destroy === 'function') currentAdapter.destroy()
      adapterRef.current = null
    }
  }, [readStore])

  React.useEffect(() => {
    if (!dirty || !draft || !recoveryChecked.current || recoveryBlocked || pendingRecovery) return
    const recovery: ProfileDraftRecovery = {
      schema_version: 2, profile_id: draft.id, base_revision: baseRevisionRef.current,
      draft, ui: uiState, updated_at: new Date().toISOString(),
    }
    if (!saveDraftRecovery(draftRecoveryAdapterRef.current, recovery)) {
      setRecoveryNotice('Draft recovery could not be written. Keep this tab open; your unsaved work is not protected against reload.')
    }
  }, [dirty, draft, bodyUi, headingUi, marginsUi, referencesUi, captionsUi, listsUi, citationUi, pendingRecovery, recoveryBlocked, externalConflict])

  const clearRecovery = React.useCallback(() => {
    if (!clearDraftRecovery(draftRecoveryAdapterRef.current)) {
      setRecoveryNotice('Draft recovery could not be cleared. The requested transition was cancelled to prevent old edits returning.')
      return false
    }
    setPendingRecovery(null)
    setRecoveryBlocked(false)
    setRecoveryNotice(null)
    return true
  }, [])

  const restoreRecovery = () => {
    if (!pendingRecovery || !envelope) return
    const recovery = pendingRecovery
    baseRevisionRef.current = recovery.base_revision
    editingExistingRef.current = recovery.draft.validationState !== 'draft'
    const conflict = recovery.base_revision !== envelope.revision ||
      (editingExistingRef.current && !envelope.profiles.some((profile) => profile.id === recovery.profile_id))
    setExternalConflict(conflict)
    setDraft(structuredClone(recovery.draft))
    setEditingId(recovery.profile_id)
    hydrateUi(recovery.draft, recovery.ui)
    setDirty(true)
    setPendingRecovery(null)
    setRecoveryBlocked(false)
    setRecoveryNotice(conflict
      ? 'Restored the full draft. Saved data changed since editing began; Save is blocked until you reload the saved version or review the latest revision.'
      : 'Restored the full unsaved draft, including name, description and unfinished input.')
    requestAnimationFrame(focusDraftName)
  }

  React.useEffect(() => {
    if (!adapterRef.current) return
    return adapterRef.current.onExternalChange(() => {
      const result = readStore(adapterRef.current!)
      if (!result.ok) { if (dirty) setExternalConflict(true); return }
      if (dirty) {
        if (result.envelope.revision !== baseRevisionRef.current) setExternalConflict(true)
      } else if (editingId) {
        const saved = result.envelope.profiles.find((p) => p.id === editingId)
        if (saved) {
          setDraft(structuredClone(saved))
          hydrateUi(saved)
          baseRevisionRef.current = result.envelope.revision
        } else { setDraft(null); setEditingId(null) }
      }
    })
  }, [loadStatus.state, adapterVersion, dirty, editingId, readStore, hydrateUi])

  React.useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])


  const createFrom = React.useCallback(async (kind: CreationKind) => {
    if (!envelope || savingRef.current || recoveryBlocked) return
    setCreationBusy(kind)
    try {
      const loaded = readStore(adapterRef.current!)
      const creationEnvelope = loaded.ok ? loaded.envelope : emptyEnvelope()
      const name = resolveUniqueName(creationEnvelope.profiles.map((p) => p.name), DEFAULT_PROFILE_NAMES[kind])
      const id = generateProfileId()
      const sourceId = kind === 'copy-suc' ? SUC_BUILTIN_ID : kind === 'copy-apa' ? APA_BUILTIN_ID : undefined
      const payload = sourceId
        ? copyProfilePayload(await api.getBuiltinProfilePayload(sourceId), id, name)
        : blankProfilePayload(id, name)
      const profile: StoredCustomProfile = {
        id, name, description: typeof payload.description === 'string' ? payload.description : '',
        sourceId, payload, validationState: 'draft', updatedAt: new Date().toISOString(),
      }
      baseRevisionRef.current = creationEnvelope.revision
      replacementConsentRef.current = false
      editingExistingRef.current = false
      setExternalConflict(false)
      setDraft(profile)
      setEditingId(id)
      hydrateUi(profile)
      setDirty(true)
      setFieldErrors({})
      setReqFieldErrors({})
      setOpStatusSafe({ kind: 'idle' })
      requestAnimationFrame(focusDraftName)
    } catch {
      setOpStatusSafe({ kind: 'error', message: 'The source profile could not be copied. No profile was created. Retry the copy, or explicitly choose a blank profile.' })
      requestAnimationFrame(() => {
        statusRef.current?.scrollIntoView({ block: 'center', behavior: 'instant' })
        statusRef.current?.focus({ preventScroll: true })
      })
    } finally { setCreationBusy(null) }
  }, [envelope, hydrateUi, setOpStatusSafe, recoveryBlocked, readStore])

  const openProfile = React.useCallback((id: string) => {
    const loaded = readStore(adapterRef.current!)
    if (!loaded.ok) return
    const profile = loaded.envelope.profiles.find((p) => p.id === id)
    if (!profile) {
      setOpStatusSafe({ kind: 'already-gone' })
      requestAnimationFrame(focusProfileList)
      return
    }
    baseRevisionRef.current = loaded.envelope.revision
    replacementConsentRef.current = false
    editingExistingRef.current = true
    setExternalConflict(false)
    setDraft(structuredClone(profile))
    setEditingId(id)
    hydrateUi(profile)
    setDirty(false)
    setFieldErrors({})
    setReqFieldErrors({})
    setOpStatusSafe({ kind: 'idle' })
    requestAnimationFrame(focusDraftName)
  }, [readStore, hydrateUi, setOpStatusSafe])

  const markChanged = () => {
    setDirty(true)
    setOpStatusSafe({ kind: 'idle' })
    if (replacementConsentRef.current) {
      replacementConsentRef.current = false
      setExternalConflict(true)
    }
  }
  const updateDraft = (patch: Partial<Pick<StoredCustomProfile, 'name' | 'description'>>) => {
    setDraft((previous) => previous ? { ...previous, ...patch } : previous)
    markChanged()
  }
  // UI models retain unfinished raw strings; the original payload is never rebuilt here.
  const updateBody = (update: (value: BodyUiModel) => BodyUiModel) => {
    setBodyUi((value) => value ? update(value) : value); markChanged()
  }
  const updateHeading = (update: (value: HeadingUiModel) => HeadingUiModel) => {
    setHeadingUi((value) => value ? update(value) : value); markChanged()
  }
  const updateMargins = (update: (value: MarginsUiModel) => MarginsUiModel) => {
    setMarginsUi((value) => value ? update(value) : value); markChanged()
  }
  const updateReferences = (update: (value: ReferencesUiModel) => ReferencesUiModel) => {
    setReferencesUi((value) => value ? update(value) : value); markChanged()
  }
  const updateCaptions = (update: (value: CaptionUiModel) => CaptionUiModel) => {
    setCaptionsUi((value) => value ? update(value) : value); markChanged()
  }
  const updateLists = (update: (value: ListUiModel) => ListUiModel) => {
    setListsUi((value) => value ? update(value) : value); markChanged()
  }
  const updateCitation = (field: CitationMatchingField, value: boolean) => {
    setCitationUi((previous) => previous ? { ...previous, [field]: value } : previous); markChanged()
  }
  const updatePageElements = (patch: Partial<PageElementsUiModel>) => {
    setDraft((previous) => previous ? { ...previous, payload: applyPageElementsUiPatch(previous.payload, patch) } : previous)
    markChanged()
  }

  const errorEntries = [
    ...(fieldErrors.name ? [{ field: 'general.name', message: fieldErrors.name }] : []),
    ...(fieldErrors.description ? [{ field: 'general.description', message: fieldErrors.description }] : []),
    ...Object.entries(reqFieldErrors).map(([field, message]) => ({ field, message })),
  ]
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
    'references.heading_text': 'references-heading-text',
    'references.heading_alignment': 'references-heading-alignment',
    'references.hanging_indent_in': 'references-hanging-indent',
    'references.space_before_pt': 'references-space-before',
    'references.space_after_pt': 'references-space-after',
    'references.font_family': 'references-font-family',
    'references.font_size_pt': 'references-font-size',
    'references.alignment': 'references-alignment',
    'captions.space_before': 'captions-space-before',
    'captions.space_after': 'captions-space-after',
    'lists.space_after': 'lists-space-after',
    'citation_matching.check_citations_have_references': 'citation-check-citations-have-references',
    'citation_matching.check_references_are_cited': 'citation-check-references-are-cited',
    'citation_matching.check_author_year_consistency': 'citation-check-author-year-consistency',
    'citation_matching.check_year_suffixes': 'citation-check-year-suffixes',
    'citation_matching.check_duplicate_references': 'citation-check-duplicate-references',
    'citation_matching.flag_ambiguous_matches': 'citation-flag-ambiguous-matches',
    'citation_matching.allow_personal_communication': 'citation-allow-personal-communication',
    'headers.check_header_requirements': 'headers-check-requirements',
    'footers.check_footer_requirements': 'footers-check-requirements',
    'page_numbers.check_page_number_requirements': 'page-numbers-check-requirements',
    'page_numbers.placement': 'page-numbers-placement',
  }

  React.useLayoutEffect(() => {
    for (const [field, id] of Object.entries(FIELD_TO_INPUT_ID)) {
      const element = document.getElementById(id)
      if (!element) continue
      element.style.scrollMarginTop = '6rem'
      const description = `validation-${field.replace(/\./g, '-')}`
      const describedBy = (element.getAttribute('aria-describedby') ?? '').split(' ').filter((value) => value && !value.startsWith('validation-'))
      if (errorEntries.some((error) => error.field === field)) {
        element.setAttribute('aria-invalid', 'true')
        describedBy.push(description)
      } else element.removeAttribute('aria-invalid')
      if (describedBy.length) element.setAttribute('aria-describedby', describedBy.join(' '))
      else element.removeAttribute('aria-describedby')
    }
  })

  const focusErrorTarget = (field: string) => {
    const id = FIELD_TO_INPUT_ID[field] ?? 'profile-retained-data'
    const element = document.getElementById(id) ?? document.getElementById('profile-retained-data')
    if (!element) return
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true
    }
    element.scrollIntoView({ block: 'center', behavior: 'instant' })
    element.focus({ preventScroll: true })
  }
  const showErrors = (errors: { field: string; message: string }[]) => {
    setFieldErrors({
      name: errors.find((error) => error.field === 'general.name')?.message,
      description: errors.find((error) => error.field === 'general.description')?.message,
    })
    setReqFieldErrors(Object.fromEntries(errors.filter((error) =>
      error.field !== 'general.name' && error.field !== 'general.description',
    ).map((error) => [error.field, error.message])))
    requestAnimationFrame(() => {
      for (const error of errors) {
        const target = document.getElementById(FIELD_TO_INPUT_ID[error.field] ?? 'profile-retained-data') ?? document.getElementById('profile-retained-data')
        for (let parent = target?.parentElement; parent; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement) parent.open = true
        }
      }
      summaryRef.current?.scrollIntoView({ block: 'center', behavior: 'instant' })
      summaryRef.current?.focus({ preventScroll: true })
    })
  }
  const finalPayload = draft ? buildSavePayload(draft, uiState) : null

  const saveProfile = async (): Promise<boolean> => {
    if (!draft || !envelope || !finalPayload || savingRef.current || !dirty) return false
    const expectedRevision = baseRevisionRef.current
    const candidate = structuredClone(finalPayload)
    const candidateDraft = { ...draft, payload: candidate }
    const errors = clientValidate(candidateDraft, envelope)
    if (errors.length) {
      showErrors(errors)
      setOpStatusSafe({ kind: 'error', message: 'Fix the highlighted fields and try again.' })
      return false
    }
    if (externalConflict || (editingExistingRef.current && !envelope.profiles.some((p) => p.id === draft.id))) {
      setExternalConflict(true)
      setOpStatusSafe({ kind: 'error', message: 'Saved profiles changed after editing began. Your draft is retained; review the latest saved version before saving.' })
      return false
    }
    savingRef.current = true
    setSaveBusy(true)
    setFieldErrors({})
    setReqFieldErrors({})
    setOpStatusSafe({ kind: 'validating' })
    try {
      const result = await api.validateCustomProfile(candidate)
      if (!result.valid) {
        if ('errors' in result) {
          showErrors(result.errors)
          setOpStatusSafe({ kind: 'backend-error', errors: result.errors.map((error) => error.message) })
        } else {
          setOpStatusSafe({ kind: 'error', message: 'Validation is unavailable. Nothing was saved; your complete draft is retained. Retry when the backend is reachable.' })
        }
        return false
      }
      const confirmed: StoredCustomProfile = {
        ...draft, id: result.profile.profile_id as string,
        name: result.profile.profile_name as string, description: result.profile.description as string,
        payload: result.profile, validationState: 'backend_confirmed', updatedAt: new Date().toISOString(),
      }
      if (confirmed.id !== draft.id) throw new Error('Validation changed the profile identity')
      const next = upsertAndBump(envelope, confirmed, confirmed.updatedAt)
      const write = await persistEnvelope(adapterRef.current!, next, expectedRevision)
      if (!write.ok) {
        readStore(adapterRef.current!)
        if (write.reason === 'stale-revision') setExternalConflict(true)
        setOpStatusSafe({ kind: 'error', message: write.reason === 'stale-revision'
          ? 'Validated, but not saved: another tab changed the saved profiles. Your complete draft is retained.'
          : `Validated, but not saved to this browser (${write.reason}). Your draft is retained; recheck storage and retry.` })
        return false
      }
      setEnvelope(write.envelope)
      setStoreHealth({ ok: true, envelope: write.envelope, recovered: false, readonly: false, firstRun: false })
      baseRevisionRef.current = write.envelope.revision
      replacementConsentRef.current = false
      editingExistingRef.current = true
      setExternalConflict(false)
      setDraft(confirmed)
      hydrateUi(confirmed)
      setDirty(false)
      const cleared = clearRecovery()
      setOpStatusSafe({ kind: 'saved' })
      requestAnimationFrame(() => {
        statusRef.current?.scrollIntoView({ block: 'center', behavior: 'instant' })
        statusRef.current?.focus({ preventScroll: true })
      })
      return cleared
    } catch {
      setOpStatusSafe({ kind: 'error', message: 'The profile could not be validated. Nothing was saved; your draft is retained. Check the connection and retry.' })
      return false
    } finally {
      savingRef.current = false
      setSaveBusy(false)
    }
  }

  // A single coordinator handles local context changes and the data router's
  // links, AppNav and POP (browser back/forward) transitions.
  const requestTransition = (action: () => void) => {
    if (savingRef.current || creationBusy) return
    if (dirty && draft) setPendingNavigation(() => action)
    else action()
  }
  const discardAndGo = () => {
    if (!pendingNavigation || !clearRecovery()) return
    const action = pendingNavigation
    setPendingNavigation(null)
    setDirty(false)
    setDraft(null)
    setEditingId(null)
    transitionAllowed.current = true
    action()
    queueMicrotask(() => { transitionAllowed.current = false })
  }
  const saveAndGo = async () => {
    if (!pendingNavigation) return
    const action = pendingNavigation
    if (!await saveProfile()) {
      setPendingNavigation(null)
      if (blocker.state === 'blocked') blocker.reset()
      return
    }
    setPendingNavigation(null)
    transitionAllowed.current = true
    action()
    queueMicrotask(() => { transitionAllowed.current = false })
  }
  const cancelLeave = () => {
    if (savingRef.current) return
    setPendingNavigation(null)
    if (blocker.state === 'blocked') blocker.reset()
  }
  React.useEffect(() => {
    if (blocker.state === 'blocked') setPendingNavigation(() => () => blocker.proceed())
  }, [blocker])

  const [reviewedLatest, setReviewedLatest] = React.useState<StoreEnvelope | null>(null)
  const reviewLatest = () => {
    const result = readStore(adapterRef.current!)
    if (result.ok && !result.readonly) setReviewedLatest(structuredClone(result.envelope))
  }
  const acceptReviewedRevision = () => {
    if (!reviewedLatest || !draft || (editingExistingRef.current && !reviewedLatest.profiles.some((p) => p.id === draft.id))) return
    const live = readStore(adapterRef.current!)
    if (!live.ok || live.readonly || live.envelope.revision !== reviewedLatest.revision) {
      setReviewedLatest(null)
      setExternalConflict(true)
      return
    }
    baseRevisionRef.current = reviewedLatest.revision
    replacementConsentRef.current = true
    setExternalConflict(false)
    setReviewedLatest(null)
    setOpStatusSafe({ kind: 'idle' })
    setRecoveryNotice('You explicitly chose to replace the reviewed saved revision with this draft. Save will revalidate and recheck that revision.')
    requestAnimationFrame(focusDraftName)
  }

  // ---------------------------------------------------------------------
  // Delete (saved custom profiles only)
  // ---------------------------------------------------------------------

  const [pendingDelete, setPendingDelete] = React.useState<StoredCustomProfile | null>(null)
  const [deleting, setDeleting] = React.useState(false)
  const [pendingReset, setPendingReset] = React.useState(false)
  const [resetting, setResetting] = React.useState(false)
  const confirmReset = async () => {
    if (!adapterRef.current || resetting) return
    setResetting(true)
    try {
      const result = await acceptReset(adapterRef.current)
      if (!result.ok) {
        readStore(adapterRef.current)
        setOpStatusSafe({ kind: 'error', message: `The corrupt store was not reset (${result.reason}). Its remaining bytes are retained.` })
        return
      }
      setEnvelope(result.envelope)
      setStoreHealth({ ok: true, envelope: result.envelope, recovered: false, readonly: false, firstRun: false })
      if (draft && !editingExistingRef.current) baseRevisionRef.current = result.envelope.revision
      else if (draft) setExternalConflict(true)
      setPendingReset(false)
      requestAnimationFrame(focusProfileList)
    } finally { setResetting(false) }
  }

  const requestDelete = (profile: StoredCustomProfile) => {
    if (deleting) return
    requestTransition(() => {
      const loaded = readStore(adapterRef.current!)
      if (!loaded.ok) {
        setOpStatusSafe({ kind: 'error', message: 'Saved profiles could not be read. Nothing was deleted.' })
        return
      }
      deleteRevisionRef.current = loaded.envelope.revision
      const target = loaded.envelope.profiles.find((saved) => saved.id === profile.id)
      if (!target) {
        setOpStatusSafe({ kind: 'already-gone' })
        return
      }
      setPendingDelete(structuredClone(target))
      setOpStatusSafe({ kind: 'idle' })
    })
  }
  const cancelDelete = () => { if (!deleting) setPendingDelete(null) }
  const confirmDelete = async () => {
    if (!pendingDelete || !envelope || deleting) return
    if ((BUILTIN_IDS as readonly string[]).includes(pendingDelete.id)) return
    setDeleting(true)
    setOpStatusSafe({ kind: 'deleting' })
    try {
      const loaded = readStore(adapterRef.current!)
      if (!loaded.ok || loaded.readonly) {
        setOpStatusSafe({ kind: 'error', message: 'The profile was not deleted: browser storage is unavailable or read-only. Stored data is retained.' })
        return
      }
      // Reading the target never refreshes the consent revision.
      const result = deleteAndBump(loaded.envelope, pendingDelete.id, new Date().toISOString())
      if (!result.ok) {
        if (draft?.id === pendingDelete.id || pendingRecovery?.profile_id === pendingDelete.id) {
          clearRecovery()
          clearEditorState()
        }
        setPendingDelete(null)
        setOpStatusSafe({ kind: 'already-gone' })
        requestAnimationFrame(focusProfileList)
        return
      }
      const write = await persistEnvelope(adapterRef.current!, result.envelope, deleteRevisionRef.current)
      if (!write.ok) {
        readStore(adapterRef.current!)
        setOpStatusSafe({ kind: 'error', message: `The profile was not deleted (${write.reason}). Recheck saved profiles before trying again.` })
        return
      }
      setEnvelope(write.envelope)
      if (draft?.id === pendingDelete.id || pendingRecovery?.profile_id === pendingDelete.id) {
        clearRecovery()
        clearEditorState()
      }
      setPendingDelete(null)
      setOpStatus({ kind: 'deleted' })
      requestAnimationFrame(focusProfileList)
    } finally { setDeleting(false) }
  }
  const discardDraft = () => requestTransition(() => {
    if (!clearRecovery()) return
    clearEditorState()
    setOpStatusSafe({ kind: 'idle' })
    requestAnimationFrame(focusProfileList)
  })

  /** Clear the editor draft + requirement models without touching storage. */
  const clearEditorState = React.useCallback(() => {
    setDraft(null)
    setEditingId(null)
    setDirty(false)
    setExternalConflict(false)
    setReviewedLatest(null)
    setBodyUi(null)
    setHeadingUi(null)
    setMarginsUi(null)
    setReferencesUi(null)
    setCaptionsUi(null)
    setListsUi(null)
    setCitationUi(null)
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
  const lastSavedProfile = envelope?.profiles.find((profile) => profile.id === editingId)
  const selectedBuiltin = builtins.find((b) => b.profileId === editingId)
  const citationModel = citationUi ?? DEFAULT_CITATION_MATCHING
  const referenceModel = referencesUi ?? EMPTY_REFERENCES_UI
  // Deriving from the payload keeps create/open/recovery/reset/save paths in sync.
  const pageElementsModel = pageElementsToUiModel(draft?.payload ?? {})

  return (
    <div className="min-h-screen bg-background text-foreground [overflow-wrap:anywhere] [&_input]:scroll-mt-24 [&_select]:scroll-mt-24 [&_textarea]:scroll-mt-24">
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
            onClick={() => requestTransition(() => { void navigate('/dashboard') })}
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
            {pendingRecovery && <p className="mt-2 break-words text-sm">Draft: {pendingRecovery.draft.name || '(unnamed profile)'}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              {pendingRecovery && <Button type="button" variant="outline" onClick={restoreRecovery}>Restore recovered draft</Button>}
              {recoveryBlocked && <Button type="button" variant="outline" onClick={() => { if (clearRecovery()) requestAnimationFrame(focusProfileList) }}>Discard recovered draft</Button>}
            </div>
          </div>
        )}

        {storeHealth && (
          <div role="status" className="mt-4 space-y-2 rounded-md border border-border bg-input/20 p-3 text-sm">
            {!adapterRef.current?.persistent
              ? <p>Browser storage is unavailable. This is an in-session draft only, not saved on this device or available for upload.</p>
              : !storeHealth.ok
                ? <p>{storeHealth.reason === 'both-corrupted'
                  ? 'The saved profile store has no usable copy. Corrupt data is retained; ordinary Save cannot overwrite it.'
                  : storeHealth.reason === 'unsupported-version'
                    ? 'This profile store uses an unsupported newer version and is read-only. Its bytes are retained; reset and persistent writes are unavailable.'
                    : 'Saved profile storage cannot be read. Your draft remains in this tab; nothing is saved.'}</p>
                : storeHealth.readonly
                  ? <p>This profile store was written by a newer version. It is read-only; existing bytes will not be downgraded.</p>
                  : storeHealth.recovered
                    ? <p>Recovered saved profiles from the supported recovery copy. Review them before making further changes.</p>
                    : <p>Profiles are saved only in this browser, after validation and a successful persistent write. No server storage or sync.</p>}
            {storeHealth.ok && Boolean(storeHealth.damagedCopies?.length) && (
              <p>A damaged {storeHealth.damagedCopies!.join(' and ')} browser copy was detected. The usable profiles are shown; damaged bytes have been retained rather than automatically reset.</p>
            )}
            {adapterRef.current?.persistent && !adapterRef.current.withExclusiveWrite && (
              <p>Conflict-safe writes are unavailable in this browser. You may read and draft, but cannot persist changes.</p>
            )}
            <Button type="button" variant="outline" onClick={() => {
              const replacement = createBrowserStoreAdapter()
              if (replacement) {
                const old = adapterRef.current
                if (old && 'destroy' in old && typeof old.destroy === 'function') old.destroy()
                adapterRef.current = replacement
              }
              readStore(adapterRef.current!)
              setAdapterVersion((version) => version + 1)
            }}>Recheck browser storage</Button>
            {!storeHealth.ok && storeHealth.reason === 'both-corrupted' && adapterRef.current?.persistent && (
              <Button type="button" variant="outline" onClick={() => { setOpStatusSafe({ kind: 'idle' }); setPendingReset(true) }} disabled={saveBusy}>Reset corrupt profile store</Button>
            )}
          </div>
        )}

        {externalConflict && (
          <section aria-label="Saved profile conflict" className="mt-4 space-y-3 rounded-md border border-warning bg-input/20 p-3 text-sm">
            <p>Saved profiles changed after this draft began. Your complete draft is retained, including any externally deleted profile. It has not been rebased or saved.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={reviewLatest}>Review latest saved version</Button>
              <Button type="button" variant="outline" onClick={() => requestTransition(() => {
                const result = readStore(adapterRef.current!)
                if (!result.ok) return
                const saved = result.envelope.profiles.find((profile) => profile.id === editingId)
                if (saved) {
                  baseRevisionRef.current = result.envelope.revision
                  editingExistingRef.current = true
                  setEditingId(saved.id)
                  setDraft(structuredClone(saved))
                  hydrateUi(saved)
                  setDirty(false)
                  setExternalConflict(false)
                } else clearEditorState()
                replacementConsentRef.current = false
                setReviewedLatest(null)
                setFieldErrors({})
                setReqFieldErrors({})
                setOpStatusSafe({ kind: 'idle' })
                requestAnimationFrame(saved ? focusDraftName : focusProfileList)
              })}>Reload saved version</Button>
            </div>
            {reviewedLatest && (
              <div className="space-y-2">
                <p>Reviewed saved revision: {reviewedLatest.revision}. Compare both complete configurations before replacing.</p>
                <details><summary>Latest saved profile</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(reviewedLatest.profiles.find((profile) => profile.id === editingId) ?? 'Profile removed in another tab', null, 2)}</pre></details>
                <details><summary>Your unsaved candidate</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(finalPayload, null, 2)}</pre></details>
                {(!editingExistingRef.current || reviewedLatest.profiles.some((profile) => profile.id === editingId)) && (
                  <Button type="button" variant="outline" onClick={acceptReviewedRevision}>Use draft against reviewed revision</Button>
                )}
              </div>
            )}
          </section>
        )}

        {errorEntries.length > 0 && (
          <div ref={summaryRef} role="region" tabIndex={-1} aria-labelledby="profile-errors-heading" className="mt-4 scroll-mt-24 rounded-md border border-destructive bg-destructive/5 p-4 focus:outline-none focus:ring-2 focus:ring-ring">
            <h2 id="profile-errors-heading" className="font-semibold">There is a problem</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {errorEntries.map(({ field, message }) => (
                <li key={field} id={`validation-${field.replace(/\./g, '-')}`}>
                  <a href={`#${FIELD_TO_INPUT_ID[field] ?? 'profile-retained-data'}`} className="text-destructive underline" onClick={(event) => { event.preventDefault(); focusErrorTarget(field) }}>{message}</a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Page-level operation status — ONE region, always mounted while a
            status is active. Lives OUTSIDE the conditional editor/action-bar
            subtrees so a success message survives editor unmount (e.g. the
            draft clearing after a successful delete). Only one status is
            active at a time, so exactly one live region renders here. */}
        {opStatus.kind !== 'idle' && (
          <div
            ref={statusRef}
            tabIndex={-1}
            className={cn(
              'mt-4 scroll-mt-24 rounded-md border px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-ring',
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
                <CardTitle id="profile-list-heading" role="heading" aria-level={2} tabIndex={-1} className="scroll-mt-24 text-base font-semibold focus:outline-none focus:ring-2 focus:ring-ring">
                  Document formatting profiles
                </CardTitle>
                <CardDescription>
                  Duplicate a built-in profile or start with blank formatting and existing APA citation defaults.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Creation actions */}
                <div className="flex flex-col gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto min-h-9 w-full justify-start whitespace-normal border-border text-left text-foreground"
                    disabled={!envelope || creationBusy !== null || saveBusy || recoveryBlocked}
                    onClick={() => requestTransition(() => { void createFrom('copy-suc') })}
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
                    className="h-auto min-h-9 w-full justify-start whitespace-normal border-border text-left text-foreground"
                    disabled={!envelope || creationBusy !== null || saveBusy || recoveryBlocked}
                    onClick={() => requestTransition(() => { void createFrom('copy-apa') })}
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
                    className="h-auto min-h-9 w-full justify-start whitespace-normal border-border text-left text-foreground"
                    disabled={!envelope || creationBusy !== null || saveBusy || recoveryBlocked}
                    onClick={() => requestTransition(() => { void createFrom('blank') })}
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

                <fieldset className="min-w-0 rounded-md border border-border p-3">
                  <legend className="px-1 text-sm font-semibold text-foreground">
                    Built-in profiles
                  </legend>
                  {builtins.length === 0 ? (
                    <p className="py-2 text-sm text-muted-foreground">{loadStatus.state === 'error' ? 'Built-in profiles are unavailable. Copying can be retried when the backend is reachable.' : 'Loading built-in profiles…'}</p>
                  ) : (
                    <ul className="space-y-2">
                      {builtins.map((b) => (
                        <li key={b.profileId}>
                          <div className="rounded-md border border-border bg-input/20 px-3 py-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex min-w-0 flex-wrap items-center gap-2">
                                  <span className="min-w-0 text-sm font-medium text-foreground [overflow-wrap:anywhere]">
                                    {b.name}
                                  </span>
                                  <Badge variant="outline" className="border-border text-muted-foreground">
                                    Built-in
                                  </Badge>
                                </div>
                                <p className="mt-0.5 text-xs leading-[16px] text-muted-foreground [overflow-wrap:anywhere]">
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

                <fieldset className="min-w-0 rounded-md border border-border p-3">
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
                                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                                    <span className="min-w-0 text-sm font-medium text-foreground [overflow-wrap:anywhere]">
                                      {p.name}
                                    </span>
                                    <Badge variant="outline" className="border-border text-muted-foreground">
                                      Custom
                                    </Badge>
                                  </div>
                                  <p className="mt-0.5 text-xs leading-[16px] text-muted-foreground [overflow-wrap:anywhere]">
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
                                  onClick={() => requestTransition(() => openProfile(p.id))}
                                  disabled={isEditing || saveBusy || recoveryBlocked}
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
              <CardHeader className="min-w-0 pb-3">
                <CardTitle id="editor-heading" role="heading" aria-level={2} tabIndex={-1} className="min-w-0 scroll-mt-24 [overflow-wrap:anywhere] text-base font-semibold focus:outline-none focus:ring-2 focus:ring-ring">
                  {selectedBuiltin
                    ? selectedBuiltin.name
                    : draft
                      ? draft.name.trim() || 'New custom profile'
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
                    {PAGE_ELEMENT_CONTROLS.map(({ field, label, notChecked }) => (
                      <details key={field} className="group rounded-md border border-border">
                        <summary className="cursor-pointer list-none rounded-md px-3 py-2.5 text-sm font-semibold text-foreground select-none transition-colors hover:bg-input/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                          <div className="flex items-center justify-between gap-2">
                            <span>{label}</span>
                            <span className="text-xs font-normal text-muted-foreground">Not checked</span>
                          </div>
                        </summary>
                        <div className="space-y-2 px-3 pb-3 pt-1">
                          <p className="text-sm text-muted-foreground">{notChecked}</p>
                          <p className="text-xs leading-[16px] text-muted-foreground">
                            Available only in Custom Profiles. Duplicate this profile to change these requirements.
                          </p>
                          <p className="text-xs leading-[16px] text-muted-foreground">{PAGE_ELEMENTS_HELP_TEXT}</p>
                        </div>
                      </details>
                    ))}
                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                      <Button
                        type="button"
                        variant="outline"
                        className="gap-1.5 border-border text-foreground"
                        onClick={() => requestTransition(() => { void createFrom(selectedBuiltin.profileId === SUC_BUILTIN_ID ? 'copy-suc' : 'copy-apa') })}
                      >
                        <Copy className="h-4 w-4 text-primary" aria-hidden="true" />
                        Duplicate this profile
                      </Button>
                    </div>
                  </div>
                ) : draft ? (
                  <>
                    <fieldset disabled={saveBusy} className="min-w-0 space-y-5">
                    <nav aria-label="Profile editor sections" className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
                      {[
                        ['profile-general', 'General'], ['profile-body', 'Body text'], ['profile-headings', 'Headings'],
                        ['profile-margins', 'Margins'], ['profile-citations', 'Citations'], ['profile-references', 'Reference List'],
                        ['profile-captions', 'Captions'], ['profile-lists', 'Lists'],
                      ].map(([id, label]) => (
                        <a key={id} href={`#${id}`} className="underline underline-offset-2" onClick={(event) => {
                          event.preventDefault()
                          const section = document.getElementById(id)
                          if (section instanceof HTMLDetailsElement) section.open = true
                          section?.scrollIntoView({ block: 'start', behavior: 'instant' })
                          section?.querySelector<HTMLElement>('summary, input')?.focus({ preventScroll: true })
                        }}>{label}</a>
                      ))}
                    </nav>
                    {/* General */}
                    <fieldset id="profile-general" className="scroll-mt-24 rounded-md border border-border p-3">
                      <legend className="px-1 text-sm font-semibold text-foreground">
                        General
                      </legend>
                      <div className="mt-2 space-y-4">
                        <div>
                          <label
                            htmlFor="profile-name"
                            className="text-sm font-medium text-foreground"
                          >
                            Profile name (required)
                          </label>
                          <input
                            id="profile-name"
                            type="text"
                            required
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
                            Description (optional)
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
                            Last confirmed state
                          </span>
                          <div className="mt-1 flex items-center gap-2">
                            {draft.validationState === 'backend_confirmed' ? (
                              <Badge className="bg-secondary/10 text-secondary">
                                <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                                Last saved version validated{dirty ? ' — current draft has unsaved changes' : ''}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="border-border text-muted-foreground">
                                <Info className="h-3 w-3" aria-hidden="true" />
                                {lastSavedProfile ? 'Stored record is not backend-confirmed' : 'Draft — not yet saved'}
                              </Badge>
                            )}
                          </div>
                          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                            Source: {friendlySourceName(draft.sourceId) ?? 'Blank custom profile'}.
                            {' '}Last saved in this browser: {lastSavedProfile ? formatAuditDateTime(lastSavedProfile.updatedAt) : editingExistingRef.current ? 'Saved record removed or unavailable' : 'Not yet saved'}.
                            {dirty && ' Upload continues to use only the last confirmed saved version, never these unsaved changes.'}
                          </p>
                        </div>
                      </div>
                    </fieldset>

                    <details className="rounded-md border border-border p-3">
                      <summary className="cursor-pointer text-sm font-medium">Recorded formatting exemptions and table policy (read-only)</summary>
                      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{RECORDED_ROLE_POLICY_NOTICE}</p>
                      {(() => {
                        const raw = draft.payload.role_policy
                        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
                          return <p className="mt-2 text-sm">Recorded policy: {raw === undefined ? 'Not supplied' : JSON.stringify(raw)}</p>
                        }
                        const policy = raw as Record<string, unknown>
                        const roles = policy.exempt_roles
                        return (
                          <div className="mt-2 space-y-2 text-sm">
                            <p>Recorded table eligibility (not an enforcement control): {policy.table_eligibility === undefined ? 'Not supplied' : JSON.stringify(policy.table_eligibility)}</p>
                            {roles === undefined ? <p>Recorded exemptions: Not supplied</p>
                              : Array.isArray(roles) ? roles.length === 0 ? <p>Recorded exemptions: Empty list</p> : (
                                <ul aria-label="Recorded formatting exemptions" className="list-disc space-y-1 pl-5">
                                  {roles.map((role, index) => <li key={index}>{typeof role === 'string' ? recordedRoleLabel(role) : `Unrecognized role value: ${JSON.stringify(role)}`}</li>)}
                                </ul>
                              ) : <p>Unrecognized exemption collection: {JSON.stringify(roles)}</p>}
                          </div>
                        )
                      })()}
                    </details>

                    {/* ------------------------------------------------------------------ */}
                    {/* Requirements — expand/collapse + real controls (Build 4/5)           */}
                    {/* ------------------------------------------------------------------ */}
                    <div
                      ref={requirementsRootRef}
                      className="space-y-4"
                      role="group"
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
                    <details id="profile-body" className="group scroll-mt-24 rounded-md border border-border" open={allExpanded || undefined}>
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
                          {(() => {
                            const raw = draft.payload.body
                            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
                            const font = raw as Record<string, unknown>
                            if ((font.font_family == null) === (font.font_size_pt == null)) return null
                            return <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Recorded independent body font requirement: family {JSON.stringify(font.font_family ?? null)}, size {JSON.stringify(font.font_size_pt ?? null)} pt. This form is retained read-only even while the paired-font control appears Off; validation still applies. Choose paired font settings explicitly to replace it.</p>
                          })()}
                          {bodyUi?.fontEnabled && (
                            <div className="mt-3 space-y-2" id="body-font-pairs" role="group" aria-label="Accepted font-and-size pairs">
                              {bodyUi.pairs.map((pair, idx) => (
                                <div key={idx} className="flex flex-wrap items-center gap-2">
                                  <input
                                    id={idx === 0 ? 'body-font-pairs-first-family' : `body-font-pair-${idx + 1}-family`}
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
                                    aria-label={`Body text font family for pair ${idx + 1}`}
                                  />
                                  <input
                                    id={`body-font-pair-${idx + 1}-size`}
                                    type="text"
                                    inputMode="decimal"
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
                                    aria-label={`Body text font size in points for pair ${idx + 1}`}
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
                              aria-label="Body text alignment"
                              value={bodyUi.alignment}
                              onChange={(e) => updateBody((u) => ({ ...u, alignment: e.target.value as AlignmentValue }))}
                              className="mt-2 w-full rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none"
                              aria-describedby="body-alignment-hint"
                            >
                              {!ALIGNMENT_SELECT_OPTIONS.some((option) => option.value === bodyUi.alignment) && <option value={bodyUi.alignment}>{bodyUi.alignment || 'No supported alignment selected'}</option>}
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
                                aria-label="Body text line spacing (multiplier)"
                                type="text"
                                inputMode="decimal"
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
                            {' '}Stored value (retained, Not checked): {JSON.stringify((draft.payload.body as Record<string, unknown> | undefined)?.first_line_indent_in ?? null)} in.
                          </p>
                        </div>
                      </div>
                    </details>

                    {/* ------------------------------------------------------------------ */}
                    {/* Heading controls                                                     */}
                    {/* ------------------------------------------------------------------ */}
                    <details id="profile-headings" className="group mt-4 scroll-mt-24 rounded-md border border-border" open={allExpanded || undefined}>
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
                          <div id="heading-font-behavior" tabIndex={-1} className="mt-2 space-y-2" role="radiogroup" aria-label="Heading font behavior">
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
                          {reqFieldErrors['headings.level_1.font'] && (
                            <p role="alert" className="mt-2 text-xs leading-relaxed text-destructive">{reqFieldErrors['headings.level_1.font']}</p>
                          )}
                          {(() => {
                            const raw = draft.payload.heading
                            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
                            const font = raw as Record<string, unknown>
                            if ((font.font_family == null) === (font.font_size_pt == null)) return null
                            return <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Recorded independent heading font requirement: family {JSON.stringify(font.font_family ?? null)}, size {JSON.stringify(font.font_size_pt ?? null)} pt. It is retained read-only, not disabled by the pair editor’s projection; validation still applies. Choose explicit paired font settings to replace it.</p>
                          })()}
                          {headingUi?.fontBehavior === 'explicit' && (
                            <div className="mt-3 space-y-2">
                              {headingUi.pairs.map((pair, idx) => (
                                <div key={idx} className="flex flex-wrap items-center gap-2">
                                  <input
                                    id={idx === 0 ? 'heading-font-pairs-first-family' : `heading-font-pair-${idx + 1}-family`}
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
                                    id={`heading-font-pair-${idx + 1}-size`}
                                    type="text"
                                    inputMode="decimal"
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
                                    updateHeading((u) => idx === 0
                                      ? { ...u, level1: { ...u.level1, bold: e.target.checked } }
                                      : idx === 1 ? { ...u, level2: { ...u.level2, bold: e.target.checked } }
                                        : { ...u, level3: { ...u.level3, bold: e.target.checked } })
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
                                    updateHeading((u) => idx === 0
                                      ? { ...u, level1: { ...u.level1, italic: e.target.checked } }
                                      : idx === 1 ? { ...u, level2: { ...u.level2, italic: e.target.checked } }
                                        : { ...u, level3: { ...u.level3, italic: e.target.checked } })
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

                    {PAGE_ELEMENT_CONTROLS.map(({ field, label, toggleLabel, inputId, errorField }) => {
                      const enabled = pageElementsModel[field]
                      const error = reqFieldErrors[errorField]
                      return (
                        <details key={field} className="group mt-4 rounded-md border border-border" open={allExpanded || undefined}>
                          <summary className="cursor-pointer list-none rounded-md px-3 py-2.5 text-sm font-semibold text-foreground select-none transition-colors hover:bg-input/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                            <div className="flex items-center justify-between gap-2">
                              <span>{label}</span>
                              <span className="ml-auto text-right text-xs font-normal text-muted-foreground">
                                {enabled ? 'Enabled · Manual review only (unscored)' : 'Not checked'}
                              </span>
                              <svg className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                              </svg>
                            </div>
                          </summary>
                          <div className="space-y-3 px-3 pb-3 pt-1">
                            <label className="flex min-h-[44px] items-start gap-2 rounded-md border border-border px-3 py-2">
                              <input
                                id={inputId}
                                type="checkbox"
                                className="mt-0.5 h-4 w-4 accent-primary"
                                checked={enabled}
                                aria-describedby={`${inputId}-hint${error ? ` ${inputId}-error` : ''}`}
                                aria-invalid={Boolean(error)}
                                onChange={(e) => updatePageElements({ [field]: e.target.checked })}
                              />
                              <span className="text-sm text-foreground">{toggleLabel}</span>
                            </label>
                            <p id={`${inputId}-hint`} className="text-xs leading-[16px] text-muted-foreground">
                              {PAGE_ELEMENTS_HELP_TEXT}
                            </p>
                            {error && (
                              <p id={`${inputId}-error`} role="alert" className="text-xs text-destructive">{error}</p>
                            )}
                            {field === 'pageNumberEnabled' && enabled && (
                              <div className="space-y-1">
                                <label htmlFor="page-numbers-placement" className="block text-sm text-foreground">
                                  PAGE field placement
                                </label>
                                <select
                                  id="page-numbers-placement"
                                  value={pageElementsModel.placement}
                                  onChange={(e) => updatePageElements({ placement: e.target.value as PageElementsUiModel['placement'] })}
                                  className="w-full max-w-xs rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none"
                                  aria-describedby={reqFieldErrors['page_numbers.placement'] ? 'page-numbers-placement-error' : undefined}
                                  aria-invalid={Boolean(reqFieldErrors['page_numbers.placement'])}
                                >
                                  <option value="header">Header</option>
                                  <option value="footer">Footer</option>
                                  <option value="either">Either</option>
                                </select>
                                {reqFieldErrors['page_numbers.placement'] && (
                                  <p id="page-numbers-placement-error" role="alert" className="text-xs text-destructive">
                                    {reqFieldErrors['page_numbers.placement']}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        </details>
                      )
                    })}
                    </div>{/* end requirements wrapper */}

                    {/* ------------------------------------------------------------------ */}
                    {/* Margin controls                                                      */}
                    {/* ------------------------------------------------------------------ */}
                    <details id="profile-margins" className="group mt-4 scroll-mt-24 rounded-md border border-border" open={allExpanded || undefined}>
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
                              onClick={() => updateMargins((previous) => ({ ...previous, ...applyMarginPreset(preset) }))}
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
                                      aria-label={`${MARGIN_SIDE_LABELS[side]} margin (inches)`}
                                      type="text"
                                      inputMode="decimal"
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
                    {/* Citations and References controls                                    */}
                    {/* ------------------------------------------------------------------ */}
                    <details id="profile-citations" className="group mt-4 scroll-mt-24 rounded-md border border-border" open={allExpanded || undefined}>
                      <summary className="cursor-pointer list-none rounded-md px-3 py-2.5 text-sm font-semibold text-foreground select-none transition-colors hover:bg-input/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                        <div className="flex items-center justify-between">
                          <span>Citations and References</span>
                          <svg className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </div>
                      </summary>
                      <div className="space-y-3 px-3 pb-3 pt-1">
                        <p className="text-xs leading-[16px] text-muted-foreground">
                          These checks compare in-text citations with the Reference List using
                          deterministic rules. They compare author surnames and years only —
                          they never rewrite the document and never confirm that a source is real.
                        </p>

                        <div className="space-y-2">
                          {CITATION_CONTROL_ROWS.map(({ field, label, hint, dependent }) => {
                            const checked = citationModel[field]
                            const parentOff = !citationModel.check_citations_have_references
                            const disabled = Boolean(dependent) && parentOff
                            const describedBy = `${CITATION_INPUT_IDS[field]}-hint`
                            return (
                              <label
                                key={field}
                                className={cn(
                                  'flex items-start gap-2 rounded-md border border-border px-3 py-2',
                                  disabled && 'opacity-60',
                                )}
                              >
                                <input
                                  id={CITATION_INPUT_IDS[field]}
                                  type="checkbox"
                                  className="mt-0.5 h-4 w-4 accent-primary"
                                  checked={checked}
                                  disabled={disabled}
                                  aria-describedby={describedBy}
                                  onChange={(e) => updateCitation(field, e.target.checked)}
                                />
                                <span>
                                  <span className="block text-sm text-foreground">{label}</span>
                                  <span
                                    id={describedBy}
                                    className="mt-0.5 block text-xs leading-[16px] text-muted-foreground"
                                  >
                                    {disabled
                                      ? `${hint} Requires “Check in-text citations against the Reference List”.`
                                      : hint}
                                  </span>
                                </span>
                              </label>
                            )
                          })}
                        </div>

                        {reqFieldErrors['citation_matching.check_citations_have_references'] && (
                          <p role="alert" className="text-xs text-destructive">
                            {reqFieldErrors['citation_matching.check_citations_have_references']}
                          </p>
                        )}
                      </div>
                    </details>

                    {/* ------------------------------------------------------------------ */}
                    {/* Reference List controls                                              */}
                    {/* ------------------------------------------------------------------ */}
                    <details id="profile-references" className="group mt-4 scroll-mt-24 rounded-md border border-border" open={allExpanded || undefined}>
                      <summary className="cursor-pointer list-none rounded-md px-3 py-2.5 text-sm font-semibold text-foreground select-none transition-colors hover:bg-input/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                        <div className="flex items-center justify-between">
                          <span>Reference List</span>
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
                          A value can only be edited while its check is on.
                        </p>
                        {(() => {
                          const missing = [
                            [referenceModel.headingTextEnabled, referenceModel.headingText, 'heading text'],
                            [referenceModel.headingAlignmentEnabled, referenceModel.headingAlignment, 'heading alignment'],
                            [referenceModel.hangingIndentEnabled, referenceModel.hangingIndent, 'hanging indent'],
                            [referenceModel.lineSpacingEnabled, referenceModel.lineSpacing, 'line spacing'],
                            [referenceModel.spaceBeforeEnabled, referenceModel.spaceBefore, 'space before'],
                            [referenceModel.spaceAfterEnabled, referenceModel.spaceAfter, 'space after'],
                            [referenceModel.fontFamilyEnabled, referenceModel.fontFamily, 'font family'],
                            [referenceModel.fontSizeEnabled, referenceModel.fontSize, 'font size'],
                            [referenceModel.alignmentEnabled, referenceModel.alignment, 'entry alignment'],
                          ].filter(([enabled, value]) => enabled && !value).map(([, , label]) => label)
                          return missing.length ? <p className="rounded-md border border-border p-2 text-xs text-muted-foreground">Enabled without a supported comparison value: {missing.join(', ')}. These configured checks cannot compare that value until one is supplied; enabling alone does not mean a check ran. Values remain optional under the existing validation contract.</p> : null
                        })()}

                        {/* Heading text */}
                        <div className="rounded-md border border-border p-3">
                          <label htmlFor="references-check-heading-text" className="flex items-start gap-2">
                            <input
                              id="references-check-heading-text"
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 accent-primary"
                              checked={referenceModel.headingTextEnabled}
                              aria-describedby="references-check-heading-text-hint"
                              onChange={(e) => updateReferences((u) => ({
                                ...u,
                                headingTextEnabled: e.target.checked,
                              }))}
                            />
                            <span className="text-sm text-foreground">Check Reference List heading text</span>
                          </label>
                          <p id="references-check-heading-text-hint" className="mt-1 text-xs leading-[16px] text-muted-foreground">
                            Flags a Reference List heading that uses different wording.
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <label htmlFor="references-heading-text" className="text-sm text-foreground">
                              Required heading text
                            </label>
                            <select
                              id="references-heading-text"
                              value={referenceModel.headingText}
                              disabled={!referenceModel.headingTextEnabled}
                              aria-describedby="references-check-heading-text-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, headingText: e.target.value as ReferenceHeadingText }))}
                              className="w-full max-w-xs rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {!referenceModel.headingText && <option value="">Unsupported or unset stored heading — choose explicitly to replace it</option>}
                              {REFERENCE_HEADING_TEXT_OPTIONS.map((option) => (
                                <option key={option} value={option}>
                                  {REFERENCE_HEADING_TEXT_LABELS[option]}
                                </option>
                              ))}
                            </select>
                          </div>
                          <label
                            htmlFor="references-allow-heading-aliases"
                            className={cn(
                              'mt-2 flex items-start gap-2',
                              !referenceModel.headingTextEnabled && 'opacity-60',
                            )}
                          >
                            <input
                              id="references-allow-heading-aliases"
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 accent-primary"
                              checked={referenceModel.allowHeadingAliases}
                              disabled={!referenceModel.headingTextEnabled}
                              aria-describedby="references-allow-heading-aliases-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, allowHeadingAliases: e.target.checked }))}
                            />
                            <span className="text-sm text-foreground">Allow common heading alternatives</span>
                          </label>
                          <p id="references-allow-heading-aliases-hint" className="mt-1 text-xs leading-[16px] text-muted-foreground">
                            Also accepts “Works Cited” and “Bibliography” as the heading. Requires the heading-text check.
                          </p>
                          {reqFieldErrors['references.heading_text'] && (
                            <p role="alert" className="mt-1 text-xs text-destructive">
                              {reqFieldErrors['references.heading_text']}
                            </p>
                          )}
                        </div>

                        {/* Heading bold */}
                        <div className="rounded-md border border-border p-3">
                          <label htmlFor="references-check-heading-bold" className="flex items-start gap-2">
                            <input
                              id="references-check-heading-bold"
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 accent-primary"
                              checked={referenceModel.headingBoldEnabled}
                              aria-describedby="references-check-heading-bold-hint"
                              onChange={(e) => updateReferences((u) => ({
                                ...u,
                                headingBoldEnabled: e.target.checked,
                              }))}
                            />
                            <span className="text-sm text-foreground">Check heading bold or regular state</span>
                          </label>
                          <p id="references-check-heading-bold-hint" className="mt-1 text-xs leading-[16px] text-muted-foreground">
                            Off means the heading’s bold or regular state is not checked.
                          </p>
                          <label htmlFor="references-heading-bold-value" className="mt-2 block text-sm">Required heading state</label>
                          <select id="references-heading-bold-value" value={referenceModel.headingBold ? 'bold' : 'regular'} disabled={!referenceModel.headingBoldEnabled}
                            className="mt-1 w-full max-w-xs rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none"
                            onChange={(event) => updateReferences((previous) => ({ ...previous, headingBold: event.target.value === 'bold' }))}>
                            <option value="bold">Bold</option><option value="regular">Regular (not bold)</option>
                          </select>
                        </div>

                        {/* Heading alignment */}
                        <div className="rounded-md border border-border p-3">
                          <label htmlFor="references-heading-alignment-enabled" className="flex items-start gap-2">
                            <input
                              id="references-heading-alignment-enabled"
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 accent-primary"
                              checked={referenceModel.headingAlignmentEnabled}
                              aria-describedby="references-check-heading-alignment-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, headingAlignmentEnabled: e.target.checked }))}
                            />
                            <span className="text-sm text-foreground">Check heading alignment</span>
                          </label>
                          <p id="references-check-heading-alignment-hint" className="mt-1 text-xs leading-[16px] text-muted-foreground">
                            Off means heading alignment is not checked.
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <label htmlFor="references-heading-alignment" className="text-sm text-foreground">
                              Heading alignment
                            </label>
                            <select
                              id="references-heading-alignment"
                              value={referenceModel.headingAlignment}
                              disabled={!referenceModel.headingAlignmentEnabled}
                              aria-describedby="references-check-heading-alignment-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, headingAlignment: e.target.value as AlignmentValue }))}
                              className="w-full max-w-xs rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <option value="">Choose an alignment</option>
                              {ALIGNMENT_SELECT_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                              ))}
                            </select>
                          </div>
                          {reqFieldErrors['references.heading_alignment'] && (
                            <p role="alert" className="mt-1 text-xs text-destructive">
                              {reqFieldErrors['references.heading_alignment']}
                            </p>
                          )}
                        </div>

                        {/* Section start */}
                        <label htmlFor="references-check-start-on-new-page" className="flex items-start gap-2 rounded-md border border-border px-3 py-2">
                          <input
                            id="references-check-start-on-new-page"
                            type="checkbox"
                            className="mt-0.5 h-4 w-4 accent-primary"
                            checked={referenceModel.startOnNewPageEnabled}
                            aria-describedby="references-check-start-on-new-page-hint"
                            onChange={(e) => updateReferences((u) => ({ ...u, startOnNewPageEnabled: e.target.checked }))}
                          />
                          <span>
                            <span className="block text-sm text-foreground">Start References on a new page</span>
                            <span id="references-check-start-on-new-page-hint" className="mt-0.5 block text-xs leading-[16px] text-muted-foreground">
                              Flags a Reference List that shares a page with the text above it.
                            </span>
                          </span>
                        </label>

                        {/* Hanging indent */}
                        <div className="rounded-md border border-border p-3">
                          <label htmlFor="references-check-hanging-indent" className="flex items-start gap-2">
                            <input
                              id="references-check-hanging-indent"
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 accent-primary"
                              checked={referenceModel.hangingIndentEnabled}
                              aria-describedby="references-check-hanging-indent-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, hangingIndentEnabled: e.target.checked }))}
                            />
                            <span className="text-sm text-foreground">Check hanging indent</span>
                          </label>
                          <p id="references-check-hanging-indent-hint" className="mt-1 text-xs leading-[16px] text-muted-foreground">
                            The first line sits flush left and the lines that follow are indented. Range: 0–4.0 in.
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <label htmlFor="references-hanging-indent" className="text-sm text-foreground">
                              Indent following lines by
                            </label>
                            <input
                              id="references-hanging-indent"
                              type="text"
                              inputMode="decimal"
                              min={0}
                              max={4}
                              step={0.05}
                              value={referenceModel.hangingIndent}
                              disabled={!referenceModel.hangingIndentEnabled}
                              aria-describedby="references-check-hanging-indent-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, hangingIndent: e.target.value }))}
                              className="w-24 rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                            />
                            <span className="text-sm text-muted-foreground">in</span>
                          </div>
                          {reqFieldErrors['references.hanging_indent_in'] && (
                            <p role="alert" className="mt-1 text-xs text-destructive">
                              {reqFieldErrors['references.hanging_indent_in']}
                            </p>
                          )}
                        </div>

                        {/* Line spacing */}
                        <div className="rounded-md border border-border p-3">
                          <label htmlFor="references-check-line-spacing" className="flex items-start gap-2">
                            <input
                              id="references-check-line-spacing"
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 accent-primary"
                              checked={referenceModel.lineSpacingEnabled}
                              aria-describedby="references-check-line-spacing-hint"
                              onChange={(event) => {
                                const enabled = event.target.checked
                                updateReferences((previous) => ({ ...previous, lineSpacingEnabled: enabled }))
                                setDraft((previous) => {
                                  if (!previous) return previous
                                  const raw = previous.payload.references
                                  const references = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
                                  return { ...previous, payload: { ...previous.payload, references: { ...references, check_line_spacing: enabled } } }
                                })
                              }}
                            />
                            <span className="text-sm text-foreground">Check Reference List line spacing</span>
                          </label>
                          <p id="references-check-line-spacing-hint" className="mt-1 text-xs leading-[16px] text-muted-foreground">
                            Range: 1.0–4.0. Off means reference line spacing is not checked.
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <label htmlFor="references-line-spacing" className="text-sm text-foreground">
                              Line spacing
                            </label>
                            <input
                              id="references-line-spacing"
                              type="text"
                              inputMode="decimal"
                              min={1}
                              max={4}
                              step={0.1}
                              value={referenceModel.lineSpacing}
                              disabled={!referenceModel.lineSpacingEnabled}
                              aria-describedby="references-check-line-spacing-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, lineSpacing: e.target.value }))}
                              className="w-24 rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                            />
                            <span className="text-sm text-muted-foreground">× (multiplier)</span>
                          </div>
                          {reqFieldErrors['references.line_spacing'] && (
                            <p role="alert" className="mt-1 text-xs text-destructive">
                              {reqFieldErrors['references.line_spacing']}
                            </p>
                          )}
                        </div>

                        {/* Space before / after */}
                        <div className="rounded-md border border-border p-3">
                          <label htmlFor="references-check-space-before" className="flex items-start gap-2">
                            <input
                              id="references-check-space-before"
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 accent-primary"
                              checked={referenceModel.spaceBeforeEnabled}
                              aria-describedby="references-check-space-before-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, spaceBeforeEnabled: e.target.checked }))}
                            />
                            <span className="text-sm text-foreground">Check space before each entry</span>
                          </label>
                          <p id="references-check-space-before-hint" className="mt-1 text-xs leading-[16px] text-muted-foreground">
                            Range: 0–240 pt.
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <label htmlFor="references-space-before" className="text-sm text-foreground">
                              Space before
                            </label>
                            <input
                              id="references-space-before"
                              type="text"
                              inputMode="decimal"
                              min={0}
                              max={240}
                              step={1}
                              value={referenceModel.spaceBefore}
                              disabled={!referenceModel.spaceBeforeEnabled}
                              aria-describedby="references-check-space-before-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, spaceBefore: e.target.value }))}
                              className="w-24 rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                            />
                            <span className="text-sm text-muted-foreground">pt</span>
                          </div>
                          {reqFieldErrors['references.space_before_pt'] && (
                            <p role="alert" className="mt-1 text-xs text-destructive">
                              {reqFieldErrors['references.space_before_pt']}
                            </p>
                          )}

                          <label htmlFor="references-check-space-after" className="mt-3 flex items-start gap-2">
                            <input
                              id="references-check-space-after"
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 accent-primary"
                              checked={referenceModel.spaceAfterEnabled}
                              aria-describedby="references-check-space-after-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, spaceAfterEnabled: e.target.checked }))}
                            />
                            <span className="text-sm text-foreground">Check space after each entry</span>
                          </label>
                          <p id="references-check-space-after-hint" className="mt-1 text-xs leading-[16px] text-muted-foreground">
                            Range: 0–240 pt.
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <label htmlFor="references-space-after" className="text-sm text-foreground">
                              Space after
                            </label>
                            <input
                              id="references-space-after"
                              type="text"
                              inputMode="decimal"
                              min={0}
                              max={240}
                              step={1}
                              value={referenceModel.spaceAfter}
                              disabled={!referenceModel.spaceAfterEnabled}
                              aria-describedby="references-check-space-after-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, spaceAfter: e.target.value }))}
                              className="w-24 rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                            />
                            <span className="text-sm text-muted-foreground">pt</span>
                          </div>
                          {reqFieldErrors['references.space_after_pt'] && (
                            <p role="alert" className="mt-1 text-xs text-destructive">
                              {reqFieldErrors['references.space_after_pt']}
                            </p>
                          )}
                        </div>

                        {/* Font family */}
                        <div className="rounded-md border border-border p-3">
                          <label htmlFor="references-check-font-family" className="flex items-start gap-2">
                            <input
                              id="references-check-font-family"
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 accent-primary"
                              checked={referenceModel.fontFamilyEnabled}
                              aria-describedby="references-check-font-family-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, fontFamilyEnabled: e.target.checked }))}
                            />
                            <span className="text-sm text-foreground">Check Reference List font family</span>
                          </label>
                          <p id="references-check-font-family-hint" className="mt-1 text-xs leading-[16px] text-muted-foreground">
                            Flags an entry set in a different font from the one you name.
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <label htmlFor="references-font-family" className="text-sm text-foreground">
                              Font family
                            </label>
                            <input
                              id="references-font-family"
                              type="text"
                              value={referenceModel.fontFamily}
                              disabled={!referenceModel.fontFamilyEnabled}
                              aria-describedby="references-check-font-family-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, fontFamily: e.target.value }))}
                              className="w-full max-w-xs rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                            />
                          </div>
                          {reqFieldErrors['references.font_family'] && (
                            <p role="alert" className="mt-1 text-xs text-destructive">
                              {reqFieldErrors['references.font_family']}
                            </p>
                          )}
                        </div>

                        {/* Font size */}
                        <div className="rounded-md border border-border p-3">
                          <label htmlFor="references-check-font-size" className="flex items-start gap-2">
                            <input
                              id="references-check-font-size"
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 accent-primary"
                              checked={referenceModel.fontSizeEnabled}
                              aria-describedby="references-check-font-size-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, fontSizeEnabled: e.target.checked }))}
                            />
                            <span className="text-sm text-foreground">Check Reference List font size</span>
                          </label>
                          <p id="references-check-font-size-hint" className="mt-1 text-xs leading-[16px] text-muted-foreground">
                            Range: 6–72 pt.
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <label htmlFor="references-font-size" className="text-sm text-foreground">
                              Font size
                            </label>
                            <input
                              id="references-font-size"
                              type="text"
                              inputMode="decimal"
                              min={6}
                              max={72}
                              step={0.5}
                              value={referenceModel.fontSize}
                              disabled={!referenceModel.fontSizeEnabled}
                              aria-describedby="references-check-font-size-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, fontSize: e.target.value }))}
                              className="w-24 rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                            />
                            <span className="text-sm text-muted-foreground">pt</span>
                          </div>
                          {reqFieldErrors['references.font_size_pt'] && (
                            <p role="alert" className="mt-1 text-xs text-destructive">
                              {reqFieldErrors['references.font_size_pt']}
                            </p>
                          )}
                        </div>

                        {/* Entry alignment */}
                        <div className="rounded-md border border-border p-3">
                          <label htmlFor="references-check-alignment" className="flex items-start gap-2">
                            <input
                              id="references-check-alignment"
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 accent-primary"
                              checked={referenceModel.alignmentEnabled}
                              aria-describedby="references-check-alignment-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, alignmentEnabled: e.target.checked }))}
                            />
                            <span className="text-sm text-foreground">Check Reference List paragraph alignment</span>
                          </label>
                          <p id="references-check-alignment-hint" className="mt-1 text-xs leading-[16px] text-muted-foreground">
                            Off means entry alignment is not checked.
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <label htmlFor="references-alignment" className="text-sm text-foreground">
                              Paragraph alignment
                            </label>
                            <select
                              id="references-alignment"
                              value={referenceModel.alignment}
                              disabled={!referenceModel.alignmentEnabled}
                              aria-describedby="references-check-alignment-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, alignment: e.target.value as AlignmentValue }))}
                              className="w-full max-w-xs rounded-md border border-border bg-white px-3 py-1.5 text-sm focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <option value="">Choose an alignment</option>
                              {ALIGNMENT_SELECT_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                              ))}
                            </select>
                          </div>
                          {reqFieldErrors['references.alignment'] && (
                            <p role="alert" className="mt-1 text-xs text-destructive">
                              {reqFieldErrors['references.alignment']}
                            </p>
                          )}
                        </div>

                        {/* Alphabetical order */}
                        <div className="rounded-md border border-border p-3">
                          <label htmlFor="references-check-reference-order" className="flex items-start gap-2">
                            <input
                              id="references-check-reference-order"
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 accent-primary"
                              checked={referenceModel.referenceOrderEnabled}
                              aria-describedby="references-check-reference-order-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, referenceOrderEnabled: e.target.checked }))}
                            />
                            <span className="text-sm text-foreground">Check Reference List alphabetical order</span>
                          </label>
                          <p id="references-check-reference-order-hint" className="mt-1 text-xs leading-[16px] text-muted-foreground">
                            Checks adjacent Reference List entries when both author identities can be determined reliably. Ambiguous or unsupported entries are skipped.
                          </p>
                        </div>

                        {/* Visible DOI presentation */}
                        <div className="rounded-md border border-border p-3">
                          <label htmlFor="references-check-doi-format" className="flex items-start gap-2">
                            <input
                              id="references-check-doi-format"
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 accent-primary"
                              checked={referenceModel.doiFormatEnabled}
                              aria-describedby="references-check-doi-format-hint"
                              onChange={(e) => updateReferences((u) => ({ ...u, doiFormatEnabled: e.target.checked }))}
                            />
                            <span className="text-sm text-foreground">Check Reference DOI format</span>
                          </label>
                          <p id="references-check-doi-format-hint" className="mt-1 text-xs leading-[16px] text-muted-foreground">
                            Checks clear visible legacy DOI presentations in Reference entries. ACA checks presentation only and does not verify registration or resolution.
                          </p>
                        </div>
                      </div>
                    </details>

                    {/* ------------------------------------------------------------------ */}
                    {/* Captions controls                                                     */}
                    {/* ------------------------------------------------------------------ */}
                    <details id="profile-captions" className="group mt-4 scroll-mt-24 rounded-md border border-border" open={allExpanded || undefined}>
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
                    <details id="profile-lists" className="group mt-4 scroll-mt-24 rounded-md border border-border" open={allExpanded || undefined}>
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
                      const summary = summarizeProfile(finalPayload ?? draft.payload)
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
                              Off requirements are not checked. Manual review requirements are unscored.
                            </li>
                          </ul>
                        </div>
                      )
                    })()}

                    <details className="rounded-md border border-border p-3">
                      <summary id="profile-retained-data" tabIndex={-1} className="scroll-mt-24 cursor-pointer text-sm font-medium focus:outline-none focus:ring-2 focus:ring-ring">Retained original profile data (read-only)</summary>
                      <p className="mt-2 text-xs text-muted-foreground">Unedited values, unsupported settings and nested metadata are retained. A displayed default is not a correction. Unknown data must pass validation before replacing any confirmed save.</p>
                      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(draft.payload, null, 2)}</pre>
                    </details>
                    </fieldset>

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
                              aria-disabled={saveBusy || !dirty}
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
                        disabled={saveBusy || recoveryBlocked}
                        onClick={() => requestTransition(() => { void createFrom('blank') })}
                      >
                        <Plus className="mr-2 h-4 w-4 text-primary" aria-hidden="true" />
                        Start with blank formatting
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
          description="Save and continue only after a persistent Save, discard these unsaved changes, or continue editing."
          confirmLabel="Discard changes"
          cancelLabel="Continue editing"
          secondaryLabel="Save and continue"
          onSecondary={() => { void saveAndGo() }}
          busy={saveBusy}
          details={recoveryNotice?.includes('could not be cleared') ? <p role="alert" className="text-destructive">{recoveryNotice}</p> : undefined}
          fallbackFocusId="editor-heading"
          confirmVariant="destructive"
          onConfirm={discardAndGo}
          onCancel={cancelLeave}
        />
      )}

      {pendingReset && (
        <ConfirmDialog
          title="Reset corrupt profile store?"
          description="Neither saved profile copy is usable. This explicitly replaces only this browser’s corrupt custom-profile store with an empty store and the recommended built-in selection. The corrupt bytes will be lost. Unsaved drafts and completed audits are not deleted. A newer-version store can never be reset here."
          confirmLabel="Reset corrupt store"
          cancelLabel="Keep stored data"
          confirmVariant="destructive"
          busy={resetting}
          details={opStatus.kind === 'error' ? <p role="alert" className="text-destructive">{opStatus.message}</p> : undefined}
          fallbackFocusId="profile-list-heading"
          onConfirm={() => { void confirmReset() }}
          onCancel={() => { if (!resetting) setPendingReset(false) }}
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
          details={opStatus.kind === 'error' ? <p role="alert" className="text-destructive">{opStatus.message}</p> : undefined}
          fallbackFocusId="profile-list-heading"
          onConfirm={() => void confirmDelete()}
          onCancel={cancelDelete}
        />
      )}
    </div>
  )
}
