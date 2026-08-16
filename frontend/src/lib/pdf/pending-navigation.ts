/**
 * Pending finding-to-page navigation state machine (pure logic).
 *
 * Bridges the gap between selection time and mapping/PDF readiness:
 * a paragraph finding selected while the mapping is still loading is
 * retained; once the mapping arrives the pending request is executed —
 * unless the audit changed or the selected finding moved on (latest
 * selection wins). Unavailable mappings always fall back to Extracted
 * Text; nothing ever navigates to page 1 as a default.
 */
import {
  classifyFindingTarget,
  resolveFindingNavigation,
  type FindingLike,
} from './finding-navigation.ts'
import type { BlockMapping } from './paragraph-mapping.ts'

export type NavCommand =
  | { kind: 'navigate'; page: number }
  | { kind: 'text' }
  | { kind: 'locating'; findingId: string }
  | { kind: 'none' }

export class PendingNav {
  private pending: FindingLike | null = null

  /** Handle a finding selection. Emits a command when decidable now. */
  select(finding: FindingLike, mappingByIndex: Map<number, BlockMapping> | null | undefined, emit: (c: NavCommand) => void): void {
    // Object findings (table/figure/section/margin) never enter the
    // paragraph pipeline — their view stays stable and nothing is retained.
    if (classifyFindingTarget(finding) !== 'paragraph') {
      this.pending = null
      emit({ kind: 'none' })
      return
    }

    const decision = resolveFindingNavigation(finding, mappingByIndex)

    if (decision.mode === 'rendered' && decision.pageNumber !== null) {
      this.pending = null
      emit({ kind: 'navigate', page: decision.pageNumber })
      return
    }
    if (decision.locationLabel) {
      // Paragraph finding with a COMPLETED unavailable mapping → Extracted Text.
      this.pending = null
      emit({ kind: 'text' })
      return
    }
    // Mapping not ready (loading/idle) and the finding has a paragraph:
    // retain the request, show "Locating finding…", never switch away.
    // Latest selection overwrites the pending one.
    if (hasParagraphIdentity(finding)) {
      this.pending = finding
      emit({ kind: 'locating', findingId: finding.id })
      return
    }
    // Non-paragraph finding: nothing to retain, nothing to emit.
    this.pending = null
    emit({ kind: 'none' })
  }

  /**
   * Execute the retained request once the mapping arrives. `selectedId` is
   * the current selection; a mismatch discards the stale request.
   */
  onMappingReady(
    mappingByIndex: Map<number, BlockMapping>,
    selectedId: string | null,
    emit: (c: NavCommand) => void,
  ): void {
    const pending = this.pending
    this.pending = null
    if (!pending) return
    if (pending.id !== selectedId) return // selection moved on — discard
    const decision = resolveFindingNavigation(pending, mappingByIndex)
    if (decision.mode === 'rendered' && decision.pageNumber !== null) {
      emit({ kind: 'navigate', page: decision.pageNumber })
    } else if (decision.locationLabel) {
      emit({ kind: 'text' })
    }
  }

  /** Mapping failed: the retained paragraph finding falls back to text. */
  onMappingFailed(selectedId: string | null, emit: (c: NavCommand) => void): void {
    const pending = this.pending
    this.pending = null
    if (!pending) return
    if (pending.id !== selectedId) return
    emit({ kind: 'text' })
  }

  /** Audit changed or unmount: drop the retained request. */
  reset(): void {
    this.pending = null
  }
}

export function hasParagraphIdentity(finding: FindingLike): boolean {
  return classifyFindingTarget(finding) === 'paragraph'
}

/** Clamp a navigation target into the valid page range (indicator == canvas). */
export function clampPage(page: number, numPages: number): number {
  if (!Number.isFinite(page) || numPages < 1) return 1
  return Math.min(Math.max(1, Math.round(page)), numPages)
}

/**
 * One-shot finding→page command consumption.
 *
 * A finding navigation command applies exactly once (identified by its
 * `seq`). After consumption, manual viewer controls (Previous/Next/zoom)
 * take full ownership: rerenders, zoom changes, and Strict Mode replays
 * never reapply the consumed command. A NEW command with a different seq
 * navigates again. Reset on audit change / PDF replacement.
 */
export class PageCommandConsumer {
  private appliedSeq = -1

  /**
   * Returns the target page to navigate to, or null when there is nothing
   * to apply. Commands are one-shot: any seq already applied — or any
   * OLDER seq arriving after a newer command (stale replay) — is ignored.
   * Reset on audit change / PDF replacement.
   */
  consume(command: { page: number; seq: number } | null, numPages: number): number | null {
    if (!command || command.seq <= this.appliedSeq) return null
    this.appliedSeq = command.seq
    return clampPage(command.page, numPages)
  }

  /** Audit changed or PDF replaced: forget the previous command. */
  reset(): void {
    this.appliedSeq = -1
  }
}
