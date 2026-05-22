import { and, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { AppKnowledgeCollectionNotFoundError, AppSearchIndexStoreError, isAppKnowledgeCollectionNotFoundError } from './errors'

const mapDeleteError = (error: unknown) => {
  if (isAppKnowledgeCollectionNotFoundError(error)) {
    return error
  }

  return new AppSearchIndexStoreError({ message: 'Could not delete knowledge collection', cause: error })
}

export const deleteKnowledgeCollection = (input: { readonly userId: string; readonly collectionId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [deleted] = yield* db
      .delete(schema.knowledgeCollection)
      .where(and(eq(schema.knowledgeCollection.id, input.collectionId), eq(schema.knowledgeCollection.userId, input.userId)))
      .returning({ id: schema.knowledgeCollection.id })

    if (deleted === undefined) {
      return yield* Effect.fail(
        new AppKnowledgeCollectionNotFoundError({ message: 'knowledge collection not found', collectionId: input.collectionId })
      )
    }
  }).pipe(Effect.withSpan('knowledge_search.set.delete'), Effect.mapError(mapDeleteError))
