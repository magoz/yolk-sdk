import { and, desc, eq, ilike } from 'drizzle-orm'
import { Effect } from 'effect'
import { ValidationError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

const defaultLimit = 20
const maxLimit = 50

export type KnowledgeRecordSummary = {
  readonly id: string
  readonly title: string
  readonly role: typeof schema.knowledgeRecord.$inferSelect.role
  readonly status: typeof schema.knowledgeRecord.$inferSelect.status
  readonly contextPolicy: typeof schema.knowledgeRecord.$inferSelect.contextPolicy
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

export const listUserKnowledgeRecords = (input: {
  readonly userId: string
  readonly query?: string
  readonly policy?: typeof schema.knowledgeRecord.$inferSelect.contextPolicy
  readonly limit?: number
}) =>
  Effect.gen(function* () {
    const limit = yield* normalizeLimit(input.limit)
    const query = input.query?.trim()
    const db = yield* Db
    const records = yield* db
      .select()
      .from(schema.knowledgeRecord)
      .where(
        and(
          eq(schema.knowledgeRecord.userId, input.userId),
          input.policy === undefined ? undefined : eq(schema.knowledgeRecord.contextPolicy, input.policy),
          query === undefined || query.length === 0 ? undefined : ilike(schema.knowledgeRecord.title, `%${query}%`)
        )
      )
      .orderBy(desc(schema.knowledgeRecord.updatedAt))
      .limit(limit)

    return yield* Effect.forEach(records, record =>
      Effect.gen(function* () {
        const representations = yield* db
          .select({ id: schema.knowledgeRepresentation.id })
          .from(schema.knowledgeRepresentation)
          .where(eq(schema.knowledgeRepresentation.recordId, record.id))
        const artifacts = yield* db
          .select()
          .from(schema.knowledgeArtifact)
          .where(eq(schema.knowledgeArtifact.recordId, record.id))
        const chunks = yield* db
          .select({ id: schema.knowledgeRepresentationChunk.id })
          .from(schema.knowledgeRepresentationChunk)
          .where(eq(schema.knowledgeRepresentationChunk.recordId, record.id))

        return {
          id: record.id,
          title: record.title,
          role: record.role,
          status: record.status,
          contextPolicy: record.contextPolicy,
          summary: record.summary ?? undefined,
          representationCount: representations.length,
          artifactCount: artifacts.length,
          chunkCount: chunks.length,
          artifacts: artifacts.map(artifact => ({
            id: artifact.id,
            kind: artifact.kind,
            mediaType: artifact.mediaType ?? undefined,
            byteSize: artifact.byteSize ?? undefined
          })),
          createdAt: record.createdAt,
          updatedAt: record.updatedAt
        }
      })
    )
  }).pipe(Effect.withSpan('knowledge.listUserKnowledgeRecords'))
