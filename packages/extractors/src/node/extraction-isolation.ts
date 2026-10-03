import { Worker } from 'node:worker_threads'
import { Effect, Match, Option, Semaphore } from 'effect'
import * as Schema from 'effect/Schema'
import { FileExtractionError } from '../errors.ts'
import type { FileExtractionFailureReason, FileExtractorError } from '../errors.ts'
import type { ExtractedFile, FileInput } from '../format.ts'
import type { FileExtractorLimits } from '../limits.ts'
import type { ParsedFileFormat } from './extract-file.ts'
import { decodeWorkerMessage, revivedError } from './extraction-worker-protocol.ts'
import type { ExtractionWorkerRequest } from './extraction-worker-protocol.ts'

/** Limits for the worker each PDF, DOCX, XLSX, or PPTX extraction runs in. */
export type WorkerIsolationOptions = {
  /** V8 old-generation heap of the worker, in MB. Default 256. */
  readonly maxOldGenerationSizeMb?: number
  /** V8 young-generation heap of the worker, in MB. Default 32. */
  readonly maxYoungGenerationSizeMb?: number
  /** Stack of the worker's main thread, in MB. Default 4 (Node's own default). */
  readonly stackSizeMb?: number
  /** Wall-clock time a worker may run before it is terminated, in ms. Default 30,000. */
  readonly timeoutMs?: number
  /** Workers running at once per layer; further extractions wait. Default 4. */
  readonly maxConcurrentWorkers?: number
  /**
   * The worker entry. Default: `extraction-worker.mjs` next to this module, which exists on disk
   * when the package is not bundled (Next.js `serverExternalPackages`). Bundled hosts can copy
   * `@yolk-sdk/extractors/node/extraction-worker` and point here.
   */
  readonly workerUrl?: string | URL
}

/**
 * Where parsers run. `'worker'` (the default) and an options object run each PDF, DOCX, XLSX, and
 * PPTX extraction in a fresh `worker_threads` worker with resource limits and a timeout.
 * `'none'` runs parsers in the calling thread: only for environments without worker threads, and
 * unsafe for untrusted input (a crafted file can exhaust the process heap or block the event loop).
 */
export type FileExtractorIsolation = 'worker' | 'none' | WorkerIsolationOptions

const PositiveSafeInteger = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0)),
  Schema.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
)

/** Resolved worker settings; every value is a positive integer. */
export const WorkerIsolationSettings = Schema.Struct({
  maxOldGenerationSizeMb: PositiveSafeInteger,
  maxYoungGenerationSizeMb: PositiveSafeInteger,
  stackSizeMb: PositiveSafeInteger,
  timeoutMs: PositiveSafeInteger,
  maxConcurrentWorkers: PositiveSafeInteger
})

export type WorkerIsolationSettings = typeof WorkerIsolationSettings.Type

/**
 * Defaults. 256 MB of old generation holds SheetJS's cell objects for the default limits (100,000
 * visited cells, 50 MiB expanded) several times over and PDF.js's working set for ordinary PDFs,
 * while keeping four concurrent workers near 1 GB of V8 heap, inside a 2 GB serverless function.
 * 32 MB of young generation is twice V8's usual 64-bit default, enough for short-lived parser
 * strings. 30 s is far above legitimate parse times at the default limits (well under a second
 * for the research workbooks) and below common serverless request budgets.
 */
export const defaultWorkerIsolation: WorkerIsolationSettings = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
  timeoutMs: 30_000,
  maxConcurrentWorkers: 4
}

/**
 * The worker file next to this module: `extraction-worker.ts` beside the source (tests, workspace)
 * and `extraction-worker.mjs` beside `dist/node/extraction-isolation.mjs`. The URL is derived from
 * this module's own URL at runtime, never written as `new URL('./…', import.meta.url)`: bundlers
 * rewrite that pattern into a copied asset whose own imports cannot resolve.
 */
export const defaultExtractionWorkerUrl = () =>
  new URL(import.meta.url.replace(/extraction-isolation\.(ts|mjs)$/, 'extraction-worker.$1'))

const stoppedMessages: Readonly<Record<FileExtractionFailureReason, string>> = {
  'resource-limit': 'File extraction exceeded its memory limit.',
  timeout: 'File extraction timed out.',
  'worker-unavailable': 'File extraction worker could not start.',
  'worker-failed': 'File extraction worker failed.'
}

const stopped = (format: ParsedFileFormat, reason: FileExtractionFailureReason, cause?: unknown) =>
  cause === undefined
    ? new FileExtractionError({ format, reason, message: stoppedMessages[reason] })
    : new FileExtractionError({ format, reason, message: stoppedMessages[reason], cause })

const isOutOfMemory = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ERR_WORKER_OUT_OF_MEMORY'

type WorkerOutcome = Effect.Effect<ExtractedFile, FileExtractorError>

type StartedWorker = {
  readonly worker: Worker
  /** Settles once with the worker's result or failure; listeners are attached at construction. */
  readonly outcome: Promise<WorkerOutcome>
}

/**
 * Start a worker and attach its listeners in the same tick, so no `error` event can go unheard
 * (an unheard worker `error` would throw in the host process).
 */
const startWorker = (
  workerUrl: string | URL,
  options: ConstructorParameters<typeof Worker>[1],
  format: ParsedFileFormat
): StartedWorker => {
  const worker = new Worker(workerUrl, options)

  const outcome = new Promise<WorkerOutcome>(resolve => {
    let started = false

    worker.on('message', (raw: unknown) =>
      Option.match(decodeWorkerMessage(raw), {
        onNone: () => resolve(Effect.fail(stopped(format, 'worker-failed'))),
        onSome: message =>
          Match.valueTags(message, {
            WorkerStarted: () => {
              started = true
            },
            WorkerSucceeded: ({ file }) => resolve(Effect.succeed(file)),
            WorkerFailed: ({ error }) => resolve(Effect.fail(revivedError(error))),
            WorkerDefect: ({ message: defect }) =>
              resolve(Effect.die(new Error(`File extraction worker defect: ${defect}`)))
          })
      })
    )

    // `ERR_WORKER_OUT_OF_MEMORY` when a heap limit is hit; errors before `WorkerStarted` mean the
    // worker file or its imports could not load.
    worker.on('error', (error: unknown) => {
      const reason = started ? 'worker-failed' : 'worker-unavailable'

      resolve(Effect.fail(stopped(format, isOutOfMemory(error) ? 'resource-limit' : reason, error)))
    })

    worker.on('exit', (code: number) =>
      resolve(
        Effect.fail(
          stopped(
            format,
            started ? 'worker-failed' : 'worker-unavailable',
            new Error(`Worker exited with code ${code}`)
          )
        )
      )
    )
  })

  return { worker, outcome }
}

/**
 * Wait for the worker's outcome, at most `timeoutMs` of wall-clock time (a real timer, not the
 * Effect `Clock`, so a test clock cannot stall it). The caller's scope terminates the worker
 * whatever happens, including interruption.
 */
const awaitOutcome = ({ outcome }: StartedWorker, format: ParsedFileFormat, timeoutMs: number) =>
  Effect.callback<ExtractedFile, FileExtractorError>(resume => {
    const timer = setTimeout(() => resume(Effect.fail(stopped(format, 'timeout'))), timeoutMs)

    void outcome.then(result => {
      clearTimeout(timer)
      resume(result)
    })

    return Effect.sync(() => clearTimeout(timer))
  })

export type WorkerExtractor = (
  input: FileInput,
  format: ParsedFileFormat,
  limits: FileExtractorLimits
) => Effect.Effect<ExtractedFile, FileExtractorError>

/**
 * Run each extraction in a fresh worker: the input is copied into a transferred buffer, the
 * worker returns only text and metadata, and the worker is terminated when the result arrives,
 * the timeout fires, or the caller is interrupted. A worker that cannot start fails closed with
 * `reason: 'worker-unavailable'`; there is no in-process fallback.
 */
export const makeWorkerExtractor = (
  settings: WorkerIsolationSettings,
  workerUrl: string | URL
): Effect.Effect<WorkerExtractor> =>
  Effect.map(Semaphore.make(settings.maxConcurrentWorkers), slots => (input, format, limits) => {
    const extraction = Effect.gen(function* () {
      const bytes = new Uint8Array(input.bytes)

      const request: ExtractionWorkerRequest = {
        filename: input.filename,
        mediaType: input.mediaType,
        bytes,
        format,
        limits
      }

      const started = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            startWorker(
              workerUrl,
              {
                workerData: request,
                transferList: [bytes.buffer],
                resourceLimits: {
                  maxOldGenerationSizeMb: settings.maxOldGenerationSizeMb,
                  maxYoungGenerationSizeMb: settings.maxYoungGenerationSizeMb,
                  stackSizeMb: settings.stackSizeMb
                }
              },
              format
            ),
          catch: cause => stopped(format, 'worker-unavailable', cause)
        }),
        ({ worker }) => Effect.promise(() => worker.terminate())
      )

      return yield* awaitOutcome(started, format, settings.timeoutMs)
    })

    return slots.withPermits(1)(Effect.scoped(extraction))
  })
