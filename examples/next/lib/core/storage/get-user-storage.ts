import { desc, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

export const getUserStorage = (input: { readonly userId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    return yield* db
      .select({ object: schema.storageObject, document: schema.knowledgeDocument })
      .from(schema.storageObject)
      .leftJoin(
        schema.knowledgeDocument,
        eq(schema.knowledgeDocument.storageObjectId, schema.storageObject.id)
      )
      .where(eq(schema.storageObject.userId, input.userId))
      .orderBy(desc(schema.storageObject.createdAt))
  }).pipe(Effect.withSpan('storage.getUserStorage'))
