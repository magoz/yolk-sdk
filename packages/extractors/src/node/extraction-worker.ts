// Worker entry for isolated extraction (`@yolk-sdk/extractors/node/extraction-worker`). The Node
// layer starts it once per extraction with V8 resource limits; it reads the request from
// `workerData`, runs the parsers, posts one plain-data result, and exits. Importing it outside a
// worker thread does nothing.
import { parentPort, workerData } from 'node:worker_threads'
import { Cause, Effect, Exit, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { extractParsedFile } from './extract-file.ts'
import {
  ExtractionWorkerMessage,
  ExtractionWorkerRequest,
  failureMessage,
  WorkerDefect,
  WorkerStarted,
  WorkerSucceeded
} from './extraction-worker-protocol.ts'
import { defaultSheetJsLoader } from './sheetjs.ts'

const run = (port: NonNullable<typeof parentPort>) =>
  Effect.gen(function* () {
    const post = (message: typeof ExtractionWorkerMessage.Type) =>
      Schema.encodeEffect(ExtractionWorkerMessage)(message).pipe(
        Effect.orDie,
        Effect.map(encoded => port.postMessage(encoded))
      )

    yield* post(new WorkerStarted({}))

    const exit = yield* Effect.exit(
      Schema.decodeUnknownEffect(ExtractionWorkerRequest)(workerData).pipe(
        Effect.orDie,
        Effect.flatMap(request =>
          extractParsedFile(
            { filename: request.filename, mediaType: request.mediaType, bytes: request.bytes },
            request.format,
            request.limits,
            // The worker always loads the installed SheetJS itself, with the version check.
            defaultSheetJsLoader
          )
        )
      )
    )

    if (Exit.isSuccess(exit)) return yield* post(new WorkerSucceeded({ file: exit.value }))

    return yield* post(
      Option.match(Cause.findErrorOption(exit.cause), {
        onSome: failureMessage,
        onNone: () => new WorkerDefect({ message: Cause.pretty(exit.cause) })
      })
    )
  })

if (parentPort !== null) await Effect.runPromise(run(parentPort))
