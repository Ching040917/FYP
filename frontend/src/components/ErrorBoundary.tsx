import { Component, ErrorInfo, ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to console so devs see stack; in production this would go to a reporter.
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, error: null })
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
            Something went wrong
          </h1>
          <p className="text-body-md text-on-surface-variant mb-1">
            An unexpected error interrupted the audit workflow.
          </p>
          {this.state.error?.message && (
            <p className="font-mono text-code-sm text-error/80 mb-6 break-words">
              {this.state.error.message}
            </p>
          )}
          <div className="flex items-center justify-center gap-3">
            <button onClick={this.handleReset} className="btn-ghost flex items-center gap-2">
              <RefreshCw className="w-4 h-4" />
              Try Again
            </button>
            <button onClick={this.handleReload} className="btn-primary">
              Reload App
            </button>
          </div>
        </div>
      </div>
    )
  }
}