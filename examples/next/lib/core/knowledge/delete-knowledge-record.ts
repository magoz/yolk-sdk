import { and, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { KnowledgeArtifactStore } from '@yolk-sdk/knowledge/artifacts'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

export const deleteKnowledgeRecord = (input: { readonly userId: string; readonly id: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const artifacts = yield* db
      .select({ storageKey: schema.knowledgeArtifact.storageKey })
      .from(schema.knowledgeArtifact)
      .innerJoin(schema.knowledgeRecord, eq(schema.knowledgeRecord.id, schema.knowledgeArtifact.recordId))
      .where(
        and(
          eq(schema.knowledgeRecord.id, input.id),
          eq(schema.knowledgeRecord.userId, input.userId)
        )
      )

    if (artifacts.length > 0) {
      const artifactStore = yield* KnowledgeArtifactStore
      yield* Effect.forEach(artifacts, artifact => artifactStore.deleteArtifact({ storageKey: artifact.storageKey }), {
        concurrency: 4
      })
    }

    yield* db
      .delete(schema.knowledgeRecord)
      .where(
        and(
          eq(schema.knowledgeRecord.id, input.id),
          eq(schema.knowledgeRecord.userId, input.userId)
        )
      )
  }).pipe(Effect.withSpan('knowledge.deleteKnowledgeRecord'))
