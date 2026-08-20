/**
 * Upload card — dropzone, file chip, cloud toggle, submit.
 *
 * NEW: "Try with the sample thesis" button — fetches /samples/sample-thesis.docx
 * and runs the audit automatically so reviewers can demo the dashboard
 * in one click without preparing their own file.
 *
 * LAYOUT BUDGET: respects the parent's h-screen overflow-hidden shell.
 * No min-h-screen, no blind h-full inside grids — uses max-h-* and flex-col
 * so the card grows naturally with content and never overflows the viewport.
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
import {
  Select,
  SelectContent,
  SelectItem,
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
import { resolveProfileSelection } from '../../lib/profile-selection'
import type { AuditResult } from '../../types/audit'
import type { FormattingProfile } from '../../types/api'

const MAX_SIZE_MB = 10
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024
const SAMPLE_PATH = '/samples/sample-thesis.docx'

export interface UploadCardProps {
  /**
   * Called when the audit completes successfully. The second argument is
   * the cloud-AI state the audit actually ran with — the source of truth
   * for whether AI-assisted findings may be presented.
   */
  onResult: (result: AuditResult, cloudEnabled: boolean) => void
  /** Optional reset signal — clears inline result when starting a new upload */
  onReset?: () => void
  /**
   * Increment this number to trigger an automatic sample-document audit.
   * Lets a parent LandingHero CTA drive the upload card without lifting
   * internal state up.
   */
  trySampleSignal?: number
}

export function UploadCard({ onResult, onReset, trySampleSignal = 0 }: UploadCardProps) {
  const { showToast } = useToast()
  const [file, setFile] = React.useState<File | null>(null)
  const [cloudEnabled, setCloudEnabled] = React.useState(false)
  const [isDragging, setIsDragging] = React.useState(false)
  const [isUploading, setIsUploading] = React.useState(false)
  const [profiles, setProfiles] = React.useState<FormattingProfile[]>([])
  const [selectedProfileId, setSelectedProfileId] = React.useState<string | null>(null)
  const [profilesLoading, setProfilesLoading] = React.useState(true)
  const [profilesError, setProfilesError] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  // Tracks the current selection across reloads without stale closures.
  const selectedProfileIdRef = React.useRef<string | null>(null)

  /**
   * Load available built-in profiles. Default = the authoritative recommended
   * profile. If a previously selected profile is no longer available, reset
   * to the recommended one and notify — never submit a stale ID.
   */
  const loadProfiles = React.useCallback(async () => {
    setProfilesLoading(true)
    setProfilesError(false)
    try {
      const list = await api.getFormattingProfiles()
      setProfiles(list)
      const { selectedId, reset } = resolveProfileSelection(list, selectedProfileIdRef.current)
      setSelectedProfileId(selectedId)
      selectedProfileIdRef.current = selectedId
      if (reset) {
        showToast('The selected document requirements are no longer available. Using the recommended profile.', 'info')
      }
    } catch {
      setProfilesError(true)
      setProfiles([])
      setSelectedProfileId(null)
      selectedProfileIdRef.current = null
    } finally {
      setProfilesLoading(false)
    }
  }, [showToast])

  React.useEffect(() => {
    void loadProfiles()
  }, [loadProfiles])

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
      setIsUploading(true)
      try {
        // Backend remains authoritative: unknown/stale profile id → friendly
        // 400. We only pass the selected id — never the full configuration.
        const raw = await api.auditDocument(target, {
          cloud: cloudEnabled,
          profileId: selectedProfileId ?? undefined,
        })
        const result = adaptAuditResponse({
          raw,
        })
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
    [cloudEnabled, onResult, selectedProfileId, showToast],
  )

  const onUpload = () => {
    if (!file) return
    // Safety: never submit when document requirements failed to load — the
    // backend would reject an unknown profile, and silently submitting
    // without a known profile is worse than blocking.
    if (profilesError || (!profilesLoading && profiles.length === 0)) {
      showToast('Document requirements could not be loaded. Please try again.', 'error')
      return
    }
    void runAudit(file)
  }

  const clearFile = () => {
    setFile(null)
    if (inputRef.current) inputRef.current.value = ''
    onReset?.()
  }

  /**
   * Auto-load the bundled sample thesis and immediately audit it.
   * Triggered by the parent incrementing `trySampleSignal` OR by the
   * "Try with the sample thesis" button below.
   */
  const loadAndAuditSample = React.useCallback(async () => {
    // Never auto-submit with an unknown profile.
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
      // Small delay so the file-chip state paints before the spinner
      await new Promise((r) => setTimeout(r, 100))
      await runAudit(sampleFile)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error.'
      showToast(`Could not load sample. ${message}`, 'error')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runAudit, showToast, profilesError, profiles.length, profilesLoading])

  // Re-run only when the parent increments the signal
  const lastSignalRef = React.useRef(trySampleSignal)
  React.useEffect(() => {
    if (trySampleSignal > lastSignalRef.current) {
      lastSignalRef.current = trySampleSignal
      void loadAndAuditSample()
    } else {
      lastSignalRef.current = trySampleSignal
    }
  }, [trySampleSignal, loadAndAuditSample])

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
        {/* Drop zone — label-wrapped file input: keyboard and pointer accessible */}
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

        {/* Try sample — secondary CTA */}
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

        {/* Selected file chip */}
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

        {/* Document requirements — profile selector (Build 5) */}
        <div className="rounded-md border border-border bg-input/20 px-3 py-3">
          <Label htmlFor="profile-select" className="text-sm font-medium">
            Document requirements
          </Label>
          <p className="mt-0.5 text-xs leading-[16px] text-muted-foreground">
            Findings are evaluated against the selected document requirements.
          </p>

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
                value={selectedProfileId ?? undefined}
                onValueChange={(v) => {
                  setSelectedProfileId(v)
                  selectedProfileIdRef.current = v
                }}
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
                  {profiles.map((p) => (
                    <SelectItem key={p.profile_id} value={p.profile_id}>
                      {p.profile_name}
                      {p.recommended ? ' — Recommended for this institution' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {(() => {
                const selected = profiles.find((p) => p.profile_id === selectedProfileId)
                if (!selected) return null
                return (
                  <div className="space-y-1.5 text-xs leading-[16px] text-muted-foreground">
                    <p>{selected.description}</p>
                    {selected.key_requirements.length > 0 && (
                      <ul className="list-disc space-y-0.5 pl-4">
                        {selected.key_requirements.map((req) => (
                          <li key={req}>{req}</li>
                        ))}
                      </ul>
                    )}
                    <p className="flex items-center gap-1">
                      <Info className="h-3 w-3 shrink-0" aria-hidden="true" />
                      Citation style: {selected.citation_style}
                    </p>
                  </div>
                )
              })()}
            </div>
          )}
        </div>

        {/* Optional AI-assisted citation review */}
        <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-input/20 px-3 py-2.5">
          <div className="flex items-start gap-2.5">
            {cloudEnabled ? (
              <Cloud className="mt-0.5 h-4 w-4 text-primary" aria-hidden="true" />
            ) : (
              <CloudOff className="mt-0.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            )}
            <div>
              <Label htmlFor="cloud-toggle" className="text-sm font-medium cursor-pointer">
                Optional AI-assisted citation review
              </Label>
              <p className="mt-0.5 flex items-start gap-1 text-xs leading-[16px] text-muted-foreground">
                <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                Off by default. When on, citation paragraphs are sent to the cloud AI for APA 7
                suggestions. Deterministic formatting checks run the same either way.
              </p>
            </div>
          </div>
          <Switch
            id="cloud-toggle"
            checked={cloudEnabled}
            onCheckedChange={setCloudEnabled}
            disabled={isUploading}
          />
        </div>

        {/* Submit */}
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
