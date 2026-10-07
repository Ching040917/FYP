/**
 * Local AI Citation Guidance — download progress panel.
 *
 * Inline (not modal) so that an ordinary readiness refresh cannot unmount it.
 * The panel is display-only: it never starts, retries, or stops anything on
 * its own — every action is an explicit user click.
 *
 * There is deliberately NO Cancel control. Ollama 0.35.1 has no cancel
 * endpoint and keeps downloading after a client disconnects, so closing this
 * view is not a cancellation and must never be described as one.
 */
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '../ui/button'
import type { LocalModelDownloadStatus } from '../../types/api'
import {
  LOCAL_MODEL_COPY,
  NO_CANCEL_NOTICE,
  downloadErrorGuidance,
  downloadProgressText,
  isDownloadActive,
  progressAriaText,
} from '../../lib/local-model-download'
import { cn } from '../../lib/utils'

export function LocalModelDownloadPanel({
  status,
  busy,
  onRetry,
  onHide,
}: {
  status: LocalModelDownloadStatus
  /** True while a start/retry request is in flight. */
  busy: boolean
  onRetry: () => void
  onHide: () => void
}) {
  const active = isDownloadActive(status)
  const failed = status.state === 'failed' || status.state === 'disconnected'
  const percentage = status.percentage
  const determinate = percentage !== null
  const progressText = downloadProgressText(status)

  return (
    <div
      data-testid="model-download-panel"
      className="mt-1 space-y-2 rounded-md border border-border bg-background/60 px-3 py-2.5"
    >
      {/*
        Live region: carries only the state message, which the Backend changes
        on state transitions alone. Numeric byte updates render outside it, so
        a screen reader is never flooded during a long download.
      */}
      <p
        role="status"
        aria-live="polite"
        data-testid="model-download-state"
        className="flex items-center gap-1.5 text-xs leading-[16px] font-medium text-foreground"
      >
        {active ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
        ) : null}
        {status.message}
      </p>

      {active ? (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          // Omitted entirely when the Backend supplied no percentage, which is
          // what makes the progress indeterminate rather than fabricated.
          aria-valuenow={determinate ? percentage : undefined}
          aria-valuetext={progressAriaText(status)}
          data-testid="model-download-progress"
          className="h-2 w-full overflow-hidden rounded bg-input/40"
        >
          <div
            className={cn(
              'h-full rounded bg-primary transition-[width] duration-500',
              determinate ? '' : 'w-full animate-pulse bg-primary/40',
            )}
            style={determinate ? { width: `${percentage}%` } : undefined}
          />
        </div>
      ) : null}

      {progressText ? (
        <p className="text-xs leading-[16px] text-muted-foreground">{progressText}</p>
      ) : null}

      {failed ? (
        <p className="flex items-start gap-1.5 text-xs leading-[16px] text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          {downloadErrorGuidance(status.error_category)}
        </p>
      ) : null}

      <p className="text-xs leading-[16px] text-muted-foreground">{NO_CANCEL_NOTICE}</p>

      <div className="flex flex-wrap items-center gap-2">
        {failed && status.retryable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-border text-foreground min-h-[44px]"
            onClick={onRetry}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            {LOCAL_MODEL_COPY.retryAction}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-border text-foreground min-h-[44px]"
          onClick={onHide}
        >
          {LOCAL_MODEL_COPY.hideProgress}
        </Button>
      </div>
    </div>
  )
}
