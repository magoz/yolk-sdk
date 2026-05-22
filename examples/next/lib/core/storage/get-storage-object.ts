import { and, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { NotFoundError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

export const getStorageObject = (input: {
  readonly id: string
  readonly userId: string
}) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [row] = yield* db
      .select({ object: schema.storageObject, document: schema.knowledgeDocument })
      .from(schema.storageObject)
      .leftJoin(schema.knowledgeDocument, eq(schema.knowledgeDocument.storageObjectId, schema.storageObject.id))
      .where(and(eq(schema.storageObject.id, input.id), eq(schema.storageObject.userId, input.userId)))

    if (row === undefined) {
      return yield* Effect.fail(
        new NotFoundError({ message: 'Storage source not found', entity: 'storageObject', id: input.id })
      )
    }

    return row
  }).pipe(Effect.withSpan('storage.getStorageObject'))
