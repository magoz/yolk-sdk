'use server'

import { Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { ValidationError } from '@/lib/core/errors'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { FileExtractor } from '@/lib/services/file-extractor/live-layer'
import { R2KnowledgeArtifactStoreLayer } from '@/lib/services/knowledge/live-layer'
import { AppRagLayer } from '@/lib/services/rag/live-layer'
import { reportError } from '@/lib/services/telemetry/report-error'
import { createFileKnowledgeObject } from './create-file-knowledge-object'

const maxFileBytes = 2_000_000

export const createFileKnowledgeObjectAction = async (formData: FormData) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const file = formData.get('file')
      const pinnedValue = formData.get('pinned')
      const pinned = pinnedValue === 'true'
      if (!(file instanceof File)) {
        return yield* Effect.fail(new ValidationError({ field: 'file', message: 'Choose a file' }))
      }

      if (file.size > maxFileBytes) {
        return yield* Effect.fail(new ValidationError({ field: 'file', message: 'File must be 2MB or smaller' }))
      }

      const arrayBuffer = yield* Effect.tryPromise({
        try: () => file.arrayBuffer(),
        catch: () => new ValidationError({ field: 'file', message: 'Could not read file' })
      })
      const bytes = new Uint8Array(arrayBuffer)

      yield* Effect.annotateCurrentSpan({
        'user.id': session.user.id,
        'knowledge.source_type': 'file',
        'knowledge.filename': file.name,
        'knowledge.media_type': file.type,
        'knowledge.byte_size': file.size,
        'knowledge.pinned': pinned
      })
      yield* createFileKnowledgeObject({
        userId: session.user.id,
        filename: file.name,
        mediaType: file.type,
        bytes,
        pinned
      })
    }).pipe(
      Effect.withSpan('action.knowledge.createFile'),
      Effect.provide(AppRagLayer),
      Effect.provide(R2KnowledgeArtifactStoreLayer),
      Effect.provide(FileExtractor.layer),
      Effect.provide(AppLayer),
      Effect.scoped,
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
      Effect.catchTag('KnowledgeArtifactError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.catchTag('RagChunkingError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.catchTag('RagEmbeddingError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.tapError(error => reportError(error, { operation: 'action.knowledge.createFile' })),
      Effect.tap(() => Effect.sync(() => revalidatePath('/knowledge'))),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catch(() =>
        Effect.succeed({ _tag: 'Error' as const, message: 'Could not create knowledge file' })
      )
    )
  )
}
