'use server'

import { Effect, Layer } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { AppKnowledgeSearchLayer } from '@/lib/services/knowledge-search/live-layer'
import { reportError } from '@/lib/services/telemetry/report-error'
import { createTextKnowledgeRecord } from './create-text-knowledge-record'

const CreateTextKnowledgeActionLayer = Layer.mergeAll(
  AppLayer,
  AppKnowledgeSearchLayer.pipe(Layer.provide(AppLayer))
)

export const createTextKnowledgeRecordAction = async (input: {
  readonly title: string
  readonly content: string
  readonly pinned: boolean
}) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      yield* Effect.annotateCurrentSpan({
        'user.id': session.user.id,
        'knowledge.title': input.title,
        'knowledge.pinned': input.pinned
      })
      yield* createTextKnowledgeRecord({
        userId: session.user.id,
        title: input.title,
        content: input.content,
        pinned: input.pinned
      })
    }).pipe(
      Effect.withSpan('action.knowledge.createText'),
      Effect.provide(CreateTextKnowledgeActionLayer),
      Effect.scoped,
      Effect.tap(() => Effect.sync(() => revalidatePath('/knowledge'))),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('ValidationError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.catchTag('KnowledgeChunkingError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.catchTag('KnowledgeEmbeddingError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.tapError(error => reportError(error, { operation: 'action.knowledge.createText' })),
      Effect.catch(() =>
        Effect.succeed({ _tag: 'Error' as const, message: 'Could not create knowledge record' })
      )
    )
  )
}
