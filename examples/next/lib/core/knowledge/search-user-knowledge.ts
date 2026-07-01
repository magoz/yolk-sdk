import { and, asc, cosineDistance, desc, eq, gte, lte, ne, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { KnowledgeEmbedder } from '@yolk-sdk/knowledge/embeddings'
import { ValidationError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

export type KnowledgeSearchResult = {
  readonly document: typeof schema.userKnowledgeDocument.$inferSelect
  readonly chunk: typeof schema.userKnowledgeChunk.$inferSelect
  readonly score: number
  readonly vectorScore?: number
  readonly textScore?: number
  readonly context: ReadonlyArray<typeof schema.userKnowledgeChunk.$inferSelect>
}

type Match = Omit<KnowledgeSearchResult, 'context'>

const defaultLimit = 8
const maxLimit = 20
const maxContextChunks = 5

const normalizePositiveInteger = (input: {
  readonly value: number | undefined
  readonly defaultValue: number
  readonly maxValue: number
  readonly field: string
}) => {
  const value = input.value ?? input.defaultValue
  if (!Number.isInteger(value) || value < 1) {
    return Effect.fail(new ValidationError({ field: input.field, message: `${input.field} must be a positive integer` }))
  }
  return Effect.succeed(Math.min(value, input.maxValue))
}

const normalizeContextChunks = (value: number | undefined) => {
  const normalized = value ?? 1
  if (!Number.isInteger(normalized) || normalized < 0) {
    return Effect.fail(new ValidationError({ field: 'contextChunks', message: 'contextChunks must be an integer >= 0' }))
  }
  return Effect.succeed(Math.min(normalized, maxContextChunks))
}

const dedupeMatches = (matches: ReadonlyArray<Match>) =>
  matches.filter((match, index, all) => all.findIndex(item => item.chunk.id === match.chunk.id) === index)

const sortMatches = (matches: ReadonlyArray<Match>, limit: number) =>
  [...matches].sort((left, right) => right.score - left.score).slice(0, limit)

export const searchUserKnowledge = (input: {
  readonly userId: string
  readonly query: string
  readonly limit?: number
  readonly minScore?: number
  readonly contextChunks?: number
}) =>
  Effect.gen(function* () {
    const query = input.query.trim()
    if (query.length === 0) {
      return yield* Effect.fail(new ValidationError({ field: 'query', message: 'Knowledge query is empty' }))
    }

    const limit = yield* normalizePositiveInteger({
      value: input.limit,
      defaultValue: defaultLimit,
      maxValue: maxLimit,
      field: 'limit'
    })
    const contextChunks = yield* normalizeContextChunks(input.contextChunks)
    const db = yield* Db
    const embedder = yield* KnowledgeEmbedder
    const embedding = yield* embedder.embedQuery(query)
    const distance = cosineDistance(schema.userKnowledgeChunk.embedding, Array.from(embedding))
    const vectorScore = sql<number>`1 - (${distance})`
    const minScoreCondition = input.minScore === undefined ? undefined : lte(distance, 1 - input.minScore)

    const vectorMatches = yield* db
      .select({
        document: schema.userKnowledgeDocument,
        chunk: schema.userKnowledgeChunk,
        score: vectorScore
      })
      .from(schema.userKnowledgeChunk)
      .innerJoin(schema.userKnowledgeDocument, eq(schema.userKnowledgeDocument.id, schema.userKnowledgeChunk.documentId))
      .where(
        and(
          eq(schema.userKnowledgeDocument.userId, input.userId),
          ne(schema.userKnowledgeDocument.availability, 'archived'),
          eq(schema.userKnowledgeDocument.status, 'ready'),
          minScoreCondition
        )
      )
      .orderBy(asc(distance))
      .limit(limit)

    const searchVector = sql`to_tsvector('english', ${schema.userKnowledgeChunk.content})`
    const searchQuery = sql`websearch_to_tsquery('english', ${query})`
    const textScore = sql<number>`ts_rank_cd(${searchVector}, ${searchQuery})`
    const textMatches = yield* db
      .select({
        document: schema.userKnowledgeDocument,
        chunk: schema.userKnowledgeChunk,
        score: textScore
      })
      .from(schema.userKnowledgeChunk)
      .innerJoin(schema.userKnowledgeDocument, eq(schema.userKnowledgeDocument.id, schema.userKnowledgeChunk.documentId))
      .where(
        and(
          eq(schema.userKnowledgeDocument.userId, input.userId),
          ne(schema.userKnowledgeDocument.availability, 'archived'),
          eq(schema.userKnowledgeDocument.status, 'ready'),
          sql`${searchVector} @@ ${searchQuery}`
        )
      )
      .orderBy(desc(textScore))
      .limit(limit)

    const matches = sortMatches(
      dedupeMatches([
        ...vectorMatches.map((match): Match => ({ ...match, vectorScore: match.score })),
        ...textMatches.map((match): Match => ({ ...match, textScore: match.score }))
      ]),
      limit
    )

    return yield* Effect.forEach(matches, match =>
      db
        .select()
        .from(schema.userKnowledgeChunk)
        .where(
          and(
            eq(schema.userKnowledgeChunk.documentId, match.chunk.documentId),
            gte(schema.userKnowledgeChunk.position, Math.max(0, match.chunk.position - contextChunks)),
            lte(schema.userKnowledgeChunk.position, match.chunk.position + contextChunks)
          )
        )
        .orderBy(asc(schema.userKnowledgeChunk.position))
        .pipe(Effect.map(context => ({ ...match, context })))
    )
  }).pipe(Effect.withSpan('knowledge.searchUserKnowledge'))
