import { useLayoutEffect, type ReactNode } from 'react'
import { createBrowserRouter, useLocation, useNavigationType } from 'react-router-dom'
import { Landing } from '../pages/Landing'
import { Dashboard } from '../pages/Dashboard'
import { AuditPage } from '../pages/AuditPage'
import { HistoryPage } from '../pages/HistoryPage'
import { ProfileEditor } from '../pages/ProfileEditor'
import { AuditRouteErrorBoundary } from '../components/AuditRouteErrorBoundary'

/** Reset forward navigation to the two index pages without taking over browser Back. */
function IndexPage({ children }: { children: ReactNode }) {
  const { key, hash } = useLocation()
  const navigationType = useNavigationType()
  useLayoutEffect(() => {
    if (navigationType !== 'POP' && !hash) window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [key, hash, navigationType])
  return children
}

/**
 * Flat route map — no shared Layout wrapper.
 * Each page owns its own chrome (sticky header, etc.).
 *
 * /                  → Landing (marketing/intro page)
 * /dashboard          → Dashboard (upload + audit results)
 * /history            → HistoryPage (past audit records)
 * /audit/:id          → AuditPage (single audit detail with polling)
 * /profiles/custom    → ProfileEditor (custom formatting profiles, Build 3)
 *
 * The Audit route is wrapped in its own error boundary so a preview
 * failure shows a calm recovery action — never the raw React stack.
 */
export const router = createBrowserRouter([
  { path: '/', element: <Landing /> },
  { path: '/dashboard', element: <IndexPage><Dashboard /></IndexPage> },
  { path: '/history', element: <IndexPage><HistoryPage /></IndexPage> },
  { path: '/profiles/custom', element: <ProfileEditor /> },
  {
    path: '/audit/:auditId',
    element: (
      <AuditRouteErrorBoundary>
        <AuditPage />
      </AuditRouteErrorBoundary>
    ),
  },
])
