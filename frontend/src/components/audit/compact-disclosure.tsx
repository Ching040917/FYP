/**
 * CompactDisclosure — one shared one-line disclosure pattern for the Audit
 * Report header (Profile Summary) and the Document Preview heading
 * (Selected Evidence).
 *
 * Collapsed state is exactly one visual line: the summary area shrinks
 * (`min-width: 0`, truncation with ellipsis) while the details control is a
 * clearly recognisable secondary button (visible border, contrasting
 * background, icon, open/closed chevron) that never shrinks, so the full
 * content stays one explicit, keyboard-operable press away at any width.
 *
 * Activating the control opens a viewport-level modal dialog rendered
 * through a portal to `document.body` — outside the Findings sidebar, the
 * Document Preview column, the Finding Details sidebar and every parent
 * overflow container — so no sidebar ever has to be hidden to read it.
 * The dialog follows the repository's ConfirmDialog contract: overlay
 * click closes, Escape closes, Tab focus is trapped, focus returns to the
 * triggering button, the body does not scroll behind it, `role="dialog"`
 * with `aria-modal`, a visible labelled title and a visible Close button.
 * Only one context dialog is open at a time (group announcement).
 *
 * The dialog is width-capped to the viewport with internal vertical
 * scrolling; long values wrap and never clip, and the page never gains
 * horizontal scrolling. The DOM text of the summary stays complete (CSS
 * truncation is visual only), so nothing is hidden from assistive
 * technology; no `title` tooltip is the sole access path to content.
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronUp, Minus, X } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import {
  DISCLOSURE_GROUP_EVENT,
  announceDisclosureOpen,
  isForeignDisclosureEvent,
} from '../../lib/audit/disclosure-group.ts'

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

export interface CompactDisclosureProps {
  /** Compact one-line content. Keep it short; it ellipsises visually. */
  summary: React.ReactNode
  /** Lead icon rendered before the summary (caller marks aria-hidden). */
  icon?: React.ReactNode
  /** Structured full content shown in the dialog. Use labelled rows/sections. */
  children: React.ReactNode
  /** Visible dialog title and accessible name. */
  panelLabel: string
  /** Trigger text. */
  detailsLabel: string
  /** Extra classes for the outer wrapper (sizing within the parent flex). */
  className?: string
  /** Extra classes for the dialog panel (width tweaks). */
  panelClassName?: string
  testId?: string
}

export function CompactDisclosure({
  summary,
  icon,
  children,
  panelLabel,
  detailsLabel,
  className,
  panelClassName,
  testId,
}: CompactDisclosureProps) {
  const [open, setOpen] = React.useState(false)
  const panelId = React.useId()
  const titleId = `${panelId}-title`
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const dialogRef = React.useRef<HTMLDivElement>(null)
  const closeRef = React.useRef<HTMLButtonElement>(null)

  const close = React.useCallback(() => setOpen(false), [])

  const announceOpen = React.useCallback(() => {
    setOpen(true)
    announceDisclosureOpen(panelId)
  }, [panelId])

  // Only one context dialog open at a time: a foreign announcement closes
  // this one. Closing never announces, so there is no loop.
  React.useEffect(() => {
    if (typeof window === 'undefined') return
    const onGroup = (event: Event) => {
      if (isForeignDisclosureEvent(event, panelId)) setOpen(false)
    }
    window.addEventListener(DISCLOSURE_GROUP_EVENT, onGroup)
    return () => window.removeEventListener(DISCLOSURE_GROUP_EVENT, onGroup)
  }, [panelId])

  // Modal dialog contract (mirrors ConfirmDialog): initial focus on Close,
  // Escape closes, Tab focus is trapped, body scroll locks, and focus
  // returns to the triggering button on close.
  React.useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        return
      }
      if (e.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      triggerRef.current?.focus?.()
    }
  }, [open ])

  const Chevron = open ? ChevronUp : ChevronDown

  return (
    <span
      data-testid={testId}
      className={cn('inline-flex min-w-0 max-w-full items-center gap-1.5', className)}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {icon}
        <span className="min-w-0 flex-1 truncate">{summary}</span>
      </span>
      <Button
        ref={triggerRef}
        variant="outline"
        size="sm"
        className="h-6 shrink-0 gap-1 bg-card px-2 text-[11px]"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? close() : announceOpen())}
      >
        {detailsLabel}
        <Chevron className="h-3 w-3" aria-hidden="true" />
      </Button>
      {open && typeof document !== 'undefined'
        ? createPortal(
          <span
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={close}
          >
            <span
              id={panelId}
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              onClick={(e) => e.stopPropagation()}
              className={cn(
                'max-h-[calc(100vh-2rem)] w-full max-w-[560px] overflow-y-auto rounded-md border border-border bg-card p-4 shadow-tonal-high',
                panelClassName,
              )}
            >
              <span className="flex items-start justify-between gap-3">
                <span id={titleId} className="text-base font-semibold text-foreground">
                  {panelLabel}
                </span>
                <Button
                  ref={closeRef}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 gap-1 px-2 text-xs"
                  aria-label="Close dialog"
                  onClick={close}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  Close
                </Button>
              </span>
              <span className="mt-3 block">{children}</span>
            </span>
          </span>,
          document.body,
        )
        : null}
    </span>
  )
}

/** Label/value rows for dialog content — structured, never one long paragraph. */
export function DisclosureRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px] leading-[19px]">
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt className="whitespace-nowrap font-medium text-foreground">{label}</dt>
          <dd className="min-w-0 break-words text-foreground [overflow-wrap:anywhere]">{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

export interface DisclosureSection {
  heading: string
  items: Array<{ text: string; tone: 'check' | 'plain' | 'muted' }>
  groups?: Array<{ heading: string; items: DisclosureSection['items'] }>
  note?: string
}

/**
 * Grouped dialog sections with clear headings — identity, enabled checks
 * and not-checked checks read as separate groups, never one long sentence.
 */
export function DisclosureSections({ sections }: { sections: DisclosureSection[] }) {
  return (
    <span className="block space-y-4">
      {sections.map((section) => (
        <section key={section.heading} aria-label={section.heading}>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{section.heading}</h3>
          {(section.groups?.length ? section.groups : [{ heading: '', items: section.items }]).map((group) => (
            <div key={group.heading} className="mt-2">
              {group.heading && <h4 className="text-[13px] font-medium text-foreground">{group.heading}</h4>}
              <ul className="mt-1.5 space-y-1">
            {group.items.map((item) => (
              <li
                key={item.text}
                className="flex items-start gap-2 text-[13px] leading-[19px] text-foreground"
              >
                {item.tone === 'check' ? (
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
                ) : item.tone === 'muted' ? (
                  <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                ) : null}
                <span className={cn('min-w-0 break-words [overflow-wrap:anywhere]', item.tone === 'muted' && 'text-muted-foreground')}>
                  {item.text}
                </span>
              </li>
            ))}
              </ul>
            </div>
          ))}
          {section.note && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{section.note}</p>}
        </section>
      ))}
    </span>
  )
}
