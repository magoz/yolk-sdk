'use server'

import { Effect, Layer } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { R2KnowledgeFileBlobStoreLayer } from '@/lib/services/knowledge/live-layer'
import { reportError } from '@/lib/services/telemetry/report-error'
import { deleteKnowledgeDocument } from './delete-knowledge-document'

const DeleteKnowledgeActionLayer = Layer.mergeAll(AppLayer, R2KnowledgeFileBlobStoreLayer)

export const deleteKnowledgeDocumentAction = async (id: string) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      yield* Effect.annotateCurrentSpan({ 'user.id': session.user.id, 'knowledge.document_id': id })
      yield* deleteKnowledgeDocument({ userId: session.user.id, id })
    }).pipe(
      Effect.withSpan('action.knowledge.delete'),
      Effect.provide(DeleteKnowledgeActionLayer),
      Effect.scoped,
      Effect.tap(() => Effect.sync(() => revalidatePath('/knowledge'))),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('KnowledgeFileError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.tapError(error => reportError(error, { operation: 'action.knowledge.delete' })),
      Effect.catch(() => Effect.succeed({ _tag: 'Error' as const, message: 'Could not delete knowledge document' }))
    )
  )
}
