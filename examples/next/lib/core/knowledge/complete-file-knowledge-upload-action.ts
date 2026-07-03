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
import { createUploadedFileKnowledgeDocument } from './create-uploaded-file-knowledge-document'

const maxFileBytes = 2_000_000

const CompleteFileKnowledgeUploadActionLayer = Layer.mergeAll(
  AppLayer,
  AppKnowledgeSearchLayer.pipe(Layer.provide(AppLayer)),
  R2KnowledgeFileBlobStoreLayer,
  FileExtractor.layer
)

export const completeFileKnowledgeUploadAction = async (input: {
  readonly storageKey: string
  readonly filename: string
  readonly mediaType: string
  readonly byteSize: number
  readonly pinned: boolean
}) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const fileStore = yield* KnowledgeFileBlobStore
      const allowedPrefix = `uploads/knowledge/${session.user.id}/`

      if (!input.storageKey.startsWith(allowedPrefix)) {
        return yield* Effect.fail(
          new ValidationError({ field: 'storageKey', message: 'Invalid upload' })
        )
      }

      if (
        !Number.isSafeInteger(input.byteSize) ||
        input.byteSize <= 0 ||
        input.byteSize > maxFileBytes
      ) {
        return yield* Effect.fail(
          new ValidationError({ field: 'file', message: 'File must be 2MB or smaller' })
        )
      }

      const bytes = yield* fileStore.getFile({ storageKey: input.storageKey })

      if (bytes.byteLength !== input.byteSize) {
        return yield* Effect.fail(
          new ValidationError({ field: 'file', message: 'Uploaded file size mismatch' })
        )
      }

      yield* Effect.annotateCurrentSpan({
        'user.id': session.user.id,
        'knowledge.source_type': 'file',
        'knowledge.filename': input.filename,
        'knowledge.media_type': input.mediaType,
        'knowledge.byte_size': input.byteSize,
        'knowledge.pinned': input.pinned
      })

      yield* createUploadedFileKnowledgeDocument({
        userId: session.user.id,
        filename: input.filename,
        mediaType: input.mediaType,
        storageKey: input.storageKey,
        bytes,
        pinned: input.pinned
      })
    }).pipe(
      Effect.withSpan('action.knowledge.completeFileUpload'),
      Effect.provide(CompleteFileKnowledgeUploadActionLayer),
      Effect.scoped,
      Effect.tap(() => Effect.sync(() => revalidatePath('/knowledge'))),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('ValidationError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.catchTag('UnsupportedFileFormatError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.catchTag('FileExtractionError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.catchTag('KnowledgeFileError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.catchTag('KnowledgeChunkingError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.catchTag('KnowledgeEmbeddingError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.tapError(error =>
        reportError(error, { operation: 'action.knowledge.completeFileUpload' })
      ),
      Effect.catch(() =>
        Effect.succeed({ _tag: 'Error' as const, message: 'Could not save uploaded file' })
      )
    )
  )
}
