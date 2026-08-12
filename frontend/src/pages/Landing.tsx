/**
 * Landing page — concise editorial entry point (Build 6).
 *
 * Presents the Academic Compliance Auditor as a local-first, read-only
 * academic document inspection tool. No live dashboard embeds, no
 * marketing statistics, no decorative animation. The static product
 * preview is example data and never touches the backend.
 *
 * Landmarks: one header, one main (#landing-main), one footer; one skip
 * link. Heading hierarchy: one h1, h2 per section.
 */

import { Link } from 'react-router-dom'
import {
  ArrowRight,
  ClipboardCheck,
  FileText,
  History,
  ListChecks,
  ListTree,
  Quote,
  Ruler,
  ShieldCheck,
  Upload,
} from 'lucide-react'
import { StaticAuditPreview } from '../components/landing/static-audit-preview'
import type { LucideIcon } from 'lucide-react'

const SHIELD_LOGO = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" />
  </svg>
)

export function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a className="skip-link" href="#landing-main">
        Skip to main content
      </a>

      {/* ────────────── Header ────────────── */}
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between gap-4 px-4 md:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-md bg-primary/15 text-primary ring-1 ring-primary/30">
              {SHIELD_LOGO}
            </div>
            <span className="text-sm font-semibold tracking-tight text-foreground">
              Academic Compliance Auditor
            </span>
          </Link>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <a href="#checks" className="transition-colors hover:text-foreground">Checks</a>
            <a href="#how" className="transition-colors hover:text-foreground">How it works</a>
            <a href="#privacy" className="transition-colors hover:text-foreground">Privacy</a>
            <a href="#scope" className="hidden transition-colors hover:text-foreground sm:inline">Scope</a>
          </nav>
        </div>
      </header>

      <main id="landing-main" className="mx-auto w-full max-w-4xl px-4 md:px-6">
        {/* ────────────── Hero ────────────── */}
        <section className="border-b border-border py-10 md:py-12">
          <p className="text-[11px] font-medium uppercase tracking-wider text-primary">
            Academic document audit
          </p>
          <h1 className="mt-3 font-serif text-page-title leading-[34px] text-foreground md:text-[34px] md:leading-[42px]">
            Review your academic document before submission
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-[21px] text-muted-foreground md:text-base md:leading-[24px]">
            The system checks supported formatting, document structure, captions, and basic
            citation patterns in a .docx thesis draft — without rewriting your original Word
            document. Deterministic formatting checks run locally by default; an optional
            AI-assisted citation review is opt-in.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              to="/dashboard"
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary/90"
            >
              <Upload className="h-4 w-4" aria-hidden="true" />
              Start an audit
            </Link>
            <Link
              to="/history"
              className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              <History className="h-4 w-4" aria-hidden="true" />
              View audit history
            </Link>
          </div>
        </section>

        {/* ────────────── Supported checks ────────────── */}
        <section id="checks" className="border-b border-border py-10 md:py-12">
          <h2 className="text-section-title text-foreground">Supported audit checks</h2>
          <p className="mt-2 max-w-2xl text-[13px] leading-[19px] text-muted-foreground">
            The audit covers formatting and structural rules enforced by the rules engine.
            Citation-pattern review is AI-assisted and optional.
          </p>
          <dl className="mt-5 grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <CheckGroup
              icon={Ruler}
              title="Typography"
              items={[
                'Font family and font size (body and headings)',
                'Line spacing and paragraph spacing',
                'Paragraph alignment',
              ]}
            />
            <CheckGroup
              icon={FileText}
              title="Page layout"
              items={[
                'Page margins (top, bottom, left, right)',
              ]}
            />
            <CheckGroup
              icon={ListTree}
              title="Document structure"
              items={['Heading hierarchy (H1–H6 levels)']}
            />
            <CheckGroup
              icon={ListChecks}
              title="Captions"
              items={['Numbered captions for tables and figures']}
            />
            <CheckGroup
              icon={Quote}
              title="Basic citation patterns"
              items={[
                'AI-assisted in-text citation pattern review (optional, cloud opt-in)',
              ]}
            />
            <CheckGroup
              icon={ClipboardCheck}
              title="Compliance summary"
              items={[
                'Weighted compliance score with per-category deductions',
                'Category verdicts and correction guidance',
              ]}
            />
          </dl>
        </section>

        {/* ────────────── Static product preview ────────────── */}
        <section className="border-b border-border py-10 md:py-12">
          <h2 className="text-section-title text-foreground">What a report looks like</h2>
          <p className="mt-2 max-w-2xl text-[13px] leading-[19px] text-muted-foreground">
            A completed report lists findings with expected and actual values, and opens
            from the history page.
          </p>
          <div className="mt-5">
            <StaticAuditPreview />
          </div>
        </section>

        {/* ────────────── How it works ────────────── */}
        <section id="how" className="border-b border-border py-10 md:py-12">
          <h2 className="text-section-title text-foreground">How the audit works</h2>
          <ol className="mt-5 list-decimal space-y-3 pl-5 text-sm leading-[21px] text-foreground">
            <li>
              <span className="font-medium">Upload a .docx document.</span>{' '}
              <span className="text-muted-foreground">
                Accepted files are .docx only, up to 10 MB. Documents are held in memory.
              </span>
            </li>
            <li>
              <span className="font-medium">Run deterministic formatting checks.</span>{' '}
              <span className="text-muted-foreground">
                Layout and structure rules run locally; the optional AI-assisted citation
                review runs only when cloud mode is enabled for that audit.
              </span>
            </li>
            <li>
              <span className="font-medium">Review findings and correction guidance.</span>{' '}
              <span className="text-muted-foreground">
                Each finding shows expected and actual values with read-only guidance. The
                original document is never modified.
              </span>
            </li>
          </ol>
        </section>

        {/* ────────────── Local-first and read-only ────────────── */}
        <section id="privacy" className="border-b border-border py-10 md:py-12">
          <h2 className="text-section-title text-foreground">Local-first and read-only</h2>
          <dl className="mt-5 grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <PrivacyRow
              icon={ShieldCheck}
              label="Local-first processing"
              detail="Deterministic formatting checks run locally by default and do not require network access."
            />
            <PrivacyRow
              icon={Upload}
              label="Optional cloud assistance"
              detail="The AI-assisted citation review is opt-in per audit, behind an explicit toggle."
            />
            <PrivacyRow
              icon={FileText}
              label="Read-only document review"
              detail="Your .docx is loaded into memory and never overwritten or rewritten."
            />
            <PrivacyRow
              icon={History}
              label="Local audit history"
              detail="Audit records are stored in a local database so previous reports can be reopened."
            />
          </dl>
        </section>

        {/* ────────────── Scope and limitations ────────────── */}
        <section id="scope" className="border-b border-border py-10 md:py-12">
          <h2 className="text-section-title text-foreground">Scope and limitations</h2>
          <ul className="mt-5 list-disc space-y-2 pl-5 text-sm leading-[21px] text-muted-foreground">
            <li>Supported format is .docx only — no PDF or LaTeX.</li>
            <li>No plagiarism detection.</li>
            <li>No full grammar correction.</li>
            <li>No complete reference-list verification.</li>
            <li>No automatic document rewriting.</li>
            <li>AI-assisted suggestions may require human review.</li>
          </ul>
        </section>

        {/* ────────────── Final action ────────────── */}
        <section className="py-10 md:py-12">
          <h2 className="text-section-title text-foreground">Start an audit</h2>
          <p className="mt-2 max-w-2xl text-[13px] leading-[19px] text-muted-foreground">
            Open the Dashboard to upload a document and review the compliance summary.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              to="/dashboard"
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary/90"
            >
              Open Dashboard
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
            <Link
              to="/history"
              className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              View audit history
            </Link>
          </div>
        </section>
      </main>

      {/* ────────────── Footer ────────────── */}
      <footer className="border-t border-border bg-card">
        <div className="mx-auto flex max-w-4xl flex-col items-start justify-between gap-4 px-4 py-6 md:flex-row md:items-center md:px-6">
          <div className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-md bg-primary/15 text-primary ring-1 ring-primary/30">
              {SHIELD_LOGO}
            </div>
            <div>
              <div className="text-sm font-semibold text-foreground">Academic Compliance Auditor</div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Local-first .docx auditing
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link to="/dashboard" className="transition-colors hover:text-foreground">Dashboard</Link>
            <Link to="/history" className="transition-colors hover:text-foreground">History</Link>
          </div>
        </div>
        <div className="border-t border-border/60 px-4 py-3 md:px-6">
          <p className="mx-auto max-w-4xl text-[11px] text-muted-foreground">
            © 2024 Academic Compliance Systems. Audit records are stored locally; the original
            document is never modified.
          </p>
        </div>
      </footer>
    </div>
  )
}

/* ----------------------------- Section pieces ----------------------------- */

function CheckGroup({ icon: Icon, title, items }: { icon: LucideIcon; title: string; items: string[] }) {
  return (
    <div>
      <dt className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
        {title}
      </dt>
      <dd className="mt-1.5 space-y-1 text-[13px] leading-[19px] text-muted-foreground">
        {items.map((item) => (
          <p key={item}>{item}</p>
        ))}
      </dd>
    </div>
  )
}

function PrivacyRow({ icon: Icon, label, detail }: { icon: LucideIcon; label: string; detail: string }) {
  return (
    <div>
      <dt className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
        {label}
      </dt>
      <dd className="mt-1.5 text-[13px] leading-[19px] text-muted-foreground">{detail}</dd>
    </div>
  )
}
