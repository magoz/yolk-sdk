import { Effect, Result } from 'effect'
import { documentPartFromText, inferTextDocumentMimeType } from '@yolk-sdk/agent/protocol'

const couldNotReadTextError = () => new Error('Could not read text')

const textFromFileReaderEffect = (blob: Blob) =>
  Effect.callback<string, Error>(resume => {
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
    const fail = () => {
      removeListeners()
      resume(Effect.fail(couldNotReadTextError()))
    }
    const handleLoad = () => {
      removeListeners()

      if (typeof reader.result === 'string') {
        resume(Effect.succeed(reader.result))
        return
      }

      resume(Effect.fail(couldNotReadTextError()))
    }
    const handleError = () => fail()

    reader.addEventListener('load', handleLoad)
    reader.addEventListener('error', handleError)
    reader.addEventListener('abort', handleError)

    if (Result.isFailure(Result.try(() => reader.readAsText(blob)))) {
      fail()
    }

    return Effect.sync(removeListeners)
  })

export const textFromBlobEffect = (blob: Blob) => {
  if (typeof blob.text === 'function') {
    return Effect.tryPromise({
      try: () => blob.text(),
      catch: couldNotReadTextError
    })
  }

  return textFromFileReaderEffect(blob)
}

export const textFromBlob = (blob: Blob) => Effect.runPromise(textFromBlobEffect(blob))

export const documentPartFromTextFileEffect = (
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

    const text = yield* textFromBlobEffect(file)

    return documentPartFromText({
      text,
      filename: file.name,
      mimeType,
      title: options?.title
    })
  })

export const documentPartFromTextFile = (
  file: File,
  options?: {
    readonly title?: string
  }
) => Effect.runPromise(documentPartFromTextFileEffect(file, options))
