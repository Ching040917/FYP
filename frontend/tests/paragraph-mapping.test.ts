/**
 * Paragraph-to-page mapping PoC tests.
 *
 * Two layers:
 *  1. Synthetic — pure unit tests of normalization, line reconstruction,
 *     header/footer detection, and every matching rule, with hand-built
 *     PageText fixtures (no PDF needed).
 *  2. Fixture end-to-end — Caption Fixture 3 and Edge Fixture 2 rendered
 *     through the real LibreOffice pipeline, text extracted with the
 *     pdfjs-dist legacy build, mapped, and compared against the frozen
 *     ground truth (expected.json).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  normalizeText,
  reconstructLines,
  findRepeatedLines,
  mapBlocksToPages,
  type PageLine,
  type PageText,
} from '../src/lib/pdf/paragraph-mapping.ts'
import { extractPageText } from '../src/lib/pdf/pdf-text-extract.ts'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function page(pageNumber: number, lines: Array<string | PageLine>, hf: string[] = []): PageText {
  return {
    pageNumber,
    lines: lines.map((l) => (typeof l === 'string' ? { text: normalizeText(l), y: 100 } : l)),
    headerFooterLines: new Set(hf.map((h) => normalizeText(h))),
  }
}

const items = (strs: Array<{ s: string; y: number; eol?: boolean }>) =>
  strs.map(({ s, y, eol }) => ({ str: s, transform: [1, 0, 0, 1, 10, y], hasEOL: eol }))

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

test('normalizeText handles ligatures, NFKC, punctuation, whitespace, case', () => {
  assert.equal(normalizeText('The ﬁnal draft’s ﬁgure—often quoted—“works” ﬁne. Café…'), "the final draft's figure-often quoted-\"works\" fine. café...")
  assert.equal(normalizeText('eﬃcient\n  ﬂow\t'), 'efficient flow')
  assert.equal(normalizeText('\u00a0hello\u00a0\u00a0world\u00a0'), 'hello world')
  assert.equal(normalizeText('Œuvre Æther'), 'oeuvre aether')
})

test('reconstructLines joins split items, breaks on hasEOL and y change', () => {
  const lines = reconstructLines(
    items([
      { s: 'Hello ', y: 100 },
      { s: 'World', y: 100 },
      { s: 'Second line', y: 100, eol: true },
      { s: 'Third', y: 90 },
      { s: 'Fourth', y: 80 },
    ]),
  )
  assert.deepEqual(
    lines.map((l) => l.text),
    ['hello world', 'second line', 'third', 'fourth'],
  )
  // empty items dropped
  assert.deepEqual(reconstructLines(items([{ s: '  ', y: 1 }, { s: 'x', y: 1 }])).map((l) => l.text), ['x'])
})

test('findRepeatedLines flags stable-position repeats only', () => {
  const pages = [
    page(1, [{ text: 'running header', y: 800 }, { text: 'body one', y: 400 }]),
    page(2, [{ text: 'running header', y: 800 }, { text: 'body one', y: 500 }]), // same text, different y
    page(3, [{ text: 'running header', y: 800 }, { text: 'unique', y: 400 }]),
  ]
  const repeated = findRepeatedLines(pages, { minFraction: 0.5 })
  assert.ok(repeated.get(1)!.has('running header'))
  assert.ok(!repeated.get(2)!.has('body one')) // moved position → not a header
  assert.ok(!repeated.get(3)!.has('unique'))
})

// ---------------------------------------------------------------------------
// matching rules
// ---------------------------------------------------------------------------

test('empty blocks map to unavailable', () => {
  const pages = [page(1, ['hello world'])]
  const result = mapBlocksToPages([{ index: 0, text: '' }], pages)
  assert.equal(result[0].confidence, 'unavailable')
  assert.equal(result[0].pageNumber, null)
})

test('unique paragraph maps exactly', () => {
  const pages = [page(1, ['hello world']), page(2, ['other content'])]
  const result = mapBlocksToPages([{ index: 0, text: 'Hello world' }], pages)
  assert.equal(result[0].confidence, 'exact')
  assert.equal(result[0].pageNumber, 1)
  assert.equal(result[0].paragraphOnPage, 1)
})

test('split text items without spaces match via squeeze', () => {
  const pages = [
    {
      pageNumber: 1,
      lines: [{ text: 'helloworld', y: 100 }], // PDF dropped the space
      headerFooterLines: new Set<string>(),
    },
  ]
  const result = mapBlocksToPages([{ index: 0, text: 'Hello world' }], pages)
  assert.equal(result[0].confidence, 'exact')
  assert.equal(result[0].pageNumber, 1)
})

test('duplicates disambiguated by previous neighbour', () => {
  const pages = [page(1, ['unique first.', 'repeat me please.']), page(2, ['unique middle.', 'repeat me please.'])]
  const blocks = [
    { index: 0, text: 'Unique first.' },
    { index: 1, text: 'Repeat me please.' },
    { index: 2, text: 'Unique middle.' },
    { index: 3, text: 'Repeat me please.' },
  ]
  const result = mapBlocksToPages(blocks, pages)
  assert.equal(result[1].pageNumber, 1) // first instance follows unique-first on p1
  assert.equal(result[3].pageNumber, 2) // second instance follows unique-middle on p2
  assert.equal(result[1].confidence, 'exact')
})

test('adjacent duplicates on the same page stay exact with paragraphOnPage', () => {
  const pages = [page(1, ['adjacent repeat.', 'adjacent repeat.', 'tail.'])]
  const blocks = [
    { index: 0, text: 'Adjacent repeat.' },
    { index: 1, text: 'Adjacent repeat.' },
  ]
  const result = mapBlocksToPages(blocks, pages)
  assert.equal(result[0].pageNumber, 1)
  assert.equal(result[1].pageNumber, 1)
  assert.equal(result[0].paragraphOnPage, 1)
  assert.equal(result[1].paragraphOnPage, 2)
})

test('ambiguous duplicates return unavailable, never first match', () => {
  // Both instances sit on pages ≥ the monotonic cursor with no neighbour
  // signal: instance A follows alpha (p1), instance B has neighbours on
  // p2 and p4 while its candidates are {2,3}. Nothing can decide → both
  // must be unavailable — never a blind first-global-match.
  const pages = [
    page(1, ['alpha.']),
    page(2, ['puzzle.', 'gamma.']),
    page(3, ['puzzle.']),
    page(4, ['delta.']),
  ]
  const blocks = [
    { index: 0, text: 'alpha.' },
    { index: 1, text: 'puzzle.' }, // occ 1: prev alpha p1, candidates {2,3} → ambiguous
    { index: 2, text: 'gamma.' },
    { index: 3, text: 'puzzle.' }, // occ 2: prev gamma p2, next delta p4 → ambiguous
    { index: 4, text: 'delta.' },
  ]
  const result = mapBlocksToPages(blocks, pages)
  assert.equal(result[1].confidence, 'unavailable')
  assert.equal(result[3].confidence, 'unavailable')
  assert.equal(result[0].pageNumber, 1)
  assert.equal(result[2].pageNumber, 2)
  assert.equal(result[4].pageNumber, 4)
})

test('cross-page paragraph reports pageRange', () => {
  const pages = [
    page(1, ['part one.', 'beginning of the long paragraph that will']),
    page(2, ['continue onto the next page and then finish.']),
  ]
  const blocks = [
    { index: 0, text: 'Part one.' },
    { index: 1, text: 'Beginning of the long paragraph that will continue onto the next page and then finish.' },
  ]
  const result = mapBlocksToPages(blocks, pages)
  assert.equal(result[1].confidence, 'exact')
  assert.equal(result[1].pageNumber, 1)
  assert.deepEqual(result[1].pageRange, [1, 2])
})

test('approximate mapping only above explicit threshold', () => {
  // 6/7 words covered ≈ 86% ≥ 0.8 → approximate; the exact block stays exact
  const pages = [page(1, ['one two three four five six.'])]
  const blocks = [
    { index: 0, text: 'one two three four five six seven' },
    { index: 1, text: 'one two three four five six.' },
  ]
  const result = mapBlocksToPages(blocks, pages)
  assert.equal(result[0].confidence, 'approximate')
  assert.equal(result[0].pageNumber, 1)
  assert.equal(result[1].confidence, 'exact')
})

test('unmatched text returns unavailable', () => {
  const pages = [page(1, ['completely different content'])]
  const result = mapBlocksToPages([{ index: 0, text: 'never appears anywhere' }], pages)
  assert.equal(result[0].confidence, 'unavailable')
})

test('monotonic: later block cannot map to an earlier page', () => {
  const pages = [page(1, ['only on page one']), page(2, ['only on page two'])]
  const blocks = [
    { index: 0, text: 'only on page two' },
    { index: 1, text: 'only on page one' }, // cursor is at 2 → must be unavailable
  ]
  const result = mapBlocksToPages(blocks, pages)
  assert.equal(result[0].pageNumber, 2)
  assert.equal(result[1].confidence, 'unavailable')
})

test('headers excluded from matching; block equal to header text unavailable', () => {
  const pages = [
    page(1, [{ text: 'running header', y: 800 }, { text: 'body', y: 100 }], ['running header']),
    page(2, [{ text: 'running header', y: 800 }, { text: 'more body', y: 100 }], ['running header']),
  ]
  const result = mapBlocksToPages([{ index: 0, text: 'Running header' }], pages)
  assert.equal(result[0].confidence, 'unavailable')
})

test('tables with repeated prose do not confuse matching', () => {
  // page 2 contains a table whose cells repeat prose three times
  const pages = [
    page(1, ['before the table']),
    page(2, ['alpha beta gamma', 'alpha beta gamma', 'alpha beta gamma', 'after the table']),
  ]
  const blocks = [
    { index: 0, text: 'Before the table' },
    { index: 1, text: 'Alpha beta gamma' }, // equals repeated cell text — single page → exact
    { index: 2, text: 'After the table' },
  ]
  const result = mapBlocksToPages(blocks, pages)
  assert.equal(result[0].pageNumber, 1)
  assert.equal(result[1].pageNumber, 2)
  assert.equal(result[2].pageNumber, 2)
})

// ---------------------------------------------------------------------------
// fixture end-to-end
// ---------------------------------------------------------------------------

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url))

async function runFixture(name: string) {
  const pdf = new Uint8Array(readFileSync(`${fixturesDir}/${name}.pdf`))
  const blocks = JSON.parse(readFileSync(`${fixturesDir}/${name}-blocks.json`, 'utf8')) as Array<{
    index: number
    text: string
  }>
  const expected = JSON.parse(readFileSync(`${fixturesDir}/${name}-expected.json`, 'utf8')) as Array<{
    index: number
    pageNumber: number | null
    pageRange: [number, number] | null
  }>
  const pages = await extractPageText(pdf)
  const results = mapBlocksToPages(blocks, pages)

  const byIndex = new Map(results.map((r) => [r.index, r]))
  const expectedByIndex = new Map(expected.map((e) => [e.index, e]))

  let exact = 0
  let approximate = 0
  let unavailable = 0
  let incorrect = 0
  const incorrectDetails: Array<{ index: number; got: number | null; want: number | null }> = []
  const ambiguous = []

  for (const e of expected) {
    const r = byIndex.get(e.index)!
    if (r.confidence === 'exact') exact += 1
    else if (r.confidence === 'approximate') approximate += 1
    else unavailable += 1
    if (r.pageNumber !== e.pageNumber) {
      incorrect += 1
      incorrectDetails.push({ index: e.index, got: r.pageNumber, want: e.pageNumber })
    }
    // ambiguous = unavailable while its text exists on ≥2 pages
    if (r.confidence === 'unavailable' && normalizeText(blocks.find((b) => b.index === e.index)?.text ?? '')) {
      const text = normalizeText(blocks.find((b) => b.index === e.index)?.text ?? '')
      const hits = pages.filter((p) =>
        p.lines.some((l) => !p.headerFooterLines.has(l.text) && l.text.includes(text)),
      ).length
      if (hits >= 2) ambiguous.push(e.index)
    }
  }

  return {
    name,
    pages: pages.length,
    blocks: blocks.length,
    exact,
    approximate,
    unavailable,
    ambiguous,
    incorrect,
    incorrectDetails,
    expectedByIndex,
    byIndex,
  }
}

test('Caption Fixture 3 maps with zero incorrect assignments', async () => {
  const r = await runFixture('caption-fixture-3')
  console.log(`caption-fixture-3: exact=${r.exact} approximate=${r.approximate} unavailable=${r.unavailable} ambiguous=${r.ambiguous.length} incorrect=${r.incorrect}`)
  assert.equal(r.incorrect, 0, JSON.stringify(r.incorrectDetails))
  // 6 non-empty blocks, 2 empty (page-break) blocks
  assert.equal(r.exact, 6)
  assert.equal(r.approximate, 0)
  assert.equal(r.unavailable, 2)
  // spot-check heading + caption + figure caption
  assert.equal(r.byIndex.get(0)!.pageNumber, 1)
  assert.equal(r.byIndex.get(3)!.pageNumber, 2)
  assert.equal(r.byIndex.get(6)!.pageNumber, 3)
})

test('Edge Fixture 2 maps with zero incorrect assignments', async () => {
  const r = await runFixture('edge-fixture-2')
  console.log(`edge-fixture-2: exact=${r.exact} approximate=${r.approximate} unavailable=${r.unavailable} ambiguous=${r.ambiguous} incorrect=${r.incorrect}`)
  assert.equal(r.incorrect, 0, JSON.stringify(r.incorrectDetails))
  // 10 non-empty blocks all exact; 4 empty blocks unavailable; no ambiguity
  assert.equal(r.exact, 10)
  assert.equal(r.approximate, 0)
  assert.equal(r.unavailable, 4)
  assert.deepEqual(r.ambiguous, [])
  // spot-checks
  assert.equal(r.byIndex.get(1)!.pageNumber, 1) // repeat me please #1
  assert.equal(r.byIndex.get(5)!.pageNumber, 2) // repeat me please #2 (neighbour-resolved)
  assert.equal(r.byIndex.get(6)!.pageNumber, 2) // adjacent repeat #1
  assert.equal(r.byIndex.get(7)!.pageNumber, 2) // adjacent repeat #2
  assert.equal(r.byIndex.get(7)!.paragraphOnPage, 4)
  assert.deepEqual(r.byIndex.get(9)!.pageRange, [3, 5]) // cross-page paragraph
  assert.equal(r.byIndex.get(10)!.pageNumber, 5) // true ambiguity #1 (prev ends p5)
  assert.equal(r.byIndex.get(12)!.pageNumber, 6) // true ambiguity #2 — cursor + monotonic
  assert.equal(r.byIndex.get(13)!.pageNumber, 6) // ligature/punctuation paragraph
})
