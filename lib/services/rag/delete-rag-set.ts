import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { AppRagSetNotFoundError, AppRagStoreError } from './errors'

const mapDeleteError = (error: unknown) => {
  if (error instanceof AppRagSetNotFoundError) {
    return error
  }

  return new AppRagStoreError({ message: 'Could not delete RAG set', cause: error })
}

export const deleteRagSet = (ragSetId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [deleted] = yield* db
      .delete(schema.ragSet)
      .where(eq(schema.ragSet.id, ragSetId))
      .returning({ id: schema.ragSet.id })

    if (deleted === undefined) {
      return yield* Effect.fail(
        new AppRagSetNotFoundError({ message: 'RAG set not found', ragSetId })
      )
    }
  }).pipe(Effect.withSpan('rag.set.delete'), Effect.mapError(mapDeleteError))
