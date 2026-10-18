/**
 * System Readiness Card (Build B1) — Dashboard, above the UploadCard.
 *
 * Presentation-only: fetches GET /api/readiness once on mount and on
 * explicit Refresh (`?refresh=1`). Validates through adaptReadiness; malformed
 * payloads never become "ready". Never gates Upload/Run Audit — the validated
 * overall is published upward only to label the first-run guidance panel.
 * Never renders raw IDs, hosts, paths, keys, provider responses, or exception
 * text.
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
import { ConfirmDialog } from '../ui/confirm-dialog'
import { LocalModelDownloadPanel } from './local-model-download-panel'
import { api } from '../../services/api'
import type { LocalModelDownloadStatus } from '../../types/api'
import {
  DOWNLOAD_POLL_INTERVAL_MS,
  LOCAL_MODEL_COPY,
  adaptDownloadStatus,
  isDownloadActive,
} from '../../lib/local-model-download'
import {
  adaptReadiness,
  overallHeadline,
  overallSupporting,
  issueCountSentence,
  type ReadinessComponentRow,
  type ReadinessModel,
  type ReadinessOverall,
} from '../../lib/readiness'
import {
  SETUP_COPY,
  SETUP_COMPONENTS,
  OFFICIAL_URLS,
  EXTERNAL_LINK_ATTRS,
  isLibreOfficeMissing,
  isOllamaMissing,
  isModelMissing,
  modelNameFromDetail,
  modelInstallCommand,
} from '../../lib/setup-paths'
import { cn } from '../../lib/utils'

type CardState = 'checking' | 'loaded' | 'error'

export function ReadinessCard({
  onReadinessChange: onReadinessChangeProp,
  expandSignal = 0,
  detailsSlot,
}: {
  /**
   * Receives the validated overall readiness after each load/error, exactly
   * once per fetch completion. `null` means checking, or the fetch failed.
   */
  onReadinessChange?: (overall: ReadinessOverall | null) => void
  /** Increment to programmatically expand + focus this card (e.g. from guidance). */
  expandSignal?: number
  /** Optional extra content rendered at the bottom of expanded details. */
  detailsSlot?: React.ReactNode
}) {
  const [state, setState] = React.useState<CardState>('checking')
  const [model, setModel] = React.useState<ReadinessModel | null>(null)
  const [expanded, setExpanded] = React.useState(false)
  const [refreshing, setRefreshing] = React.useState(false)
  const [refreshError, setRefreshError] = React.useState(false)
  // Local AI Citation Guidance — download state lives at card level so an
  // ordinary readiness refresh (which replaces `model`) cannot unmount an
  // in-flight download view.
  const [download, setDownload] = React.useState<LocalModelDownloadStatus | null>(null)
  const [downloadBusy, setDownloadBusy] = React.useState(false)
  const [downloadStartFailed, setDownloadStartFailed] = React.useState(false)
  const [downloadHidden, setDownloadHidden] = React.useState(false)
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const downloadPollRef = React.useRef(false)
  const pollTimerRef = React.useRef<number | null>(null)
  const fetchingRef = React.useRef(false)
  const mountedRef = React.useRef(false)
  const onReadinessChangeRef = React.useRef(onReadinessChangeProp)
  React.useEffect(() => {
    onReadinessChangeRef.current = onReadinessChangeProp
  }, [onReadinessChangeProp])

  // Bubble the validated overall readiness after each load/error, exactly once
  // per fetch completion (not during fetch). `null` means checking or the
  // fetch failed — the caller treats it as not confirmed.
  const publishReadiness = React.useCallback(
    (m: ReadinessModel | null, isChecking: boolean) => {
      const cb = onReadinessChangeRef.current
      if (!cb) return
      if (isChecking && m === null) cb(null)
      else cb(m === null ? null : m.overall)
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
          publishReadiness(null, false)
        } else {
          setRefreshError(true)
        }
        return
      }
      setModel(parsed)
      setState('loaded')
      setRefreshError(false)
      publishReadiness(parsed, false)
    } catch {
      if (!model) {
        setState('error')
        publishReadiness(null, false)
      } else {
        setRefreshError(true)
      }
    } finally {
      fetchingRef.current = false
      setRefreshing(false)
    }
  }, [model, publishReadiness])

  /**
   * Read the Backend's download snapshot. Malformed payloads are dropped, so
   * a bad response can never render as a completed download.
   */
  const refreshDownloadStatus = React.useCallback(async () => {
    if (downloadPollRef.current) return null
    downloadPollRef.current = true
    try {
      const parsed = adaptDownloadStatus(await api.getLocalModelDownloadStatus())
      setDownload(parsed)
      return parsed
    } catch {
      return null
    } finally {
      downloadPollRef.current = false
    }
  }, [])

  /** Poll once per second while a download is active; stop on any terminal state. */
  React.useEffect(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
    if (!isDownloadActive(download)) return

    pollTimerRef.current = window.setTimeout(async () => {
      pollTimerRef.current = null
      const next = await refreshDownloadStatus()
      // Readiness is re-derived from the Backend, which independently
      // confirms the model through Ollama's installed-model list first.
      if (next?.state === 'completed') void fetchReadiness(true)
    }, DOWNLOAD_POLL_INTERVAL_MS)

    return () => {
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [download, refreshDownloadStatus, fetchReadiness])

  /** Start the download. Runs only after the user confirms in the dialog. */
  const startDownload = React.useCallback(async () => {
    if (downloadBusy || isDownloadActive(download)) return
    setDownloadBusy(true)
    setConfirmOpen(false)
    setDownloadHidden(false)
    setDownloadStartFailed(false)
    try {
      await api.startLocalModelDownload()
      await refreshDownloadStatus()
    } catch {
      // Never surface the raw failure; the manual command stays available.
      setDownloadStartFailed(true)
    } finally {
      setDownloadBusy(false)
    }
  }, [downloadBusy, download, refreshDownloadStatus])

  // Initial mount: one request each, using the Backend cache for readiness.
  React.useEffect(() => {
    if (mountedRef.current) return
    mountedRef.current = true
    publishReadiness(null, true)
    void fetchReadiness(false)
    // Re-attach to a download that was already running (e.g. the user
    // navigated away and came back).
    void refreshDownloadStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // External expand signal (e.g. first-run guidance "View system readiness").
  const lastExpandSignal = React.useRef(0)
  React.useEffect(() => {
    if (expandSignal > 0 && expandSignal !== lastExpandSignal.current) {
      lastExpandSignal.current = expandSignal
      setExpanded(true)
      const el = document.getElementById('readiness-heading')
      el?.scrollIntoView({ block: 'center' })
      ;(el as HTMLElement | null)?.focus?.({ preventScroll: true })
    }
  }, [expandSignal])

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

  // Single object keeps ReadinessRow / SetupPathway props readable.
  const downloadUi: DownloadUi = {
    status: download,
    busy: downloadBusy,
    startFailed: downloadStartFailed,
    hidden: downloadHidden,
    onRequest: () => setConfirmOpen(true),
    onRetry: () => void startDownload(),
    onHide: () => setDownloadHidden(true),
    onShow: () => setDownloadHidden(false),
  }

  return (
    <section
      aria-labelledby="readiness-heading"
      className="rounded-md border border-border bg-card px-4 py-3"
    >
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-x-5 gap-y-2 p-0">
        <CardTitle
          id="readiness-heading"
          tabIndex={-1}
          className="shrink-0 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          System readiness
        </CardTitle>
        <div
          role="status"
          aria-live="polite"
          className="min-w-0 flex-1 text-sm"
        >
          <p className="flex items-center gap-2 font-medium text-foreground">
            {state === 'checking' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" /> : model?.overall === 'ready' ? <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" /> : <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />}
            {headline}
          </p>
          {supporting && <p className="mt-0.5 text-xs text-muted-foreground">{supporting}</p>}
        </div>
            <div className="flex flex-wrap items-center gap-2">
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
      </CardHeader>
      <CardContent className={expanded || refreshError ? 'space-y-3 px-0 pb-0 pt-3' : 'hidden'}>
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
            {expanded && (m.overall === 'degraded' || m.overall === 'blocked') ? (
              <p className="text-sm text-muted-foreground">
                {issueCountSentence(m.overall, m.rows)}
              </p>
            ) : null}

            {refreshError && (
              <p role="status" className="text-xs text-muted-foreground">
                Could not refresh right now. Showing the previous status.
              </p>
            )}


            {expanded && (
              <div
                id={detailsId}
                className="space-y-2 border-t border-border pt-3"
              >
                {supporting && <p className="text-sm text-muted-foreground">{supporting}</p>}
                {m.rows.map((row) => (
                  <ReadinessRow
                    key={row.id}
                    row={row}
                    rows={m.rows}
                    onCheckAgain={() => void fetchReadiness(true)}
                    refreshing={refreshing}
                    downloadUi={downloadUi}
                  />
                ))}
                {detailsSlot && <div className="pt-1">{detailsSlot}</div>}
              </div>
            )}
              </>
            )
          })()
        )}
      </CardContent>
      {confirmOpen ? (
        <ConfirmDialog
          title={LOCAL_MODEL_COPY.confirmTitle}
          description={LOCAL_MODEL_COPY.confirmIntro}
          details={
            <>
              <p>{LOCAL_MODEL_COPY.confirmCost}</p>
              <p>{LOCAL_MODEL_COPY.confirmHardware}</p>
              <p>{LOCAL_MODEL_COPY.confirmReassurance}</p>
            </>
          }
          confirmLabel={LOCAL_MODEL_COPY.confirmStart}
          cancelLabel={LOCAL_MODEL_COPY.confirmCancel}
          busy={downloadBusy}
          onConfirm={() => void startDownload()}
          onCancel={() => setConfirmOpen(false)}
        />
      ) : null}
    </section>
  )
}

/** Download state + actions threaded from the card into the pathway UI. */
interface DownloadUi {
  status: LocalModelDownloadStatus | null
  busy: boolean
  startFailed: boolean
  hidden: boolean
  onRequest: () => void
  onRetry: () => void
  onHide: () => void
  onShow: () => void
}

function ReadinessRow({
  row,
  rows,
  onCheckAgain,
  refreshing,
  downloadUi,
}: {
  row: ReadinessComponentRow
  rows: ReadinessComponentRow[]
  onCheckAgain: () => void
  refreshing: boolean
  downloadUi: DownloadUi
}) {
  const Icon = iconFor(row)
  const setup = setupPathwayFor(row, rows)
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
      {setup && (
        <SetupPathway
          setup={setup}
          onCheckAgain={onCheckAgain}
          refreshing={refreshing}
          downloadUi={downloadUi}
        />
      )}
    </div>
  )
}

/** Resolve the optional-component setup pathway for a row (or null). */
function setupPathwayFor(
  row: ReadinessComponentRow,
  rows: ReadinessComponentRow[],
): { kind: 'libreoffice' | 'ollama' | 'model'; url?: string; linkLabel?: string; body: string; command?: string; modelName?: string | null } | null {
  if (!SETUP_COMPONENTS.has(row.id) || row.state !== 'unavailable') return null
  if (isLibreOfficeMissing(row)) {
    return {
      kind: 'libreoffice',
      url: OFFICIAL_URLS.libreoffice,
      linkLabel: SETUP_COPY.libreoffice.linkLabel,
      body: SETUP_COPY.libreoffice.body,
    }
  }
  if (isOllamaMissing(row)) {
    return {
      kind: 'ollama',
      url: OFFICIAL_URLS.ollama,
      linkLabel: SETUP_COPY.ollama.linkLabel,
      body: SETUP_COPY.ollama.body,
    }
  }
  if (isModelMissing(row, rows)) {
    const name = modelNameFromDetail(row.detail)
    return {
      kind: 'model',
      body: SETUP_COPY.model.body,
      command: name ? modelInstallCommand(name) : undefined,
      modelName: name,
    }
  }
  return null
}

/**
 * Optional-component setup pathway: plain-language explanation, official
 * download link (LibreOffice/Ollama), a copyable model command, an optional
 * confirmed in-app model download, and a Check again action that reuses the
 * card's readiness refresh.
 *
 * ACA never installs anything and never executes a local command: the only
 * download it can start is the trusted configured model, by asking the user's
 * own Ollama service, and only after explicit confirmation.
 */
function SetupPathway({
  setup,
  onCheckAgain,
  refreshing,
  downloadUi,
}: {
  setup: { kind: 'libreoffice' | 'ollama' | 'model'; url?: string; linkLabel?: string; body: string; command?: string; modelName?: string | null }
  onCheckAgain: () => void
  refreshing: boolean
  downloadUi: DownloadUi
}) {
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle')
  const command = setup.kind === 'model' && setup.command ? setup.command : null
  // The download status payload is authoritative; the readiness detail is the
  // fallback so the name is never guessed locally.
  const modelName = downloadUi.status?.model_name ?? setup.modelName ?? null
  const downloadStarted =
    downloadUi.status !== null && downloadUi.status.state !== 'idle'
  const showDownloadAction =
    setup.kind === 'model' && !downloadStarted && !downloadUi.busy

  async function copyCommand() {
    if (!command) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(command)
        setCopyState('copied')
      } else {
        setCopyState('failed')
      }
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <div className="mt-1 space-y-2 rounded-md border border-border bg-background/60 px-3 py-2.5">
      <p className="text-xs font-medium text-foreground">
        {SETUP_COPY.optionalNote} —{' '}
        {setup.kind === 'libreoffice'
          ? SETUP_COPY.libreoffice.title
          : setup.kind === 'ollama'
            ? SETUP_COPY.ollama.title
            : SETUP_COPY.model.title}
      </p>
      {setup.kind === 'model' && (
        <>
          <p className="text-xs leading-[16px] text-muted-foreground break-words">
            {LOCAL_MODEL_COPY.scope}
          </p>
          <p className="text-xs leading-[16px] text-muted-foreground break-words">
            {LOCAL_MODEL_COPY.accuracy}
          </p>
          {modelName ? (
            <p className="text-xs leading-[16px] text-muted-foreground break-words">
              {LOCAL_MODEL_COPY.modelLabel}:{' '}
              <span className="font-mono text-foreground">{modelName}</span>
            </p>
          ) : null}
          <p className="text-xs leading-[16px] text-muted-foreground break-words">
            {LOCAL_MODEL_COPY.sizeLabel}: {LOCAL_MODEL_COPY.sizeValue}
          </p>
        </>
      )}
      <p className="text-xs leading-[16px] text-muted-foreground break-words">{setup.body}</p>
      {setup.url && setup.linkLabel && (
        <p className="text-xs text-muted-foreground break-words">{SETUP_COPY.thirdPartyNote}</p>
      )}
      {command !== null && (
        <div>
          <p className="mb-1 text-xs font-medium text-foreground">
            {LOCAL_MODEL_COPY.modelLabel}
          </p>
          <code
            data-testid="model-command"
            className="block select-all rounded border border-border bg-input/40 px-2 py-1.5 font-mono text-xs text-foreground break-all"
          >
            {command}
          </code>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {showDownloadAction && (
          <Button
            type="button"
            size="sm"
            className="min-h-[44px]"
            onClick={downloadUi.onRequest}
            disabled={downloadUi.busy}
          >
            {LOCAL_MODEL_COPY.downloadAction}
          </Button>
        )}
        {setup.url && setup.linkLabel && (
          <a
            href={setup.url}
            {...EXTERNAL_LINK_ATTRS}
            className="inline-flex min-h-[44px] items-center rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {setup.linkLabel}
          </a>
        )}
        {command !== null && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-border text-foreground min-h-[44px]"
            onClick={() => void copyCommand()}
          >
            {copyState === 'copied' ? SETUP_COPY.model.copiedLabel : SETUP_COPY.model.copyLabel}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-border text-foreground min-h-[44px]"
          onClick={onCheckAgain}
          disabled={refreshing}
        >
          {refreshing ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : null}
          Check again
        </Button>
      </div>
      {setup.kind === 'model' && downloadStarted ? (
        downloadUi.hidden ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-border text-foreground min-h-[44px]"
            onClick={downloadUi.onShow}
          >
            {LOCAL_MODEL_COPY.showProgress}
          </Button>
        ) : downloadUi.status ? (
          <LocalModelDownloadPanel
            status={downloadUi.status}
            busy={downloadUi.busy}
            onRetry={downloadUi.onRetry}
            onHide={downloadUi.onHide}
          />
        ) : null
      ) : null}
      {setup.kind === 'model' && downloadUi.startFailed ? (
        <p role="status" className="text-xs leading-[16px] text-muted-foreground">
          {LOCAL_MODEL_COPY.startFailed}
        </p>
      ) : null}
      {copyState !== 'idle' && (
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {copyState === 'copied'
            ? SETUP_COPY.model.copiedLabel
            : SETUP_COPY.model.copyFailedLabel}
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
