import { Effect, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { documentPartFromText, inferTextDocumentMimeType } from '@yolk-sdk/agent/protocol'

/** A `Blob`/`File` could not be read as text. */
export class BlobTextReadError extends Schema.TaggedError<BlobTextReadError>()(
  'BlobTextReadError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

const couldNotReadTextError = (cause?: unknown) =>
  new BlobTextReadError({ message: 'Could not read text', cause })

const textFromFileReaderEffect = (blob: Blob) =>
  Effect.callback<string, BlobTextReadError>(resume => {
    if (typeof FileReader === 'undefined') {
      resume(Effect.fail(couldNotReadTextError()))

      return Effect.void
    }

    const reader = new FileReader()

    const removeListeners = () => {
      reader.removeEventListener('load', handleLoad)
      reader.removeEventListener('error', handleError)
      reader.removeEventListener('abort', handleError)
    }

    const fail = (cause?: unknown) => {
      removeListeners()
      resume(Effect.fail(couldNotReadTextError(cause)))
    }

    const handleLoad = () => {
      removeListeners()

      if (Predicate.isString(reader.result)) {
        resume(Effect.succeed(reader.result))

        return
      }

      resume(Effect.fail(couldNotReadTextError()))
    }

    const handleError = () => fail(reader.error ?? undefined)

    reader.addEventListener('load', handleLoad)
    reader.addEventListener('error', handleError)
    reader.addEventListener('abort', handleError)

    const started = Result.try(() => reader.readAsText(blob))

    if (Result.isFailure(started)) {
      fail(started.failure)
    }

    return Effect.sync(removeListeners)
  })

export const textFromBlob = (blob: Blob) => {
  if (Predicate.isFunction(blob.text)) {
    return Effect.tryPromise({
      try: () => blob.text(),
      catch: couldNotReadTextError
    })
  }

  return textFromFileReaderEffect(blob)
}

export const documentPartFromTextFile = (
  file: File,
  options?: {
    readonly title?: string
  }
) =>
  Effect.gen(function* () {
    const mimeType = inferTextDocumentMimeType({
      filename: file.name,
      mimeType: file.type
    })

    if (mimeType === undefined) return undefined

    const text = yield* textFromBlob(file)

    return documentPartFromText({
      text,
      filename: file.name,
      mimeType,
      title: options?.title
    })
  })
