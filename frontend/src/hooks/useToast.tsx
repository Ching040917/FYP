import { createContext, useContext, useState, ReactNode, useCallback } from 'react'
import { CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react'

interface Toast {
  id: string
  message: string
  type: 'success' | 'error' | 'warning' | 'info'
  duration?: number
}

interface ToastContextType {
  toasts: Toast[]
  showToast: (message: string, type: Toast['type'], duration?: number) => void
  dismissToast: (id: string) => void
}

const ToastContext = createContext<ToastContextType | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const showToast = useCallback((message: string, type: Toast['type'], duration = 5000) => {
    const id = Math.random().toString(36).slice(2)
    setToasts(prev => [...prev, { id, message, type, duration }])
    if (duration > 0) {
      setTimeout(() => dismissToast(id), duration)
    }
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ toasts, showToast, dismissToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  )
}

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  // Intentionally NOT a live region: each toast item carries its own
  // role="status"/"alert" so a newly mounted toast is announced exactly once.
  // A live region on the container would re-announce the whole list every
  // time another toast is added or dismissed (duplicate announcements).
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(toast => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const typeStyles = {
    success: 'bg-secondary/90 text-on-secondary border-secondary',
    error: 'bg-error/90 text-on-error border-error',
    warning: 'bg-warning/90 text-white border-warning',
    info: 'bg-primary/90 text-on-primary border-primary',
  }

  const icons = {
    success: <CheckCircle className="w-5 h-5" />,
    error: <AlertCircle className="w-5 h-5" />,
    warning: <AlertTriangle className="w-5 h-5" />,
    info: <Info className="w-5 h-5" />,
  }

  return (
    /* role="alert" for urgent failures; role="status" for normal feedback.
       Both imply the correct aria-live politeness and announce once on mount. */
    <div
      role={toast.type === 'error' ? 'alert' : 'status'}
      className={`flex items-center gap-3 px-4 py-3 rounded-lg border shadow-tonal-high min-w-[280px] max-w-md pointer-events-auto animate-slide-in ${typeStyles[toast.type]}`}
    >
      {icons[toast.type]}
      <p className="text-body-md flex-1">{toast.message}</p>
      <button type="button" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)} className="text-current opacity-70 hover:opacity-100">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
      </button>
    </div>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used within ToastProvider')
  return context
}