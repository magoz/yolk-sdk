import { and, desc, eq, ilike } from 'drizzle-orm'
import { Effect } from 'effect'
import { ValidationError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import type { KnowledgeAvailability } from './availability'

const defaultLimit = 20
const maxLimit = 50

export type KnowledgeDocumentSummary = {
  readonly id: string
  readonly slug: string
  readonly title: string
  readonly purpose: string
  readonly origin: string
  readonly status: typeof schema.userKnowledgeDocument.$inferSelect.status
  readonly availability: KnowledgeAvailability
  readonly summary?: string
  readonly fileCount: number
  readonly chunkCount: number
  readonly files: ReadonlyArray<{
    readonly id: string
    readonly mediaType?: string
    readonly byteSize?: number
  }>
  readonly createdAt: Date
  readonly updatedAt: Date
}

const normalizeLimit = (value: number | undefined) => {
  const limit = value ?? defaultLimit
  if (!Number.isInteger(limit) || limit < 1) {
    return Effect.fail(
      new ValidationError({ field: 'limit', message: 'limit must be a positive integer' })
    )
  }
  return Effect.succeed(Math.min(limit, maxLimit))
}

export const listUserKnowledgeDocuments = (input: {
  readonly userId: string
  readonly query?: string
  readonly availability?: KnowledgeAvailability
  readonly limit?: number
}) =>
  Effect.gen(function* () {
    const limit = yield* normalizeLimit(input.limit)
    const query = input.query?.trim()
    const db = yield* Db
    const documents = yield* db
      .select()
      .from(schema.userKnowledgeDocument)
      .where(
        and(
          eq(schema.userKnowledgeDocument.userId, input.userId),
          input.availability === undefined
            ? undefined
            : eq(schema.userKnowledgeDocument.availability, input.availability),
          query === undefined || query.length === 0
            ? undefined
            : ilike(schema.userKnowledgeDocument.title, `%${query}%`)
        )
      )
      .orderBy(desc(schema.userKnowledgeDocument.updatedAt))
      .limit(limit)

    return yield* Effect.forEach(documents, document =>
      Effect.gen(function* () {
        const files = yield* db
          .select()
          .from(schema.userKnowledgeFile)
          .where(eq(schema.userKnowledgeFile.documentId, document.id))
        const chunks = yield* db
          .select({ id: schema.userKnowledgeChunk.id })
          .from(schema.userKnowledgeChunk)
          .where(eq(schema.userKnowledgeChunk.documentId, document.id))

        return {
          id: document.id,
          slug: document.slug,
          title: document.title,
          purpose: document.purpose,
          origin: document.origin,
          status: document.status,
          availability: document.availability,
          summary: document.summary ?? undefined,
          fileCount: files.length,
          chunkCount: chunks.length,
          files: files.map(file => ({
            id: file.id,
            mediaType: file.mediaType ?? undefined,
            byteSize: file.byteSize ?? undefined
          })),
          createdAt: document.createdAt,
          updatedAt: document.updatedAt
        }
      })
    )
  }).pipe(Effect.withSpan('knowledge.listUserKnowledgeDocuments'))
