/**
 * System Readiness Card (Build B1) — Dashboard, above the UploadCard.
 *
 * Presentation-only: fetches GET /api/readiness once on mount and on
 * explicit Refresh (`?refresh=1`). Validates through adaptReadiness; malformed
 * payloads never become "ready". Does not gate Upload/Run Audit — behavioral
 * gating is Build B2. Never renders raw IDs, hosts, paths, keys, provider
 * responses, or exception text.
 */
import * as React from 'react'
import {
  CheckCircle2,
  AlertTriangle,
  Info,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Minus,
} from 'lucide-react'
import { Button } from '../ui/button'
import { CardContent, CardHeader, CardTitle } from '../ui/card'
import { api } from '../../services/api'
import {
  adaptReadiness,
  overallHeadline,
  overallSupporting,
  issueCountSentence,
  isCloudAvailableFromModel,
  type ReadinessComponentRow,
  type ReadinessModel,
} from '../../lib/readiness'
import { cn } from '../../lib/utils'

type CardState = 'checking' | 'loaded' | 'error'

export function ReadinessCard({
  onCloudAvailable: onCloudAvailableProp,
}: {
  onCloudAvailable?: (available: boolean | null) => void
}) {
  const [state, setState] = React.useState<CardState>('checking')
  const [model, setModel] = React.useState<ReadinessModel | null>(null)
  const [expanded, setExpanded] = React.useState(false)
  const [refreshing, setRefreshing] = React.useState(false)
  const [refreshError, setRefreshError] = React.useState(false)
  const fetchingRef = React.useRef(false)
  const mountedRef = React.useRef(false)
  const onCloudAvailableRef = React.useRef(onCloudAvailableProp)
  React.useEffect(() => {
    onCloudAvailableRef.current = onCloudAvailableProp
  }, [onCloudAvailableProp])

  // Bubble the derived Cloud availability after each load/error, exactly once
  // per fetch completion (not during fetch). `null` means checking/fetch
  // failure — caller treats it as not-available.
  const publishCloudAvailable = React.useCallback(
    (m: ReadinessModel | null, isChecking: boolean) => {
      const cb = onCloudAvailableRef.current
      if (!cb) return
      if (isChecking && m === null) cb(null)
      else cb(isCloudAvailableFromModel(m))
    },
    [],
  )

  const fetchReadiness = React.useCallback(async (refresh: boolean) => {
    if (fetchingRef.current) return
    fetchingRef.current = true
    if (refresh) setRefreshing(true)
    try {
      const raw = await api.getReadiness(refresh)
      const parsed = adaptReadiness(raw)
      if (!parsed) {
        // Malformed — never claim ready. First load becomes an error;
        // refresh keeps the last valid result.
        if (!model) {
          setState('error')
          setModel(null)
          publishCloudAvailable(null, false)
        } else {
          setRefreshError(true)
        }
        return
      }
      setModel(parsed)
      setState('loaded')
      setRefreshError(false)
      publishCloudAvailable(parsed, false)
    } catch {
      if (!model) {
        setState('error')
        publishCloudAvailable(null, false)
      } else {
        setRefreshError(true)
      }
    } finally {
      fetchingRef.current = false
      setRefreshing(false)
    }
  }, [model, publishCloudAvailable])

  // Initial mount: one request, uses Backend cache.
  React.useEffect(() => {
    if (mountedRef.current) return
    mountedRef.current = true
    publishCloudAvailable(null, true)
    void fetchReadiness(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const headline =
    state === 'checking'
      ? 'Checking system readiness'
      : state === 'error'
        ? 'System readiness could not be checked'
        : overallHeadline(model!.overall)

  const supporting =
    state === 'checking'
      ? ''
      : state === 'error'
        ? 'You can try again. Existing audit controls remain unchanged.'
        : overallSupporting(model!.overall)

  const showViewDetails = state === 'loaded' && model !== null
  const detailsId = 'readiness-details'

  return (
    <section
      aria-labelledby="readiness-heading"
      className="rounded-md border border-border bg-card py-4"
    >
      <CardHeader className="pb-3">
        <CardTitle id="readiness-heading" className="text-base font-semibold">
          System readiness
        </CardTitle>
        <div
          role="status"
          aria-live="polite"
          className="mt-1 space-y-1 text-sm"
        >
          <p className="font-medium text-foreground">{headline}</p>
          {supporting && <p className="text-muted-foreground">{supporting}</p>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {state === 'error' ? (
          <div role="alert" className="rounded-md border border-border bg-input/20 px-3 py-2.5 text-sm">
            <p className="flex items-start gap-1.5 text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              System readiness could not be checked. You can try again.
            </p>
          </div>
        ) : state === 'checking' ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Checking system readiness
          </p>
        ) : (
          (() => {
            const m = model
            if (!m) return null
            return (
              <>
            {m.overall === 'degraded' || m.overall === 'blocked' ? (
              <p className="text-sm text-muted-foreground">
                {issueCountSentence(m.overall, m.rows)}
              </p>
            ) : null}

            {refreshError && (
              <p role="status" className="text-xs text-muted-foreground">
                Could not refresh right now. Showing the previous status.
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {showViewDetails && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="border-border text-foreground min-h-[44px]"
                  aria-expanded={expanded}
                  aria-controls={detailsId}
                  onClick={() => setExpanded((e) => !e)}
                >
                  {expanded ? (
                    <>
                      <ChevronDown className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      Hide details
                    </>
                  ) : (
                    <>
                      <ChevronRight className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      View details
                    </>
                  )}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-border text-foreground min-h-[44px]"
                onClick={() => void fetchReadiness(true)}
                disabled={refreshing}
                aria-label="Refresh system readiness"
              >
                {refreshing ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                )}
                Refresh
              </Button>
            </div>

            {expanded && (
              <div
                id={detailsId}
                className="space-y-2 border-t border-border pt-3"
              >
                {m.rows.map((row) => (
                  <ReadinessRow key={row.id} row={row} />
                ))}
              </div>
            )}
              </>
            )
          })()
        )}
      </CardContent>
    </section>
  )
}

function ReadinessRow({ row }: { row: ReadinessComponentRow }) {
  const Icon = iconFor(row)
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-input/20 px-3 py-2.5 min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{row.label}</span>
        <span className={cn('shrink-0 text-xs font-medium', stateTone(row.state))}>
          {row.stateLabel}
        </span>
      </div>
      <p className="min-w-0 text-xs leading-[16px] text-muted-foreground break-words">
        {row.message}
      </p>
      {row.detail && (
        <p className="min-w-0 text-xs leading-[16px] text-muted-foreground break-words">
          {row.detail}
        </p>
      )}
    </div>
  )
}

function iconFor(row: ReadinessComponentRow) {
  if (row.state === 'ready') return CheckCircle2
  if (row.state === 'unavailable') return AlertTriangle
  if (row.state === 'misconfigured') return AlertTriangle
  if (row.state === 'optional') return Minus
  return Info
}

function stateTone(state: ReadinessComponentRow['state']): string {
  if (state === 'ready') return 'text-secondary'
  if (state === 'unavailable') return 'text-warning'
  if (state === 'misconfigured') return 'text-destructive'
  if (state === 'optional') return 'text-muted-foreground'
  return 'text-muted-foreground'
}
