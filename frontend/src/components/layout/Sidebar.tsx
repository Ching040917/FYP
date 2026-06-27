import { NavLink, useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'

const navItems = [
  { path: '/', label: 'Dashboard', icon: HomeIcon },
  { path: '/history', label: 'History', icon: HistoryIcon },
] as const

function HomeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  )
}

function HistoryIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

function LogoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  )
}

export function Sidebar() {
  const location = useLocation()
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isMobileOpen, setIsMobileOpen] = useState(false)

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 1024) {
        setIsMobileOpen(false)
      }
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const isActive = (path: string) => location.pathname === path || (path !== '/' && location.pathname.startsWith(path))

  if (typeof window !== 'undefined' && window.innerWidth < 1024) {
    return (
      <>
        <button
          className="fixed top-4 left-4 z-50 btn-ghost md:hidden"
          onClick={() => setIsMobileOpen(true)}
          aria-label="Open menu"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
        {isMobileOpen && (
          <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setIsMobileOpen(false)} />
        )}
        <aside className={`fixed top-0 left-0 h-full z-50 bg-surface-container border-r border-outline-variant transition-transform duration-200 md:relative md:translate-x-0 ${isMobileOpen ? 'translate-x-0' : '-translate-x-full'} w-64`}>
          <SidebarContent isCollapsed={false} isActive={isActive} onClose={() => setIsMobileOpen(false)} />
        </aside>
      </>
    )
  }

  return (
    <aside className={`h-screen fixed top-0 left-0 z-30 bg-surface-container border-r border-outline-variant transition-all duration-200 ${isCollapsed ? 'w-16' : 'w-64'}`}>
      <SidebarContent isCollapsed={isCollapsed} isActive={isActive} />
      <button
        className="absolute bottom-4 left-1/2 -translate-x-1/2 p-2 rounded-lg hover:bg-surface-container-high transition-colors"
        onClick={() => setIsCollapsed(!isCollapsed)}
        aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <svg className="w-5 h-5 text-on-surface-variant" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={isCollapsed ? "M9 5l7 7-7 7" : "M15 19l-7-7 7-7"} />
        </svg>
      </button>
    </aside>
  )
}

function SidebarContent({ isCollapsed, isActive, onClose }: { isCollapsed: boolean; isActive: (path: string) => boolean; onClose?: () => void }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 p-4 border-b border-outline-variant">
        <LogoIcon className="w-8 h-8 text-primary flex-shrink-0" />
        {!isCollapsed && (
          <span className="text-headline-md text-on-surface whitespace-nowrap">Academic Auditor</span>
        )}
      </div>
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const active = isActive(item.path)
          return (
            <NavLink
              key={item.path}
              to={item.path}
              onClick={onClose}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
                active
                  ? 'bg-primary/10 text-primary'
                  : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
              }`}
              title={isCollapsed ? item.label : undefined}
            >
              <item.icon className="w-5 h-5 flex-shrink-0" />
              {!isCollapsed && <span className="font-medium">{item.label}</span>}
            </NavLink>
          )
        })}
      </nav>
      <div className="p-3 border-t border-outline-variant">
        {!isCollapsed && (
          <div className="text-xs text-on-surface-variant text-center">
            Academic Compliance Auditor v1.0
          </div>
        )}
      </div>
    </div>
  )
}