/**
 * Upload card — dropzone, file chip, cloud toggle, submit. Ported from
 * reference_project/src/components/audit/upload-card.tsx.
 *
 * The cloud toggle is visual-only on the wire: the backend's DEPLOY_MODE is
 * env-controlled. The `?cloud=1` query is sent so the affordance exists,
 * but the server currently ignores it (per the engine-protection rule).
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
import { extractDocumentStats } from '../../lib/audit/stats'
import { adaptAuditResponse } from '../../lib/audit/adapter'
import type { AuditResult, DocumentStats } from '../../types/audit'

const MAX_SIZE_MB = 10
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024

const ZERO_STATS: DocumentStats = {
  paragraphs: 0, headings: 0, tables: 0, images: 0, sections: 0, words: 0,
}

export interface UploadCardProps {
  /** Called when the audit completes successfully */
  onResult: (result: AuditResult) => void
  /** Optional reset signal — clears inline result when starting a new upload */
  onReset?: () => void
}

export function UploadCard({ onResult, onReset }: UploadCardProps) {
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

  const onUpload = async () => {
    if (!file) return
    setIsUploading(true)
    try {
      // Compute stats + adapter in parallel with the upload round-trip.
      const [stats, raw] = await Promise.all([
        extractDocumentStats(file).catch(() => ZERO_STATS),
        api.auditDocument(file, { cloud: cloudEnabled }),
      ])
      const result = adaptAuditResponse({
        raw,
        documentStats: stats,
        cloudEnabled,
      })
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
  }

  const clearFile = () => {
    setFile(null)
    if (inputRef.current) inputRef.current.value = ''
    onReset?.()
  }

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

        {/* Cloud toggle — visual-only; backend DEPLOY_MODE stays env-controlled */}
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
                Reserved for future deployments; current build always uses local Ollama.
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