import { Component, ErrorInfo, ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
}

/**
 * Audit-route error boundary (Build: detached-buffer containment).
 *
 * Catches render-phase errors on the Audit page and shows a calm recovery
 * message with a single "Try reloading the preview" action. Deliberately
 * does NOT expose the raw React stack trace to general users — the global
 * boundary prints internals; this route boundary is the general-user
 * surface for preview failures.
 *
 * Note: async/effect errors (like a detached-buffer `.slice()`) are caught
 * by the try/catch guards in the PDF byte consumers, not by a class
 * boundary (React boundaries only catch render-phase throws). This
 * boundary is the belt-and-suspenders for any render-time failure.
 */
export class AuditRouteErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Dev diagnostics only — never surfaced to general users.
    console.error('[AuditRouteErrorBoundary]', error, info.componentStack)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="card-elevated p-8 max-w-lg w-full text-center">
          <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-error/10 flex items-center justify-center">
            <AlertTriangle className="w-7 h-7 text-error" />
          </div>
          <h1 className="text-headline-md font-semibold text-on-surface mb-2">
            Preview unavailable
          </h1>
          <p className="text-body-md text-on-surface-variant mb-6">
            The document preview could not be loaded. Try reloading the preview.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button onClick={this.handleReload} className="btn-primary flex items-center gap-2">
              <RefreshCw className="w-4 h-4" />
              Reload preview
            </button>
          </div>
        </div>
      </div>
    )
  }
}
