/**
 * Custom Profile Editor (Build 3) — editor shell, profile list, creation
 * paths, and backend-gated save.
 *
 * Scope for this Build:
 *   - view built-in and saved custom profiles;
 *   - duplicate SUC Academic Report / APA 7 Student Paper;
 *   - create a safe blank custom profile;
 *   - edit custom profile name + description;
 *   - save ONLY after POST /api/formatting-profiles/validate succeeds;
 *   - return to the upload workflow.
 *
 * Deliberately deferred (Build 4+): Body / Heading / Margin / References /
 * Caption / List controls (shown as disabled placeholders here), deletion
 * (Build 7), and upload-selector integration (Build 6). The editor is a
 * dedicated route — never a full-page modal.
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
  APA_BUILTIN_ID,
  SUC_BUILTIN_ID,
  CITATION_STYLE,
  CREATION_LABELS,
  DEFAULT_PROFILE_NAMES,
  MAX_DESCRIPTION_LENGTH,
  blankProfilePayload,
  buildSavePayload,
  clientValidate,
  copyProfilePayload,
  friendlySourceName,
  generateProfileId,
  loadEnvelope,
  createMemoryStoreAdapter,
  persistEnvelope,
  resolveUniqueName,
  upsertAndBump,
  type CreationKind,
  type StoreAdapter,
  type StoreEnvelope,
  type StoredCustomProfile,
} from '../lib/custom-profile-store/editor'
import { createBrowserStoreAdapter } from '../lib/custom-profile-store/localstorage-adapter'
import { cn } from '../lib/utils'

interface BuiltinViewModel {
  profileId: string
  name: string
  description: string
  sourceName: string
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
  const [saveStatus, setSaveStatus] = React.useState<
    { kind: 'idle' } | { kind: 'validating' } | { kind: 'saved' } | { kind: 'error'; message: string } | { kind: 'backend-error'; errors: string[] }
  >({ kind: 'idle' })
  const [pendingNavigation, setPendingNavigation] = React.useState<null | { to: string }>(null)

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
        setSaveStatus({ kind: 'idle' })
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
      setSaveStatus({ kind: 'idle' })
    },
    [envelope],
  )

  const updateDraft = (patch: Partial<Pick<StoredCustomProfile, 'name' | 'description'>>) => {
    setDraft((prev) => {
      if (!prev) return prev
      return { ...prev, ...patch }
    })
    setDirty(true)
    setSaveStatus({ kind: 'idle' })
  }

  // ---------------------------------------------------------------------
  // Save (backend-gated)
  // ---------------------------------------------------------------------

  const saveProfile = React.useCallback(async () => {
    if (!draft || !envelope) return
    const clientErrors = clientValidate(draft, envelope)
    if (clientErrors.length > 0) {
      setFieldErrors({
        name: clientErrors.some((e) => e.field === 'general.name')
          ? clientErrors.find((e) => e.field === 'general.name')!.message
          : undefined,
        description: clientErrors.some((e) => e.field === 'general.description')
          ? clientErrors.find((e) => e.field === 'general.description')!.message
          : undefined,
      })
      setSaveStatus({ kind: 'error', message: 'Fix the highlighted fields and try again.' })
      return
    }
    setFieldErrors({})
    setSaveStatus({ kind: 'validating' })
    try {
      const result = await api.validateCustomProfile(buildSavePayload(draft))
      if (result.valid) {
        // Backend-confirmed normalized payload replaces the local payload.
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
          // Stale write refusal (another tab). Never overwrite the newer
          // version; keep the draft.
          setEnvelope(loadEnvelope(adapterRef.current!))
          setSaveStatus({
            kind: 'error',
            message: 'This profile was updated in another tab. Reload before saving.',
          })
          return
        }
        setEnvelope(next)
        setDraft(confirmed)
        setDirty(false)
        setSaveStatus({ kind: 'saved' })
      } else if ('errors' in result) {
        const nameErr = result.errors.find((e) => e.field === 'general.name')
        const descErr = result.errors.find((e) => e.field === 'general.description')
        setFieldErrors({
          name: nameErr?.message,
          description: descErr?.message,
        })
        setSaveStatus({
          kind: 'backend-error',
          errors: result.errors.map((e) => e.message),
        })
      } else {
        setSaveStatus({
          kind: 'error',
          message: 'The profile could not be validated. Please try again.',
        })
      }
    } catch {
      setSaveStatus({
        kind: 'error',
        message: 'The profile could not be validated. Please try again.',
      })
    }
  }, [draft, envelope])

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
        className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8"
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
                                    Last updated {formatAuditDateTime(p.updatedAt)}
                                  </p>
                                </div>
                              </div>
                              <div className="mt-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="gap-1.5 border-border text-foreground"
                                  onClick={() => openProfile(p.id)}
                                  disabled={isEditing}
                                >
                                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                                  {isEditing ? 'Editing' : 'Edit'}
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

                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div>
                            <span className="text-sm font-medium text-foreground">
                              Citation style
                            </span>
                            <div className="mt-1 rounded-md border border-border bg-input/20 px-3 py-2 text-sm text-muted-foreground">
                              {CITATION_STYLE}
                              <span className="ml-2 text-xs">(non-selectable)</span>
                            </div>
                          </div>
                          <div>
                            <span className="text-sm font-medium text-foreground">
                              Source profile
                            </span>
                            <div className="mt-1 rounded-md border border-border bg-input/20 px-3 py-2 text-sm text-muted-foreground">
                              {friendlySourceName(draft.sourceId) ?? 'Custom profile'}
                            </div>
                          </div>
                        </div>

                        <div>
                          <span className="text-sm font-medium text-foreground">
                            Validation state
                          </span>
                          <div className="mt-1 flex items-center gap-2">
                            {draft.validationState === 'backend_confirmed' ? (
                              <Badge className="bg-secondary/10 text-secondary">
                                <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                                Backend confirmed
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="border-border text-muted-foreground">
                                <Info className="h-3 w-3" aria-hidden="true" />
                                Not yet saved
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    </fieldset>

                    {/* Requirements placeholders (Build 4+) */}
                    <fieldset className="rounded-md border border-border p-3">
                      <legend className="px-1 text-sm font-semibold text-foreground">
                        Requirements
                      </legend>
                      <p className="mt-1 text-xs leading-[16px] text-muted-foreground">
                        Detailed formatting requirements are configured in the next setup step.
                      </p>
                      <ul className="mt-3 space-y-2">
                        {['Body text', 'Headings', 'Margins', 'References', 'Captions and lists'].map(
                          (label) => (
                            <li
                              key={label}
                              className="rounded-md border border-dashed border-border bg-input/10 px-3 py-2.5 text-sm text-muted-foreground"
                              aria-disabled="true"
                            >
                              {label}
                              <span className="mt-0.5 block text-xs leading-[16px]">
                                Available in the next setup step
                              </span>
                            </li>
                          ),
                        )}
                      </ul>
                    </fieldset>

                    {/* Save */}
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-center gap-2" aria-live="polite">
                        {saveStatus.kind === 'saved' && (
                          <span className="flex items-center gap-1.5 text-sm font-medium text-secondary">
                            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                            Custom profile saved
                          </span>
                        )}
                        {saveStatus.kind === 'validating' && (
                          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            Validating…
                          </span>
                        )}
                        {saveStatus.kind === 'error' && (
                          <span className="flex items-start gap-1.5 text-sm leading-[21px] text-destructive">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            {saveStatus.message}
                          </span>
                        )}
                        {saveStatus.kind === 'backend-error' && (
                          <span className="flex items-start gap-1.5 text-sm leading-[21px] text-destructive">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            The profile did not pass validation.
                          </span>
                        )}
                      </div>
                      <Button
                        type="button"
                        onClick={() => void saveProfile()}
                        disabled={saveStatus.kind === 'validating' || !dirty}
                        className="bg-primary text-primary-foreground hover:bg-primary/90"
                      >
                        {saveStatus.kind === 'validating' ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <Save className="mr-2 h-4 w-4" aria-hidden="true" />
                        )}
                        Save custom profile
                      </Button>
                    </div>

                    {saveStatus.kind === 'backend-error' && saveStatus.errors.length > 0 && (
                      <div
                        role="alert"
                        className="rounded-md border border-border bg-input/20 px-3 py-2.5"
                      >
                        <ul className="list-disc space-y-1 pl-4 text-xs leading-[16px] text-muted-foreground">
                          {saveStatus.errors.map((msg, i) => (
                            <li key={i}>{msg}</li>
                          ))}
                        </ul>
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
    </div>
  )
}
