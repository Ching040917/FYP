/**
 * Accessible modal dialog (Build 3) — focus trap, Escape-to-close, focus
 * restoration, and body scroll lock. Used for the unsaved-changes warning and
 * other small confirmations. No color-only status: every message carries text.
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from '../ui/button'

export interface ConfirmDialogProps {
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
  /** Variant for the confirm action. */
  confirmVariant?: 'default' | 'destructive' | 'outline'
  busy?: boolean
  /**
   * Optional extra content rendered under the description. Included in the
   * dialog's `aria-describedby`, so richer confirmations stay screen-reader
   * complete. Existing callers pass only `description` and are unaffected.
   */
  details?: React.ReactNode
  /** Optional third decision, e.g. Save before leaving a dirty editor. */
  secondaryLabel?: string
  onSecondary?: () => void
  /** Used when the original trigger was removed by the confirmed operation. */
  fallbackFocusId?: string
}

const FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]):not(:disabled)'

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  confirmVariant = 'default',
  busy = false,
  details,
  secondaryLabel,
  onSecondary,
  fallbackFocusId,
}: ConfirmDialogProps) {
  const dialogRef = React.useRef<HTMLDivElement>(null)
  const cancelRef = React.useRef<HTMLButtonElement>(null)
  const triggerRef = React.useRef<HTMLElement | null>(null)
  const titleId = React.useId()
  const descriptionId = React.useId()
  const detailsId = React.useId()
  const [portal] = React.useState(() => document.createElement('div'))

  React.useLayoutEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null
    document.body.appendChild(portal)
    const background = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== portal)
    const previous = background.map((element) => ({ element, inert: element.inert }))
    background.forEach((element) => { element.inert = true })
    cancelRef.current?.focus()
    const prevOverflow = document.body.style.getPropertyValue('overflow')
    const prevPriority = document.body.style.getPropertyPriority('overflow')
    document.body.style.setProperty('overflow', 'hidden')
    return () => {
      document.body.style.setProperty('overflow', prevOverflow, prevPriority)
      previous.forEach(({ element, inert }) => { element.inert = inert })
      portal.remove()
      const trigger = triggerRef.current
      const fallback = fallbackFocusId ? document.getElementById(fallbackFocusId) : null
      const target = trigger?.isConnected && !trigger.closest('[inert]') && !trigger.matches(':disabled')
        ? trigger : fallback
      target?.scrollIntoView({ block: 'center', behavior: 'instant' })
      target?.focus({ preventScroll: true })
    }
  }, [portal, fallbackFocusId])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault()
        onCancel()
        return
      }
      if (e.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.getClientRects().length > 0 && !element.closest('[inert]'))
      if (focusables.length === 0) { e.preventDefault(); dialog.focus(); return }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog || !dialog.contains(document.activeElement))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog || !dialog.contains(document.activeElement))) {
        e.preventDefault()
        first.focus()
      }
    }
    const keepFocusInside = (event: FocusEvent) => {
      const dialog = dialogRef.current
      if (dialog && !dialog.contains(event.target as Node)) {
        if (busy) dialog.focus()
        else cancelRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('focusin', keepFocusInside)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', keepFocusInside)
    }
  }, [busy, onCancel])

  React.useLayoutEffect(() => {
    if (busy && dialogRef.current && !dialogRef.current.contains(document.activeElement)) dialogRef.current.focus()
    if (busy && document.activeElement instanceof HTMLElement && document.activeElement.matches(':disabled')) dialogRef.current?.focus()
  }, [busy])

  return createPortal(
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      tabIndex={-1}
      aria-busy={busy}
      aria-labelledby={titleId}
      aria-describedby={
        details
          ? `${descriptionId} ${detailsId}`
          : descriptionId
      }
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={busy ? undefined : onCancel}
    >
      <div
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-md border border-border bg-card p-5 [overflow-wrap:anywhere]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold text-foreground">
            {title}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Close dialog"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <p id={descriptionId} className="mt-2 text-sm leading-[21px] text-muted-foreground">
          {description}
        </p>
        {details ? (
          <div
            id={detailsId}
            className="mt-3 space-y-2 text-sm leading-[21px] text-muted-foreground"
          >
            {details}
          </div>
        ) : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy} ref={cancelRef}>
            {cancelLabel}
          </Button>
          {secondaryLabel && onSecondary && (
            <Button type="button" onClick={onSecondary} disabled={busy}>{secondaryLabel}</Button>
          )}
          <Button type="button" variant={confirmVariant} onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>, portal
  )
}
