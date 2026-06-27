/**
 * Landing page — the marketing/intro page for the Academic Compliance Auditor.
 *
 * Ported from a standalone HTML mockup to a React page component. Uses the
 * existing Material 3 design tokens (surface-container, on-surface-variant,
 * outline-variant, primary, secondary, tertiary) already configured in
 * tailwind.config.js. Decorative effects (hero glow, grid bg, window frame,
 * marquee, reveal-on-scroll) live in index.css.
 *
 * Navigation:
 *   - In-page anchors (#features, #how, #architecture, #privacy) use plain
 *     <a> tags — same-page scroll works natively.
 *   - App routes (/dashboard, /history) use react-router-dom <Link>.
 *
 * Animations:
 *   - Score ring IntersectionObserver → useEffect
 *   - Reveal-on-scroll IntersectionObserver → useEffect
 */

import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'

const SHIELD_LOGO = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#c0c1ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" className="w-5 h-5">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" />
  </svg>
)

export function Landing() {
  const scoreRingRef = useRef<SVGCircleElement | null>(null)
  const scoreNumRef = useRef<HTMLSpanElement | null>(null)

  // Animated score gauge on the dashboard preview
  useEffect(() => {
    const ring = scoreRingRef.current
    const num = scoreNumRef.current
    if (!ring || !num) return

    const circumference = 2 * Math.PI * 20 // r=20
    const target = 84
    let current = 0
    let raf = 0

    const animate = () => {
      const step = () => {
        current += 1
        if (current > target) current = target
        num.textContent = String(current)
        const offset = circumference - (current / 100) * circumference
        ring.setAttribute('stroke-dashoffset', String(offset))
        if (current < target) raf = requestAnimationFrame(step)
      }
      step()
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            animate()
            observer.disconnect()
          }
        })
      },
      { threshold: 0.3 },
    )
    observer.observe(ring)

    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [])

  // Reveal-on-scroll for .reveal elements
  useEffect(() => {
    const els = document.querySelectorAll('.reveal')
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('visible'))
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible')
            observer.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.1 },
    )
    els.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  return (
    <div className="bg-background text-on-surface font-sans antialiased">
      {/* ============ TOP NAV ============ */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-surface-container/80 backdrop-blur-md border-b border-outline-variant">
        <div className="max-w-[1440px] mx-auto px-md h-16 flex items-center justify-between">
          <a href="#top" className="flex items-center gap-md">
            <div className="w-8 h-8 rounded-md bg-primary/15 border border-primary/30 flex items-center justify-center">
              {SHIELD_LOGO}
            </div>
            <span className="font-semibold text-on-surface tracking-tight">Academic Compliance Auditor</span>
          </a>
          <nav className="hidden md:flex items-center gap-lg text-sm text-on-surface-variant">
            <a href="#features" className="hover:text-on-surface transition-colors">Features</a>
            <a href="#dashboard" className="hover:text-on-surface transition-colors">Dashboard</a>
            <a href="#how" className="hover:text-on-surface transition-colors">How it works</a>
            <a href="#architecture" className="hover:text-on-surface transition-colors">Architecture</a>
            <a href="#privacy" className="hover:text-on-surface transition-colors">Privacy</a>
          </nav>
          <div className="flex items-center gap-sm">
            <Link
              to="/dashboard"
              className="hidden sm:inline-flex items-center gap-xs px-md py-xs rounded border border-outline-variant text-on-surface-variant hover:text-on-surface hover:border-primary/50 transition-colors text-sm"
            >
              <span className="material-symbols-outlined text-base">play_arrow</span>
              Live demo
            </Link>
            <Link
              to="/dashboard"
              className="inline-flex items-center gap-xs px-md py-sm rounded bg-primary text-on-primary font-medium text-sm hover:opacity-90 transition-opacity"
            >
              <span className="material-symbols-outlined text-base">download</span>
              Open the app
            </Link>
          </div>
        </div>
      </header>

      {/* ============ HERO ============ */}
      <section id="top" className="hero-glow relative pt-32 pb-20 md:pt-40 md:pb-28 overflow-hidden">
        <div className="absolute inset-0 grid-bg opacity-40 pointer-events-none" />
        <div className="relative max-w-[1440px] mx-auto px-md">
          <div className="max-w-3xl mx-auto text-center">
            <div className="inline-flex items-center gap-xs px-md py-xs rounded-full border border-outline-variant bg-surface-container text-sm text-on-surface-variant mb-md">
              <span className="w-1.5 h-1.5 rounded-full bg-secondary animate-pulse" />
              Local-first · Privacy-preserving · APA 7th precise
            </div>
            <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-[1.05] mb-md">
              Audit your thesis <span className="text-primary">before</span> the deadline does it for you.
            </h1>
            <p className="text-lg md:text-xl text-on-surface-variant max-w-2xl mx-auto mb-lg leading-relaxed">
              A local-first web app that scans <span className="font-mono text-secondary">.docx</span> files for layout compliance, heading hierarchy, and APA 7th citation accuracy — in seconds, with zero data leaving your machine.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-sm">
              <Link
                to="/dashboard"
                className="inline-flex items-center gap-xs px-lg py-sm rounded bg-primary text-on-primary font-medium hover:opacity-90 transition-opacity"
              >
                <span className="material-symbols-outlined">visibility</span>
                See the dashboard
              </Link>
              <a
                href="#architecture"
                className="inline-flex items-center gap-xs px-lg py-sm rounded border border-outline-variant text-on-surface hover:border-primary/50 transition-colors"
              >
                <span className="material-symbols-outlined">schema</span>
                Read the architecture
              </a>
            </div>

            {/* Stat row */}
            <div className="mt-xl grid grid-cols-2 md:grid-cols-4 gap-md max-w-3xl mx-auto">
              <Stat value="<0.5s" tone="primary" label="Layout rule pass" />
              <Stat value="100%" tone="secondary" label="Local by default" />
              <Stat value="10MB" tone="primary" label="File size cap" />
              <Stat value=".docx" tone="secondary" label="Only format supported" />
            </div>
          </div>
        </div>
      </section>

      {/* ============ FEATURES ============ */}
      <section id="features" className="py-20 md:py-28">
        <div className="max-w-[1440px] mx-auto px-md">
          <div className="text-center max-w-2xl mx-auto mb-xl">
            <p className="text-sm uppercase tracking-widest text-primary font-medium mb-sm">Three pillars</p>
            <h2 className="text-3xl md:text-4xl font-semibold tracking-tight mb-md">Built for the last 48 hours of thesis season.</h2>
            <p className="text-on-surface-variant text-lg">Every architectural choice exists to make late-stage formatting checks faster, safer, and more accurate than anything else on the market.</p>
          </div>

          <div className="grid md:grid-cols-3 gap-md">
            <FeatureCard
              tone="primary"
              icon="shield_lock"
              title="Local-first, always"
              description="Your draft never leaves the machine. The default pipeline runs entirely against a local AI engine (Ollama + Qwen2.5-3B). The cloud is opt-in and disabled behind a UI toggle."
              points={[
                'Read-only memory buffer handling',
                'Never rewrites your .docx',
                'Cloud path locked behind consent',
              ]}
            />
            <FeatureCard
              tone="secondary"
              icon="memory"
              title="Dual-engine audit"
              description="Layout checks run on a deterministic rules engine in under half a second. Citation checks run on a parallel AI track. They merge into one consistent report — no waiting."
              points={[
                'Async background task fan-out',
                'JSON-defensive AI output parsing',
                'Graceful fallback on model timeout',
              ]}
            />
            <FeatureCard
              tone="tertiary"
              icon="analytics"
              title="Weighted scoring"
              description="Structural violations (page margins, heading gaps) weigh as Major Violations. Typography inconsistencies weigh as Minor. One typo won't tank your grade — but a missing H2 will."
              points={[
                'Score = 100 − weighted deductions',
                'Per-line violation highlighting',
                'AI-generated fix tooltips',
              ]}
            />
          </div>
        </div>
      </section>

      {/* ============ DASHBOARD PREVIEW ============ */}
      <section id="dashboard" className="py-20 md:py-28 bg-surface-container-lowest">
        <div className="max-w-[1440px] mx-auto px-md">
          <div className="text-center max-w-2xl mx-auto mb-xl">
            <p className="text-sm uppercase tracking-widest text-primary font-medium mb-sm">The dashboard</p>
            <h2 className="text-3xl md:text-4xl font-semibold tracking-tight mb-md">Every error in context, every fix one click away.</h2>
            <p className="text-on-surface-variant text-lg">Upload a draft. The left panel shows the document with errors highlighted at the line. The right panel gives you structured fixes.</p>
          </div>

          {/* Dashboard window mockup */}
          <div className="window-frame">
            {/* Window chrome */}
            <div className="h-9 bg-surface-container border-b border-outline-variant flex items-center px-md gap-sm">
              <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
              <span className="ml-md text-xs text-on-surface-variant font-mono">academic-compliance.local — Compliance Check</span>
            </div>

            {/* Top bar */}
            <div className="h-16 bg-surface-container border-b border-outline-variant flex items-center justify-between px-md">
              <div className="flex items-center gap-md">
                <div className="w-7 h-7 rounded bg-primary/15 border border-primary/30 flex items-center justify-center">
                  {SHIELD_LOGO}
                </div>
                <span className="text-on-surface font-medium">Academic Compliance Portal</span>
              </div>
              <div className="flex items-center gap-md">
                {/* Score gauge */}
                <div className="relative w-12 h-12">
                  <svg className="w-12 h-12" viewBox="0 0 48 48">
                    <circle cx="24" cy="24" r="20" fill="none" stroke="#34343d" strokeWidth="3" />
                    <circle
                      ref={scoreRingRef}
                      className="progress-ring__circle"
                      cx="24" cy="24" r="20" fill="none"
                      stroke="#4edea3" strokeWidth="3" strokeLinecap="round"
                      strokeDasharray="125.66" strokeDashoffset="125.66"
                    />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span ref={scoreNumRef} className="text-sm font-mono font-semibold text-secondary">0</span>
                  </div>
                </div>
                <span className="text-sm text-on-surface-variant hidden sm:inline">SCORE</span>
                <span className="material-symbols-outlined text-on-surface-variant cursor-pointer hover:text-on-surface hidden sm:inline">notifications</span>
                <span className="material-symbols-outlined text-on-surface-variant cursor-pointer hover:text-on-surface hidden sm:inline">help</span>
                <div className="w-8 h-8 rounded-full bg-tertiary/20 border border-tertiary/30 flex items-center justify-center">
                  <span className="material-symbols-outlined text-tertiary text-base">person</span>
                </div>
              </div>
            </div>

            {/* Body: sidebar + main + assistant */}
            <div className="grid grid-cols-[180px_1fr_320px] min-h-[560px] max-md:grid-cols-1">
              {/* Left sidebar */}
              <aside className="bg-surface-container border-r border-outline-variant p-md max-md:hidden">
                <div className="mb-md">
                  <p className="text-on-surface font-medium text-sm">Lead Auditor</p>
                  <p className="text-xs text-on-surface-variant">Department of Research</p>
                </div>
                <button className="w-full mb-sm flex items-center justify-center gap-xs px-md py-sm rounded bg-primary text-on-primary text-sm font-medium hover:opacity-90 transition-opacity">
                  <span className="material-symbols-outlined text-base">add</span>
                  New Audit
                </button>
                <button className="w-full mb-md flex items-center justify-center gap-xs px-md py-sm rounded bg-secondary text-on-secondary text-sm font-medium hover:opacity-90 transition-opacity">
                  <span className="material-symbols-outlined text-base">rule</span>
                  Compliance Check
                </button>
                <nav className="space-y-xs">
                  <a className="flex items-center gap-sm px-sm py-xs rounded text-on-surface-variant hover:bg-surface-container-high text-sm transition-colors">
                    <span className="material-symbols-outlined text-base">history</span>
                    History
                  </a>
                  <a className="flex items-center gap-sm px-sm py-xs rounded text-on-surface-variant hover:bg-surface-container-high text-sm transition-colors">
                    <span className="material-symbols-outlined text-base">database</span>
                    Regulatory DB
                  </a>
                  <a className="flex items-center gap-sm px-sm py-xs rounded text-on-surface-variant hover:bg-surface-container-high text-sm transition-colors">
                    <span className="material-symbols-outlined text-base">monitoring</span>
                    Analytics
                  </a>
                </nav>
              </aside>

              {/* Main document */}
              <main className="bg-background p-lg overflow-auto">
                <div className="flex items-start gap-md">
                  {/* Line numbers */}
                  <div className="text-right font-mono text-xs text-on-surface-variant pt-xs select-none">
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                      <div key={n} className="h-6">{n}</div>
                    ))}
                  </div>
                  <div className="flex-1 font-sans">
                    <h2 className="text-2xl font-semibold mb-md text-on-surface">Chapter 4: Methodology and Analysis</h2>
                    <p className="text-on-surface leading-relaxed mb-md">The primary dataset was collected over a three-month period utilizing a stratified random sampling approach. Participant demographics were recorded, ensuring representation across all targeted socioeconomic strata.</p>
                    {/* Highlighted paragraph */}
                    <p className="text-on-surface leading-relaxed mb-md p-sm rounded border-l-2 border-error bg-error/5">
                      However, an alternative methodology was proposed by Smith (2022) but was not fully integrated into the initial framework due to time constraints and lack of available literature regarding its long-term efficacy in similar cohort studies.
                    </p>
                    <p className="text-on-surface leading-relaxed">Further analysis revealed a statistically significant correlation between the independent variables, supporting the primary hypothesis formulated during the preliminary review phase.</p>
                  </div>
                </div>
              </main>

              {/* Right assistant */}
              <aside className="bg-surface-container border-l border-outline-variant p-md overflow-auto">
                <div className="flex items-center justify-between mb-md">
                  <div className="flex items-center gap-xs">
                    <span className="material-symbols-outlined text-primary text-base">auto_awesome</span>
                    <span className="font-medium text-on-surface text-sm">Citation Assistant</span>
                  </div>
                  <span className="px-sm py-xs rounded text-xs bg-tertiary/15 text-tertiary border border-tertiary/30">3 Issues</span>
                </div>

                {/* Major violation */}
                <div className="violation-card rounded-lg bg-error/5 border-l-2 border-error p-sm mb-sm">
                  <div className="flex items-center justify-between mb-xs">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-error bg-error/15 px-sm py-xs rounded">Major Violation</span>
                    <span className="text-xs font-mono text-on-surface-variant">Line 6-7</span>
                  </div>
                  <h4 className="text-sm font-semibold text-on-surface mb-xs">Missing Citation & Formatting</h4>
                  <p className="text-xs text-on-surface-variant leading-relaxed mb-sm">&ldquo;Smith (2022)&rdquo; is mentioned in text but missing from the bibliography. The paragraph structure also deviates from APA 7th ed. guidelines for long quotes.</p>
                  <div className="bg-surface-container-high rounded p-sm mb-sm">
                    <p className="text-[10px] uppercase tracking-wider text-primary mb-xs flex items-center gap-xs">
                      <span className="material-symbols-outlined text-xs">smart_toy</span>
                      AI Fix Suggestion
                    </p>
                    <code className="text-[11px] font-mono text-on-surface leading-relaxed block">Insert Citation › Add New Source. Ensure author name is spelled exactly as &lsquo;Smith, J.&rsquo;</code>
                  </div>
                  <button className="w-full text-xs py-xs rounded bg-primary text-on-primary font-medium hover:opacity-90 transition-opacity">Apply Format Fix</button>
                </div>

                {/* Minor violation */}
                <div className="rounded-lg bg-tertiary/5 border-l-2 border-tertiary p-sm">
                  <div className="flex items-center justify-between mb-xs">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-tertiary bg-tertiary/15 px-sm py-xs rounded">Minor Violation</span>
                    <span className="text-xs font-mono text-on-surface-variant">Line 12</span>
                  </div>
                  <h4 className="text-sm font-semibold text-on-surface mb-xs">Passive Voice Overuse</h4>
                  <p className="text-xs text-on-surface-variant leading-relaxed">Academic guidelines recommend active voice for clarity. &ldquo;Further analysis revealed...&rdquo; could be restructured.</p>
                </div>
              </aside>
            </div>

            {/* Footer */}
            <div className="h-10 bg-surface-container border-t border-outline-variant flex items-center justify-between px-md text-xs text-on-surface-variant">
              <div className="flex items-center gap-md">
                <span className="flex items-center gap-xs">
                  <span className="w-1.5 h-1.5 rounded-full bg-outline" />
                  Optional Cloud Mode
                </span>
                <span className="font-mono text-outline">(Disabled)</span>
              </div>
              <span className="font-mono hidden sm:inline">© 2024 Academic Compliance Systems. All rights reserved.</span>
              <div className="flex items-center gap-xs">
                <span className="w-1.5 h-1.5 rounded-full bg-secondary" />
                <span className="text-secondary">Local AI Core: Online</span>
                <span className="font-mono ml-xs text-outline hidden sm:inline">(Ollama Qwen2.5-3B)</span>
              </div>
            </div>
          </div>

          {/* CTA below mockup — links to the live dashboard */}
          <div className="mt-xl text-center">
            <Link
              to="/dashboard"
              className="inline-flex items-center gap-xs px-lg py-sm rounded bg-primary text-on-primary font-medium hover:opacity-90 transition-opacity"
            >
              <span className="material-symbols-outlined">play_arrow</span>
              Open the live dashboard
            </Link>
          </div>
        </div>
      </section>

      {/* ============ HOW IT WORKS ============ */}
      <section id="how" className="py-20 md:py-28">
        <div className="max-w-[1440px] mx-auto px-md">
          <div className="text-center max-w-2xl mx-auto mb-xl">
            <p className="text-sm uppercase tracking-widest text-primary font-medium mb-sm">How it works</p>
            <h2 className="text-3xl md:text-4xl font-semibold tracking-tight mb-md">Three steps from draft to clean.</h2>
          </div>

          <div className="grid md:grid-cols-3 gap-md relative">
            {/* Connecting line */}
            <div className="hidden md:block absolute top-8 left-[16%] right-[16%] h-px bg-gradient-to-r from-primary/0 via-primary/40 to-primary/0 pointer-events-none" />

            <Step
              num={1}
              tone="primary"
              icon="upload_file"
              title="Drop your .docx"
              description="Drag it onto the upload zone. Strict validation rejects anything over 10 MB or any non-.docx file before it touches the parser."
            />
            <Step
              num={2}
              tone="secondary"
              icon="bolt"
              title="Dual-engine scan"
              description="Layout rules run synchronously in <0.5s. AI citation checks fire as a background task. Both merge into one report."
            />
            <Step
              num={3}
              tone="tertiary"
              icon="task_alt"
              title="Click-to-fix"
              description="Each violation has an AI-generated fix tooltip. Apply the ones you agree with. Re-run for a fresh score."
            />
          </div>
        </div>
      </section>

      {/* ============ ARCHITECTURE ============ */}
      <section id="architecture" className="py-20 md:py-28 bg-surface-container-lowest">
        <div className="max-w-[1440px] mx-auto px-md">
          <div className="grid lg:grid-cols-2 gap-xl items-center">
            <div>
              <p className="text-sm uppercase tracking-widest text-primary font-medium mb-sm">Under the hood</p>
              <h2 className="text-3xl md:text-4xl font-semibold tracking-tight mb-md">A decoupled dual-engine architecture.</h2>
              <p className="text-on-surface-variant leading-relaxed mb-md">
                The frontend is React, the backend is FastAPI on ASGI. The document parser is <span className="font-mono text-secondary">python-docx</span> reading files directly into memory buffers — no Word client, no rewriting.
              </p>
              <p className="text-on-surface-variant leading-relaxed mb-lg">
                The layout rules engine runs deterministically on the request thread. Citation verification dispatches to a background task against Ollama (default) or Gemini 1.5 Flash (opt-in). Output is JSON-defensive — bad AI responses degrade to a warning card, never a crash.
              </p>

              <div className="space-y-sm">
                <ArchRow icon="check_circle" title="React + FastAPI" subtitle="Decoupled B/S architecture, ASGI async concurrency" />
                <ArchRow icon="check_circle" title="python-docx" subtitle="In-memory OpenXML scan, no Word instance spawned" />
                <ArchRow icon="check_circle" title="Ollama · Qwen2.5-3B" subtitle="Default local AI path · quantized for speed" />
                <ArchRow icon="check_circle" title="Strategy-pattern rules" subtitle="Typographic checks composed as pluggable strategies" />
              </div>
            </div>

            {/* Architecture diagram */}
            <div className="space-y-sm">
              {/* Frontend */}
              <div className="code-block p-md">
                <div className="flex items-center gap-sm mb-sm">
                  <span className="material-symbols-outlined text-primary text-base">web</span>
                  <span className="tok-key">Frontend</span>
                  <span className="text-on-surface-variant">React.js · Virtual DOM · incremental updates</span>
                </div>
                <div className="text-center text-on-surface-variant">│ HTTP / Async JSON</div>
              </div>

              {/* Backend */}
              <div className="code-block p-md">
                <div className="flex items-center gap-sm mb-sm">
                  <span className="material-symbols-outlined text-secondary text-base">dns</span>
                  <span className="tok-key">Backend</span>
                  <span className="text-on-surface-variant">FastAPI · ASGI · BackgroundTasks</span>
                </div>
                <div className="grid grid-cols-2 gap-sm mt-sm">
                  <div className="rounded border border-primary/30 bg-primary/5 p-sm">
                    <p className="text-xs tok-key mb-xs">Layout Rules Engine</p>
                    <p className="text-[11px] text-on-surface-variant">Deterministic · &lt;0.5s</p>
                  </div>
                  <div className="rounded border border-secondary/30 bg-secondary/5 p-sm">
                    <p className="text-xs tok-fn mb-xs">Ollama · Qwen2.5-3B</p>
                    <p className="text-[11px] text-on-surface-variant">Async background task</p>
                  </div>
                </div>
                <p className="text-[11px] text-on-surface-variant mt-sm italic">↳ optional cloud path: Gemini 1.5 Flash (UI-gated)</p>
              </div>

              {/* Parser */}
              <div className="code-block p-md">
                <div className="flex items-center gap-sm mb-xs">
                  <span className="material-symbols-outlined text-tertiary text-base">description</span>
                  <span className="tok-key">Document Parser</span>
                  <span className="text-on-surface-variant">python-docx · in-memory</span>
                </div>
              </div>

              {/* Code snippet */}
              <div className="code-block p-md mt-sm">
                <p className="text-xs text-on-surface-variant mb-sm flex items-center gap-xs">
                  <span className="material-symbols-outlined text-base">code</span>
                  main.py · /api/audit
                </p>
                <pre className="leading-relaxed overflow-x-auto">
                  <span className="tok-com">{'# Async background task — long AI work without blocking'}</span>{'\n'}
                  <span className="tok-key">{'async def'}</span> <span className="tok-fn">{'async_ai_citation_task'}</span>{'(sample_text, result_holder):'}{'\n'}
                  {'    '}<span className="tok-key">{'if'}</span>{' ServerConfig.DEPLOY_MODE == '}<span className="tok-str">{'"LOCAL"'}</span>{':'}{'\n'}
                  {'        response = ollama.generate('}{'\n'}
                  {'            model='}<span className="tok-str">{"'qwen2.5:3b'"}</span>{','}{'\n'}
                  {'            prompt='}<span className="tok-str">{'f"Verify APA 7th: {sample_text}"'}</span>{'\n'}
                  {'        )'}{'\n'}
                  {'    result_holder.extend('}<span className="tok-fn">{'parse_ai_json'}</span>{'(response['}<span className="tok-str">{"'response'"}</span>{']))'}
                </pre>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============ PRIVACY ============ */}
      <section id="privacy" className="py-20 md:py-28">
        <div className="max-w-[1440px] mx-auto px-md">
          <div className="rounded-2xl bg-surface-container border border-outline-variant p-lg md:p-xl relative overflow-hidden">
            <div className="absolute top-0 right-0 w-96 h-96 bg-primary/5 rounded-full blur-3xl pointer-events-none" />
            <div className="absolute bottom-0 left-0 w-72 h-72 bg-secondary/5 rounded-full blur-3xl pointer-events-none" />

            <div className="relative grid lg:grid-cols-[1fr_1fr] gap-xl items-center">
              <div>
                <p className="text-sm uppercase tracking-widest text-secondary font-medium mb-sm">Privacy by default</p>
                <h2 className="text-3xl md:text-4xl font-semibold tracking-tight mb-md">Your unpublished work stays unpublished.</h2>
                <p className="text-on-surface-variant leading-relaxed mb-lg">
                  Universities and supervisors handle sensitive research — sometimes embargoed, sometimes proprietary, sometimes both. We designed every layer of the stack around the assumption that <span className="text-on-surface font-medium">the network is hostile until proven otherwise</span>.
                </p>
                <div className="space-y-md">
                  <PrivacyRow icon="visibility_off" title="Zero outbound by default" description="The local AI engine runs on your machine. Nothing is uploaded, transmitted, or logged." />
                  <PrivacyRow icon="lock" title="Cloud is opt-in, not opt-out" description={<>The Gemini pipeline is locked behind an explicit UI toggle. The default deploy mode is <span className="font-mono text-secondary">LOCAL</span>.</>} />
                  <PrivacyRow icon="edit_off" title="Read-only file handling" description="Files are loaded into memory buffers. Your original .docx is never touched, modified, or rewritten." />
                </div>
              </div>

              {/* Honest limitations panel */}
              <div className="rounded-xl bg-surface-container-lowest border border-outline-variant p-lg">
                <div className="flex items-center gap-sm mb-md">
                  <span className="material-symbols-outlined text-tertiary">info</span>
                  <h3 className="text-lg font-semibold">Honest limitations</h3>
                </div>
                <p className="text-sm text-on-surface-variant mb-md">Because we care about trust more than marketing copy.</p>
                <div className="space-y-md text-sm">
                  <Limitation title="Complex Word styling" description="python-docx captures global styles and paragraph-level configs but may miss intricate run-level local font overrides." />
                  <Limitation title="AI output is non-deterministic" description={<>Local models can hallucinate or return malformed JSON. Our <span className="font-mono text-secondary">parse_ai_json</span> utility catches these gracefully — they degrade to warning cards, not crashes.</>} />
                  <Limitation title="One format only" description=".docx. No PDF, no LaTeX, no plagiarism DB lookups, no grammar rewriting." />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============ TECH STACK MARQUEE ============ */}
      <section className="py-md border-y border-outline-variant bg-surface-container overflow-hidden">
        <div className="max-w-[1440px] mx-auto px-md mb-md">
          <p className="text-center text-xs uppercase tracking-widest text-on-surface-variant">Powered by the boring, reliable stack</p>
        </div>
        <div className="flex overflow-hidden">
          <div className="marquee flex gap-xl items-center whitespace-nowrap">
            {TECH_STACK.concat(TECH_STACK).map((tech, i) => (
              <span key={i} className="text-2xl font-semibold text-on-surface-variant/60">
                {tech}
                <span className="ml-xl">·</span>
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ============ CTA ============ */}
      <section className="py-20 md:py-28">
        <div className="max-w-3xl mx-auto px-md text-center">
          <h2 className="text-3xl md:text-5xl font-semibold tracking-tight mb-md">Stop losing points to formatting.</h2>
          <p className="text-lg text-on-surface-variant mb-lg">Built for thesis supervisors who refuse to spend 30% of grading time on typography. Built for students who can&rsquo;t afford another point deduction.</p>
          <div className="flex flex-wrap items-center justify-center gap-sm">
            <Link
              to="/dashboard"
              className="inline-flex items-center gap-xs px-lg py-sm rounded bg-primary text-on-primary font-medium hover:opacity-90 transition-opacity"
            >
              <span className="material-symbols-outlined">visibility</span>
              Open the dashboard
            </Link>
            <Link
              to="/history"
              className="inline-flex items-center gap-xs px-lg py-sm rounded border border-outline-variant text-on-surface hover:border-primary/50 transition-colors"
            >
              <span className="material-symbols-outlined">history</span>
              View audit history
            </Link>
          </div>
        </div>
      </section>

      {/* ============ FOOTER ============ */}
      <footer className="border-t border-outline-variant bg-surface-container-lowest py-xl">
        <div className="max-w-[1440px] mx-auto px-md">
          <div className="grid md:grid-cols-4 gap-lg mb-lg">
            <div className="md:col-span-2">
              <div className="flex items-center gap-md mb-sm">
                <div className="w-8 h-8 rounded-md bg-primary/15 border border-primary/30 flex items-center justify-center">
                  {SHIELD_LOGO}
                </div>
                <span className="font-semibold text-on-surface">Academic Compliance Auditor</span>
              </div>
              <p className="text-sm text-on-surface-variant max-w-md leading-relaxed">
                A privacy-preserving, local-first auditing platform built for the high-stakes environment of academic work. Detection, location, and suggestions only — never rewriting.
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-on-surface-variant mb-sm">Product</p>
              <ul className="space-y-xs text-sm">
                <li><a href="#features" className="text-on-surface-variant hover:text-on-surface transition-colors">Features</a></li>
                <li><a href="#dashboard" className="text-on-surface-variant hover:text-on-surface transition-colors">Dashboard</a></li>
                <li><a href="#how" className="text-on-surface-variant hover:text-on-surface transition-colors">How it works</a></li>
                <li><Link to="/history" className="text-on-surface-variant hover:text-on-surface transition-colors">History</Link></li>
              </ul>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-on-surface-variant mb-sm">Resources</p>
              <ul className="space-y-xs text-sm">
                <li><a href="#architecture" className="text-on-surface-variant hover:text-on-surface transition-colors">Architecture</a></li>
                <li><a href="#privacy" className="text-on-surface-variant hover:text-on-surface transition-colors">Privacy</a></li>
                <li><Link to="/dashboard" className="text-on-surface-variant hover:text-on-surface transition-colors">Live demo</Link></li>
              </ul>
            </div>
          </div>
          <div className="pt-md border-t border-outline-variant flex flex-col md:flex-row items-center justify-between gap-sm text-xs text-on-surface-variant">
            <p className="font-mono">© 2024 Academic Compliance Systems. All rights reserved.</p>
            <p className="font-mono flex items-center gap-xs">
              <span className="w-1.5 h-1.5 rounded-full bg-secondary" />
              Local AI Core: Online · Ollama Qwen2.5-3B
            </p>
          </div>
        </div>
      </footer>
    </div>
  )
}

/* ----------------------------- Sub-components ----------------------------- */

const TECH_STACK = [
  'React', 'FastAPI', 'python-docx', 'Ollama',
  'Qwen2.5-3B', 'Gemini 1.5 Flash', 'Tailwind', 'Inter', 'JetBrains Mono',
]

function Stat({ value, tone, label }: { value: string; tone: 'primary' | 'secondary'; label: string }) {
  return (
    <div className="p-md rounded-lg border border-outline-variant bg-surface-container">
      <div className={`text-3xl font-semibold font-mono ${tone === 'primary' ? 'text-primary' : 'text-secondary'}`}>{value}</div>
      <div className="text-xs uppercase tracking-wider text-on-surface-variant mt-xs">{label}</div>
    </div>
  )
}

function FeatureCard({
  tone,
  icon,
  title,
  description,
  points,
}: {
  tone: 'primary' | 'secondary' | 'tertiary'
  icon: string
  title: string
  description: string
  points: string[]
}) {
  const toneClasses = {
    primary: 'bg-primary/10 border-primary/20 text-primary',
    secondary: 'bg-secondary/10 border-secondary/20 text-secondary',
    tertiary: 'bg-tertiary/10 border-tertiary/20 text-tertiary',
  } as const

  return (
    <div className="reveal p-lg rounded-xl bg-surface-container border border-outline-variant hover:border-primary/40 transition-colors">
      <div className={`w-12 h-12 rounded-lg border flex items-center justify-center mb-md ${toneClasses[tone]}`}>
        <span className="material-symbols-outlined">{icon}</span>
      </div>
      <h3 className="text-xl font-semibold mb-sm">{title}</h3>
      <p className="text-on-surface-variant text-sm leading-relaxed mb-md">{description}</p>
      <ul className="space-y-xs text-sm">
        {points.map((p) => (
          <li key={p} className="flex items-start gap-xs text-on-surface-variant">
            <span className="material-symbols-outlined text-secondary text-base">check_circle</span>
            {p}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Step({
  num,
  tone,
  icon,
  title,
  description,
}: {
  num: number
  tone: 'primary' | 'secondary' | 'tertiary'
  icon: string
  title: string
  description: string
}) {
  const toneClasses = {
    primary: 'bg-primary/15 border-primary/40 text-primary',
    secondary: 'bg-secondary/15 border-secondary/40 text-secondary',
    tertiary: 'bg-tertiary/15 border-tertiary/40 text-tertiary',
  } as const
  const badgeBg = {
    primary: 'bg-primary text-on-primary',
    secondary: 'bg-secondary text-on-secondary',
    tertiary: 'bg-tertiary text-on-tertiary',
  } as const

  return (
    <div className="reveal text-center">
      <div className={`relative mx-auto w-16 h-16 rounded-full border-2 flex items-center justify-center mb-md ${toneClasses[tone]}`}>
        <span className="material-symbols-outlined text-2xl">{icon}</span>
        <span className={`absolute -top-1 -right-1 w-6 h-6 rounded-full text-xs font-mono font-semibold flex items-center justify-center ${badgeBg[tone]}`}>
          {num}
        </span>
      </div>
      <h3 className="text-lg font-semibold mb-sm">{title}</h3>
      <p className="text-sm text-on-surface-variant leading-relaxed">{description}</p>
    </div>
  )
}

function ArchRow({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div className="flex items-start gap-sm">
      <span className="material-symbols-outlined text-primary mt-0.5">{icon}</span>
      <div>
        <p className="font-medium text-on-surface text-sm">{title}</p>
        <p className="text-xs text-on-surface-variant">{subtitle}</p>
      </div>
    </div>
  )
}

function PrivacyRow({ icon, title, description }: { icon: string; title: string; description: React.ReactNode }) {
  return (
    <div className="flex items-start gap-md">
      <div className="w-10 h-10 rounded bg-secondary/10 border border-secondary/30 flex items-center justify-center shrink-0">
        <span className="material-symbols-outlined text-secondary">{icon}</span>
      </div>
      <div>
        <p className="font-semibold text-on-surface">{title}</p>
        <p className="text-sm text-on-surface-variant">{description}</p>
      </div>
    </div>
  )
}

function Limitation({ title, description }: { title: string; description: React.ReactNode }) {
  return (
    <div className="border-l-2 border-outline pl-sm">
      <p className="text-on-surface font-medium mb-xs">{title}</p>
      <p className="text-xs text-on-surface-variant">{description}</p>
    </div>
  )
}
