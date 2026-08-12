/**
 * Expected vs Actual — semantic definition list for one finding's evidence.
 *
 * Null fields are omitted entirely; nothing is fabricated and null is never
 * rendered as zero. Values preserve whitespace and wrap (no horizontal
 * overflow). The actual-value cell uses the system monospace stack because
 * it quotes document text; expected values are specification prose.
 */

interface ExpectedActualTableProps {
  expected: string | null
  actual: string | null
}

export function ExpectedActualTable({ expected, actual }: ExpectedActualTableProps) {
  if (expected == null && actual == null) return null

  return (
    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {expected != null && (
        <div className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Expected
          </dt>
          <dd className="mt-1.5 whitespace-pre-wrap break-words rounded border border-border bg-input/20 px-3 py-2 text-sm leading-[21px] text-foreground">
            {expected}
          </dd>
        </div>
      )}
      {actual != null && (
        <div className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Actual
          </dt>
          <dd className="mt-1.5 whitespace-pre-wrap break-words rounded border border-border bg-input/20 px-3 py-2 font-mono text-[13px] leading-[19px] text-foreground">
            {actual}
          </dd>
        </div>
      )}
    </dl>
  )
}
