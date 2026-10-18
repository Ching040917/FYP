/**
 * Upload card — Build 6: dropzone, file chip, merged profile
 * selector (built-in + backend-confirmed custom), store-backed selection, and
 * submit-time frozen-request submission.
 *
 * Selection source of truth: `envelope.selected_id` (namespaced string) — the
 * component keeps no second independent selected-profile state. The write path
 * is revision-guarded; submission re-reads the live envelope and deep-copies
 * only the last backend-confirmed payload.
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, MinusCircle, ClipboardList } from 'lucide-react'
import {
  Upload,
  FileText,
  X,
  ShieldCheck,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { Button } from '../ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '../ui/card'
import { Link } from 'react-router-dom'
import { Settings2 } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { Label } from '../ui/label'
import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'
import { api } from '../../services/api'
import { useToast } from '../../hooks/useToast'
import { adaptAuditResponse } from '../../lib/audit/adapter'
import {
  buildSelectorOptions,
  decodeSelectorIdentity,
  resolveUploadSelection,
  staleFriendlyMessage,
  validateAndFreezeSubmission,
} from '../../lib/upload-selector'
import type { FrozenSubmission } from '../../lib/upload-selector'
import type { AuditResult } from '../../types/audit'
import type { FormattingProfile } from '../../types/api'
import {
  RECOMMENDED_BUILTIN_ID,
  saveStore,
  setSelectedProfile,
  type StoreEnvelope,
  type StoredCustomProfile,
} from '../../lib/custom-profile-store/store.ts'
import { loadEnvelope } from '../../lib/custom-profile-store/editor.ts'
import { createBrowserStoreAdapter } from '../../lib/custom-profile-store/localstorage-adapter.ts'
import { profileDetailSections, selectedProfileSummary } from '../../lib/audit/enabled-checks-wording'
import { DisclosureSections } from './compact-disclosure'

const MAX_SIZE_MB = 10
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024
const SAMPLE_PATH = '/samples/sample-thesis.docx'

export interface UploadCardProps {
  onResult: (result: AuditResult) => void
  onReset?: () => void
  trySampleSignal?: number
  /**
   * Post-audit navigation: the Dashboard passes a value tied to lastAuditId so
   * a completed Audit shows a persistent "View audit" action in its completion
   * panel. When supplied, the panel's View action reuses the frozen audit id.
   * If navigation/Dismiss lives outside this card (preferred: Dashboard owns
   * the completion panel), clients implement it via onResult's AuditResult.
   */
  completionAuditId?: string | null
  onViewAudit?: (auditId: string) => void
  onDismissCompletion?: () => void
}

export function UploadCard({ onResult, onReset, trySampleSignal = 0 }: UploadCardProps) {
  const { showToast } = useToast()
  const [file, setFile] = React.useState<File | null>(null)
  const [isDragging, setIsDragging] = React.useState(false)
  const [isUploading, setIsUploading] = React.useState(false)
  const [profiles, setProfiles] = React.useState<FormattingProfile[]>([])
  const [selectedValue, setSelectedValue] = React.useState<string | null>(null)
  const selectedValueRef = React.useRef<string | null>(null)
  const [profilesLoading, setProfilesLoading] = React.useState(true)
  const [profilesError, setProfilesError] = React.useState(false)
  const [builtinPayloads, setBuiltinPayloads] = React.useState<Record<string, Record<string, unknown>>>({})
  const [builtinDetailsError, setBuiltinDetailsError] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const adapterRef = React.useRef<ReturnType<typeof createBrowserStoreAdapter> | null>(null)
  const [envelope, setEnvelope] = React.useState<StoreEnvelope | null>(null)
  const [envelopeRevision, setEnvelopeRevision] = React.useState<number>(0)
  const [customProfilesWarning, setCustomProfilesWarning] = React.useState<string | null>(null)
  const firstVisitRef = React.useRef(true)

  const setSelection = React.useCallback((v: string | null) => {
    setSelectedValue(v)
    selectedValueRef.current = v
  }, [])

  const loadEnvelopeState = React.useCallback((): StoreEnvelope => {
    const adapter = adapterRef.current
    if (!adapter) {
      return {
        schema_version: 1,
        revision: 0,
        updated_at: new Date(0).toISOString(),
        profiles: [],
        selected_id: null,
      }
    }
    const env = loadEnvelope(adapter)
    setEnvelope(env)
    setEnvelopeRevision(env.revision)
    return env
  }, [])

  const syncFromSources = React.useCallback(
    (
      builtinProfiles: FormattingProfile[],
      env: StoreEnvelope | null,
      opts: { notifyStale?: boolean } = {},
    ) => {
      const confirmed =
        env?.profiles.filter((p) => p.validationState === 'backend_confirmed') ?? []
      const raw = env?.selected_id ?? selectedValueRef.current
      const result = resolveUploadSelection(
        builtinProfiles,
        confirmed,
        raw,
        false,
        firstVisitRef.current,
      )
      setSelection(result.selectedValue)
      if (env && result.normalizedPersisted && result.normalizedPersisted !== env.selected_id) {
        const adapter = adapterRef.current
        if (adapter) {
          const next = setSelectedProfile(env, result.normalizedPersisted)
          const withBump: StoreEnvelope = {
            ...next,
            revision: next.revision + 1,
            updated_at: new Date().toISOString(),
          }
          const res = saveStore(adapter, withBump, env.revision)
          if (res.ok) {
            setEnvelope(withBump)
            setEnvelopeRevision(withBump.revision)
          }
        }
      }
      const wasStale = result.stale
      if (!wasStale) firstVisitRef.current = false
      if (wasStale && opts.notifyStale) {
        showToast(result.friendlyMessage ?? staleFriendlyMessage(), 'info')
      }
    },
    [setSelection, showToast],
  )

  React.useEffect(() => {
    if (adapterRef.current) return
    const adapter = createBrowserStoreAdapter()
    adapterRef.current = adapter
    if (!adapter) {
      setCustomProfilesWarning(
        'Saved custom profiles are unavailable in this browser session.',
      )
    }
  }, [])

  const loadProfiles = React.useCallback(async () => {
    setProfilesLoading(true)
    setProfilesError(false)
    try {
      const list = await api.getFormattingProfiles()
      setProfiles(list)
      const env = loadEnvelopeState()
      syncFromSources(list, env, { notifyStale: false })
    } catch {
      setProfilesError(true)
      setProfiles([])
      setSelection(null)
    } finally {
      setProfilesLoading(false)
    }
  }, [loadEnvelopeState, setSelection, syncFromSources])

  React.useEffect(() => {
    void loadProfiles()
  }, [loadProfiles])

  React.useEffect(() => {
    const adapter = adapterRef.current
    if (!adapter) return
    const unsub = adapter.onExternalChange(() => {
      const fresh = loadEnvelopeState()
      if (isUploading) {
        syncFromSources(profiles, fresh, { notifyStale: false })
        return
      }
      const hadSelection = selectedValueRef.current !== null
      const beforeConfirmed =
        envelope?.profiles.filter((p) => p.validationState === 'backend_confirmed') ?? []
      const afterConfirmed =
        fresh.profiles.filter((p) => p.validationState === 'backend_confirmed') ?? []
      const prevDecoded = decodeSelectorIdentity(selectedValueRef.current ?? '')
      const prevWasCustom = prevDecoded?.kind === 'custom'
      const prevStillExistedBefore = prevDecoded
        ? prevWasCustom
          ? beforeConfirmed.some((p) => p.id === prevDecoded.id)
          : profiles.some((p) => p.profile_id === prevDecoded.id)
        : false
      const prevNowExists = prevDecoded
        ? prevWasCustom
          ? afterConfirmed.some((p) => p.id === prevDecoded.id)
          : profiles.some((p) => p.profile_id === prevDecoded.id)
        : false
      syncFromSources(profiles, fresh, { notifyStale: hadSelection })
      if (hadSelection && prevStillExistedBefore && !prevNowExists) {
        showToast(staleFriendlyMessage(), 'info')
      } else if (
        fresh.revision !== envelopeRevision &&
        fresh.selected_id !== selectedValueRef.current
      ) {
        const freshDecoded = decodeSelectorIdentity(fresh.selected_id ?? '')
        const currentDecoded = prevDecoded
        const selectionActuallyChanged =
          !freshDecoded || !currentDecoded || freshDecoded.id !== currentDecoded.id
        if (selectionActuallyChanged && !prevNowExists) {
          // Already covered by stale path above.
        } else if (selectionActuallyChanged) {
          showToast(
            'Profile selection changed in another tab. Review the current selection before continuing.',
            'info',
          )
        }
      }
    })
    return unsub
  }, [
    envelope,
    envelopeRevision,
    isUploading,
    loadEnvelopeState,
    profiles,
    showToast,
    syncFromSources,
  ])

  const tryPersistSelection = React.useCallback(
    (value: string, env: StoreEnvelope) => {
      const adapter = adapterRef.current
      if (!adapter) {
        setSelection(value)
        return
      }
      setSelection(value)
      const next = setSelectedProfile(env, value)
      const withBump: StoreEnvelope = {
        ...next,
        revision: next.revision + 1,
        updated_at: new Date().toISOString(),
      }
      const res = saveStore(adapter, withBump, env.revision)
      if (!res.ok) {
        if (res.reason === 'stale-revision') {
          const live = loadEnvelope(adapter)
          setEnvelope(live)
          setEnvelopeRevision(live.revision)
          syncFromSources(profiles, live, { notifyStale: false })
          showToast(
            'Profile selection changed in another tab. Review the current selection before continuing.',
            'info',
          )
        }
        return
      }
      setEnvelope(withBump)
      setEnvelopeRevision(withBump.revision)
    },
    [profiles, setSelection, showToast, syncFromSources],
  )

  const handleSelectionChange = React.useCallback(
    (nextValue: string) => {
      if (isUploading) return
      const env = (envelope ?? loadEnvelopeState()) as StoreEnvelope
      const decoded = decodeSelectorIdentity(nextValue)
      if (!decoded) {
        showToast('That document profile could not be selected. Please try again.', 'error')
        return
      }
      if (decoded.kind === 'custom') {
        const hit = env.profiles.find(
          (p: StoredCustomProfile) => p.id === decoded.id,
        )
        if (!hit || hit.validationState !== 'backend_confirmed') {
          showToast('That custom profile is no longer available.', 'error')
          const confirmed =
            env.profiles.filter((p) => p.validationState === 'backend_confirmed') ?? []
          const result = resolveUploadSelection(profiles, confirmed, env.selected_id, false, false)
          if (result.selectedValue) void tryPersistSelection(result.selectedValue, env)
          return
        }
      } else if (!profiles.some((p) => p.profile_id === decoded.id)) {
        showToast('That document profile could not be selected. Please try again.', 'error')
        return
      }
      void tryPersistSelection(nextValue, env)
    },
    [envelope, isUploading, loadEnvelopeState, profiles, showToast, tryPersistSelection],
  )

  const selectFile = (f: File | null) => {
    if (!f) return
    if (!f.name.toLowerCase().endsWith('.docx')) {
      showToast('Unsupported file format. Only .docx files are accepted.', 'error')
      return
    }
    if (f.size > MAX_SIZE_BYTES) {
      showToast(
        `File too large. Maximum size is ${MAX_SIZE_MB}MB. Your file is ${(f.size / 1024 / 1024).toFixed(1)}MB.`,
        'error',
      )
      return
    }
    setFile(f)
    onReset?.()
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const f = e.dataTransfer.files?.[0]
    if (f) selectFile(f)
  }

  const runAudit = React.useCallback(
    async (target: File) => {
      const liveEnv = loadEnvelopeState()
      const frozenResult = validateAndFreezeSubmission(
        liveEnv as StoreEnvelope,
        profiles,
        selectedValueRef.current,
      )
      if (!frozenResult.ok) {
        if (frozenResult.resetToRecommended) {
          const confirmed =
            liveEnv.profiles.filter((p) => p.validationState === 'backend_confirmed') ?? []
          const resolved = resolveUploadSelection(
            profiles,
            confirmed,
            RECOMMENDED_BUILTIN_ID,
            false,
            false,
          )
          const fallback = resolved.selectedValue
          if (fallback) void tryPersistSelection(fallback, liveEnv as StoreEnvelope)
        }
        showToast(frozenResult.friendlyMessage, 'error')
        return
      }
      const frozen: FrozenSubmission = frozenResult.frozen
      setIsUploading(true)
      try {
        const baseOpts: {
          profileId?: string
          customProfile?: Record<string, unknown>
        } = {}
        if (frozen.kind === 'builtin') baseOpts.profileId = frozen.profileId
        else if (frozen.kind === 'custom') baseOpts.customProfile = frozen.payload
        const raw = await api.auditDocument(target, baseOpts)
        const result = adaptAuditResponse({ raw })
        showToast(
          `Audit complete. Score: ${result.weighted_compliance_score}/100 for enabled checks · ${result.major_count} major · ${result.minor_count} minor`,
          'success',
        )
        onResult(result)
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown error during upload.'
        showToast(`Audit failed. ${message}`, 'error')
      } finally {
        setIsUploading(false)
      }
    },
    [loadEnvelopeState, onResult, profiles, showToast, tryPersistSelection],
  )

  const onUpload = () => {
    if (!file) return
    if (profilesError || (!profilesLoading && profiles.length === 0)) {
      showToast('Document requirements could not be loaded. Please try again.', 'error')
      return
    }
    {
      const env = envelope ?? loadEnvelopeState()
      const liveResult = validateAndFreezeSubmission(
        env as StoreEnvelope,
        profiles,
        selectedValueRef.current,
      )
      if (!liveResult.ok) {
        if (liveResult.resetToRecommended) {
          const confirmed =
            (env as StoreEnvelope).profiles.filter(
              (p: StoredCustomProfile) => p.validationState === 'backend_confirmed',
            ) ?? []
          const resolved = resolveUploadSelection(
            profiles,
            confirmed,
            RECOMMENDED_BUILTIN_ID,
            false,
            false,
          )
          const fallback = resolved.selectedValue
          if (fallback) void tryPersistSelection(fallback, env as StoreEnvelope)
        }
        showToast(liveResult.friendlyMessage, 'error')
        return
      }
    }
    void runAudit(file)
  }

  const clearFile = () => {
    setFile(null)
    if (inputRef.current) inputRef.current.value = ''
    onReset?.()
  }

  const loadAndAuditSample = React.useCallback(async () => {
    if (profilesError || (!profilesLoading && profiles.length === 0)) {
      showToast('Document requirements could not be loaded. Please try again.', 'error')
      return
    }
    try {
      const res = await fetch(SAMPLE_PATH)
      if (!res.ok) throw new Error(`Sample fetch failed: ${res.status}`)
      const blob = await res.blob()
      const sampleFile = new File([blob], 'sample-thesis.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
      selectFile(sampleFile)
      await new Promise((r) => setTimeout(r, 100))
      await runAudit(sampleFile)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error.'
      showToast(`Could not load sample. ${message}`, 'error')
    }
  }, [runAudit, showToast, profilesError, profiles.length, profilesLoading])

  const lastSignalRef = React.useRef(trySampleSignal)
  React.useEffect(() => {
    if (trySampleSignal > lastSignalRef.current) {
      lastSignalRef.current = trySampleSignal
      void loadAndAuditSample()
    } else {
      lastSignalRef.current = trySampleSignal
    }
  }, [trySampleSignal, loadAndAuditSample])

  const confirmedCustomProfiles: readonly StoredCustomProfile[] = React.useMemo(() => {
    if (!envelope) return []
    return envelope.profiles.filter((p) => p.validationState === 'backend_confirmed')
  }, [envelope])

  const selectorOptions = React.useMemo(() => {
    return buildSelectorOptions(profiles, confirmedCustomProfiles, builtinPayloads)
  }, [profiles, confirmedCustomProfiles, builtinPayloads])

  const selectedOption = React.useMemo(() => {
    if (!selectedValue) return null
    return selectorOptions.find((o) => o.value === selectedValue) ?? null
  }, [selectorOptions, selectedValue])

  const selectedBuiltinId = selectedOption?.isBuiltIn ? selectedOption.underlyingId : null
  React.useEffect(() => {
    if (!selectedBuiltinId || builtinPayloads[selectedBuiltinId]) return
    let cancelled = false
    setBuiltinDetailsError(null)
    void api.getBuiltinProfilePayload(selectedBuiltinId).then((payload) => {
      if (!cancelled) setBuiltinPayloads((current) => ({ ...current, [selectedBuiltinId]: payload }))
    }).catch(() => {
      if (!cancelled) setBuiltinDetailsError(selectedBuiltinId)
    })
    return () => { cancelled = true }
  }, [selectedBuiltinId, builtinPayloads, profiles])

  // Compact profile summary resets when the selection changes.
  const [showFullRequirements, setShowFullRequirements] = React.useState(false)
  React.useEffect(() => {
    setShowFullRequirements(false)
  }, [selectedValue])

  const summaryRows = React.useMemo(() => selectedOption?.snapshot
    ? selectedProfileSummary(selectedOption.snapshot)
    : [], [selectedOption])

  return (
    <div className="grid min-w-0 grid-cols-1 items-start gap-5 md:grid-cols-[11fr_9fr]">
    <Card className="min-w-0 border-border bg-card">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base font-semibold">Start an audit</CardTitle>
            <CardDescription>
              Upload a .docx thesis or report for supported formatting checks. Deterministic
              validation runs locally.
            </CardDescription>
          </div>
          <Badge
            variant="outline"
            className="hidden sm:inline-flex border-border text-muted-foreground"
          >
            Max {MAX_SIZE_MB}MB · .docx only
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <label
          id="upload-dropzone"
          tabIndex={-1}
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          className={cn(
            'relative flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed px-6 text-center transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background',
            file ? 'min-h-[64px] flex-row py-3' : 'min-h-[148px] flex-col py-8',
            isDragging
              ? 'border-primary bg-primary/5'
              : 'border-border bg-input hover:border-primary/50 hover:bg-input/70',
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="sr-only"
            onChange={(e) => selectFile(e.target.files?.[0] ?? null)}
          />
          <Upload className={cn('shrink-0 text-muted-foreground', file ? 'h-4 w-4' : 'h-6 w-6')} aria-hidden="true" />
          <div className="text-sm font-medium">
            {isDragging ? 'Drop the file to upload' : file ? 'Drop a replacement DOCX or click to browse' : 'Drag & drop your .docx here'}
          </div>
          {!file && <div className="text-xs text-muted-foreground">or click to browse</div>}
        </label>

        <p className="text-[13px] leading-[19px] text-muted-foreground">
          Supported formatting checks: margins, fonts, font sizes, paragraph spacing, heading
          hierarchy, and media captions.
        </p>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full border-border bg-input/30 text-foreground hover:bg-muted/40 hover:text-foreground"
          disabled={isUploading}
          onClick={() => void loadAndAuditSample()}
        >
          <FileText className="mr-2 h-3.5 w-3.5 text-primary" aria-hidden="true" />
          Try with the sample thesis
        </Button>

        {file && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-input/40 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <FileText className="h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{file.name}</div>
                <div className="text-xs text-muted-foreground">
                  {(file.size / 1024).toFixed(1)} KB
                </div>
              </div>
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={clearFile}
              disabled={isUploading}
              aria-label="Remove file"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}

        <p id="upload-action-help" className="text-xs text-muted-foreground">
          {!file ? 'Upload a DOCX file to continue.' : 'Your selected profile will be applied to this document.'}
        </p>


        <Button
          type="button"
          className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
          disabled={!file || isUploading || profilesLoading || profilesError || profiles.length === 0}
          aria-describedby="upload-action-help"
          onClick={onUpload}
        >
          {isUploading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Auditing…
            </>
          ) : (
            <>
              <ShieldCheck className="mr-2 h-4 w-4" aria-hidden="true" />
              Run compliance audit
            </>
          )}
        </Button>
      </CardContent>
    </Card>
    <Card className="min-w-0 border-border bg-card">
      <CardContent className="p-5">
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="profile-select" className="text-sm font-medium">
              Selected profile
            </Label>
            <Link
              to="/profiles/custom"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
              Manage custom profiles
            </Link>
          </div>

          {customProfilesWarning && !profilesLoading && !profilesError && (
            <p
              role="status"
              aria-live="polite"
              className="mt-2 text-xs leading-[16px] text-muted-foreground"
            >
              {customProfilesWarning}
            </p>
          )}

          {profilesLoading ? (
            <div
              role="status"
              aria-live="polite"
              className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Loading document requirements…
            </div>
          ) : profilesError || profiles.length === 0 ? (
            <div
              role="alert"
              aria-live="assertive"
              className="mt-2 flex items-center justify-between gap-2 rounded-md border border-border bg-input/30 px-2.5 py-2"
            >
              <span className="text-xs text-muted-foreground">
                Document requirements could not be loaded. Please try again.
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 gap-1 text-xs"
                onClick={() => void loadProfiles()}
              >
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                Retry
              </Button>
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              <Select
                value={selectedValue ?? undefined}
                onValueChange={handleSelectionChange}
                disabled={isUploading}
              >
                <SelectTrigger
                  id="profile-select"
                  className="w-full min-w-0 [&>span]:min-w-0 [&>span]:truncate [&>span]:text-left"
                  aria-label="Document requirements profile"
                >
                  <SelectValue placeholder="Select document requirements" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Built-in</SelectLabel>
                    {selectorOptions
                      .filter((o) => o.isBuiltIn)
                      .map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.displayName}
                          {o.isRecommended ? ' — Recommended for this institution' : ''}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                  {selectorOptions.some((o) => !o.isBuiltIn) && (
                    <SelectGroup>
                      <SelectLabel>Custom</SelectLabel>
                      {selectorOptions
                        .filter((o) => !o.isBuiltIn)
                        .map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.displayName}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>

              {(() => {
                const opt = selectedOption
                if (!opt) return null
                const citationStyle = summaryRows.find((row) => row.heading === 'Citation style')
                return (
                  <div className="space-y-2 text-xs leading-[16px] text-muted-foreground">
                    <p className="break-words font-medium text-foreground">{opt.displayName}</p>
                    <div className="flex flex-wrap items-center gap-1">
                      <span>Source: {opt.isBuiltIn ? 'Built-in · Read-only' : 'Custom · Independently editable'}</span>
                      {opt.isRecommended && (
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          Recommended
                        </Badge>
                      )}
                    </div>
                    {citationStyle && (
                      <p className="break-words">
                        Citation style: <span className="font-medium text-foreground">{citationStyle.text}</span>
                      </p>
                    )}

                    {summaryRows.length > 0 ? (
                      <dl className="divide-y divide-border rounded-md border border-border bg-background/40 px-2.5">
                        {summaryRows.filter((row) => row.heading !== 'Citation style').map((row) => (
                          <div key={row.heading} className="py-2">
                            <dt className={cn('flex items-center gap-1.5 font-medium', row.heading.startsWith('Manual') ? 'text-purple-700 dark:text-purple-300' : row.heading === 'Not checked' ? 'text-destructive' : 'text-success')}>
                              {row.heading.startsWith('Manual') ? <ClipboardList className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : row.heading === 'Not checked' ? <MinusCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                              {row.heading === 'Not checked' ? 'Not checked by ACA' : row.heading.startsWith('Manual') ? 'Manual review only' : row.heading}
                            </dt>
                            <dd className="mt-0.5 break-words">
                              {row.heading === 'Scored checks' ? (
                                <>
                                  <p>{row.text.replace(' enabled', ' requirements checked automatically')}</p>
                                  <p>These checks affect the compliance score.</p>
                                </>
                              ) : row.heading.startsWith('Manual') ? (
                                <>
                                  <p>{row.text} · Unscored</p>
                                  <p>Manual review does not affect the numeric compliance score.</p>
                                </>
                              ) : (
                                <>
                                  <p>{row.text}</p>
                                  <p>Not included in this profile’s automated checks.</p>
                                </>
                              )}
                              {row.items && row.items.length > 0 && (
                                <ul className="mt-1 space-y-0.5" aria-label={`${row.heading} requirements`}>
                                  {row.items.map((item) => (
                                    <li key={item.label} className="break-words">
                                      {item.label}
                                      {item.value !== 'Not checked' && item.value !== 'Manual review' && ` · ${item.value}`}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p role="status">
                        {builtinDetailsError === opt.underlyingId
                          ? 'Profile summary could not be loaded. Listed requirements remain available in Review full requirements.'
                          : 'Loading profile summary…'}
                        {builtinDetailsError === opt.underlyingId && (
                          <Button type="button" variant="ghost" size="sm" className="ml-1 h-7 px-2 text-xs" onClick={() => void loadProfiles()}>
                            Retry
                          </Button>
                        )}
                      </p>
                    )}

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto min-h-9 max-w-full whitespace-normal border-border px-3 py-2 text-left text-primary hover:bg-muted/40 hover:text-foreground"
                      aria-haspopup="dialog"
                      onClick={() => setShowFullRequirements(true)}
                    >
                      Review full requirements
                    </Button>
                    {showFullRequirements && <RequirementsDialog onClose={() => setShowFullRequirements(false)}>
                      {opt.snapshot ? (
                        <DisclosureSections sections={profileDetailSections(opt.snapshot)} />
                      ) : (
                        <>
                          {opt.description && <p className="break-words">{opt.description}</p>}
                          <ul className="list-disc space-y-0.5 pl-4">
                            {opt.keyRequirements.map((req) => <li key={req}>{req}</li>)}
                          </ul>
                        </>
                      )}
                    </RequirementsDialog>}
                  </div>
                )
              })()}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
    </div>
  )
}

function RequirementsDialog({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const panelRef = React.useRef<HTMLDivElement>(null)
  const closeRef = React.useRef<HTMLButtonElement>(null)
  const titleId = React.useId()
  React.useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    return () => {
      document.body.style.overflow = overflow
      trigger?.focus()
    }
  }, [])
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-3 sm:p-6" onClick={onClose}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="flex max-h-[90dvh] w-full min-w-0 max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
          if (event.key !== 'Tab') return
          const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []).filter((element) => element.getClientRects().length > 0)
          const first = controls[0]
          const last = controls[controls.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }}>
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold">Full profile requirements</h2>
          <Button ref={closeRef} type="button" variant="outline" size="sm" onClick={onClose}><X className="mr-1.5 h-4 w-4" aria-hidden="true" />Close</Button>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain break-words p-5 text-sm">{children}
          <section className="mt-4 border-t border-border pt-3"><h3 className="font-semibold">Scope</h3><p className="mt-1 text-muted-foreground">Only enabled deterministic checks contribute to the score. Manual review requirements are unscored. Writing quality, factual accuracy and unsupported formatting requirements are not assessed.</p></section>
        </div>
      </div>
    </div>, document.body,
  )
}
