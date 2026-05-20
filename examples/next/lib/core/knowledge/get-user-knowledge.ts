import { desc, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

export const getUserKnowledge = (input: { readonly userId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    return yield* db
      .select({
        object: schema.knowledgeObject,
        representation: schema.knowledgeRepresentation,
        artifact: schema.knowledgeArtifact
      })
      .from(schema.knowledgeObject)
      .leftJoin(schema.knowledgeRepresentation, eq(schema.knowledgeRepresentation.objectId, schema.knowledgeObject.id))
      .leftJoin(schema.knowledgeArtifact, eq(schema.knowledgeArtifact.id, schema.knowledgeRepresentation.artifactId))
      .where(eq(schema.knowledgeObject.userId, input.userId))
      .orderBy(desc(schema.knowledgeObject.updatedAt))
  }).pipe(Effect.withSpan('knowledge.getUserKnowledge'))
