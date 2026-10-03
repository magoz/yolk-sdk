import { describe, expect, it } from '@effect/vitest'
import { Cause, Effect, Exit } from 'effect'
import { strToU8, zipSync } from 'fflate'
import * as XLSX from 'xlsx'
import { FileExtractionError, OfficeArchiveError } from '../src/errors.ts'
import type { FileInput } from '../src/format.ts'
import { defaultExtractionWorkerUrl } from '../src/node/extraction-isolation.ts'
import type { FileExtractorOptions } from '../src/node/live-layer.ts'
import {
  docxMediaType,
  extractWith,
  makeDocx,
  makePdf,
  makePptx,
  pptxMediaType,
  singleSheetParts,
  worksheet,
  xlsxInput,
  zipParts
} from './fixtures.ts'

// Real worker threads running the package's worker entry (from source here, `dist` when
// published) with the real parsers and the installed SheetJS. No wall-clock assertions: the
// timeout case only uses a deadline no worker can meet.

const inWorker = (input: FileInput, isolation: FileExtractorOptions['isolation'] = 'worker') =>
  extractWith(input, { isolation })

const linkedWorkbook = () => {
  const book = XLSX.utils.book_new()

  const sheet = XLSX.utils.aoa_to_sheet([
    ['Name', 'Share', 'Site'],
    ['Acme', 0.125, 'acme']
  ])

  if (sheet.C2 !== undefined) sheet.C2.l = { Target: 'https://acme.example/' }

  if (sheet.B2 !== undefined) sheet.B2.z = '0.0%'

  XLSX.utils.book_append_sheet(book, sheet, 'Links')
  book.Props = { Title: 'Worker report' }

  const written: unknown = XLSX.write(book, { bookType: 'xlsx', type: 'array' })

  if (!(written instanceof ArrayBuffer)) throw new Error('Expected XLSX fixture')

  return new Uint8Array(written)
}

const inputs: ReadonlyArray<FileInput> = [
  xlsxInput(linkedWorkbook(), 'links.xlsx'),
  { filename: 'brief.docx', mediaType: docxMediaType, bytes: makeDocx('Hello DOCX') },
  { filename: 'deck.pptx', mediaType: pptxMediaType, bytes: makePptx() },
  { filename: 'paper.pdf', mediaType: 'application/pdf', bytes: makePdf('Hello PDF') }
]

/** About 300,000 numeric cells: far more than a 16 MB heap holds as SheetJS cell objects. */
const heapHeavyWorkbook = () => {
  const rows = 30_000

  const sheetData = Array.from({ length: rows }, (_, row) => {
    const cells = Array.from(
      { length: 10 },
      (_, column) => `<c r="${String.fromCharCode(65 + column)}${row + 1}"><v>${row}</v></c>`
    )

    return `<row r="${row + 1}">${cells.join('')}</row>`
  })

  return zipParts(singleSheetParts(worksheet(sheetData.join(''), `A1:J${rows}`)))
}

describe('isolated extraction in a worker thread', () => {
  for (const input of inputs) {
    it.effect(`extracts ${input.filename} in a worker exactly as in-process`, () =>
      Effect.gen(function* () {
        const isolated = yield* inWorker(input)
        const inProcess = yield* extractWith(input, { isolation: 'none' })

        expect(isolated).toEqual(inProcess)
      })
    )
  }

  it.effect('returns the workbook text, title, and sheet names from the worker', () =>
    Effect.gen(function* () {
      const extracted = yield* inWorker(inputs[0] ?? xlsxInput(linkedWorkbook()))

      expect(extracted).toEqual({
        content: '# Links\nName,Share,Site\nAcme,12.5%,acme <https://acme.example/>',
        metadata: { format: 'xlsx', title: 'Worker report', sheetNames: ['Links'] }
      })
    })
  )

  it.effect('keeps typed errors and their archive cause across the thread boundary', () =>
    Effect.gen(function* () {
      const error = yield* inWorker({
        filename: 'deck.pptx',
        mediaType: pptxMediaType,
        bytes: zipSync({ 'ppt/slides/slide1.xml': strToU8('<a:t>x</a:t>') })
      }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(FileExtractionError)
      expect(error.message).toBe('Invalid Office archive.')
      expect(error).toMatchObject({ reason: undefined, cause: expect.any(OfficeArchiveError) })
    })
  )

  it.effect('stops a worker that exhausts its heap, and the process keeps working', () =>
    Effect.gen(function* () {
      const book = heapHeavyWorkbook()

      const error = yield* inWorker(xlsxInput(book), { maxOldGenerationSizeMb: 16 }).pipe(
        Effect.flip
      )

      expect(error).toEqual(
        new FileExtractionError({
          format: 'xlsx',
          reason: 'resource-limit',
          message: 'File extraction exceeded its memory limit.',
          cause: expect.objectContaining({ code: 'ERR_WORKER_OUT_OF_MEMORY' })
        })
      )

      // The same file with the default heap parses and then hits the cell-visit limit.
      const limited = yield* inWorker(xlsxInput(book)).pipe(Effect.flip)

      expect(limited.message).toBe('XLSX exceeds the worksheet or cell-visit limit.')
      expect(yield* inWorker(inputs[1] ?? xlsxInput(book))).toMatchObject({ content: 'Hello DOCX' })
    })
  )

  it.effect('terminates a worker that runs past its timeout', () =>
    Effect.gen(function* () {
      const error = yield* inWorker(inputs[0] ?? xlsxInput(linkedWorkbook()), {
        timeoutMs: 1
      }).pipe(Effect.flip)

      expect(error).toEqual(
        new FileExtractionError({
          format: 'xlsx',
          reason: 'timeout',
          message: 'File extraction timed out.'
        })
      )
    })
  )

  it.effect('fails closed when the worker cannot start', () =>
    Effect.gen(function* () {
      const missing = new URL('./no-such-extraction-worker.mjs', defaultExtractionWorkerUrl())

      const error = yield* inWorker(inputs[1] ?? xlsxInput(linkedWorkbook()), {
        workerUrl: missing
      }).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: 'FileExtractionError',
        format: 'docx',
        reason: 'worker-unavailable',
        message: 'File extraction worker could not start.'
      })
    })
  )

  it.effect('reports a worker that exits without a result', () =>
    Effect.gen(function* () {
      const exiting = new URL(
        `data:text/javascript,${encodeURIComponent(
          "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ _tag: 'Started' }); setTimeout(() => process.exit(3), 10)"
        )}`
      )

      const error = yield* inWorker(inputs[1] ?? xlsxInput(linkedWorkbook()), {
        workerUrl: exiting
      }).pipe(Effect.flip)

      expect(error).toMatchObject({
        reason: 'worker-failed',
        message: 'File extraction worker failed.'
      })
    })
  )

  it.effect('runs extractions beyond the concurrency limit once a worker is free', () =>
    Effect.gen(function* () {
      const results = yield* Effect.forEach(
        inputs,
        input => extractWith(input, { isolation: { maxConcurrentWorkers: 1 } }),
        {
          concurrency: 'unbounded'
        }
      )

      expect(results.map(result => result.metadata.format)).toEqual(['xlsx', 'docx', 'pptx', 'pdf'])
    })
  )

  it.effect(
    'rejects an in-process SheetJS loader or invalid settings when the layer is built',
    () =>
      Effect.gen(function* () {
        const input = inputs[0] ?? xlsxInput(linkedWorkbook())

        const loader = yield* Effect.exit(
          extractWith(input, { isolation: 'worker', loadSheetJs: async () => XLSX })
        )

        const invalid = yield* Effect.exit(inWorker(input, { maxOldGenerationSizeMb: 0 }))

        for (const exit of [loader, invalid])
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      })
  )
})
