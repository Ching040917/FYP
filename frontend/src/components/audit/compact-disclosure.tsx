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
 * Native top-layer modality, focus and scrolling are owned by
 * SupportingDetailsDialog. Overlay click and Escape close it.
 * Only one context dialog is open at a time (group announcement).
 *
 * The dialog is width-capped to the viewport with internal vertical
 * scrolling; long values wrap and never clip, and the page never gains
 * horizontal scrolling. The DOM text of the summary stays complete (CSS
 * truncation is visual only), so nothing is hidden from assistive
 * technology; no `title` tooltip is the sole access path to content.
 */
import * as React from 'react'
import { ChevronDown, ChevronUp, Minus } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import {
  DISCLOSURE_GROUP_EVENT,
  announceDisclosureOpen,
  isForeignDisclosureEvent,
} from '../../lib/audit/disclosure-group.ts'
import { SupportingDetailsDialog } from './supporting-details-dialog'


export interface CompactDisclosureProps {
  /** Compact one-line content. Keep it short; it ellipsises visually. */
  summary: React.ReactNode
  /** Lead icon rendered before the summary (caller marks aria-hidden). */
  icon?: React.ReactNode
  /** Structured full content shown in the dialog. Use labelled rows/sections. */
  children: React.ReactNode
  /** Visible dialog title and accessible name. */
  panelLabel: string
  /** Persistent read-only context beneath the dialog title. */
  panelContext?: string
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
  panelContext,
  detailsLabel,
  className,
  panelClassName,
  testId,
}: CompactDisclosureProps) {
  const [open, setOpen] = React.useState(false)
  const panelId = React.useId()
  const triggerRef = React.useRef<HTMLButtonElement>(null)

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
      {open && (
        <SupportingDetailsDialog id={panelId} title={panelLabel} context={panelContext} onClose={close} className={cn('max-w-[560px]', panelClassName)}>
          {children}
        </SupportingDetailsDialog>
      )}
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
    <div className="space-y-5">
      {sections.map((section) => (
        <section key={section.heading} aria-label={section.heading} className="border-t border-border pt-4">
          <h3 className="text-base font-semibold text-primary">{section.heading}</h3>
          {section.note && <p className="mt-2 text-[13px] leading-5 text-muted-foreground">{section.note}</p>}
          {section.items.length === 0 ? <p className="mt-3 text-[13px] leading-5 text-muted-foreground">None</p> : (
          <div data-requirement-groups className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-4">
          {(section.groups?.length ? section.groups : [{ heading: '', items: section.items }]).map((group) => (
            <div key={group.heading} className="min-w-0">
              {group.heading && <h4 className="text-[13px] font-medium text-foreground">{group.heading}</h4>}
              <ul className="mt-1.5 space-y-1">
            {group.items.map((item) => (
              <li
                key={item.text}
                className="flex items-start gap-2 text-[13px] leading-[19px] text-foreground"
              >
                {item.tone === 'check' ? (
                  <span className="w-3.5 shrink-0 text-center text-primary" aria-hidden="true">•</span>
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
          </div>
          )}
        </section>
      ))}
    </div>
  )
}
