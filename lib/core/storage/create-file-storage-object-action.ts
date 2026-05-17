'use server'

import { Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { FileExtractor } from '@/lib/services/file-extractor/live-layer'
import { AppRagLayer } from '@/lib/services/rag/live-layer'
import { reportError } from '@/lib/services/telemetry/report-error'
import { createFileStorageObject } from './create-file-storage-object'

const maxFileBytes = 2_000_000

export const createFileStorageObjectAction = async (formData: FormData) => {
  await cookies()

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return { _tag: 'Error' as const, message: 'Choose a file' }
  }

  if (file.size > maxFileBytes) {
    return { _tag: 'Error' as const, message: 'File must be 2MB or smaller' }
  }

  const bytes = new Uint8Array(await file.arrayBuffer())

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      yield* Effect.annotateCurrentSpan({
        'user.id': session.user.id,
        'storage.source_type': 'file',
        'storage.filename': file.name,
        'storage.media_type': file.type,
        'storage.byte_size': file.size
      })
      yield* createFileStorageObject({
        userId: session.user.id,
        filename: file.name,
        mediaType: file.type,
        bytes
      })
    }).pipe(
      Effect.withSpan('action.storage.createFile'),
      Effect.provide(AppRagLayer),
      Effect.provide(FileExtractor.layer),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('UnsupportedFileFormatError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.catchTag('FileExtractionError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.tapError(error => reportError(error, { operation: 'action.storage.createFile' })),
      Effect.tap(() => Effect.sync(() => revalidatePath('/storage'))),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catch(() =>
        Effect.succeed({ _tag: 'Error' as const, message: 'Could not create storage file' })
      )
    )
  )
}
