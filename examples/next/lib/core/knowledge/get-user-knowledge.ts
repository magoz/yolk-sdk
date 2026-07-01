import { desc, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

export const getUserKnowledge = (input: { readonly userId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    return yield* db
      .select({
        document: schema.userKnowledgeDocument,
        file: schema.userKnowledgeFile
      })
      .from(schema.userKnowledgeDocument)
      .leftJoin(schema.userKnowledgeFile, eq(schema.userKnowledgeFile.documentId, schema.userKnowledgeDocument.id))
      .where(eq(schema.userKnowledgeDocument.userId, input.userId))
      .orderBy(desc(schema.userKnowledgeDocument.updatedAt))
  }).pipe(Effect.withSpan('knowledge.getUserKnowledge'))
