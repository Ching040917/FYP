import { createBrowserRouter } from 'react-router-dom'
import { Layout } from '../components/layout/Layout'
import { Dashboard } from '../pages/Dashboard'
import { AuditPage } from '../pages/AuditPage'
import { HistoryPage } from '../pages/HistoryPage'

/**
 * Dashboard renders its own full-bleed reference layout (sticky header +
 * hero + main + footer) and therefore lives outside the shared Layout
 * (sidebar + header). History and AuditPage keep the existing chrome.
 */
export const router = createBrowserRouter([
  { path: '/', element: <Dashboard /> },
  {
    element: <Layout />,
    children: [
      { path: '/history', element: <HistoryPage /> },
      { path: '/audit/:auditId', element: <AuditPage /> },
    ],
  },
])