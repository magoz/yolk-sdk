import { and, desc, eq, ilike } from 'drizzle-orm'
import { Effect } from 'effect'
import { ValidationError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

const defaultLimit = 20
const maxLimit = 50

export type KnowledgeObjectSummary = {
  readonly id: string
  readonly title: string
  readonly role: typeof schema.knowledgeObject.$inferSelect.role
  readonly status: typeof schema.knowledgeObject.$inferSelect.status
  readonly contextPolicy: typeof schema.knowledgeObject.$inferSelect.contextPolicy
  readonly summary?: string
  readonly representationCount: number
  readonly artifactCount: number
  readonly chunkCount: number
  readonly artifacts: ReadonlyArray<{
    readonly id: string
    readonly kind: typeof schema.knowledgeArtifact.$inferSelect.kind
    readonly mediaType?: string
    readonly byteSize?: number
  }>
  readonly createdAt: Date
  readonly updatedAt: Date
}

const normalizeLimit = (value: number | undefined) => {
  const limit = value ?? defaultLimit
  if (!Number.isInteger(limit) || limit < 1) {
    return Effect.fail(new ValidationError({ field: 'limit', message: 'limit must be a positive integer' }))
  }
  return Effect.succeed(Math.min(limit, maxLimit))
}

export const listUserKnowledgeObjects = (input: {
  readonly userId: string
  readonly query?: string
  readonly policy?: typeof schema.knowledgeObject.$inferSelect.contextPolicy
  readonly limit?: number
}) =>
  Effect.gen(function* () {
    const limit = yield* normalizeLimit(input.limit)
    const query = input.query?.trim()
    const db = yield* Db
    const objects = yield* db
      .select()
      .from(schema.knowledgeObject)
      .where(
        and(
          eq(schema.knowledgeObject.userId, input.userId),
          input.policy === undefined ? undefined : eq(schema.knowledgeObject.contextPolicy, input.policy),
          query === undefined || query.length === 0 ? undefined : ilike(schema.knowledgeObject.title, `%${query}%`)
        )
      )
      .orderBy(desc(schema.knowledgeObject.updatedAt))
      .limit(limit)

    return yield* Effect.forEach(objects, object =>
      Effect.gen(function* () {
        const representations = yield* db
          .select({ id: schema.knowledgeRepresentation.id })
          .from(schema.knowledgeRepresentation)
          .where(eq(schema.knowledgeRepresentation.objectId, object.id))
        const artifacts = yield* db
          .select()
          .from(schema.knowledgeArtifact)
          .where(eq(schema.knowledgeArtifact.objectId, object.id))
        const chunks = yield* db
          .select({ id: schema.knowledgeChunk.id })
          .from(schema.knowledgeChunk)
          .where(eq(schema.knowledgeChunk.objectId, object.id))

        return {
          id: object.id,
          title: object.title,
          role: object.role,
          status: object.status,
          contextPolicy: object.contextPolicy,
          summary: object.summary ?? undefined,
          representationCount: representations.length,
          artifactCount: artifacts.length,
          chunkCount: chunks.length,
          artifacts: artifacts.map(artifact => ({
            id: artifact.id,
            kind: artifact.kind,
            mediaType: artifact.mediaType ?? undefined,
            byteSize: artifact.byteSize ?? undefined
          })),
          createdAt: object.createdAt,
          updatedAt: object.updatedAt
        }
      })
    )
  }).pipe(Effect.withSpan('knowledge.listUserKnowledgeObjects'))
