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
  Zap,
} from 'lucide-react'
import { Button } from '../ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '../ui/card'
import { Switch } from '../ui/switch'
import { Label } from '../ui/label'
import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'
import { api } from '../../services/api'
import { useToast } from '../../hooks/useToast'
import { adaptAuditResponse } from '../../lib/audit/adapter'
import type { AuditResult } from '../../types/audit'

const MAX_SIZE_MB = 10
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024
const SAMPLE_PATH = '/samples/sample-thesis.docx'

export interface UploadCardProps {
  /** Called when the audit completes successfully */
  onResult: (result: AuditResult) => void
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
  const inputRef = React.useRef<HTMLInputElement>(null)

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
        const raw = await api.auditDocument(target, { cloud: cloudEnabled })
        const result = adaptAuditResponse({ raw })
        showToast(
          `Audit complete. Score: ${result.weighted_compliance_score}/100 · ${result.major_count} major · ${result.minor_count} minor`,
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
    [cloudEnabled, onResult, showToast],
  )

  const onUpload = () => {
    if (!file) return
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
  }, [runAudit, showToast])

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
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/30">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-lg font-semibold">Upload Document</CardTitle>
              <CardDescription>
                Drop your .docx thesis or report here. Local-only by default.
              </CardDescription>
            </div>
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
        {/* Drop zone */}
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={cn(
            'relative flex min-h-[148px] cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed px-6 py-8 text-center transition-colors',
            isDragging
              ? 'border-primary bg-primary/5'
              : 'border-border bg-input hover:bg-input/70 hover:border-primary/50',
          )}
        >
          <Upload className="h-6 w-6 text-muted-foreground" />
          <div className="text-sm font-medium">
            {isDragging ? 'Drop the file to upload' : 'Drag & drop your .docx here'}
          </div>
          <div className="text-xs text-muted-foreground">or click to browse</div>
          <input
            ref={inputRef}
            type="file"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={(e) => selectFile(e.target.files?.[0] ?? null)}
          />
        </div>

        {/* Try sample — secondary CTA */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full border-border bg-input/30 text-foreground hover:bg-muted/40 hover:text-foreground"
          disabled={isUploading}
          onClick={() => void loadAndAuditSample()}
        >
          <Zap className="mr-2 h-3.5 w-3.5 text-secondary" />
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

        {/* Cloud toggle */}
        <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-input/20 px-3 py-2.5">
          <div className="flex items-start gap-2.5">
            {cloudEnabled ? (
              <Cloud className="mt-0.5 h-4 w-4 text-primary" />
            ) : (
              <CloudOff className="mt-0.5 h-4 w-4 text-muted-foreground" />
            )}
            <div>
              <Label htmlFor="cloud-toggle" className="text-sm font-medium cursor-pointer">
                Cloud AI citation audit
              </Label>
              <p className="text-xs text-muted-foreground">
                Off by default. When on, paragraph text is sent to the AI for APA 7 checks.
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
          disabled={!file || isUploading}
          onClick={onUpload}
        >
          {isUploading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Auditing…
            </>
          ) : (
            <>
              <ShieldCheck className="mr-2 h-4 w-4" />
              Run Compliance Audit
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  )
}
