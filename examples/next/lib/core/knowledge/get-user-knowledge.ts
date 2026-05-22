import { desc, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

export const getUserKnowledge = (input: { readonly userId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    return yield* db
      .select({
        object: schema.knowledgeRecord,
        representation: schema.knowledgeRepresentation,
        artifact: schema.knowledgeArtifact
      })
      .from(schema.knowledgeRecord)
      .leftJoin(schema.knowledgeRepresentation, eq(schema.knowledgeRepresentation.recordId, schema.knowledgeRecord.id))
      .leftJoin(schema.knowledgeArtifact, eq(schema.knowledgeArtifact.id, schema.knowledgeRepresentation.artifactId))
      .where(eq(schema.knowledgeRecord.userId, input.userId))
      .orderBy(desc(schema.knowledgeRecord.updatedAt))
  }).pipe(Effect.withSpan('knowledge.getUserKnowledge'))
