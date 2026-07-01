'use server'

import { createId } from '@paralleldrive/cuid2'
import { Effect, Layer } from 'effect'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { ValidationError } from '@/lib/core/errors'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { R2KnowledgeUploadStore, R2KnowledgeUploadStoreLayer } from '@/lib/services/knowledge/live-layer'
import { reportError } from '@/lib/services/telemetry/report-error'

const maxFileBytes = 2_000_000

const CreateFileKnowledgeUploadUrlActionLayer = Layer.mergeAll(AppLayer, R2KnowledgeUploadStoreLayer)

const safeFilename = (filename: string) => filename.trim().replaceAll('/', '_').replaceAll('\\', '_')

export const createFileKnowledgeUploadUrlAction = async (input: {
  readonly filename: string
  readonly mediaType: string
  readonly byteSize: number
}) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const uploadStore = yield* R2KnowledgeUploadStore
      const filename = safeFilename(input.filename)

      if (filename.length === 0) {
        return yield* Effect.fail(new ValidationError({ field: 'filename', message: 'Choose a file' }))
      }

      if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0 || input.byteSize > maxFileBytes) {
        return yield* Effect.fail(new ValidationError({ field: 'file', message: 'File must be 2MB or smaller' }))
      }

      const storageKey = `uploads/knowledge/${session.user.id}/${createId()}/${filename}`

      yield* Effect.annotateCurrentSpan({
        'user.id': session.user.id,
        'knowledge.filename': filename,
        'knowledge.media_type': input.mediaType,
        'knowledge.byte_size': input.byteSize
      })

      const upload = yield* uploadStore.createUploadUrl({
        storageKey,
        mediaType: input.mediaType.length > 0 ? input.mediaType : undefined
      })

      return { _tag: 'Success' as const, upload }
    }).pipe(
      Effect.withSpan('action.knowledge.createFileUploadUrl'),
      Effect.provide(CreateFileKnowledgeUploadUrlActionLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('ValidationError', error => Effect.succeed({ _tag: 'Error' as const, message: error.message })),
      Effect.catchTag('KnowledgeFileError', error => Effect.succeed({ _tag: 'Error' as const, message: error.message })),
      Effect.tapError(error => reportError(error, { operation: 'action.knowledge.createFileUploadUrl' })),
      Effect.catch(() => Effect.succeed({ _tag: 'Error' as const, message: 'Could not create upload URL' }))
    )
  )
}
