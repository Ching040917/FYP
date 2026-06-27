/**
 * AppFooter — unified footer used on every page.
 *
 * Matches the Landing page footer styling exactly:
 *   - border-t border-outline-variant
 *   - bg-surface-container-lowest
 *   - py-xl
 *
 * IMPORTANT: no `mt-auto` class. The footer sits naturally after the main
 * content. The page wrapper uses `min-h-screen flex flex-col` so on short
 * pages the footer still reaches the bottom via flex-grow on <main>, but
 * on long pages it sits right after the content with no gap.
 *
 * The old footer used `mt-auto` which forced it to the viewport bottom
 * even when content was short — creating the "跑位" (floating footer) bug.
 */
import { ShieldCheck, Lock, Cloud } from 'lucide-react'

export function AppFooter() {
  return (
    <footer className="border-t border-outline-variant bg-surface-container-lowest py-xl">
      <div className="mx-auto max-w-[1440px] px-4 md:px-6">
        <div className="flex flex-col items-start justify-between gap-3 text-xs text-on-surface-variant md:flex-row md:items-center">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-primary" />
            <span>
              Academic Compliance Auditor · Read-only formatting checker. Your file is parsed
              in-memory and never modified.
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <Lock className="h-3 w-3" /> Local by default
            </span>
            <span className="flex items-center gap-1">
              <Cloud className="h-3 w-3" /> Cloud opt-in
            </span>
          </div>
        </div>
      </div>
    </footer>
  )
}
