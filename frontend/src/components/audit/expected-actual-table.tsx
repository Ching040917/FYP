/**
 * Current vs Required — semantic definition list for one finding's evidence.
 *
 * Reader-facing order is Current (what the document has) then Required (what
 * the profile demands), matching the findings-card comparison.
 *
 * Null fields are omitted entirely; nothing is fabricated and null is never
 * rendered as zero. Values preserve whitespace and wrap (no horizontal
 * overflow). The Current cell uses the system monospace stack because it
 * quotes document text; Required values are specification prose.
 */


interface ExpectedActualTableProps {
  expected: string | null
  actual: string | null
}

export function ExpectedActualTable({ expected, actual }: ExpectedActualTableProps) {
  if (expected == null && actual == null) return null

  return (
    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {actual != null && (
        <div className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Current
          </dt>
          <dd className="mt-1.5 whitespace-pre-wrap break-words border-l-2 border-border pl-3 font-mono text-[13px] leading-[19px] text-foreground">
            {actual}
          </dd>
        </div>
      )}
      {expected != null && (
        <div className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Required
          </dt>
          <dd className="mt-1.5 whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-sm leading-[21px] text-foreground">
            {expected}
          </dd>
        </div>
      )}
    </dl>
  )
}
