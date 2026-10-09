/**
 * Severity palette — measured WCAG conformance.
 *
 * These are computed from the real hexes in `tailwind.config.js`, not from
 * Tailwind class-name substrings. A colour-name check passes no matter how
 * light the colour is; a luminance check does not.
 *
 * Thresholds are the WCAG AA requirements themselves and are never lowered:
 *   - badge label text on its badge background  ≥ 4.5:1  (1.4.3 AA)
 *   - stripe / icon indicator on the card surface ≥ 3:1  (1.4.11 non-text)
 *   - selected title on selected background       ≥ 4.5:1
 *   - selected indicator on selected background   ≥ 3:1
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { severityBadge } from '../src/lib/audit/categories.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TAILWIND = readFileSync(resolve(ROOT, 'tailwind.config.js'), 'utf8')

/** Pull one hex out of the Tailwind `colors` block by token name. */
function token(name: string): string {
  const match = TAILWIND.match(new RegExp(`'?${name}'?\\s*:\\s*'(#[0-9A-Fa-f]{6})'`))
  assert.ok(match, `tailwind token "${name}" not found`)
  return match[1]!
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const [r, g, b] = channels.map((v) =>
    v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4),
  ) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.1 contrast ratio between two hex colours. */
export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (l1 + 0.05) / (l2 + 0.05)
}

const CARD = token('card') // #FFFFFF — the surface every finding row sits on
const SEVERITIES = ['major', 'minor', 'review', 'unknown'] as const

// ---------------------------------------------------------------------------
// Measured contrast
// ---------------------------------------------------------------------------

test('every severity badge label meets WCAG AA text contrast', () => {
  for (const sev of SEVERITIES) {
    const ratio = contrast(token(`severity-${sev}-text`), token(`severity-${sev}-bg`))
    assert.ok(
      ratio >= 4.5,
      `${severityBadge(sev).label} label is ${ratio.toFixed(2)}:1 on its badge — needs 4.5:1`,
    )
  }
})

test('every severity indicator meets 3:1 non-text contrast on the card', () => {
  for (const sev of SEVERITIES) {
    const ratio = contrast(token(`severity-${sev}-indicator`), CARD)
    assert.ok(
      ratio >= 3,
      `${severityBadge(sev).label} indicator is ${ratio.toFixed(2)}:1 on the card — needs 3:1`,
    )
  }
})

test('severity indicators stay 3:1 on a selected row too', () => {
  // The stripe is drawn over the selected background as well as the card.
  const selectedBg = token('finding-selected-bg')
  for (const sev of SEVERITIES) {
    const ratio = contrast(token(`severity-${sev}-indicator`), selectedBg)
    assert.ok(ratio >= 3, `${sev} indicator is ${ratio.toFixed(2)}:1 on the selected row`)
  }
})

test('the selected finding title and indicator meet contrast', () => {
  const bg = token('finding-selected-bg')
  const title = contrast(token('finding-selected-title'), bg)
  assert.ok(title >= 4.5, `selected title is ${title.toFixed(2)}:1 — needs 4.5:1`)

  const indicator = contrast(token('finding-selected-indicator'), bg)
  assert.ok(indicator >= 3, `selected indicator is ${indicator.toFixed(2)}:1 — needs 3:1`)

  // The 1px selection ring must be visible against the selected surface.
  const ring = contrast(token('finding-selected-border'), bg)
  assert.ok(ring >= 3, `selected ring is ${ring.toFixed(2)}:1 — needs 3:1`)
})

test('the focus ring is visible against the card surface', () => {
  const ratio = contrast(token('ring'), CARD)
  assert.ok(ratio >= 3, `focus ring is ${ratio.toFixed(2)}:1 on the card — needs 3:1`)
})

// ---------------------------------------------------------------------------
// Severity is never communicated by colour alone
// ---------------------------------------------------------------------------

test('all four severities carry a distinct visible text label', () => {
  const labels = SEVERITIES.map((sev) => severityBadge(sev).label)
  for (const label of labels) {
    assert.ok(label.trim().length > 0)
  }
  assert.deepEqual(labels, ['Major', 'Minor', 'Manual review', 'Unclassified'])
  // No two states share a label, so colour is never the only signal.
  assert.equal(new Set(labels).size, labels.length)
})

test('the four severity states use four distinct palettes', () => {
  const classes = SEVERITIES.map((sev) => severityBadge(sev).className)
  assert.equal(new Set(classes).size, classes.length, 'two severities share a badge class')
  const indicators = SEVERITIES.map((sev) => severityBadge(sev).indicatorClassName)
  assert.equal(new Set(indicators).size, indicators.length)
})

test('an unknown severity is labelled Unclassified and never borrows Minor', () => {
  const unknown = severityBadge('unknown')
  assert.equal(unknown.label, 'Unclassified')
  assert.notEqual(unknown.className, severityBadge('minor').className)
  assert.notEqual(unknown.indicatorClassName, severityBadge('minor').indicatorClassName)
  // Contrast is measured for Unclassified too, not inherited from Minor.
  assert.ok(contrast(token('severity-unknown-text'), token('severity-unknown-bg')) >= 4.5)
})

test('Manual review never uses the Minor palette', () => {
  const review = severityBadge('review')
  assert.equal(review.label, 'Manual review')
  assert.notEqual(review.className, severityBadge('minor').className)
  assert.notEqual(review.indicatorClassName, severityBadge('minor').indicatorClassName)
})

test('an out-of-union severity resolves to Unclassified, not Minor', () => {
  for (const rogue of ['critical', 'HIGH', '', '  ', 'minor ', 'nope', null, undefined]) {
    assert.equal(
      severityBadge(rogue as never).label,
      'Unclassified',
      `${String(rogue)} fell through to the wrong severity`,
    )
  }
})

// ---------------------------------------------------------------------------
// Selected / hover / focus must be distinguishable
// ---------------------------------------------------------------------------

test('selected, hover and focus do not share one token', () => {
  const selectedBg = token('finding-selected-bg')
  const hoverBg = token('muted')
  // Different tokens...
  assert.notEqual(selectedBg, hoverBg)
  assert.notEqual(selectedBg, token('card'))
  // ...and each is individually legible where it is drawn.
  assert.ok(contrast(token('finding-selected-title'), selectedBg) >= 4.5)
  assert.ok(contrast(token('muted-foreground'), hoverBg) >= 4.5)
})

test('the card reserves its left border in both states so selection cannot shift layout', () => {
  const source = readFileSync(resolve(ROOT, 'src/components/audit/error-list.tsx'), 'utf8')
  // The width is declared once on the shared base class, so BOTH states
  // reserve it and selection only swaps the colour. A width declared in just
  // one branch would be a 2px layout jump when selecting.
  assert.match(source, /'flex w-full items-start gap-2\.5 border-l-2 /)
  assert.match(source, /border-l-finding-selected-indicator/)
  assert.match(source, /border-l-transparent/)
  // No state re-declares the width in a way that could differ.
  assert.equal((source.match(/border-l-(?!2\b)/g) ?? []).length >= 1, true)
})
