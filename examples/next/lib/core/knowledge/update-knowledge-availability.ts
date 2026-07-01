import { and, eq, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { NotFoundError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import type { KnowledgeAvailability } from './availability'

export const updateKnowledgeAvailability = (input: {
  readonly userId: string
  readonly id: string
  readonly availability: KnowledgeAvailability
}) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [document] = yield* db
      .update(schema.userKnowledgeDocument)
      .set({
        availability: input.availability,
        updatedAt: sql`CURRENT_TIMESTAMP`
      })
      .where(
        and(
          eq(schema.userKnowledgeDocument.id, input.id),
          eq(schema.userKnowledgeDocument.userId, input.userId)
        )
      )
      .returning()

    if (document === undefined) {
      return yield* Effect.fail(new NotFoundError({ message: 'Knowledge document not found', entity: 'userKnowledgeDocument', id: input.id }))
    }

    return document
  }).pipe(Effect.withSpan('knowledge.updateKnowledgeAvailability'))
