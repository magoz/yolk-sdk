import { and, eq, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { NotFoundError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

export const updateKnowledgeContextPolicy = (input: {
  readonly userId: string
  readonly id: string
  readonly contextPolicy: 'pinned' | 'routable' | 'searchable' | 'archived'
}) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [object] = yield* db
      .update(schema.knowledgeRecord)
      .set({ contextPolicy: input.contextPolicy, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        and(
          eq(schema.knowledgeRecord.id, input.id),
          eq(schema.knowledgeRecord.userId, input.userId)
        )
      )
      .returning()

    if (object === undefined) {
      return yield* Effect.fail(new NotFoundError({ message: 'Knowledge record not found', entity: 'knowledgeRecord', id: input.id }))
    }

    return object
  }).pipe(Effect.withSpan('knowledge.updateKnowledgeContextPolicy'))
