/**
 * Score dashboard — hero score panel + radar breakdown chart +
 * per-category deduction bars. Implements FR-4 visual dashboard.
 * Ported from reference_project/src/components/audit/score-dashboard.tsx.
 */

import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
} from 'recharts'
import { TrendingDown, AlertOctagon, AlertTriangle, Award } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card'
import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'
import { gradeFor } from '../../lib/audit/scoring'
import { CATEGORY_LABELS, categoryColor } from '../../lib/audit/categories'
import type { AuditResult, ScoreBreakdown } from '../../types/audit'

export function ScoreDashboard({ result }: { result: AuditResult }) {
  const grade = gradeFor(result.weighted_compliance_score)

  const radarData = result.score_breakdown.map((b) => ({
    category: CATEGORY_LABELS[b.category],
    remaining: b.remaining,
    deduction: b.deduction,
  }))

  const toneClasses = {
    success: 'from-emerald-500/20 to-emerald-500/0 text-emerald-300 ring-emerald-500/30',
    warning: 'from-amber-500/20 to-amber-500/0 text-amber-300 ring-amber-500/30',
    error:   'from-rose-500/20 to-rose-500/0 text-rose-300 ring-rose-500/30',
  } as const

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      {/* Hero score */}
      <Card className="lg:col-span-5 border-border bg-card overflow-hidden">
        <div
          className={cn(
            'relative bg-gradient-to-br px-6 py-5 ring-1 ring-inset',
            toneClasses[grade.tone],
          )}
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Compliance Score
              </div>
              <div className="mt-1 flex items-end gap-2">
                <span className="font-mono text-5xl font-bold leading-none text-foreground">
                  {result.weighted_compliance_score}
                </span>
                <span className="mb-1 text-lg text-muted-foreground">/100</span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-4xl font-bold leading-none">{grade.grade}</div>
              <div className="mt-1 text-xs uppercase tracking-wider text-muted-foreground">
                {grade.label}
              </div>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Badge variant="outline" className="border-rose-500/30 bg-rose-500/10 text-rose-300">
              <AlertOctagon className="mr-1 h-3 w-3" /> {result.major_count} Major
            </Badge>
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-300">
              <AlertTriangle className="mr-1 h-3 w-3" /> {result.minor_count} Minor
            </Badge>
            <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">
              <Award className="mr-1 h-3 w-3" /> Audited{' '}
              {new Date(result.audited_at).toLocaleTimeString()}
            </Badge>
          </div>
        </div>
        <CardContent className="grid grid-cols-3 gap-2 pt-4 text-center">
          <Stat label="Paragraphs" value={result.document_stats.paragraphs} />
          <Stat label="Headings" value={result.document_stats.headings} />
          <Stat label="Tables" value={result.document_stats.tables} />
          <Stat label="Images" value={result.document_stats.images} />
          <Stat label="Sections" value={result.document_stats.sections} />
          <Stat label="Words" value={result.document_stats.words} />
        </CardContent>
      </Card>

      {/* Radar chart */}
      <Card className="lg:col-span-7 border-border bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Category Coverage</CardTitle>
          <CardDescription>
            Per-category remaining score (0 = fully violated, 100 = clean)
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <div className="h-[260px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={radarData} outerRadius="72%">
                <PolarGrid stroke="#464554" />
                <PolarAngleAxis dataKey="category" tick={{ fill: '#c7c4d7', fontSize: 11 }} />
                <PolarRadiusAxis
                  angle={90}
                  domain={[0, 100]}
                  tick={{ fill: '#908fa0', fontSize: 10 }}
                  stroke="#464554"
                />
                <Radar
                  dataKey="remaining"
                  stroke="#c0c1ff"
                  fill="#c0c1ff"
                  fillOpacity={0.35}
                  strokeWidth={2}
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Per-category deduction bars */}
      <Card className="lg:col-span-12 border-border bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-rose-300" />
            Per-Category Deductions
          </CardTitle>
          <CardDescription>
            Major violations cost more; each category has a deduction cap so a single noisy area cannot zero-out the total.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <div className="h-[200px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={radarData}
                layout="vertical"
                margin={{ left: 8, right: 24, top: 4, bottom: 4 }}
              >
                <XAxis
                  type="number"
                  domain={[0, 32]}
                  tick={{ fill: '#908fa0', fontSize: 10 }}
                  stroke="#464554"
                />
                <YAxis
                  type="category"
                  dataKey="category"
                  width={130}
                  tick={{ fill: '#c7c4d7', fontSize: 11 }}
                  stroke="#464554"
                />
                <Tooltip
                  cursor={{ fill: '#1f1f27' }}
                  contentStyle={{
                    background: '#0d0d15',
                    border: '1px solid #464554',
                    borderRadius: '6px',
                    fontSize: 12,
                  }}
                  labelStyle={{ color: '#e4e1ed' }}
                />
                <Bar dataKey="deduction" radius={[0, 4, 4, 0]}>
                  {radarData.map((_d, i) => (
                    <Cell
                      key={i}
                      fill={categoryColor[(result.score_breakdown[i] as ScoreBreakdown).category]}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-input/30 px-2 py-2">
      <div className="font-mono text-lg font-semibold text-foreground">
        {value.toLocaleString()}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    </div>
  )
}