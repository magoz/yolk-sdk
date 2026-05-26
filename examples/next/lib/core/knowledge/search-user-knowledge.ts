import { and, asc, cosineDistance, desc, eq, gte, lte, ne, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { KnowledgeEmbedder } from '@yolk-sdk/knowledge/embeddings'
import { ValidationError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

export type KnowledgeSearchResult = {
  readonly record: typeof schema.knowledgeRecord.$inferSelect
  readonly representation: typeof schema.knowledgeRepresentation.$inferSelect
  readonly chunk: typeof schema.knowledgeRepresentationChunk.$inferSelect
  readonly score: number
  readonly vectorScore?: number
  readonly textScore?: number
  readonly context: ReadonlyArray<typeof schema.knowledgeRepresentationChunk.$inferSelect>
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
    const distance = cosineDistance(schema.knowledgeRepresentationChunk.embedding, Array.from(embedding))
    const vectorScore = sql<number>`1 - (${distance})`
    const minScoreCondition = input.minScore === undefined ? undefined : lte(distance, 1 - input.minScore)

    const vectorMatches = yield* db
      .select({
        record: schema.knowledgeRecord,
        representation: schema.knowledgeRepresentation,
        chunk: schema.knowledgeRepresentationChunk,
        score: vectorScore
      })
      .from(schema.knowledgeRepresentationChunk)
      .innerJoin(schema.knowledgeRecord, eq(schema.knowledgeRecord.id, schema.knowledgeRepresentationChunk.recordId))
      .innerJoin(schema.knowledgeRepresentation, eq(schema.knowledgeRepresentation.id, schema.knowledgeRepresentationChunk.representationId))
      .where(
        and(
          eq(schema.knowledgeRecord.userId, input.userId),
          ne(schema.knowledgeRecord.contextPolicy, 'archived'),
          eq(schema.knowledgeRecord.status, 'ready'),
          eq(schema.knowledgeRepresentation.status, 'ready'),
          minScoreCondition
        )
      )
      .orderBy(asc(distance))
      .limit(limit)

    const searchVector = sql`to_tsvector('english', ${schema.knowledgeRepresentationChunk.content})`
    const searchQuery = sql`websearch_to_tsquery('english', ${query})`
    const textScore = sql<number>`ts_rank_cd(${searchVector}, ${searchQuery})`
    const textMatches = yield* db
      .select({
        record: schema.knowledgeRecord,
        representation: schema.knowledgeRepresentation,
        chunk: schema.knowledgeRepresentationChunk,
        score: textScore
      })
      .from(schema.knowledgeRepresentationChunk)
      .innerJoin(schema.knowledgeRecord, eq(schema.knowledgeRecord.id, schema.knowledgeRepresentationChunk.recordId))
      .innerJoin(schema.knowledgeRepresentation, eq(schema.knowledgeRepresentation.id, schema.knowledgeRepresentationChunk.representationId))
      .where(
        and(
          eq(schema.knowledgeRecord.userId, input.userId),
          ne(schema.knowledgeRecord.contextPolicy, 'archived'),
          eq(schema.knowledgeRecord.status, 'ready'),
          eq(schema.knowledgeRepresentation.status, 'ready'),
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
        .from(schema.knowledgeRepresentationChunk)
        .where(
          and(
            eq(schema.knowledgeRepresentationChunk.representationId, match.chunk.representationId),
            gte(schema.knowledgeRepresentationChunk.position, Math.max(0, match.chunk.position - contextChunks)),
            lte(schema.knowledgeRepresentationChunk.position, match.chunk.position + contextChunks)
          )
        )
        .orderBy(asc(schema.knowledgeRepresentationChunk.position))
        .pipe(Effect.map(context => ({ ...match, context })))
    )
  }).pipe(Effect.withSpan('knowledge.searchUserKnowledge'))
