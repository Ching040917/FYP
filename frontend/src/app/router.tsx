import { createBrowserRouter } from 'react-router-dom'
import { Layout } from '../components/layout/Layout'
import { Dashboard } from '../pages/Dashboard'
import { AuditPage } from '../pages/AuditPage'
import { HistoryPage } from '../pages/HistoryPage'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'audit/:auditId', element: <AuditPage /> },
      { path: 'history', element: <HistoryPage /> },
    ],
  },
])