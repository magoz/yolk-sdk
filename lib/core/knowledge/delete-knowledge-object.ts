import { and, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { KnowledgeArtifactStore } from '@yolk/knowledge/artifacts'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

export const deleteKnowledgeObject = (input: { readonly userId: string; readonly id: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const artifacts = yield* db
      .select({ storageKey: schema.knowledgeArtifact.storageKey })
      .from(schema.knowledgeArtifact)
      .innerJoin(schema.knowledgeObject, eq(schema.knowledgeObject.id, schema.knowledgeArtifact.objectId))
      .where(
        and(
          eq(schema.knowledgeObject.id, input.id),
          eq(schema.knowledgeObject.userId, input.userId)
        )
      )

    if (artifacts.length > 0) {
      const artifactStore = yield* KnowledgeArtifactStore
      yield* Effect.forEach(artifacts, artifact => artifactStore.deleteArtifact({ storageKey: artifact.storageKey }), {
        concurrency: 4
      })
    }

    yield* db
      .delete(schema.knowledgeObject)
      .where(
        and(
          eq(schema.knowledgeObject.id, input.id),
          eq(schema.knowledgeObject.userId, input.userId)
        )
      )
  }).pipe(Effect.withSpan('knowledge.deleteKnowledgeObject'))
