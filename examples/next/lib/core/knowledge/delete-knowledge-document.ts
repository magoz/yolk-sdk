import { and, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { KnowledgeFileBlobStore } from '@yolk-sdk/knowledge/files'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

export const deleteKnowledgeDocument = (input: { readonly userId: string; readonly id: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const files = yield* db
      .select({ storageKey: schema.userKnowledgeFile.storageKey })
      .from(schema.userKnowledgeFile)
      .innerJoin(schema.userKnowledgeDocument, eq(schema.userKnowledgeDocument.id, schema.userKnowledgeFile.documentId))
      .where(
        and(
          eq(schema.userKnowledgeDocument.id, input.id),
          eq(schema.userKnowledgeDocument.userId, input.userId)
        )
      )

    if (files.length > 0) {
      const fileStore = yield* KnowledgeFileBlobStore
      yield* Effect.forEach(files, file => fileStore.deleteFile({ storageKey: file.storageKey }), {
        concurrency: 4
      })
    }

    yield* db
      .delete(schema.userKnowledgeDocument)
      .where(
        and(
          eq(schema.userKnowledgeDocument.id, input.id),
          eq(schema.userKnowledgeDocument.userId, input.userId)
        )
      )
  }).pipe(Effect.withSpan('knowledge.deleteKnowledgeDocument'))
