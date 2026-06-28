/**
 * AppFooter — unified footer used on every page.
 *
 * This is the EXACT same footer as the Landing page (copied verbatim from
 * Landing.tsx lines 478-524). Every page uses this same footer so the
 * footer looks identical across Landing, Dashboard, History, and Audit detail.
 *
 * The footer is a normal block element (no fixed/sticky/absolute positioning).
 * It flows naturally after the main content. The page wrapper uses
 * `min-h-screen` (no flex-col) so the page scrolls naturally and the footer
 * sits at the very end — no overlap, no floating, no gap.
 */
import { Link } from 'react-router-dom'
import { ShieldCheck } from 'lucide-react'

const SHIELD_LOGO = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#c0c1ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
)

export function AppFooter() {
  return (
    <footer className="border-t border-outline-variant bg-surface-container-lowest py-xl">
      <div className="max-w-[1440px] mx-auto px-md">
        <div className="grid md:grid-cols-4 gap-lg mb-lg">
          <div className="md:col-span-2">
            <div className="flex items-center gap-md mb-sm">
              <div className="w-8 h-8 rounded-md bg-primary/15 border border-primary/30 flex items-center justify-center">
                {SHIELD_LOGO}
              </div>
              <span className="font-semibold text-on-surface">Academic Compliance Auditor</span>
            </div>
            <p className="text-sm text-on-surface-variant max-w-md leading-relaxed">
              A privacy-preserving, local-first auditing platform built for the high-stakes environment of academic work. Detection, location, and suggestions only — never rewriting.
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-on-surface-variant mb-sm">Product</p>
            <ul className="space-y-xs text-sm">
              <li><Link to="/dashboard" className="text-on-surface-variant hover:text-on-surface transition-colors">Dashboard</Link></li>
              <li><Link to="/history" className="text-on-surface-variant hover:text-on-surface transition-colors">History</Link></li>
              <li><Link to="/" className="text-on-surface-variant hover:text-on-surface transition-colors">Landing</Link></li>
            </ul>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-on-surface-variant mb-sm">Resources</p>
            <ul className="space-y-xs text-sm">
              <li><Link to="/" className="text-on-surface-variant hover:text-on-surface transition-colors">Architecture</Link></li>
              <li><Link to="/" className="text-on-surface-variant hover:text-on-surface transition-colors">Privacy</Link></li>
              <li><Link to="/dashboard" className="text-on-surface-variant hover:text-on-surface transition-colors">Live demo</Link></li>
            </ul>
          </div>
        </div>
        <div className="pt-md border-t border-outline-variant flex flex-col md:flex-row items-center justify-between gap-sm text-xs text-on-surface-variant">
          <p className="font-mono">© 2024 Academic Compliance Systems. All rights reserved.</p>
          <p className="font-mono flex items-center gap-xs">
            <span className="w-1.5 h-1.5 rounded-full bg-secondary" />
            Local AI Core: Online · Ollama Qwen2.5-3B
          </p>
        </div>
      </div>
    </footer>
  )
}
