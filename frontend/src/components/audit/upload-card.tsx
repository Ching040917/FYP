/**
 * Upload card — Build 6: dropzone, file chip, cloud toggle, merged profile
 * selector (built-in + backend-confirmed custom), store-backed selection, and
 * submit-time frozen-request submission.
 *
 * Selection source of truth: `envelope.selected_id` (namespaced string) — the
 * component keeps no second independent selected-profile state. The write path
 * is revision-guarded; submission re-reads the live envelope and deep-copies
 * only the last backend-confirmed payload.
 */

import * as React from 'react'
import {
  Upload,
  FileText,
  X,
  ShieldCheck,
  Loader2,
  Cloud,
  CloudOff,
  Info,
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
import { Switch } from '../ui/switch'
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

const MAX_SIZE_MB = 10
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024
const SAMPLE_PATH = '/samples/sample-thesis.docx'

export interface UploadCardProps {
  onResult: (result: AuditResult, cloudEnabled: boolean) => void
  onReset?: () => void
  trySampleSignal?: number
  /** Derived from Dashboard's Readiness result: true only when cloud_ai is ready. */
  cloudAvailable?: boolean | null
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

export function UploadCard({ onResult, onReset, trySampleSignal = 0, cloudAvailable }: UploadCardProps) {
  const { showToast } = useToast()
  const [file, setFile] = React.useState<File | null>(null)
  const [cloudEnabled, setCloudEnabled] = React.useState(false)
  const [isDragging, setIsDragging] = React.useState(false)
  const [isUploading, setIsUploading] = React.useState(false)
  const [profiles, setProfiles] = React.useState<FormattingProfile[]>([])
  const [selectedValue, setSelectedValue] = React.useState<string | null>(null)
  const selectedValueRef = React.useRef<string | null>(null)
  const [profilesLoading, setProfilesLoading] = React.useState(true)
  const [profilesError, setProfilesError] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const adapterRef = React.useRef<ReturnType<typeof createBrowserStoreAdapter> | null>(null)
  const [envelope, setEnvelope] = React.useState<StoreEnvelope | null>(null)
  const [envelopeRevision, setEnvelopeRevision] = React.useState<number>(0)
  const [customProfilesWarning, setCustomProfilesWarning] = React.useState<string | null>(null)
  const firstVisitRef = React.useRef(true)
  const cloudAvailableRef = React.useRef<boolean | null>(cloudAvailable ?? null)
  React.useEffect(() => {
    cloudAvailableRef.current = cloudAvailable ?? null
  }, [cloudAvailable])

  const isCloudAvailable = cloudAvailable === true

  // Cloud switch may be enabled only when cloud_ai.state === "ready".
  // If Cloud becomes unavailable (optional/unavailable/misconfigured/
  // unknown/checking/error) while ON, force it Off before any future
  // submission — preserve DOCX and Profile, keep Run Audit enabled, never
  // auto-enable Cloud.
  React.useEffect(() => {
    if (!isCloudAvailable && cloudEnabled) {
      setCloudEnabled(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCloudAvailable])

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
          cloud?: boolean
          profileId?: string
          customProfile?: Record<string, unknown>
        } = { cloud: cloudAvailableRef.current === true ? cloudEnabled : false }
        if (frozen.kind === 'builtin') baseOpts.profileId = frozen.profileId
        else if (frozen.kind === 'custom') baseOpts.customProfile = frozen.payload
        const raw = await api.auditDocument(target, baseOpts)
        const result = adaptAuditResponse({ raw })
        showToast(
          `Audit complete. Score: ${result.weighted_compliance_score}/100 for enabled checks · ${result.major_count} major · ${result.minor_count} minor`,
          'success',
        )
        onResult(result, cloudEnabled)
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown error during upload.'
        showToast(`Audit failed. ${message}`, 'error')
      } finally {
        setIsUploading(false)
      }
    },
    [cloudEnabled, loadEnvelopeState, onResult, profiles, showToast, tryPersistSelection],
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
    return buildSelectorOptions(profiles, confirmedCustomProfiles)
  }, [profiles, confirmedCustomProfiles])

  const selectedOption = React.useMemo(() => {
    if (!selectedValue) return null
    return selectorOptions.find((o) => o.value === selectedValue) ?? null
  }, [selectorOptions, selectedValue])

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base font-semibold">Start an audit</CardTitle>
            <CardDescription>
              Upload a .docx thesis or report for supported formatting checks. Deterministic
              validation runs locally by default.
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
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          className={cn(
            'relative flex min-h-[148px] cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed px-6 py-8 text-center transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background',
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
          <Upload className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          <div className="text-sm font-medium">
            {isDragging ? 'Drop the file to upload' : 'Drag & drop your .docx here'}
          </div>
          <div className="text-xs text-muted-foreground">or click to browse</div>
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

        <div className="rounded-md border border-border bg-input/20 px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="profile-select" className="text-sm font-medium">
              Document requirements
            </Label>
            <Link
              to="/profiles/custom"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
              Manage custom profiles
            </Link>
          </div>
          <p className="mt-0.5 text-xs leading-[16px] text-muted-foreground">
            Findings are evaluated against the selected document requirements.
          </p>

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
                  className="w-full"
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
                return (
                  <div className="space-y-1.5 text-xs leading-[16px] text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="font-medium text-foreground">{opt.displayName}</span>
                      <Badge
                        variant={opt.isBuiltIn ? 'outline' : 'secondary'}
                        className={
                          opt.isBuiltIn
                            ? 'border-border text-muted-foreground'
                            : 'bg-secondary/10 text-secondary'
                        }
                      >
                        {opt.isBuiltIn ? 'Built-in' : 'Custom'}
                      </Badge>
                      {opt.isRecommended && (
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          Recommended for this institution
                        </Badge>
                      )}
                    </div>
                    <p>{opt.description || (opt.isBuiltIn ? '' : 'Custom formatting profile')}</p>
                    {opt.keyRequirements.length > 0 && (
                      <ul className="list-disc space-y-0.5 pl-4">
                        {opt.keyRequirements.map((req) => (
                          <li key={req}>{req}</li>
                        ))}
                      </ul>
                    )}
                    <p className="flex items-center gap-1">
                      <Info className="h-3 w-3 shrink-0" aria-hidden="true" />
                      Citation style: {opt.citationStyle}
                    </p>
                  </div>
                )
              })()}
            </div>
          )}
        </div>

        <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-input/20 px-3 py-2.5">
          <div className="flex items-start gap-2.5">
            {cloudEnabled ? (
              <Cloud className="mt-0.5 h-4 w-4 text-primary" aria-hidden="true" />
            ) : (
              <CloudOff className="mt-0.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            )}
            <div>
              <Label htmlFor="cloud-toggle" className="text-sm font-medium cursor-pointer">
                Use cloud AI-assisted review
              </Label>
              <p className="mt-0.5 flex items-start gap-1 text-xs leading-[16px] text-muted-foreground">
                <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                Local AI is used by default when available. Deterministic checks always run.
              </p>
              {!isCloudAvailable && (
                <p
                  role="status"
                  aria-live="polite"
                  className="mt-1 text-xs leading-[16px] text-muted-foreground"
                >
                  Cloud AI review is unavailable. Deterministic checks remain available.
                </p>
              )}
            </div>
          </div>
          <Switch
            id="cloud-toggle"
            checked={cloudEnabled && isCloudAvailable}
            onCheckedChange={setCloudEnabled}
            disabled={isUploading || !isCloudAvailable}
          />
        </div>

        <Button
          type="button"
          className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
          disabled={!file || isUploading || profilesLoading || profilesError || profiles.length === 0}
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
  )
}
