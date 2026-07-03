import { and, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { NotFoundError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

export const deleteStorageObject = (input: { readonly id: string; readonly userId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [deleted] = yield* db
      .delete(schema.storageObject)
      .where(
        and(eq(schema.storageObject.id, input.id), eq(schema.storageObject.userId, input.userId))
      )
      .returning({ id: schema.storageObject.id })

    if (deleted === undefined) {
      return yield* Effect.fail(
        new NotFoundError({
          message: 'Storage source not found',
          entity: 'storageObject',
          id: input.id
        })
      )
    }

    return deleted
  }).pipe(Effect.withSpan('storage.deleteStorageObject'))
