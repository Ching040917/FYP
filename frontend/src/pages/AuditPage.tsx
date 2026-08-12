import { useEffect, useState, useCallback, useRef, type ReactNode, type KeyboardEvent } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '../services/api'
import { useToast } from '../hooks/useToast'
import { CheckCircle2, ChevronDown, Filter, Info, Loader2, MapPin, Quote, ShieldAlert, X, XCircle } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { AppNav } from '../components/layout/AppNav'
import { ErrorList } from '../components/audit/error-list'
import { VerdictChecklist } from '../components/audit/verdict-checklist'
import { FindingDetail } from '../components/audit/finding-detail'
import { DocumentPreview } from '../components/audit/document-preview'
import { categoryForRuleCode, humanizeRuleCode, aiProviderLabel, normalizeAiProvider } from '../lib/audit/adapter'
import { gradeFor } from '../lib/audit/scoring'
import { cn } from '../lib/utils'
import type { AuditDocumentStats, AuditResponse, DocumentBlock, Violation } from '../types/api'
import type { AuditCategory, LayoutError } from '../types/audit'

// Poll every 2s; give up after 5 minutes (150 attempts).
const POLL_INTERVAL_MS = 2000
const POLL_MAX_ATTEMPTS = 150

// Mobile/tablet workspace tabs — below lg the workspace uses a tab interface
// so findings, document, and details are each a single accessible view.
const WORKSPACE_TABS = [
  { id: 'findings', label: 'Findings' },
  { id: 'document', label: 'Document' },
  { id: 'details', label: 'Details' },
] as const
type WorkspaceView = (typeof WORKSPACE_TABS)[number]['id']

function toLayoutError(v: Violation): LayoutError {
  const loc = (v.location ?? {}) as Record<string, unknown>
  const paragraphIndex = typeof loc.paragraph_index === 'number' ? loc.paragraph_index : -1
  const position = paragraphIndex >= 0 ? paragraphIndex + 1 : 0
  return {
    id: v.id,
    category: categoryForRuleCode(v.rule_code),
    severity: v.severity === 'MAJOR' ? 'major' : 'minor',
    position,
    title: humanizeRuleCode(v.rule_code),
    detail: v.message,
    suggestion: v.expected_value ?? v.actual_value ?? 'No automatic fix available — review manually.',
    snippet: (v.actual_value ?? '').toString().slice(0, 140) || undefined,
  }
}

export function AuditPage() {
  const { auditId } = useParams<{ auditId: string }>()
  const navigate = useNavigate()
  const { showToast } = useToast()

  const [audit, setAudit] = useState<AuditResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [, setPolling] = useState(false)
  const [pollAttempts, setPollAttempts] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Document preview state — loaded once after audit is available.
  const [blocks, setBlocks] = useState<DocumentBlock[] | null>(null)
  const [blocksLoading, setBlocksLoading] = useState(false)
  const [blocksError, setBlocksError] = useState(false)
  const blocksFetchedRef = useRef(false)

  // Mobile/tablet workspace view — tabs below lg, side-by-side at lg+.
  const [mobileView, setMobileView] = useState<WorkspaceView>('findings')
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  // Ref to the detail scroll region — reset scroll position on selection change.
  const detailScrollRef = useRef<HTMLDivElement>(null)

  // Category filter — single source shared by the overview and Findings.
  const [categoryFilter, setCategoryFilter] = useState<AuditCategory | 'all'>('all')
  const [categoryOpen, setCategoryOpen] = useState(false)
  const categoryPanelRef = useRef<HTMLDivElement>(null)

  // Tablet drawer (1024–1279) — Finding Detail in a modal right drawer.
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)
  const drawerTriggerRef = useRef<HTMLElement | null>(null)

  // Close the category popover on outside click / Escape.
  useEffect(() => {
    if (!categoryOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (categoryPanelRef.current && !categoryPanelRef.current.contains(e.target as Node)) {
        setCategoryOpen(false)
      }
    }
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setCategoryOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [categoryOpen])

  const handleCategorySelect = (category: string) => {
    setCategoryFilter((cur) => (cur === category ? 'all' : (category as AuditCategory)))
  }

  // Focus enters the drawer, Esc closes, focus returns to the trigger.
  useEffect(() => {
    if (!drawerOpen) return
    drawerTriggerRef.current = document.activeElement as HTMLElement | null
    drawerRef.current?.querySelector<HTMLButtonElement>('[data-drawer-close]')?.focus()
  }, [drawerOpen])

  const closeDrawer = () => {
    setDrawerOpen(false)
    drawerTriggerRef.current?.focus()
    drawerTriggerRef.current = null
  }

  const handleDrawerKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeDrawer()
      return
    }
    if (e.key !== 'Tab') return
    const dialog = drawerRef.current
    if (!dialog) return
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
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

  // Tablet (lg 1024–1279): selecting a finding opens the Detail drawer.
  const handleTabletSelect = (e: LayoutError) => {
    setSelectedId(e.id)
    setDrawerOpen(true)
  }

  // Roving-tabindex keyboard nav for the mobile tablist (auto-activation).
  const handleTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null
    if (e.key === 'ArrowRight') next = (index + 1) % WORKSPACE_TABS.length
    else if (e.key === 'ArrowLeft') next = (index - 1 + WORKSPACE_TABS.length) % WORKSPACE_TABS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = WORKSPACE_TABS.length - 1
    else return
    e.preventDefault()
    const tab = WORKSPACE_TABS[next]
    setMobileView(tab.id)
    tabRefs.current.get(tab.id)?.focus()
  }

  // Selecting a finding on mobile opens the Document view when the linked
  // paragraph is available, otherwise Details — never an empty Document.
  const handleMobileSelect = (e: LayoutError) => {
    setSelectedId(e.id)
    const locatable = e.position > 0 && blocks !== null && blocks.length > 0
    setMobileView(locatable ? 'document' : 'details')
  }

  // Reset detail scroll to top when the selected finding changes — no focus
  // theft; the user's keyboard cursor stays exactly where it was.
  useEffect(() => {
    if (detailScrollRef.current) {
      detailScrollRef.current.scrollTop = 0
    }
  }, [selectedId])
  const attemptsRef = useRef(0)
  const pollingRef = useRef(false)
  const inFlightRef = useRef(false)

  const fetchAudit = useCallback(async () => {
    if (!auditId || inFlightRef.current) return
    inFlightRef.current = true
    try {
      const data = await api.getAudit(auditId)
      setAudit(data)
      if (data.status === 'processing') {
        pollingRef.current = true
        setPolling(true)
        attemptsRef.current += 1
        setPollAttempts(attemptsRef.current)
      } else {
        pollingRef.current = false
        setPolling(false)
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load audit')
      pollingRef.current = false
      setPolling(false)
      showToast(err.message || 'Failed to load audit', 'error')
    } finally {
      setLoading(false)
      inFlightRef.current = false
    }
  }, [auditId, showToast])

  // Initial fetch + polling lifecycle.
  useEffect(() => {
    if (!auditId) return
    attemptsRef.current = 0
    pollingRef.current = false
    setPollAttempts(0)

    fetchAudit()
    const interval = setInterval(() => {
      if (!pollingRef.current) return
      if (attemptsRef.current >= POLL_MAX_ATTEMPTS) {
        pollingRef.current = false
        setPolling(false)
        const msg = 'Audit is taking longer than expected. Please refresh or try again later.'
        setError(msg)
        showToast(msg, 'error')
        return
      }
      fetchAudit()
    }, POLL_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [auditId, fetchAudit, showToast])

  // Preselect the first finding once a completed audit arrives.
  useEffect(() => {
    if (!audit || audit.status !== 'completed') return
    if (selectedId === null && audit.violations.length > 0) {
      setSelectedId(audit.violations[0].id)
    }
  }, [audit, selectedId])

  // Load document blocks once the audit is available.
  useEffect(() => {
    if (!auditId || !audit || audit.status !== 'completed' || blocksFetchedRef.current) return
    blocksFetchedRef.current = true
    setBlocksLoading(true)
    api.getDocumentBlocks(auditId)
      .then((data) => setBlocks(data.blocks))
      .catch(() => {
        setBlocks(null)
        setBlocksError(true)
      })
      .finally(() => setBlocksLoading(false))
  }, [auditId, audit])

  const isProcessing = audit?.status === 'processing'
  const violations = audit?.violations ?? []
  const mappedErrors = violations.map(toLayoutError)
  const selectedViolation = violations.find((v) => v.id === selectedId) ?? null
  const grade = audit ? gradeFor(audit.weighted_score) : null

  const breakdown = audit?.score_breakdown ?? []
  const catCounts = breakdown.reduce(
    (acc, b) => {
      if (b.deduction <= 0) acc.pass += 1
      else if (b.major > 0) acc.fail += 1
      else acc.warn += 1
      return acc
    },
    { fail: 0, warn: 0, pass: 0 },
  )

  // Detail stack shared by the mobile Details tab, desktop pane, and drawer.
  const renderDetailStack = (a: AuditResponse) => (
    <>
      <FindingDetail violation={selectedViolation} />
      <CitationSection audit={a} isProcessing={isProcessing} selectedViolation={selectedViolation} />
      <DocStats stats={a.document_stats} />
    </>
  )

  return (
    <div className="min-h-screen bg-background text-foreground lg:flex lg:h-dvh lg:flex-col lg:overflow-hidden">
      <a className="skip-link" href="#audit-report">
        Skip to audit report
      </a>
      <AppNav
        current="audit"
        title="Audit Report"
        subtitle={audit?.filename ?? 'Academic Compliance Auditor'}
        backTo="/dashboard"
      />

      <main
        id="audit-report"
        className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-hidden lg:py-4"
      >
        {loading ? (
          <LoadingState />
        ) : error || !audit ? (
          <ErrorState error={error} onBack={() => navigate('/dashboard')} />
        ) : (
          <>
            {/* ────────────── Compact report toolbar ────────────── */}
            <section className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border pb-3 lg:pb-4">
              <div className="min-w-0 flex-1">
                <h1 className="truncate font-serif text-lg font-semibold leading-6 text-foreground md:text-xl">
                  {audit.filename}
                </h1>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
                  <StatusBadge status={audit.status} />
                  {audit.status === 'completed' && (
                    <span>
                      {audit.major_count ?? 0} major · {audit.minor_count ?? 0} minor findings
                    </span>
                  )}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Score
                </div>
                <div className="flex items-baseline justify-end gap-1.5">
                  <span className="font-mono text-lg font-semibold text-foreground">
                    {audit.weighted_score}
                  </span>
                  <span className="text-[13px] text-muted-foreground">/100</span>
                  {grade && (
                    <span className="text-[13px] text-muted-foreground">
                      · {grade.label} {grade.grade}
                    </span>
                  )}
                </div>
              </div>

              {/* Category overview trigger — compact, never expanded by default */}
              {breakdown.length > 0 && (
                <div className="relative" ref={categoryPanelRef}>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-expanded={categoryOpen}
                    aria-controls="category-panel"
                    onClick={() => setCategoryOpen((o) => !o)}
                  >
                    <Filter className="h-3.5 w-3.5" aria-hidden="true" />
                    Categories · {breakdown.length}
                    {catCounts.fail > 0 && <span className="text-destructive">{catCounts.fail} fail</span>}
                    {catCounts.warn > 0 && <span className="text-warning">{catCounts.warn} warn</span>}
                    {catCounts.pass > 0 && <span className="text-success">{catCounts.pass} pass</span>}
                  </Button>
                  {categoryOpen && (
                    <div
                      id="category-panel"
                      className="absolute right-0 top-full z-40 mt-2 max-h-[70vh] w-[min(600px,90vw)] overflow-y-auto rounded-md border border-border bg-card p-4 shadow-tonal-high"
                    >
                      <VerdictChecklist
                        breakdown={breakdown}
                        selectedCategory={categoryFilter}
                        onSelectCategory={handleCategorySelect}
                      />
                    </div>
                  )}
                </div>
              )}
            </section>

            {isProcessing && <ProcessingBanner pollAttempts={pollAttempts} />}
            {audit.status === 'failed' && <FailedBanner />}

            {/* ────────────── Review workspace ────────────── */}
            <div className="mt-6 lg:mt-4 lg:min-h-0 lg:flex-1">
              {/* Mobile/tablet: tabbed workspace (single active panel for SR). */}
              <div className="lg:hidden">
                <div
                  role="tablist"
                  aria-label="Audit workspace views"
                  className="inline-flex w-full rounded-md border border-border bg-input/20 p-1"
                >
                  {WORKSPACE_TABS.map((tab, i) => {
                    const selected = mobileView === tab.id
                    return (
                      <button
                        key={tab.id}
                        ref={(el) => {
                          if (el) tabRefs.current.set(tab.id, el)
                          else tabRefs.current.delete(tab.id)
                        }}
                        role="tab"
                        id={`tab-${tab.id}`}
                        aria-selected={selected}
                        aria-controls={`panel-${tab.id}`}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => setMobileView(tab.id)}
                        onKeyDown={(e) => handleTabKeyDown(e, i)}
                        className={cn(
                          'flex-1 rounded px-3 py-1.5 text-sm transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                          selected
                            ? 'bg-card font-medium text-foreground ring-1 ring-border'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {tab.label}
                      </button>
                    )
                  })}
                </div>

                {/* Findings panel */}
                <div
                  role="tabpanel"
                  id="panel-findings"
                  aria-labelledby="tab-findings"
                  hidden={mobileView !== 'findings'}
                  tabIndex={0}
                  className="mt-4 space-y-6 focus:outline-none"
                >
                  {audit.status === 'completed' && violations.length === 0 ? (
                    <NoFindingsState />
                  ) : (
                    <ErrorList
                      result={{ physical_layout_errors: mappedErrors }}
                      selectedId={selectedId}
                      onSelect={handleMobileSelect}
                      categoryFilter={categoryFilter}
                      onCategoryFilterChange={setCategoryFilter}
                    />
                  )}
                </div>

                {/* Document panel — always rendered so aria-controls resolves;
                    active prop re-triggers scroll-to-block when the tab opens. */}
                <div
                  role="tabpanel"
                  id="panel-document"
                  aria-labelledby="tab-document"
                  hidden={mobileView !== 'document'}
                  tabIndex={0}
                  className="mt-4 space-y-3 focus:outline-none"
                >
                  <DocumentPreview
                    blocks={blocks}
                    violations={audit.violations}
                    selectedViolationId={selectedId}
                    isLoading={blocksLoading}
                    loadError={blocksError}
                    onSelectViolation={setSelectedId}
                    active={mobileView === 'document'}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    {selectedViolation && (
                      <Button onClick={() => setMobileView('details')} variant="outline" size="sm">
                        <ChevronDown className="h-4 w-4" aria-hidden="true" />
                        View finding details
                      </Button>
                    )}
                    <Button onClick={() => setMobileView('findings')} variant="ghost" size="sm">
                      Back to findings
                    </Button>
                  </div>
                </div>

                {/* Details panel */}
                <div
                  role="tabpanel"
                  id="panel-details"
                  aria-labelledby="tab-details"
                  hidden={mobileView !== 'details'}
                  tabIndex={0}
                  className="mt-4 space-y-6 focus:outline-none"
                >
                  {renderDetailStack(audit)}
                  <div>
                    <Button onClick={() => setMobileView('findings')} variant="ghost" size="sm">
                      Back to findings
                    </Button>
                  </div>
                </div>
              </div>

              {/* Tablet 1024–1279: Findings + Document; Detail opens as drawer. */}
              <div className="hidden h-full min-h-0 grid-cols-[32fr_68fr] items-stretch gap-6 lg:grid xl:hidden">
                <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
                  {audit.status === 'completed' && violations.length === 0 ? (
                    <NoFindingsState />
                  ) : (
                    <ErrorList
                      result={{ physical_layout_errors: mappedErrors }}
                      selectedId={selectedId}
                      onSelect={handleTabletSelect}
                      categoryFilter={categoryFilter}
                      onCategoryFilterChange={setCategoryFilter}
                      className="lg:h-full lg:min-h-0 lg:flex-1 lg:overflow-hidden"
                    />
                  )}
                </div>
                <div className="min-h-0 min-w-0 overflow-hidden">
                  <DocumentPreview
                    blocks={blocks}
                    violations={audit.violations}
                    selectedViolationId={selectedId}
                    isLoading={blocksLoading}
                    loadError={blocksError}
                    onSelectViolation={(id) => {
                      setSelectedId(id)
                      setDrawerOpen(true)
                    }}
                    fitRegion
                  />
                </div>
              </div>

              {/* Desktop ≥1280: three-column full-height review workspace. */}
              <div className="hidden h-full min-h-0 grid-cols-[24fr_46fr_30fr] items-stretch gap-6 xl:grid">
                <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
                  {audit.status === 'completed' && violations.length === 0 ? (
                    <NoFindingsState />
                  ) : (
                    <ErrorList
                      result={{ physical_layout_errors: mappedErrors }}
                      selectedId={selectedId}
                      onSelect={(e) => setSelectedId(e.id)}
                      categoryFilter={categoryFilter}
                      onCategoryFilterChange={setCategoryFilter}
                      className="lg:h-full lg:min-h-0 lg:flex-1 lg:overflow-hidden"
                    />
                  )}
                </div>
                <div className="min-h-0 min-w-0 overflow-hidden">
                  <DocumentPreview
                    blocks={blocks}
                    violations={audit.violations}
                    selectedViolationId={selectedId}
                    isLoading={blocksLoading}
                    loadError={blocksError}
                    onSelectViolation={setSelectedId}
                    fitRegion
                  />
                </div>
                <div
                  ref={detailScrollRef}
                  className="min-h-0 min-w-0 space-y-6 overflow-y-auto pr-1"
                >
                  {renderDetailStack(audit)}
                </div>
              </div>
            </div>

            {/* Tablet drawer — modal right drawer (1024–1279 only). */}
            {drawerOpen && selectedViolation && (
              <div className="fixed inset-0 z-50 xl:hidden" role="presentation">
                <div
                  className="absolute inset-0 bg-black/60"
                  aria-hidden="true"
                  onClick={closeDrawer}
                />
                <div
                  ref={drawerRef}
                  role="dialog"
                  aria-modal="true"
                  aria-label="Finding details"
                  onKeyDown={handleDrawerKeyDown}
                  className="absolute right-0 top-0 flex h-full w-[min(420px,92vw)] flex-col bg-background shadow-xl"
                >
                  <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
                    <h2 className="min-w-0 truncate text-component-title text-foreground">
                      {humanizeRuleCode(selectedViolation.rule_code)}
                    </h2>
                    <Button
                      variant="ghost"
                      size="icon"
                      data-drawer-close
                      onClick={closeDrawer}
                      aria-label="Close finding details"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
                    {renderDetailStack(audit)}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}

/* ----------------------------- Report header pieces ----------------------------- */

function StatusBadge({ status }: { status: string }) {
  if (status === 'processing') {
    return (
      <Badge variant="outline" className="border-information/40 bg-information/10 text-information">
        <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Processing
      </Badge>
    )
  }
  if (status === 'completed') {
    return (
      <Badge variant="outline" className="border-success/40 bg-success/10 text-success">
        <CheckCircle2 className="mr-1 h-3 w-3" /> Completed
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-destructive">
      <XCircle className="mr-1 h-3 w-3" /> Failed
    </Badge>
  )
}

/* ----------------------------- Page states ----------------------------- */

function LoadingState() {
  return (
    <div className="space-y-6" role="status" aria-busy="true">
      <div className="h-6 w-1/3 rounded bg-muted animate-pulse" />
      <div className="h-4 w-2/3 rounded bg-muted animate-pulse" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[9fr_16fr] xl:grid-cols-[2fr_3fr]">
        <div className="space-y-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-14 rounded bg-muted animate-pulse" />
          ))}
        </div>
        <div className="space-y-4">
          <div className="h-6 w-1/2 rounded bg-muted animate-pulse" />
          <div className="h-40 rounded bg-muted animate-pulse" />
          <div className="h-24 rounded bg-muted animate-pulse" />
        </div>
      </div>
    </div>
  )
}

function ErrorState({ error, onBack }: { error: string | null; onBack: () => void }) {
  return (
    <div className="py-16 text-center">
      <p className="text-sm text-foreground">{error || 'Audit not found'}</p>
      <Button onClick={onBack} variant="outline" className="mt-4 border-border">
        Back to Dashboard
      </Button>
    </div>
  )
}

function ProcessingBanner({ pollAttempts }: { pollAttempts: number }) {
  return (
    <section className="mt-6 rounded-md border border-border bg-input/20 px-4 py-3">
      <div className="flex items-start gap-3">
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-information" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium text-foreground">Audit in progress</p>
          <p className="mt-0.5 text-[13px] leading-[19px] text-muted-foreground">
            Layout checks are complete. Citations are being processed in the background — the
            report updates as checks finish. Poll attempt {pollAttempts}/{POLL_MAX_ATTEMPTS}.
          </p>
        </div>
      </div>
    </section>
  )
}

function FailedBanner() {
  return (
    <section className="mt-6 rounded-md border border-border bg-input/20 px-4 py-3">
      <div className="flex items-start gap-3">
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium text-foreground">Audit did not complete</p>
          <p className="mt-0.5 text-[13px] leading-[19px] text-muted-foreground">
            This audit failed partway through. Findings shown below, if any, may be incomplete.
            Re-run the audit to get a fresh result.
          </p>
        </div>
      </div>
    </section>
  )
}

function NoFindingsState() {
  return (
    <section className="rounded-md border border-border px-4 py-6">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
        <div>
          <h2 className="text-component-title text-foreground">No supported findings detected</h2>
          <p className="mt-1 text-sm leading-[21px] text-muted-foreground">
            This audit detected no supported compliance violations in the document. It does not
            certify the document as academically correct in all respects.
          </p>
        </div>
      </div>
    </section>
  )
}

/* ----------------------------- Secondary sections ----------------------------- */

function getParagraphIndex(v: Violation | null): number | null {
  if (!v) return null
  const loc = v.location as Record<string, unknown> | null
  const n = loc?.paragraph_index
  return typeof n === 'number' && n >= 0 ? n : null
}

function CitationSection({
  audit,
  isProcessing,
  selectedViolation,
}: {
  audit: AuditResponse
  isProcessing: boolean
  selectedViolation: Violation | null
}) {
  const issues = audit.citation_issues ?? []
  const status = audit.ai_review_status ?? null
  const provider = normalizeAiProvider(audit.ai_provider)

  // Guidance is shown only for the deterministic citation finding that is
  // currently selected. Matching uses persisted stable data — paragraph
  // index plus the exact deterministic message — never display order or
  // text search. Same-paragraph findings therefore stay distinct.
  const selectedPara = getParagraphIndex(selectedViolation)
  const isCitationSelected =
    selectedViolation !== null &&
    selectedViolation.rule_code === 'CITATION_MISMATCH' &&
    selectedPara !== null
  const matchedIssue =
    isCitationSelected && selectedViolation
      ? (issues.find(
          (i) => i.paragraph_index === selectedPara && i.message === selectedViolation.message,
        ) ?? null)
      : null

  let body: ReactNode
  if (isProcessing) {
    body = (
      <p className="mt-2 flex items-center gap-2 text-[13px] leading-[19px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-information" aria-hidden="true" />
        Citation review in progress — guidance appears when complete.
      </p>
    )
  } else if (!selectedViolation) {
    body = (
      <p className="mt-2 flex items-start gap-2 text-[13px] leading-[19px] text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Select a citation finding from the findings list to see AI-assisted guidance.
      </p>
    )
  } else if (!isCitationSelected) {
    body = (
      <p className="mt-2 flex items-start gap-2 text-[13px] leading-[19px] text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        This finding was verified by deterministic checks. AI-assisted guidance is available for
        citation findings — select one from the list to see it.
      </p>
    )
  } else if (matchedIssue) {
    body = (
      <>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] leading-[19px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
            Paragraph {selectedPara + 1}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5 text-ai-assisted" aria-hidden="true" />
            Human verification required
          </span>
        </div>
        {matchedIssue.text_snippet && (
          <blockquote className="mt-2 rounded border-l-2 border-ai-assisted/40 bg-ai-assisted/5 px-3 py-2 font-serif text-[13px] leading-[19px] text-foreground">
            “{matchedIssue.text_snippet}”
          </blockquote>
        )}
        <p className="mt-2 whitespace-pre-wrap break-words rounded border border-border bg-input/20 px-3 py-2 text-[13px] leading-[21px] text-foreground">
          {matchedIssue.suggestion}
        </p>
        <p className="mt-2 flex items-start gap-2 text-[13px] leading-[19px] text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Completed via {aiProviderLabel(provider)}. Guidance is AI-assisted and requires human
          verification of the source details.
        </p>
        {status === null && (
          <p className="mt-2 flex items-start gap-2 text-[13px] leading-[19px] text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            AI review status was not recorded for this audit.
          </p>
        )}
      </>
    )
  } else {
    body = (
      <p className="mt-2 flex items-start gap-2 text-[13px] leading-[19px] text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {status === 'UNAVAILABLE' ? (
          <>
            AI-assisted guidance was unavailable for this citation finding. Deterministic
            citation findings remain valid.
          </>
        ) : (
          <>No AI-assisted guidance is stored for this citation finding.</>
        )}
      </p>
    )
  }

  return (
    <section aria-label="AI-assisted citation guidance" className="border-t border-border pt-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-component-title text-foreground">
          {matchedIssue
            ? 'AI-assisted guidance for Citation Mismatch'
            : 'AI-assisted guidance'}
        </h3>
        <Badge variant="outline" className="border-ai-assisted/40 bg-ai-assisted/10 text-ai-assisted">
          <Quote className="mr-1 h-3 w-3" aria-hidden="true" /> AI-assisted
        </Badge>
      </div>
      {body}
    </section>
  )
}

const STAT_LABELS: Array<[keyof AuditDocumentStats, string]> = [
  ['paragraphs', 'Paragraphs'],
  ['headings', 'Headings'],
  ['tables', 'Tables'],
  ['images', 'Images'],
  ['sections', 'Sections'],
  ['words', 'Words'],
]

function DocStats({ stats }: { stats?: AuditDocumentStats | null }) {
  if (!stats) return null
  const rows = STAT_LABELS.filter(([key]) => stats[key] != null)
  if (rows.length === 0) return null

  return (
    <section aria-label="Document statistics" className="border-t border-border pt-5">
      <h3 className="text-component-title text-foreground">Document statistics</h3>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        {rows.map(([key, label]) => (
          <div key={key} className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-1.5">
            <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</dt>
            <dd className="font-mono text-[13px] text-foreground">{stats[key]}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
