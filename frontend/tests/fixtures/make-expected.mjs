// Throwaway ground-truth generator for mapping PoC fixtures.
// Computes expected page/pageRange per block from the FROZEN pdf via the
// same text-extraction layer (pdfjs legacy + normalizeText), using a naive
// "first page containing the full text" scan that is deliberately
// independent of the mapper's alignment algorithm.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractPageText } from '../../src/lib/pdf/pdf-text-extract.ts'
import { normalizeText } from '../../src/lib/pdf/paragraph-mapping.ts'

const fixturesDir = dirname(fileURLToPath(import.meta.url))

const contains = (hay, needle) => hay.includes(needle) || hay.replace(/\s+/g, '').includes(needle.replace(/\s+/g, ''))

for (const name of ['caption-fixture-3', 'edge-fixture-2']) {
  const pdf = new Uint8Array(readFileSync(join(fixturesDir, `${name}.pdf`)))
  const blocks = JSON.parse(readFileSync(join(fixturesDir, `${name}-blocks.json`), 'utf8'))
  const pages = await extractPageText(pdf)
  const blobs = pages.map((p) => p.lines.filter((l) => !p.headerFooterLines.has(l.text)).map((l) => l.text).join('\n'))

  const expected = blocks.map((b) => {
    const t = normalizeText(b.text)
    if (!t) return { index: b.index, pageNumber: null, pageRange: null }
    // full text in one page
    for (let i = 0; i < blobs.length; i++) {
      if (contains(blobs[i], t)) return { index: b.index, pageNumber: i + 1, pageRange: null }
    }
    // smallest window 2..4
    for (let w = 2; w <= Math.min(4, blobs.length); w++) {
      for (let i = 0; i + w <= blobs.length; i++) {
        if (contains(blobs.slice(i, i + w).join('\n'), t)) {
          return { index: b.index, pageNumber: i + 1, pageRange: [i + 1, i + w] }
        }
      }
    }
    return { index: b.index, pageNumber: null, pageRange: null }
  })

  writeFileSync(join(fixturesDir, `${name}-expected.json`), JSON.stringify(expected, null, 1))
  console.log(name, 'expected written, pages=', pages.length, 'blocks=', expected.length)
}
