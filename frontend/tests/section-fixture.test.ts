/**
 * Section → page-range fixture end-to-end tests (PoC).
 *
 * Runs the REAL pipeline over the frozen LibreOffice-rendered fixtures:
 *   extractPageText → mapBlocksToPages → mapSection, compared against the
 *   independently prepared ground truth (expected.json).
 *
 * Reports exact / approximate / unavailable / incorrect counts and requires
 * zero incorrect assignments, exact start/end equality with ground truth,
 * correct mid-page flags, and unavailable never becoming Page 1.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractPageText } from '../src/lib/pdf/pdf-text-extract.ts'
import { mapBlocksToPages } from '../src/lib/pdf/paragraph-mapping.ts'
import { mapSection, type SectionMetadataLike } from '../src/lib/pdf/section-mapping.ts'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

interface GTEntry {
  section_index: number
  startPage: number | null
  endPage: number | null
  confidence: 'exact' | 'approximate' | 'unavailable'
  startsMidPage: boolean
  endsMidPage: boolean
}

async function runFixture(name: string) {
  const pdf = new Uint8Array(readFileSync(join(fixturesDir, `${name}.pdf`)))
  const blocks = JSON.parse(readFileSync(join(fixturesDir, `${name}-blocks.json`), 'utf8')) as Array<{ index: number; text: string }>
  const meta = JSON.parse(readFileSync(join(fixturesDir, `${name}-meta.json`), 'utf8')) as SectionMetadataLike[]
  const expected = JSON.parse(readFileSync(join(fixturesDir, `${name}-expected.json`), 'utf8')) as GTEntry[]

  const pages = await extractPageText(pdf)
  const mapping = mapBlocksToPages(blocks, pages)
  const byIndex = new Map(mapping.map((m) => [m.index, m]))
  const blockTexts = new Map(blocks.map((b) => [b.index, b.text]))

  const results = meta.map((m) =>
    mapSection({ sections: meta, byIndex, blockTexts, numPages: pages.length }, m.section_index),
  )

  let exact = 0
  let approximate = 0
  let unavailable = 0
  let incorrect = 0
  const incorrectDetails: string[] = []

  for (const gt of expected) {
    const r = results.find((x) => x.sectionIndex === gt.section_index)!
    if (r.confidence === 'exact') exact += 1
    else if (r.confidence === 'approximate') approximate += 1
    else unavailable += 1

    // exact start/end equality
    if (r.startPage !== gt.startPage || r.endPage !== gt.endPage) {
      incorrect += 1
      incorrectDetails.push(`sec${gt.section_index}: got [${r.startPage},${r.endPage}] want [${gt.startPage},${gt.endPage}]`)
    }
    if (r.confidence !== gt.confidence) {
      incorrect += 1
      incorrectDetails.push(`sec${gt.section_index}: confidence ${r.confidence} want ${gt.confidence}`)
    }
    if (r.startsMidPage !== gt.startsMidPage || r.endsMidPage !== gt.endsMidPage) {
      incorrect += 1
      incorrectDetails.push(`sec${gt.section_index}: mid-page flags ${r.startsMidPage}/${r.endsMidPage} want ${gt.startsMidPage}/${gt.endsMidPage}`)
    }
    // unavailable never defaults to Page 1
    if (r.confidence === 'unavailable' && r.startPage === 1) {
      incorrect += 1
      incorrectDetails.push(`sec${gt.section_index}: unavailable defaulted to Page 1`)
    }
  }

  return { name, pages: pages.length, exact, approximate, unavailable, incorrect, incorrectDetails }
}

const FIXTURES = ['sec3p', 'sec2next', 'sec2cont', 'secodd', 'secland', 'secsize', 'sectable', 'secfigure', 'secunmapped', 'secconflict']

test('section fixtures: zero incorrect ranges across all 10 fixtures', async () => {
  let totalExact = 0
  let totalApprox = 0
  let totalUnavail = 0
  let totalIncorrect = 0
  const allDetails: string[] = []

  for (const name of FIXTURES) {
    const r = await runFixture(name)
    totalExact += r.exact
    totalApprox += r.approximate
    totalUnavail += r.unavailable
    totalIncorrect += r.incorrect
    allDetails.push(...r.incorrectDetails)
    console.log(`${name}: exact=${r.exact} approximate=${r.approximate} unavailable=${r.unavailable} incorrect=${r.incorrect}`)
  }

  console.log(`TOTAL: exact=${totalExact} approximate=${totalApprox} unavailable=${totalUnavail} incorrect=${totalIncorrect}`)
  assert.deepEqual(allDetails, [], `incorrect ranges: ${allDetails.join('; ')}`)
  assert.equal(totalIncorrect, 0, 'zero known incorrect ranges required')
})

test('section fixtures: exact ranges equal ground truth start/end', async () => {
  for (const name of FIXTURES) {
    const r = await runFixture(name)
    assert.equal(r.incorrect, 0, `${name}: ${r.incorrectDetails.join('; ')}`)
  }
})

test('continuous fixture: mid-page flags are set correctly', async () => {
  const pdf = new Uint8Array(readFileSync(join(fixturesDir, 'sec2cont.pdf')))
  const blocks = JSON.parse(readFileSync(join(fixturesDir, 'sec2cont-blocks.json'), 'utf8'))
  const meta = JSON.parse(readFileSync(join(fixturesDir, 'sec2cont-meta.json'), 'utf8')) as SectionMetadataLike[]
  const pages = await extractPageText(pdf)
  const mapping = mapBlocksToPages(blocks, pages)
  const byIndex = new Map(mapping.map((m) => [m.index, m]))
  const blockTexts = new Map(blocks.map((b) => [b.index, b.text]))
  const r0 = mapSection({ sections: meta, byIndex, blockTexts, numPages: pages.length }, 0)
  const r1 = mapSection({ sections: meta, byIndex, blockTexts, numPages: pages.length }, 1)
  // both sections share page 1 (continuous break)
  assert.equal(r0.endPage, 1)
  assert.equal(r1.startPage, 1)
  assert.equal(r0.endsMidPage, true)
  assert.equal(r1.startsMidPage, true)
})

test('section fixtures: table-only and figure-only sections stay unavailable (no fake page)', async () => {
  for (const name of ['sectable', 'secfigure']) {
    const pdf = new Uint8Array(readFileSync(join(fixturesDir, `${name}.pdf`)))
    const blocks = JSON.parse(readFileSync(join(fixturesDir, `${name}-blocks.json`), 'utf8'))
    const meta = JSON.parse(readFileSync(join(fixturesDir, `${name}-meta.json`), 'utf8')) as SectionMetadataLike[]
    const pages = await extractPageText(pdf)
    const mapping = mapBlocksToPages(blocks, pages)
    const byIndex = new Map(mapping.map((m) => [m.index, m]))
    const blockTexts = new Map(blocks.map((b) => [b.index, b.text]))
    const r1 = mapSection({ sections: meta, byIndex, blockTexts, numPages: pages.length }, 1)
    assert.equal(r1.confidence, 'unavailable', `${name} section 1`)
    assert.equal(r1.startPage, null)
    assert.notEqual(r1.startPage, 1, 'unavailable never defaults to Page 1')
  }
})
