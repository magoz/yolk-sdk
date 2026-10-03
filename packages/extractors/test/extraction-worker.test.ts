import { describe, expect, it } from '@effect/vitest'
import { Cause, Effect, Exit, Fiber } from 'effect'
import { strToU8, zipSync } from 'fflate'
import { vi } from 'vitest'
import * as XLSX from 'xlsx'
import { FileExtractionError, OfficeArchiveError } from '../src/errors.ts'
import type { FileInput } from '../src/format.ts'
import { defaultFileExtractorLimits } from '../src/limits.ts'
import {
  defaultExtractionWorkerUrl,
  defaultWorkerIsolation,
  extractionWorkerUrlFor,
  makeWorkerExtractor
} from '../src/node/extraction-isolation.ts'
import type { WorkerIsolationOptions } from '../src/node/extraction-isolation.ts'
import { makeFileExtractorLayer } from '../src/node/live-layer.ts'
import { processAdmissionSnapshot } from '../src/node/worker-admission.ts'
import { FileExtractor } from '../src/service.ts'
import {
  docxMediaType,
  extractWith,
  makeDocx,
  makePdf,
  makePptx,
  pptxMediaType,
  singleSheetParts,
  sourceWorkerUrl,
  worksheet,
  xlsxInput,
  zipParts
} from './fixtures.ts'

// Real worker threads running the package's worker entry (from source here; the built
// `dist` bundle is the default and is covered by `pnpm packages:smoke`) with the real parsers and
// the installed SheetJS. No wall-clock assertions: the timeout and queue cases only use deadlines
// nothing can meet, and admission is asserted on the pool's counts.

const inWorker = (input: FileInput, isolation: WorkerIsolationOptions = {}) =>
  extractWith(input, { isolation: { workerUrl: sourceWorkerUrl, ...isolation } })

const pdfInput: FileInput = {
  filename: 'held.pdf',
  mediaType: 'application/pdf',
  bytes: new Uint8Array([37, 80, 68, 70])
}

/** A stub worker that only posts a message, as `code` says, from a `data:` URL. */
const stubWorker = (code: string) =>
  new URL(
    `data:text/javascript,${encodeURIComponent(`import { parentPort } from 'node:worker_threads'; ${code}`)}`
  )

/**
 * Stub workers that start, announce themselves on a `BroadcastChannel`, and hold their slot until
 * the test broadcasts `release`; then they reply with a fixed result. Counting announcements gives
 * the number of workers started.
 */
const openHeldWorkers = (name: string) => {
  const channel = new BroadcastChannel(name)
  let started = 0
  const waiters = new Set<() => void>()

  channel.onmessage = (event: MessageEvent) => {
    if (event.data !== 'started') return

    started += 1

    for (const wake of [...waiters]) wake()
  }

  const workerUrl = stubWorker(
    `const channel = new BroadcastChannel(${JSON.stringify(name)}); channel.onmessage = event => { if (event.data !== 'release') return; parentPort.postMessage({ _tag: 'WorkerSucceeded', file: { content: 'held', metadata: { format: 'pdf' } } }); channel.close() }; parentPort.postMessage({ _tag: 'WorkerStarted' }); channel.postMessage('started')`
  )

  return {
    workerUrl,
    started: () => started,
    /** Wait until `count` workers have started in total. */
    awaitStarted: (count: number) =>
      Effect.promise(
        () =>
          new Promise<void>(resolve => {
            const wake = () => {
              if (started < count) return

              waiters.delete(wake)
              resolve()
            }

            waiters.add(wake)
            wake()
          })
      ),
    /** Every running stub replies and is then terminated by the layer. */
    release: () => Effect.sync(() => channel.postMessage('release')),
    close: () => Effect.sync(() => channel.close())
  }
}

/** `openHeldWorkers` whose channel is closed with the test's scope, even when an assertion fails. */
const heldWorkers = (name: string) =>
  Effect.acquireRelease(
    Effect.sync(() => openHeldWorkers(name)),
    held => held.close()
  )

const times = (count: number) => Array.from({ length: count }, (_, index) => index)

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
      const missing = new URL('./no-such-extraction-worker.mjs', sourceWorkerUrl)

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

  it.effect('reports a worker that exits after starting without a result', () =>
    Effect.gen(function* () {
      const exiting = stubWorker(
        "parentPort.postMessage({ _tag: 'WorkerStarted' }); setTimeout(() => process.exit(3), 10)"
      )

      const error = yield* inWorker(inputs[1] ?? xlsxInput(linkedWorkbook()), {
        workerUrl: exiting
      }).pipe(Effect.flip)

      expect(error).toEqual(
        new FileExtractionError({
          format: 'docx',
          reason: 'worker-failed',
          message: 'File extraction worker failed.',
          cause: new Error('Worker exited with code 3')
        })
      )
    })
  )

  it.effect('reports a worker that exits before starting as unavailable', () =>
    Effect.gen(function* () {
      const error = yield* inWorker(inputs[1] ?? xlsxInput(linkedWorkbook()), {
        workerUrl: stubWorker('process.exit(3)')
      }).pipe(Effect.flip)

      expect(error).toMatchObject({
        reason: 'worker-unavailable',
        cause: new Error('Worker exited with code 3')
      })
    })
  )

  it.effect('fails a worker that posts a malformed message', () =>
    Effect.gen(function* () {
      const malformed = stubWorker(
        "parentPort.postMessage({ _tag: 'Started' }); setInterval(() => {}, 1000)"
      )

      const error = yield* inWorker(inputs[1] ?? xlsxInput(linkedWorkbook()), {
        workerUrl: malformed
      }).pipe(Effect.flip)

      // No cause: the message itself was rejected, and the worker is terminated, not exited.
      expect(error).toEqual(
        new FileExtractionError({
          format: 'docx',
          reason: 'worker-failed',
          message: 'File extraction worker failed.'
        })
      )
      expect(processAdmissionSnapshot()).toEqual({ active: 0, waiting: 0 })
    })
  )

  it.effect("runs extractions beyond a layer's share once its worker is free", () =>
    Effect.gen(function* () {
      const results = yield* Effect.gen(function* () {
        const extractor = yield* FileExtractor

        return yield* Effect.forEach(inputs, input => extractor.extract(input), {
          concurrency: 'unbounded'
        })
      }).pipe(
        Effect.provide(
          makeFileExtractorLayer({
            isolation: { workerUrl: sourceWorkerUrl, maxConcurrentWorkers: 1 }
          })
        )
      )

      expect(results.map(result => result.metadata.format)).toEqual(['xlsx', 'docx', 'pptx', 'pdf'])
    })
  )

  it.effect('caps running workers process-wide across independently built layers', () =>
    Effect.gen(function* () {
      const held = yield* heldWorkers('yolk-extractors-peak')

      // Six extractions, each through its own layer build (as per-request `Effect.provide` does).
      const extractions = (count: number) =>
        Effect.forkChild(
          Effect.forEach(times(count), () => inWorker(pdfInput, { workerUrl: held.workerUrl }), {
            concurrency: 'unbounded'
          })
        )

      const first = yield* extractions(4)

      yield* held.awaitStarted(4)

      const second = yield* extractions(2)

      // Wait until both newcomers queue (each starts with its own layer build).
      while (processAdmissionSnapshot().waiting < 2) yield* Effect.yieldNow

      // Four running and two waiting is the peak: no fifth worker started.
      expect(processAdmissionSnapshot()).toEqual({ active: 4, waiting: 2 })
      expect(held.started()).toBe(4)

      // Join the first four, so their slots have been released (after `worker.terminate()`).
      yield* held.release()

      const firstResults = yield* Fiber.join(first)

      yield* held.awaitStarted(6)

      expect(processAdmissionSnapshot()).toEqual({ active: 2, waiting: 0 })

      yield* held.release()

      const results = [...firstResults, ...(yield* Fiber.join(second))]

      expect(results.map(result => result.content)).toEqual(times(6).map(() => 'held'))
      expect(processAdmissionSnapshot()).toEqual({ active: 0, waiting: 0 })
    })
  )

  it.effect('keeps a layer within its own maxConcurrentWorkers share', () =>
    Effect.gen(function* () {
      const held = yield* heldWorkers('yolk-extractors-share')

      const all = yield* Effect.forkChild(
        Effect.gen(function* () {
          const extractor = yield* FileExtractor

          return yield* Effect.forEach(times(3), () => extractor.extract(pdfInput), {
            concurrency: 'unbounded'
          })
        }).pipe(
          Effect.provide(
            makeFileExtractorLayer({
              isolation: { workerUrl: held.workerUrl, maxConcurrentWorkers: 1 }
            })
          )
        )
      )

      for (const count of [1, 2, 3]) {
        yield* held.awaitStarted(count)

        // The others wait in the layer's share, not in the process pool.
        expect(processAdmissionSnapshot()).toEqual({ active: 1, waiting: 0 })
        expect(held.started()).toBe(count)

        yield* held.release()
      }

      expect(yield* Fiber.join(all)).toHaveLength(3)
    })
  )

  it.effect('fails with busy, without starting a worker, when no slot frees up in time', () =>
    Effect.gen(function* () {
      const held = yield* heldWorkers('yolk-extractors-busy')

      const holders = yield* Effect.forkChild(
        Effect.forEach(times(4), () => inWorker(pdfInput, { workerUrl: held.workerUrl }), {
          concurrency: 'unbounded'
        })
      )

      yield* held.awaitStarted(4)

      const error = yield* inWorker(pdfInput, {
        workerUrl: held.workerUrl,
        maxQueueWaitMs: 20
      }).pipe(Effect.flip)

      expect(error).toEqual(
        new FileExtractionError({
          format: 'pdf',
          reason: 'busy',
          message: 'File extraction is busy. Try again later.'
        })
      )
      expect(held.started()).toBe(4)
      expect(processAdmissionSnapshot()).toEqual({ active: 4, waiting: 0 })

      yield* held.release()
      yield* Fiber.join(holders)
    })
  )

  it.effect('fails with busy, without starting a worker, once its deadline has passed', () =>
    Effect.gen(function* () {
      const held = yield* heldWorkers('yolk-extractors-expired')

      // Every `Date.now` reads a second later than the one before, so the admission deadline
      // (1 ms after the first read) has passed by the time a free slot would be taken.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const now = Date.now.bind(Date)
          let reads = 0

          return vi.spyOn(Date, 'now').mockImplementation(() => now() + 1000 * reads++)
        }),
        spy => Effect.sync(() => spy.mockRestore())
      )

      expect(processAdmissionSnapshot()).toEqual({ active: 0, waiting: 0 })

      const error = yield* inWorker(pdfInput, {
        workerUrl: held.workerUrl,
        maxQueueWaitMs: 1
      }).pipe(Effect.flip)

      expect(error).toMatchObject({
        reason: 'busy',
        message: 'File extraction is busy. Try again later.'
      })
      expect(held.started()).toBe(0)
      expect(processAdmissionSnapshot()).toEqual({ active: 0, waiting: 0 })
    })
  )

  it.effect('terminates the worker and frees its slot when the caller is interrupted', () =>
    Effect.gen(function* () {
      const held = yield* heldWorkers('yolk-extractors-interrupt')
      const fiber = yield* Effect.forkChild(inWorker(pdfInput, { workerUrl: held.workerUrl }))

      yield* held.awaitStarted(1)

      expect(processAdmissionSnapshot()).toEqual({ active: 1, waiting: 0 })

      // Interruption waits for the scope's release, which awaits `worker.terminate()` before the
      // slot is returned.
      yield* Fiber.interrupt(fiber)

      expect(processAdmissionSnapshot()).toEqual({ active: 0, waiting: 0 })

      // The pool is usable again: a new held worker starts at once.
      const next = yield* Effect.forkChild(inWorker(pdfInput, { workerUrl: held.workerUrl }))

      yield* held.awaitStarted(2)
      yield* held.release()

      expect(yield* Fiber.join(next)).toMatchObject({ content: 'held' })
    })
  )

  it('derives the built worker from the module location, and nothing elsewhere', () => {
    expect(
      extractionWorkerUrlFor(
        'file:///app/node_modules/@yolk-sdk/extractors/dist/node/extraction-isolation.mjs'
      )?.href
    ).toBe('file:///app/node_modules/@yolk-sdk/extractors/dist/node/extraction-worker.mjs')
    expect(
      extractionWorkerUrlFor('file:///repo/packages/extractors/src/node/extraction-isolation.ts')
        ?.href
    ).toBe('file:///repo/packages/extractors/dist/node/extraction-worker.mjs')
    expect(extractionWorkerUrlFor('file:///app/.next/server/chunks/_ccc56ab8._.js')).toBeUndefined()
    expect(extractionWorkerUrlFor('file:///app/chunks/extraction-isolation.mjs')).toBeUndefined()
    expect(defaultExtractionWorkerUrl()?.href).toBe(
      new URL('../dist/node/extraction-worker.mjs', import.meta.url).href
    )
  })

  it.effect('fails closed without starting a worker when there is no worker URL', () =>
    Effect.gen(function* () {
      const extract = yield* makeWorkerExtractor(defaultWorkerIsolation, undefined)

      const error = yield* extract(pdfInput, 'pdf', defaultFileExtractorLimits).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: 'FileExtractionError',
        format: 'pdf',
        reason: 'worker-unavailable',
        message: 'File extraction worker could not start.'
      })
      expect(processAdmissionSnapshot()).toEqual({ active: 0, waiting: 0 })
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

        const invalid = yield* Effect.forEach(
          [
            { maxOldGenerationSizeMb: 0 },
            // The process-wide pool has four slots; a layer can only lower its share.
            { maxConcurrentWorkers: 5 },
            { maxQueueWaitMs: 0 },
            // Above Node's largest timer delay, `setTimeout` would fire after 1 ms.
            { timeoutMs: 2 ** 31 },
            { maxQueueWaitMs: 2 ** 31 }
          ],
          isolation => Effect.exit(inWorker(input, isolation))
        )

        for (const exit of [loader, ...invalid])
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      })
  )
})
