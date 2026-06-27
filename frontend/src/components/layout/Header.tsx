import { useState } from 'react'

export function Header() {
  const [deployMode, setDeployMode] = useState<'LOCAL' | 'CLOUD'>('LOCAL')

  return (
    <header className="bg-surface-container border-b border-outline-variant sticky top-0 z-20">
      <div className="max-w-[1440px] mx-auto px-4 md:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-4">
            <h1 className="text-headline-lg text-on-surface">Academic Compliance Auditor</h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="relative">
                <select
                  value={deployMode}
                  onChange={(e) => setDeployMode(e.target.value as 'LOCAL' | 'CLOUD')}
                  className="input-field w-auto appearance-none pr-8"
                >
                  <option value="LOCAL">Local (Ollama)</option>
                  <option value="CLOUD">Cloud (Gemini)</option>
                </select>
                <svg className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" /></svg>
              </div>
              <input type="file" id="file-upload" accept=".docx" className="hidden" />
              <label htmlFor="file-upload" className="btn-primary">
                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                Upload .docx
              </label>
            </div>
          </div>
        </div>
      </div>
    </header>
  )
}