'use server'

import { Effect, Layer } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { KnowledgeFileBlobStore } from '@yolk-sdk/knowledge/files'
import { AppLayer } from '@/lib/layers'
import { ValidationError } from '@/lib/core/errors'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { FileExtractor } from '@/lib/services/file-extractor/live-layer'
import { R2KnowledgeFileBlobStoreLayer } from '@/lib/services/knowledge/live-layer'
import { AppKnowledgeSearchLayer } from '@/lib/services/knowledge-search/live-layer'
import { reportError } from '@/lib/services/telemetry/report-error'
import { createFileStorageObject } from './create-file-storage-object'

const maxFileBytes = 2_000_000

const CompleteFileStorageUploadActionLayer = Layer.mergeAll(
  AppLayer,
  AppKnowledgeSearchLayer.pipe(Layer.provide(AppLayer)),
  R2KnowledgeFileBlobStoreLayer,
  FileExtractor.layer
)

export const completeFileStorageUploadAction = async (input: {
  readonly storageKey: string
  readonly filename: string
  readonly mediaType: string
  readonly byteSize: number
}) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const fileStore = yield* KnowledgeFileBlobStore
      const allowedPrefix = `uploads/storage/${session.user.id}/`

      if (!input.storageKey.startsWith(allowedPrefix)) {
        return yield* Effect.fail(new ValidationError({ field: 'storageKey', message: 'Invalid upload' }))
      }

      if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0 || input.byteSize > maxFileBytes) {
        return yield* Effect.fail(new ValidationError({ field: 'file', message: 'File must be 2MB or smaller' }))
      }

      const bytes = yield* fileStore.getFile({ storageKey: input.storageKey })

      if (bytes.byteLength !== input.byteSize) {
        return yield* Effect.fail(new ValidationError({ field: 'file', message: 'Uploaded file size mismatch' }))
      }

      yield* createFileStorageObject({
        userId: session.user.id,
        filename: input.filename,
        mediaType: input.mediaType,
        bytes
      }).pipe(Effect.ensuring(fileStore.deleteFile({ storageKey: input.storageKey }).pipe(Effect.ignore)))
    }).pipe(
      Effect.withSpan('action.storage.completeFileUpload'),
      Effect.provide(CompleteFileStorageUploadActionLayer),
      Effect.scoped,
      Effect.tap(() => Effect.sync(() => revalidatePath('/storage'))),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('ValidationError', error => Effect.succeed({ _tag: 'Error' as const, message: error.message })),
      Effect.catchTag('UnsupportedFileFormatError', error => Effect.succeed({ _tag: 'Error' as const, message: error.message })),
      Effect.catchTag('FileExtractionError', error => Effect.succeed({ _tag: 'Error' as const, message: error.message })),
      Effect.catchTag('KnowledgeFileError', error => Effect.succeed({ _tag: 'Error' as const, message: error.message })),
      Effect.tapError(error => reportError(error, { operation: 'action.storage.completeFileUpload' })),
      Effect.catch(() => Effect.succeed({ _tag: 'Error' as const, message: 'Could not index uploaded file' }))
    )
  )
}
