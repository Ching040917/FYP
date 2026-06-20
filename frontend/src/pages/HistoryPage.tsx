import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../services/api'
import type { AuditListItem } from '../types/api'
import { ArrowLeft, Loader2, FileText, AlertCircle, ChevronRight } from 'lucide-react'

export function HistoryPage() {
  const navigate = useNavigate()
  const [audits, setAudits] = useState<AuditListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchAudits = async () => {
    try {
      const data = await api.listAudits(50)
      setAudits(data)
    } catch (err: any) {
      setError(err.message || 'Failed to load history')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAudits()
  }, [])

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return <span className="badge-success">Completed</span>
      case 'failed':
        return <span className="badge-error">Failed</span>
      default:
        return <span className="badge-warning">Processing</span>
    }
  }

  const getScoreBadge = (score: number) => {
    const color = score >= 80 ? 'text-secondary' : score >= 50 ? 'text-amber-500' : 'text-error'
    return <span className={`font-mono text-lg font-bold ${color}`}>{score}</span>
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-4 mb-8">
          <button onClick={() => navigate('/')} className="btn-ghost p-2">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-headline-lg font-bold text-on-background">Audit History</h1>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-error/10 border border-error/20 rounded-lg flex items-center gap-3 text-error">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <p className="text-body-md">{error}</p>
          </div>
        )}

        {audits.length === 0 ? (
          <div className="card-elevated p-12 text-center">
            <FileText className="w-16 h-16 text-outline-variant mx-auto mb-4" />
            <p className="text-body-lg text-on-surface-variant">No audits yet</p>
            <p className="text-body-md text-on-surface-variant mt-1">Upload a .docx file to get started</p>
            <button onClick={() => navigate('/')} className="btn-primary mt-6">
              <ChevronRight className="w-5 h-5 ml-2" />
              Start New Audit
            </button>
          </div>
        ) : (
          <div className="card-elevated overflow-hidden">
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="w-12"></th>
                    <th>Filename</th>
                    <th className="w-28">Score</th>
                    <th className="w-36">Status</th>
                    <th className="w-48">Date</th>
                    <th className="w-12"></th>
                  </tr>
                </thead>
                <tbody>
                  {audits.map((audit) => (
                    <tr key={audit.id} className="cursor-pointer hover:bg-surface-container-high" onClick={() => navigate(`/audit/${audit.id}`)}>
                      <td>
                        <FileText className="w-5 h-5 text-on-surface-variant mx-auto" />
                      </td>
                      <td className="font-medium text-on-surface truncate max-w-xs" title={audit.filename}>
                        {audit.filename}
                      </td>
                      <td>{getScoreBadge(audit.weighted_score)}</td>
                      <td>{getStatusBadge(audit.status)}</td>
                      <td className="text-body-md text-on-surface-variant">
                        {new Date(audit.created_at).toLocaleString()}
                      </td>
                      <td className="text-center">
                        <ChevronRight className="w-5 h-5 text-on-surface-variant mx-auto" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}