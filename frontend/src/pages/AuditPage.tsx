import { useEffect, useState, useCallback, useMemo, useRef, type ReactNode, type KeyboardEvent } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api, downloadBlob } from '../services/api'
import { useToast } from '../hooks/useToast'
import { CheckCircle2, ChevronDown, Download, Filter, Info, Loader2, MapPin, PauseCircle, Quote, ShieldAlert, X, XCircle } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { ConfirmDialog } from '../components/ui/confirm-dialog'
import { AppNav } from '../components/layout/AppNav'
import { ErrorList } from '../components/audit/error-list'
import { VerdictChecklist } from '../components/audit/verdict-checklist'
import { FindingDetail } from '../components/audit/finding-detail'
import { DocumentPreview } from '../components/audit/document-preview'
import { categoryForRuleCode, humanizeRuleCode, aiProviderLabel, normalizeAiProvider } from '../lib/audit/adapter'
import { useFindingMapping } from '../hooks/use-finding-mapping'
import { invalidateMapping } from '../lib/pdf/mapping-cache.ts'
import { useRenderedPdf, dropRenderedPdfCache } from '../hooks/use-rendered-pdf.ts'
import { classifyFindingTarget, resolveFindingNavigation } from '../lib/pdf/finding-navigation.ts'
import { resolveCitationHighlight, type CitationRect } from '../lib/pdf/citation-highlight.ts'
import { resolveFormattingHighlight, evidenceFamily } from '../lib/pdf/formatting-highlight.ts'
import {
  OBJECT_RULES,
  resolveObjectSelection,
  resolveTableNavigations,
  getObjectNavigation,
  dropObjectNavCache,
} from '../lib/pdf/object-navigation.ts'
import {
  FIGURE_OUTLINE_RULES,
  resolveFigureOutline,
} from '../lib/pdf/figure-bbox.ts'
import {
  getPageGeometry,
  geometryLoaderFromBytes,
  dropPageGeometry,
} from '../lib/pdf/figure-outlines.ts'
import { friendlyFindingMessage } from '../lib/friendly-finding'
import { interruptionMessage } from '../lib/audit/interrupted-audit'
import { formatAuditDateTime, auditDateTimeAttr } from '../lib/format-date'
import { PendingNav, hasParagraphIdentity, type NavCommand } from '../lib/pdf/pending-navigation.ts'
import type { PageGeometry } from '../lib/pdf/pdf-text-extract.ts'
import { MARGIN_RULES, MARGIN_UNAVAILABLE_MESSAGE, resolveMarginNavigation, resolveMarginMarker, marginMarkerChip, sectionIndexOf } from '../lib/pdf/margin-navigation.ts'
import { mapAllSections, type SectionMetadataLike, type SectionRange } from '../lib/pdf/section-mapping.ts'
import {
  cacheSectionRanges,
  cachedSectionRanges,
  dropSectionRangeCache,
  sectionMapInput,
} from '../lib/pdf/section-cache.ts'
import { cn } from '../lib/utils'
import type { AuditDocumentStats, AuditResponse, DocumentBlock, Violation } from '../types/api'
import type { AuditCategory, LayoutError } from '../types/audit'
import {
  ALL_ENABLED_CHECKS_PASSED,
  ENABLED_CHECKS_CAUTION,
  ENABLED_CHECKS_SUFFIX,
  profileDisclosure,
} from '../lib/audit/enabled-checks-wording'

// Concise user-facing notices for non-navigable findings (Task 3).
const OBJECT_NOTICE =
  'Exact page location is not available for this finding. Review the finding details for its document location.'
const TEXT_FALLBACK_NOTICE =
  'The rendered-page location could not be confirmed. Showing the extracted-text location instead.'

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
    // Student-facing plain language; the raw deterministic message stays
    // untouched in the violation record.
    detail: friendlyFindingMessage(v.rule_code, v.message, v.expected_value, v.actual_value, v.location),
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

  // Finding-to-page navigation (mapping PoC): ONE owner of the rendered PDF
  // bytes shared by the viewer AND the mapper (no duplicate fetch, no byte
  // divergence); session-cached mapping from those exact bytes + blocks.
  // Interrupted audits have no rendered preview — never fetch it.
  const gatedAuditId =
    audit && audit.status !== 'processing' && audit.status !== 'interrupted'
      ? audit.id
      : null
  const renderedPdf = useRenderedPdf(gatedAuditId)
  const { bundle: mappingBundle, status: mappingStatus } = useFindingMapping(
    gatedAuditId,
    blocks,
    blocksError,
    renderedPdf.status === 'available' ? renderedPdf.bytes : undefined,
  )
  // Figure outline evidence (Build 8F): operator-list geometry from the SAME
  // shared bytes, loaded once per audit. Geometry is independent of the
  // paragraph mapping — it can be ready before or after it.
  const [figureGeometry, setFigureGeometry] = useState<PageGeometry[] | null>(null)
  // PDF bytes identity — a replaced PDF for the SAME audit must not reuse
  // geometry computed from the previous bytes.
  const geometryBytesRef = useRef<ArrayBuffer | undefined>(undefined)
  useEffect(() => {
    if (!gatedAuditId) {
      setFigureGeometry(null)
      return
    }
    if (renderedPdf.status !== 'available' || renderedPdf.bytes === undefined) {
      setFigureGeometry(null)
      return
    }
    const bytesChanged = geometryBytesRef.current !== renderedPdf.bytes
    geometryBytesRef.current = renderedPdf.bytes
    if (bytesChanged) dropPageGeometry(gatedAuditId)
    let cancelled = false
    const loader = geometryLoaderFromBytes(renderedPdf.bytes)
    if (!loader) {
      setFigureGeometry(null)
      return
    }
    getPageGeometry(gatedAuditId, loader)
      .then((g) => {
        if (!cancelled) setFigureGeometry(g)
      })
      .catch(() => {
        if (!cancelled) setFigureGeometry(null)
      })
    return () => {
      cancelled = true
    }
  }, [gatedAuditId, renderedPdf?.status, renderedPdf?.bytes])
  const [previewMode, setPreviewMode] = useState<'rendered' | 'text'>('rendered')
  const [pageCommand, setPageCommand] = useState<{ page: number; seq: number } | null>(null)
  const [locatingId, setLocatingId] = useState<string | null>(null)
  const [navNotice, setNavNotice] = useState<string | null>(null)
  // Exact citation highlight (Build 6) — latest selected finding wins.
  const [citationRects, setCitationRects] = useState<CitationRect[] | null>(null)
  const [citationLabel, setCitationLabel] = useState<string | null>(null)
  const [highlightMessage, setHighlightMessage] = useState<string | null>(null)
  // Formatting evidence highlight (Build 7) — mutually exclusive with citation.
  const [formattingEvidence, setFormattingEvidence] = useState<{ kind: 'run' | 'paragraph'; pageRects: CitationRect[] } | null>(null)
  const [formattingSpacingSide, setFormattingSpacingSide] = useState<'before' | 'after' | null>(null)
  const [formattingLabel, setFormattingLabel] = useState<string | null>(null)
  const [formattingMessage, setFormattingMessage] = useState<string | null>(null)
  // Table/Figure object navigation status (page + compact message only).
  const [objectStatus, setObjectStatus] = useState<{ label: string | null; message: string | null } | null>(null)
  // Exact Figure outline (Build 8F) — mutually exclusive with citation /
  // formatting evidence. Latest selection wins.
  const [figureOutline, setFigureOutline] = useState<{
    rect: { page: number; x: number; y: number; width: number; height: number }
    label: string
  } | null>(null)
  const [figureMessage, setFigureMessage] = useState<string | null>(null)
  const figureStateRef = useRef<{ ruleCode: string; imageIndex: number; pageNumber: number | null } | null>(null)

  // Margin section navigation status (Build: Section page-range navigation).
  const [marginStatus, setMarginStatus] = useState<{ label: string | null; message: string | null } | null>(null)
  // Margin page-edge marker (Build: Margin markers): exact-range only.
  const [marginMarker, setMarginMarker] = useState<{
    side: 'left' | 'right' | 'top' | 'bottom'
    startPage: number
    endPage: number
    sectionNumber: number
  } | null>(null)
  const [marginChipLabel, setMarginChipLabel] = useState<string | null>(null)

  const clearMarginStatus = useCallback(() => {
    setMarginStatus(null)
    setMarginMarker(null)
    setMarginChipLabel(null)
  }, [])

  const clearFigureOutline = useCallback(() => {
    setFigureOutline(null)
    setFigureMessage(null)
    figureStateRef.current = null
  }, [])

  const clearObjectStatus = useCallback(() => setObjectStatus(null), [])

  const clearCitationHighlight = useCallback(() => {
    setCitationRects(null)
    setCitationLabel(null)
    setHighlightMessage(null)
  }, [])

  const clearFormattingHighlight = useCallback(() => {
    setFormattingEvidence(null)
    setFormattingSpacingSide(null)
    setFormattingLabel(null)
    setFormattingMessage(null)
  }, [])

  const navigateToRenderedPage = (page: number) => {
    setPreviewMode('rendered')
    setPageCommand((cur) => ({ page, seq: (cur?.seq ?? 0) + 1 }))
  }

  /**
   * Exact Figure outline (Build 8F): resolve the authoritative image_index
   * against the operator-list geometry. Rendered ONLY when identity is
   * reliable AND page/order agree AND the geometry is finite — otherwise the
   * truthful page message, never an approximate outline. Geometry may still
   * be loading — the geometry-ready effect applies it for the latest
   * selection (latest-wins guard).
   */
  const applyFigureOutline = useCallback(
    (violation: Violation, navigatePage: number | null) => {
      const ruleCode = violation.rule_code
      const imageIndex = (violation.location ?? {}).image_index
      if (
        !FIGURE_OUTLINE_RULES.has(ruleCode) ||
        typeof imageIndex !== 'number' ||
        imageIndex < 0
      ) {
        clearFigureOutline()
        return
      }
      figureStateRef.current = { ruleCode, imageIndex, pageNumber: navigatePage }
      if (!figureGeometry) {
        setFigureOutline(null)
        setFigureMessage(null)
        return
      }
      const result = resolveFigureOutline({
        finding: { ruleCode, location: violation.location },
        geometry: figureGeometry,
        pageNumber: navigatePage,
      })
      setFigureOutline(result.rect ? { rect: result.rect, label: result.label ?? '' } : null)
      setFigureMessage(result.message)
      // The operator page is authoritative — when geometry resolved a real
      // page that differs from the (host-derived) navigation page, navigate
      // to the operator's page so the outline is actually visible.
      if (result.pageNumber !== null && result.pageNumber !== navigatePage) {
        navigateToRenderedPage(result.pageNumber)
      }
    },
    [figureGeometry, clearFigureOutline],
  )

  // Geometry arrives AFTER the selection: apply the outline for the LATEST
  // figure selection only (latest-wins; stale selections never repaint).
  useEffect(() => {
    const state = figureStateRef.current
    if (!state || !figureGeometry) return
    const result = resolveFigureOutline({
      finding: { ruleCode: state.ruleCode, location: { image_index: state.imageIndex } },
      geometry: figureGeometry,
      pageNumber: state.pageNumber,
    })
    setFigureOutline(result.rect ? { rect: result.rect, label: result.label ?? '' } : null)
    setFigureMessage(result.message)
    if (result.pageNumber !== null && result.pageNumber !== state.pageNumber) {
      navigateToRenderedPage(result.pageNumber)
    }
  }, [figureGeometry])

  // Pending-navigation state machine: a finding selected while the mapping
  // is still loading is retained and executed once it arrives.
  const pendingNavRef = useRef<PendingNav | null>(null)
  if (!pendingNavRef.current) pendingNavRef.current = new PendingNav()
  const emitNav = useCallback((command: NavCommand) => {
    if (command.kind === 'navigate') {
      setLocatingId(null)
      setNavNotice(null)
      navigateToRenderedPage(command.page)
    } else if (command.kind === 'text') {
      setLocatingId(null)
      setPreviewMode('text')
      setNavNotice(TEXT_FALLBACK_NOTICE)
    } else if (command.kind === 'locating') {
      setLocatingId(command.findingId)
      setNavNotice(null)
    }
  }, [navigateToRenderedPage])

  // The fallback banner is only truthful while Extracted Text is active:
  // any switch to Rendered Pages (manual or via a mapped finding) hides it.
  // It reappears only after a new genuine unavailable navigation result.
  useEffect(() => {
    if (previewMode === 'rendered') setNavNotice(null)
    if (previewMode === 'text') {
      clearCitationHighlight() // overlays live on rendered pages
      clearFormattingHighlight()
      clearObjectStatus()
      clearFigureOutline()
      clearMarginStatus()
    }
  }, [previewMode, clearCitationHighlight, clearFormattingHighlight, clearObjectStatus, clearFigureOutline, clearMarginStatus])

  // Reset navigation state when the audit changes.
  useEffect(() => {
    pendingNavRef.current?.reset()
    setPageCommand(null)
    setPreviewMode('rendered')
    setLocatingId(null)
    setNavNotice(null)
    clearCitationHighlight()
    clearFormattingHighlight()
    clearObjectStatus()
    clearFigureOutline()
    clearMarginStatus()
    if (auditId) {
      dropObjectNavCache(auditId)
      dropPageGeometry(auditId)
      dropSectionRangeCache(auditId)
    }
  }, [auditId, clearCitationHighlight, clearFormattingHighlight, clearObjectStatus, clearFigureOutline, clearMarginStatus])

  // PDF replaced: any highlight from the previous document is stale, and so
  // are the session caches derived from the previous bytes (paragraph
  // mapping, operator geometry, object navigation). Never serve old-bytes
  // evidence for the new document.
  useEffect(() => {
    clearCitationHighlight()
    clearFormattingHighlight()
    clearObjectStatus()
    clearFigureOutline()
    clearMarginStatus()
    if (gatedAuditId) {
      dropObjectNavCache(gatedAuditId)
      dropPageGeometry(gatedAuditId)
      invalidateMapping(gatedAuditId)
    }
  }, [renderedPdf?.bytes, gatedAuditId, clearCitationHighlight, clearFormattingHighlight, clearObjectStatus, clearFigureOutline, clearMarginStatus])

  // Execute (or fail) the retained navigation request when the mapping
  // settles — never before.
  useEffect(() => {
    if (mappingStatus === 'ready' && mappingBundle) {
      pendingNavRef.current?.onMappingReady(mappingBundle.byIndex, selectedId, emitNav)
    } else if (mappingStatus === 'error') {
      pendingNavRef.current?.onMappingFailed(selectedId, emitNav)
    }
  }, [mappingStatus, mappingBundle, selectedId, emitNav])

  // Table findings resolve as a BATCH (collision-safe): table_index is the
  // authoritative identity, uncaptioned tables map from surrounding blocks
  // only, and no two indexes ever share one physical object.
  const tableFindings = useMemo(() => {
    if (!audit) return []
    return audit.violations
      .filter(
        (v) =>
          OBJECT_RULES.has(v.rule_code) &&
          typeof v.location?.table_index === 'number',
      )
      .map((v) => ({ id: v.id, ruleCode: v.rule_code, location: v.location }))
  }, [audit])
  const tableNav = useMemo(
    () => resolveTableNavigations(gatedAuditId, tableFindings, mappingBundle),
    [gatedAuditId, tableFindings, mappingBundle],
  )

  // Object-navigation bundle augmented with the figure operator geometry:
  // figure page resolution is geometry-first, so both the row label and the
  // selection chip/navigation derive from the exact operator page.
  const figureBundle = useMemo(
    () => (mappingBundle ? { ...mappingBundle, geometry: figureGeometry } : null),
    [mappingBundle, figureGeometry],
  )

  // Section mapping (Build: margin navigation). Built from the optional API
  // `sections` metadata + the existing paragraph mapping bundle. Session-
  // cached; only successes are cached.
  const [sectionRanges, setSectionRanges] = useState<SectionRange[] | null>(null)
  const sectionMeta: SectionMetadataLike[] | null | undefined = audit?.sections
  useEffect(() => {
    if (!gatedAuditId || !sectionMeta || sectionMeta.length === 0) {
      setSectionRanges(null)
      return
    }
    if (!mappingBundle) return // mapping not ready — never cache a failure
    // The rendered PDF page count is the validation bound — the REAL page
    // count extracted from the PDF, never the max mapped paragraph page
    // (a document whose final page holds unmapped paragraphs would wrongly
    // shrink the bound and reject valid section boundaries as out-of-range).
    const numPages = mappingBundle.pages.length
    const input = sectionMapInput(sectionMeta, mappingBundle.byIndex, numPages)
    if (!input) {
      setSectionRanges(null)
      return
    }
    // Session cache: reuse a previous successful resolution for this audit.
    const cached = cachedSectionRanges(gatedAuditId)
    if (cached) {
      setSectionRanges(cached)
      return
    }
    const ranges = mapAllSections(input)
    cacheSectionRanges(gatedAuditId, ranges)
    setSectionRanges(ranges)
  }, [gatedAuditId, sectionMeta, mappingBundle])

  // User-facing location labels per finding (exact/approximate → page label,
  // unavailable → paragraph label; never confidence terminology).
  const locationLabels = useMemo(() => {
    if (!audit) return null
    const labels = new Map<string, string>()
    for (const v of audit.violations) {
      if (MARGIN_RULES.has(v.rule_code)) {
        const idx = sectionIndexOf(v.location)
        if (idx !== null) {
          const range = sectionRanges?.find((r) => r.sectionIndex === idx)
          const decision = resolveMarginNavigation(v.rule_code, idx, range)
          if (decision.rowLabel) labels.set(v.id, decision.rowLabel)
        }
        continue
      }
      if (OBJECT_RULES.has(v.rule_code) && mappingBundle) {
        // Table/Figure findings: `Page N · Table M` / `Table M · Page unavailable`
        const loc = v.location ?? {}
        if (typeof loc.table_index === 'number') {
          const decision = tableNav.get(loc.table_index)
          if (decision?.label) labels.set(v.id, decision.label)
        } else {
          const objectNav = getObjectNavigation(gatedAuditId, { ruleCode: v.rule_code, location: v.location }, figureBundle)
          if (objectNav.label) labels.set(v.id, objectNav.label)
        }
        continue
      }
      if (mappingBundle) {
        const decision = resolveFindingNavigation(v, mappingBundle.byIndex)
        if (decision.locationLabel) labels.set(v.id, decision.locationLabel)
      } else if (mappingStatus === 'error' && hasParagraphIdentity(v)) {
        const para = v.location?.paragraph_index as number
        labels.set(v.id, `Paragraph ${para + 1} · Page unavailable`)
      }
    }
    return labels
  }, [figureBundle, mappingBundle, mappingStatus, audit, tableNav, sectionRanges])

  // Mobile/tablet workspace view — tabs below lg, side-by-side at lg+.
  const [mobileView, setMobileView] = useState<WorkspaceView>('findings')
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  // Ref to the detail scroll region — reset scroll position on selection change.
  const detailScrollRef = useRef<HTMLDivElement>(null)

  // Category filter — single source shared by the overview and Findings.
  const [categoryFilter, setCategoryFilter] = useState<AuditCategory | 'all'>('all')
  const [categoryOpen, setCategoryOpen] = useState(false)
  const categoryPanelRef = useRef<HTMLDivElement>(null)

  // PDF export — one clear action; guarded against duplicate clicks.
  const [exporting, setExporting] = useState(false)

  // Interrupted-audit deletion — confirmation + progress guard.
  const [deleteTarget, setDeleteTarget] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const handleDeleteInterrupted = async () => {
    if (!auditId || deleting) return
    setDeleting(true)
    try {
      await api.deleteAudit(auditId)
      invalidateMapping(auditId)
      dropRenderedPdfCache(auditId)
      showToast('Interrupted audit deleted.', 'success')
      navigate('/history')
    } catch (err: any) {
      setDeleteTarget(false)
      showToast(err?.message || 'Could not delete the audit. Please try again.', 'error')
    } finally {
      setDeleting(false)
    }
  }

  const handleExport = async () => {
    if (!auditId || exporting) return
    setExporting(true)
    try {
      const { blob, filename } = await api.exportAuditPdf(auditId)
      downloadBlob(blob, filename ?? `compliance-report-${auditId.slice(0, 8)}.pdf`)
      showToast('PDF report downloaded.', 'success')
    } catch (err: any) {
      showToast(err?.message || 'Could not download the PDF report. Please try again.', 'error')
    } finally {
      setExporting(false)
    }
  }

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
    applyNavigation(e)
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
    applyNavigation(e)
    const locatable = e.position > 0 && blocks !== null && blocks.length > 0
    setMobileView(locatable ? 'document' : 'details')
  }

  // Desktop (≥1280): selection only navigates the document pane.
  const handleDesktopSelect = (e: LayoutError) => {
    setSelectedId(e.id)
    applyNavigation(e)
  }

  // Exact/approximate mapping → Rendered Pages + page navigation;
  // completed unavailable mapping → extracted-text paragraph location;
  // Table/Figure object findings navigate to the reliably mapped page (never
  // forced into Extracted Text; view stays stable when unavailable); other
  // object-typed findings (section/margin) show a concise notice instead.
  // Selection uses the REAL violation (it carries location.paragraph_index /
  // table_index / image_index) — the presentation LayoutError does not.
  const applyNavigation = (e: LayoutError) => {
    const violation = violations.find((v) => v.id === e.id) ?? null
    if (!violation) return
    const findingLike = {
      id: violation.id,
      ruleCode: violation.rule_code,
      message: violation.message,
      location: violation.location,
    }
    if (classifyFindingTarget(violation) === 'object') {
      clearCitationHighlight()
      clearFormattingHighlight()
      clearFigureOutline()
      clearObjectStatus()
      clearMarginStatus() // margin marker is exclusive; the margin branch re-sets it
      // Margin findings (MARGIN_*): navigate to the proven section range
      // using the authoritative section_index. Unavailable keeps the view
      // stable (never jumps to Page 1).
      if (MARGIN_RULES.has(violation.rule_code)) {
        const idx = sectionIndexOf(violation.location)
        if (idx !== null) {
          const range = sectionRanges?.find((r) => r.sectionIndex === idx) ?? null
          const decision = resolveMarginNavigation(violation.rule_code, idx, range)
          setMarginStatus(
            decision.chipLabel || decision.message
              ? { label: decision.chipLabel, message: decision.message }
              : null,
          )
          // Margin marker: only for EXACT ranges; the viewer shows it on
          // every page inside the affected range (manual Previous/Next
          // stays free) and hides it outside.
          const markerState = resolveMarginMarker({
            ruleCode: violation.rule_code,
            sectionIndex: idx,
            range,
            currentPage: decision.navigatePage ?? 1,
          })
          setMarginMarker(
            markerState.side && markerState.startPage !== null && markerState.endPage !== null
              ? {
                  side: markerState.side,
                  startPage: markerState.startPage,
                  endPage: markerState.endPage,
                  sectionNumber: markerState.sectionNumber ?? idx + 1,
                }
              : null,
          )
          setMarginChipLabel(marginMarkerChip(markerState))
          if (decision.navigatePage !== null) {
            navigateToRenderedPage(decision.navigatePage)
          }
        } else {
          setMarginStatus({ label: null, message: MARGIN_UNAVAILABLE_MESSAGE })
          setMarginMarker(null)
          setMarginChipLabel(null)
        }
        setNavNotice(null)
        pendingNavRef.current?.reset()
        return
      }
      // Object rules (Table/Figure): navigate to the reliably mapped page;
      // overlays stay mutually exclusive; no forced Extracted Text.
      if (OBJECT_RULES.has(violation.rule_code)) {
        const loc = violation.location ?? {}
        if (typeof loc.table_index === 'number') {
          // Batch-resolved table decision (collision-safe identity)
          const decision = tableNav.get(loc.table_index)
          setObjectStatus(
            decision && decision.mode !== 'none'
              ? { label: decision.chipLabel, message: decision.message }
              : null,
          )
          if (decision?.mode === 'rendered' && decision.pageNumber !== null) {
            navigateToRenderedPage(decision.pageNumber)
          }
        } else {
          const objectSel = resolveObjectSelection(gatedAuditId, findingLike, figureBundle)
          setObjectStatus(objectSel.status)
          if (objectSel.navigatePage !== null) {
            navigateToRenderedPage(objectSel.navigatePage)
          }
          // Exact Figure outline: image_index is the authoritative identity.
          // The outline is rendered only when identity + order + geometry all
          // agree; otherwise the truthful page message (never approximate).
          applyFigureOutline(violation, objectSel.navigatePage)
        }
        setNavNotice(null)
        // stable: keep the current preview mode
        pendingNavRef.current?.reset()
      } else {
        setObjectStatus(null)
        setNavNotice(OBJECT_NOTICE)
      }
      return
    }
    // Citation and formatting overlays are mutually exclusive; the latest
    // selection replaces the previous one.
    setObjectStatus(null)
    clearFigureOutline()
    clearMarginStatus()
    if (evidenceFamily(violation.rule_code) === 'formatting') {
      clearCitationHighlight()
      const fmt = resolveFormattingHighlight(findingLike, mappingBundle)
      setFormattingEvidence(fmt.kind !== 'none' && fmt.pageRects.length > 0 ? { kind: fmt.kind, pageRects: fmt.pageRects } : null)
      setFormattingSpacingSide(fmt.spacingSide)
      setFormattingLabel(fmt.label)
      setFormattingMessage(fmt.message)
    } else {
      clearFormattingHighlight()
      // Exact citation highlight: resolves (or clears) from the deterministic
      // finding's own fields; failure keeps Rendered Pages active.
      const hl = resolveCitationHighlight(
        { ...findingLike, actualValue: violation.actual_value },
        mappingBundle,
      )
      setCitationRects(hl.rects)
      setCitationLabel(hl.label)
      setHighlightMessage(hl.message)
    }
    pendingNavRef.current?.select(violation, mappingBundle?.byIndex, emitNav)
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
        ) : audit.status === 'interrupted' ? (
          <InterruptedPanel
            audit={audit}
            onUploadAgain={() => navigate('/dashboard')}
            onDelete={() => setDeleteTarget(true)}
            onReturn={() => navigate('/dashboard')}
          />
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
                  {audit.status === 'completed' && profileDisclosure(audit.profile_snapshot) && (
                    <span className="inline-flex items-center gap-1">
                      {profileDisclosure(audit.profile_snapshot)}
                    </span>
                  )}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Score (enabled checks)
                </div>
                <div className="flex items-baseline justify-end gap-1.5">
                  <span className="font-mono text-lg font-semibold text-foreground">
                    {audit.weighted_score}
                  </span>
                  <span className="text-[13px] text-muted-foreground">/100</span>
                </div>
                <div className="mt-0.5 text-right text-[12px] leading-4 text-muted-foreground">
                  {ENABLED_CHECKS_SUFFIX}
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

              {/* Export PDF — completed: enabled; processing: disabled with a
                  clear tooltip; failed: enabled so the backend decides (409 when
                  there is nothing meaningful to export). */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleExport}
                disabled={exporting || isProcessing}
                title={
                  isProcessing
                    ? 'The PDF is available once the audit finishes processing.'
                    : exporting
                      ? 'Preparing your PDF…'
                      : 'Download this audit report as a PDF'
                }
                aria-busy={exporting}
              >
                {exporting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {exporting ? 'Preparing PDF…' : 'Export PDF'}
              </Button>
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
                      locationLabels={locationLabels}
                      locatingId={locatingId}
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
                    renderedPdf={renderedPdf}
                    notice={navNotice}
                                        previewMode={previewMode}
                    onPreviewModeChange={setPreviewMode}
                    pendingPage={pageCommand}
                    citationRects={citationRects}
                    citationLabel={citationLabel}
                    highlightMessage={highlightMessage}
                    formattingEvidence={formattingEvidence}
                    formattingSpacingSide={formattingSpacingSide}
                    formattingLabel={formattingLabel}
                    formattingMessage={formattingMessage}
                    objectStatus={objectStatus}
                    figureOutline={figureOutline}
                    figureMessage={figureMessage}
                    marginStatus={marginStatus}
                    marginMarker={marginMarker}
                    marginChipLabel={marginChipLabel}
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
                      locationLabels={locationLabels}
                      locatingId={locatingId}
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
                    renderedPdf={renderedPdf}
                    notice={navNotice}
                                        previewMode={previewMode}
                    onPreviewModeChange={setPreviewMode}
                    pendingPage={pageCommand}
                    citationRects={citationRects}
                    citationLabel={citationLabel}
                    highlightMessage={highlightMessage}
                    formattingEvidence={formattingEvidence}
                    formattingSpacingSide={formattingSpacingSide}
                    formattingLabel={formattingLabel}
                    formattingMessage={formattingMessage}
                    objectStatus={objectStatus}
                    figureOutline={figureOutline}
                    figureMessage={figureMessage}
                    marginStatus={marginStatus}
                    marginMarker={marginMarker}
                    marginChipLabel={marginChipLabel}
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
                      onSelect={handleDesktopSelect}
                      categoryFilter={categoryFilter}
                      onCategoryFilterChange={setCategoryFilter}
                      locationLabels={locationLabels}
                      locatingId={locatingId}
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
                    renderedPdf={renderedPdf}
                    notice={navNotice}
                                        previewMode={previewMode}
                    onPreviewModeChange={setPreviewMode}
                    pendingPage={pageCommand}
                    citationRects={citationRects}
                    citationLabel={citationLabel}
                    highlightMessage={highlightMessage}
                    formattingEvidence={formattingEvidence}
                    formattingSpacingSide={formattingSpacingSide}
                    formattingLabel={formattingLabel}
                    formattingMessage={formattingMessage}
                    objectStatus={objectStatus}
                    figureOutline={figureOutline}
                    figureMessage={figureMessage}
                    marginStatus={marginStatus}
                    marginMarker={marginMarker}
                    marginChipLabel={marginChipLabel}
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

      {/* Interrupted-audit delete confirmation */}
      {deleteTarget && audit?.status === 'interrupted' && (
        <ConfirmDialog
          title="Delete interrupted audit?"
          description="This removes the interrupted audit record. Your original document is not stored by ACA."
          confirmLabel="Delete audit"
          cancelLabel="Cancel"
          confirmVariant="destructive"
          busy={deleting}
          onConfirm={() => void handleDeleteInterrupted()}
          onCancel={() => setDeleteTarget(false)}
        />
      )}
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
  if (status === 'interrupted') {
    return (
      <Badge variant="outline" className="border-warning/40 bg-warning/10 text-warning">
        <PauseCircle className="mr-1 h-3 w-3" aria-hidden="true" /> Interrupted
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

/* ----------------------------- Interrupted audit ----------------------------- */

function InterruptedPanel({
  audit,
  onUploadAgain,
  onDelete,
  onReturn,
}: {
  audit: AuditResponse
  onUploadAgain: () => void
  onDelete: () => void
  onReturn: () => void
}) {
  const message = interruptionMessage(audit.interruption_reason)
  const snapshot = audit.profile_snapshot

  return (
    <div className="mx-auto w-full max-w-2xl rounded-md border border-warning/40 bg-warning/5 px-5 py-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <PauseCircle className="h-5 w-5 text-warning" aria-hidden="true" />
        Audit interrupted
      </h2>
      <p className="mt-2 text-sm leading-[21px] text-muted-foreground">
        {message} No compliance result was produced.
      </p>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Document</dt>
          <dd className="break-words text-foreground">{audit.filename}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Created</dt>
          <dd>
            <time dateTime={auditDateTimeAttr(audit.created_at) ?? undefined}>{formatAuditDateTime(audit.created_at)}</time>
          </dd>
        </div>
        {audit.interrupted_at && (
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Interrupted at</dt>
            <dd>
              <time dateTime={auditDateTimeAttr(audit.interrupted_at) ?? undefined}>{formatAuditDateTime(audit.interrupted_at)}</time>
            </dd>
          </div>
        )}
        {snapshot?.profile_name && (
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Formatting profile</dt>
            <dd>
              {snapshot.profile_name}
              {typeof snapshot.profile_version === 'number' ? ` (v${snapshot.profile_version})` : ''}
            </dd>
          </div>
        )}
        {snapshot?.citation_style && (
          <div>
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Citation style</dt>
            <dd>{snapshot.citation_style}</dd>
          </div>
        )}
      </dl>

      <p className="mt-4 text-xs leading-[16px] text-muted-foreground">
        The original document was not retained. Uploading the document again creates a new audit.
      </p>

      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button type="button" className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={onUploadAgain}>
          Upload document again
        </Button>
        <Button type="button" variant="outline" className="border-border text-foreground" onClick={onDelete}>
          Delete interrupted audit
        </Button>
        <Button type="button" variant="ghost" className="text-muted-foreground" onClick={onReturn}>
          Return to dashboard
        </Button>
      </div>
    </div>
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
          <h2 className="text-component-title text-foreground">{ALL_ENABLED_CHECKS_PASSED}</h2>
          <p className="mt-1 text-sm leading-[21px] text-muted-foreground">
            {ENABLED_CHECKS_CAUTION}
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

/**
 * Split a stored guidance suggestion into the personalised correction and
 * the shared reference material. Backend suggestions are assembled as
 * "Recommended correction\n<reason>" followed by the generic "What to
 * verify" checklist, "APA 7 formatting example" templates, and placeholder
 * warning. Showing the correction per finding while rendering the shared
 * blocks once (collapsible) avoids repeating identical templates for every
 * citation finding in the same paragraph.
 */
function splitGuidanceSuggestion(suggestion: string | null): { correction: string; shared: string | null } {
  if (!suggestion) return { correction: '', shared: null }
  const sections = suggestion.split(/\n\n+/)
  const correction = (sections[0] ?? '').replace(/^Recommended correction\s*\n/, '').trim()
  const shared = sections.slice(1).join('\n\n').trim()
  if (!correction) return { correction: suggestion, shared: null }
  return { correction, shared: shared || null }
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
        {(() => {
          const { correction, shared } = splitGuidanceSuggestion(matchedIssue.suggestion)
          return (
            <>
              {correction && (
                <p className="mt-2 whitespace-pre-wrap break-words rounded border border-border bg-input/20 px-3 py-2 text-[13px] leading-[21px] text-foreground">
                  {correction}
                </p>
              )}
              {shared && (
                <details className="mt-2 rounded-md border border-border bg-card">
                  <summary className="cursor-pointer select-none px-3 py-2 text-[13px] font-medium text-foreground">
                    APA templates and verification checklist
                  </summary>
                  <div className="whitespace-pre-wrap break-words border-t border-border px-3 py-2 text-[13px] leading-[21px] text-muted-foreground">
                    {shared}
                  </div>
                </details>
              )}
            </>
          )
        })()}
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
