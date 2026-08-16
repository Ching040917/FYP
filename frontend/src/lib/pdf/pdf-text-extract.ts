/**
 * PDF text extraction + shared pdfjs configuration.
 *
 * ONE pdfjs instance for the whole app: the viewer and the paragraph
 * mapper must use the same build and the same worker configuration, or
 * the mapper fails in the browser while working in Node tests (the legacy
 * build has no auto-configured worker there). Environment-aware:
 *   - Node (tests/fixtures): legacy build, fake worker — works headless;
 *   - Browser: standard build + the Vite worker asset, configured once.
 */
import {
  findRepeatedLines,
  reconstructLines,
  type PageText,
  type TextItemLike,
} from './paragraph-mapping.ts'

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null

export function getPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      if (typeof window === 'undefined') {
        const legacy = await import('pdfjs-dist/legacy/build/pdf.mjs')
        return legacy as typeof import('pdfjs-dist')
      }
      const main = await import('pdfjs-dist')
      if (!main.GlobalWorkerOptions.workerSrc) {
        const { default: workerSrc } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
        main.GlobalWorkerOptions.workerSrc = workerSrc
      }
      return main
    })()
  }
  return pdfjsPromise
}

export async function extractPageText(pdfBytes: ArrayBuffer | Uint8Array): Promise<PageText[]> {
  const pdfjsLib = await getPdfjs()
  const task = pdfjsLib.getDocument({ data: pdfBytes })
  const doc = await task.promise
  try {
    const raw: PageText[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      const items = content.items.filter(
        (it): boolean => typeof (it as { str?: unknown }).str === 'string',
      ) as unknown as TextItemLike[]
      const viewport = page.getViewport({ scale: 1 })
      raw.push({
        pageNumber: n,
        lines: reconstructLines(items as TextItemLike[]),
        headerFooterLines: new Set(),
        items: items as TextItemLike[],
        pageWidth: viewport.width,
        pageHeight: viewport.height,
      })
    }
    const repeated = findRepeatedLines(raw)
    return raw.map((p) => ({
      ...p,
      headerFooterLines: repeated.get(p.pageNumber) ?? new Set(),
    }))
  } finally {
    await doc.destroy()
  }
}
