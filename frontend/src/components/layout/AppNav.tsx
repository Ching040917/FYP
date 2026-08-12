/**
 * AppNav — sticky top navigation bar shown on every page (except Landing
 * which has its own marketing header). Provides consistent navigation
 * between Dashboard, History, and back to Landing.
 *
 * Uses the same Material 3 design tokens as the Landing page header
 * (bg-surface-container/80 backdrop-blur, border-outline-variant).
 *
 * Props:
 *   - current: which page is active (for highlight state)
 *   - title: page title shown next to the logo
 *   - subtitle: small caption under the title
 *   - backTo: optional back button target (e.g. '/dashboard')
 */
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, ShieldCheck, LayoutDashboard, History, Home } from 'lucide-react'
import { Button } from '../ui/button'

type NavPage = 'dashboard' | 'history' | 'audit' | 'landing'

export interface AppNavProps {
  current?: NavPage
  title: string
  subtitle?: string
  backTo?: string
}

export function AppNav({ current, title, subtitle, backTo }: AppNavProps) {
  const navigate = useNavigate()

  return (
    <header className="sticky top-0 z-30 border-b border-outline-variant bg-surface-container/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-3 md:px-6">
        {/* Left: back button + logo + title */}
        <div className="flex items-center gap-2.5">
          {backTo && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-on-surface-variant hover:text-on-surface"
              onClick={() => navigate(backTo)}
              aria-label="Back"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
          )}
          <Link to="/" className="flex items-center gap-2.5 outline-none">
            <div className="grid h-9 w-9 place-items-center rounded-md bg-primary/15 text-primary ring-1 ring-primary/30">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div className="text-left">
              <div className="text-sm font-semibold tracking-tight text-on-surface">{title}</div>
              {subtitle && (
                <div className="text-[11px] uppercase tracking-wider text-on-surface-variant">
                  {subtitle}
                </div>
              )}
            </div>
          </Link>
        </div>

        {/* Right: navigation buttons */}
        <nav className="flex items-center gap-1.5">
          <NavLink to="/" active={current === 'landing'} label="Home" icon={<Home className="h-3.5 w-3.5" />} />
          <NavLink to="/dashboard" active={current === 'dashboard'} label="Dashboard" icon={<LayoutDashboard className="h-3.5 w-3.5" />} />
          <NavLink to="/history" active={current === 'history'} label="History" icon={<History className="h-3.5 w-3.5" />} />
        </nav>
      </div>
    </header>
  )
}

function NavLink({
  to,
  active,
  label,
  icon,
}: {
  to: string
  active: boolean
  label: string
  icon: React.ReactNode
}) {
  return (
    <Link
      to={to}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? 'bg-primary/15 text-primary ring-1 ring-primary/30'
          : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
      }`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </Link>
  )
}
