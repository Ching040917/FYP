import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../services/api'
import { useToast } from '../hooks/useToast'
import { Upload, FileText, Loader2, CheckCircle, AlertCircle, BarChart2 } from 'lucide-react'

export function Dashboard() {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file) return

    setUploading(true)

    try {
      const result = await api.auditDocument(file)
      showToast('Upload successful! Starting analysis...', 'success')
      navigate(`/audit/${result.audit_id}`)
    } catch (err: any) {
      const msg = err.response?.data?.detail || err.message || 'Upload failed. Please try again.'
      showToast(msg, 'error')
    } finally {
      setUploading(false)
    }
  }, [file, navigate, showToast])

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const droppedFile = e.dataTransfer.files[0]
    if (droppedFile && droppedFile.name.endsWith('.docx')) {
      setFile(droppedFile)
    } else if (droppedFile) {
      showToast('Only .docx files are supported', 'error')
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]
    if (selectedFile) {
      if (selectedFile.name.endsWith('.docx')) {
        setFile(selectedFile)
      } else {
        showToast('Only .docx files are supported', 'error')
      }
    }
  }

  const removeFile = () => setFile(null)

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-headline-lg font-bold text-on-background">Audit Dashboard</h1>
          <p className="text-body-md text-on-surface-variant mt-2">Upload a .docx file to check layout compliance and APA citations</p>
        </div>

        <form onSubmit={handleSubmit} className="card-elevated p-6">
          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
              file ? 'border-primary bg-primary/5' : 'border-outline-variant hover:border-primary/50'
            }`}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            <input
              type="file"
              id="file-upload"
              accept=".docx"
              onChange={handleFileSelect}
              className="hidden"
            />
            <label htmlFor="file-upload" className="cursor-pointer">
              {file ? (
                <div className="flex flex-col items-center gap-3">
                  <FileText className="w-12 h-12 text-primary" />
                  <p className="text-body-lg font-medium text-on-surface">{file.name}</p>
                  <p className="text-body-md text-on-surface-variant">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                  <button
                    type="button"
                    onClick={removeFile}
                    className="text-sm text-error hover:underline"
                  >
                    Remove file
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <Upload className="w-12 h-12 text-outline-variant" />
                  <p className="text-body-lg text-on-surface">Drag & drop a .docx file here</p>
                  <p className="text-body-md text-on-surface-variant">or click to browse</p>
                  <p className="text-label-md text-on-surface-variant">Max 10 MB • .docx only</p>
                </div>
              )}
            </label>
          </div>

          <div className="mt-6 flex justify-end">
            <button
              type="submit"
              disabled={!file || uploading}
              className="btn-primary flex items-center gap-2 min-w-[160px] justify-center"
            >
              {uploading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <CheckCircle className="w-5 h-5" />
                  Start Audit
                </>
              )}
            </button>
          </div>
        </form>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <div className="card p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary/10 rounded-lg">
                <BarChart2 className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-label-md text-on-surface-variant uppercase">Layout Score</p>
                <p className="text-headline-md font-bold text-on-surface">—</p>
              </div>
            </div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-secondary/10 rounded-lg">
                <CheckCircle className="w-5 h-5 text-secondary" />
              </div>
              <div>
                <p className="text-label-md text-on-surface-variant uppercase">Passed Checks</p>
                <p className="text-headline-md font-bold text-on-surface">—</p>
              </div>
            </div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-error/10 rounded-lg">
                <AlertCircle className="w-5 h-5 text-error" />
              </div>
              <div>
                <p className="text-label-md text-on-surface-variant uppercase">Violations</p>
                <p className="text-headline-md font-bold text-on-surface">—</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}