import { useNavigate } from 'react-router-dom'
import { ArrowLeft, FileText, Clock } from 'lucide-react'
import { Button } from '../components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '../components/ui/card'
import { Badge } from '../components/ui/badge'

export function HistoryPage() {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* Sticky header */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-3 md:px-6">
          <div className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 place-items-center rounded-md bg-primary/15 text-primary ring-1 ring-primary/30">
              <FileText className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight">History Records</div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Academic Compliance Auditor
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="border-border text-muted-foreground">
              <Clock className="mr-1 h-3 w-3" /> Coming Soon
            </Badge>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-border bg-gradient-to-b from-primary/5 to-transparent">
        <div className="mx-auto max-w-[1440px] px-4 py-8 md:px-6 md:py-10">
          <h1 className="max-w-3xl text-2xl font-bold tracking-tight md:text-3xl">
            Audit History
            <span className="text-primary"> (Coming Soon)</span>
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-muted-foreground md:text-base">
            Your past audit records will appear here. Each entry will show the compliance score,
            status, and a link to the detailed violation report.
          </p>
        </div>
      </section>

      {/* Main content */}
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 md:px-6 md:py-8">
        <div className="max-w-3xl mx-auto">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-lg font-semibold">History Records</CardTitle>
              <CardDescription>
                This page is under active development. Check back soon!
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-h-[300px] flex-col items-center justify-center gap-4 text-center">
              <div className="grid h-16 w-16 place-items-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/30">
                <FileText className="h-7 w-7" />
              </div>
              <div>
                <div className="text-base font-semibold text-foreground">No history yet</div>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  Run your first audit from the Dashboard to populate this history.
                </p>
              </div>
              <Button
                variant="outline"
                className="border-border text-muted-foreground"
                onClick={() => navigate('/')}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Dashboard
              </Button>
            </CardContent>
          </Card>
        </div>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-border bg-background/60">
        <div className="mx-auto max-w-[1440px] px-4 py-5 md:px-6">
          <div className="flex flex-col items-start justify-between gap-3 text-xs text-muted-foreground md:flex-row md:items-center">
            <div className="flex items-center gap-2">
              <span>Auditra · Read-only formatting checker.</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}