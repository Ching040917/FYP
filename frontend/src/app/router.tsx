import { createBrowserRouter } from 'react-router-dom'
import { Landing } from '../pages/Landing'
import { Dashboard } from '../pages/Dashboard'
import { AuditPage } from '../pages/AuditPage'
import { HistoryPage } from '../pages/HistoryPage'

/**
 * Flat route map — no shared Layout wrapper.
 * Each page owns its own chrome (sticky header, etc.).
 *
 * /            → Landing (marketing/intro page)
 * /dashboard   → Dashboard (upload + audit results)
 * /history     → HistoryPage (past audit records)
 * /audit/:id   → AuditPage (single audit detail with polling)
 */
export const router = createBrowserRouter([
  { path: '/', element: <Landing /> },
  { path: '/dashboard', element: <Dashboard /> },
  { path: '/history', element: <HistoryPage /> },
  { path: '/audit/:auditId', element: <AuditPage /> },
])
