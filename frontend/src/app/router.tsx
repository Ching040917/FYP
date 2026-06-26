import { createBrowserRouter } from 'react-router-dom'
import { LandingPage } from '../pages/LandingPage'
import { Dashboard } from '../pages/Dashboard'
import { AuditPage } from '../pages/AuditPage'
import { HistoryPage } from '../pages/HistoryPage'

/**
 * Flat route map — no shared Layout wrapper.
 * Each page owns its own chrome (sticky header, etc.).
 */
export const router = createBrowserRouter([
  { path: '/', element: <LandingPage /> },
  { path: '/workspace', element: <Dashboard /> },
  { path: '/history', element: <HistoryPage /> },
  { path: '/audit/:auditId', element: <AuditPage /> },
])