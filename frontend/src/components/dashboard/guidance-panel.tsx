/**
 * First-run Setup Guidance (Dashboard, left intake stack).
 *
 * Dismissible inline panel shown on the first Dashboard visit. Never blocks
 * upload or audit submission. Persistence lives in lib/guidance.ts
 * (versioned localStorage record; memory fallback keeps the session usable).
 */
import { AlertTriangle, CheckCircle2, Cloud, X } from 'lucide-react'
import { Button } from '../ui/button'
import type { ReactNode } from 'react'

export type GuidanceReadiness = 'ready' | 'degraded' | 'blocked' | 'unavailable'

export interface GuidancePanelProps {
  /** Readiness overall; 'unavailable' means readiness could not be confirmed. */
  readiness: GuidanceReadiness
  onStartAuditing: () => void
  onViewReadiness: () => void
  onDismiss: () => void
}

const POINTS = [
  {
    icon: CheckCircle2,
    text: 'Deterministic document checks run locally.',
  },
  {
    icon: CheckCircle2,
    text: 'Rendered-page preview is optional. Extracted-text evidence remains available.',
  },
  {
    icon: CheckCircle2,
    text: 'Local AI-assisted citation review is optional and uses the configured local service when available.',
  },
  {
    icon: Cloud,
    text: 'Cloud AI review requires explicit opt-in.',
  },
]

export function GuidancePanel({
  readiness,
  onStartAuditing,
  onViewReadiness,
  onDismiss,
}: GuidancePanelProps) {
  const extraNote =
    readiness === 'degraded'
      ? 'Some optional features are unavailable, but deterministic checks remain available.'
      : readiness === 'unavailable'
        ? 'System readiness could not be confirmed. You can still review the status above or try again.'
        : readiness === 'blocked'
          ? 'A required component needs attention. See System readiness above for details.'
          : null

  return (
    <section
      aria-labelledby="guidance-heading"
      className="rounded-md border border-border bg-card py-4"
    >
      <div className="flex items-start justify-between gap-3 px-4">
        <h2 id="guidance-heading" className="text-base font-semibold text-foreground">
          Welcome to ACA
        </h2>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss setup guidance"
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-input/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <ul className="mt-2 space-y-2 px-4">
        {POINTS.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-2 text-sm leading-[19px] text-muted-foreground">
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0 break-words">{text}</span>
          </li>
        ))}
      </ul>

      {extraNote && (
        <p className="mt-2 flex items-start gap-1.5 px-4 text-xs leading-[16px] text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{extraNote}</span>
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 px-4">
        <Button
          type="button"
          size="sm"
          className="min-h-[44px] bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={onStartAuditing}
        >
          Start auditing
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-[44px] border-border text-foreground"
          onClick={onViewReadiness}
        >
          View system readiness
        </Button>
        <Button asChild variant="ghost" size="sm" className="min-h-[44px] text-muted-foreground hover:text-foreground">
          <a href="/#how">Read setup guidance</a>
        </Button>
      </div>
    </section>
  )
}

export function GuidanceSlot({ children }: { children?: ReactNode }) {
  return children === undefined ? null : <>{children}</>
}
