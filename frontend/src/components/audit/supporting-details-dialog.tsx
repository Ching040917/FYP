import * as React from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'

/** Native modality supplies inertness; explicit Tab cycling keeps focus inside the content. */
export function SupportingDetailsDialog({ title, onClose, children, id, className }: {
  title: string
  onClose: () => void
  children: React.ReactNode
  id?: string
  className?: string
}) {
  const dialogRef = React.useRef<HTMLDialogElement>(null)
  const closeRef = React.useRef<HTMLButtonElement>(null)
  const bodyRef = React.useRef<HTMLDivElement>(null)
  const titleId = React.useId()
  const pointerStartedOutside = React.useRef(false)
  React.useEffect(() => {
    const dialog = dialogRef.current!
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overflow = document.body.style.getPropertyValue('overflow')
    const priority = document.body.style.getPropertyPriority('overflow')
    document.body.style.setProperty('overflow', 'hidden')
    dialog.showModal()
    closeRef.current?.focus({ preventScroll: true })
    if (bodyRef.current) bodyRef.current.scrollTop = 0
    return () => {
      dialog.close()
      if (overflow) document.body.style.setProperty('overflow', overflow, priority)
      else document.body.style.removeProperty('overflow')
      if (opener?.isConnected) opener.focus({ preventScroll: true })
      else {
        const fallback = document.querySelector<HTMLElement>('dialog[open], main, h1') ?? document.body
        const tabIndex = fallback.getAttribute('tabindex')
        fallback.setAttribute('tabindex', '-1')
        fallback.focus({ preventScroll: true })
        if (tabIndex === null) fallback.addEventListener('blur', () => fallback.removeAttribute('tabindex'), { once: true })
        else fallback.setAttribute('tabindex', tabIndex)
      }
    }
  }, [])
  const outside = (event: React.MouseEvent<HTMLDialogElement> | React.PointerEvent<HTMLDialogElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom
  }
  return createPortal(
    <dialog ref={dialogRef} id={id} role="dialog" aria-modal="true" aria-labelledby={titleId}
      className={cn('m-auto max-h-[calc(100dvh-1.5rem)] w-[calc(100%-1.5rem)] min-w-0 max-w-3xl overflow-hidden rounded-lg border border-border bg-card p-0 text-foreground backdrop:bg-black/60 open:flex open:flex-col', className)}
      onKeyDown={event => {
        if (event.key !== 'Tab') return
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]'))
          .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0)
        if (!controls.length) return
        event.preventDefault()
        const current = controls.indexOf(document.activeElement as HTMLElement)
        const next = current < 0 ? (event.shiftKey ? controls.length - 1 : 0)
          : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
        controls[next].focus({ preventScroll: true })
      }}
      onCancel={event => { event.preventDefault(); onClose() }}
      onPointerDown={event => { pointerStartedOutside.current = event.target === event.currentTarget && outside(event) }}
      onClick={event => { if (event.target === event.currentTarget && pointerStartedOutside.current && outside(event)) onClose() }}>
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3">
        <h2 id={titleId} className="min-w-0 flex-1 basis-40 break-words text-base font-semibold [overflow-wrap:anywhere]">{title}</h2>
        <Button ref={closeRef} autoFocus type="button" variant="outline" size="sm" className="shrink-0 gap-1" onClick={onClose}>
          <X className="h-3.5 w-3.5" aria-hidden="true" />Close
        </Button>
      </div>
      <div ref={bodyRef} tabIndex={0} data-dialog-body className="min-h-0 overflow-y-auto overscroll-contain p-4 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary [overflow-wrap:anywhere]">
        {children}
      </div>
    </dialog>, document.body,
  )
}
