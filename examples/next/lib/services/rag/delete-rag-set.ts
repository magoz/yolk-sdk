import { and, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { AppRagSetNotFoundError, AppRagStoreError, isAppRagSetNotFoundError } from './errors'

const mapDeleteError = (error: unknown) => {
  if (isAppRagSetNotFoundError(error)) {
    return error
  }

  return new AppRagStoreError({ message: 'Could not delete RAG set', cause: error })
}

export const deleteRagSet = (input: { readonly userId: string; readonly ragSetId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [deleted] = yield* db
      .delete(schema.ragSet)
      .where(and(eq(schema.ragSet.id, input.ragSetId), eq(schema.ragSet.userId, input.userId)))
      .returning({ id: schema.ragSet.id })

    if (deleted === undefined) {
      return yield* Effect.fail(
        new AppRagSetNotFoundError({ message: 'RAG set not found', ragSetId: input.ragSetId })
      )
    }
  }).pipe(Effect.withSpan('rag.set.delete'), Effect.mapError(mapDeleteError))
