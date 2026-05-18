import { and, asc, eq, gte, lte, ne } from 'drizzle-orm'
import { Effect } from 'effect'
import { NotFoundError, ValidationError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

const defaultBefore = 3
const defaultAfter = 6
const maxContextChunks = 20
const defaultMaxChars = 20_000
const maxMaxChars = 60_000

export type KnowledgeContextWindow = {
  readonly object: typeof schema.knowledgeObject.$inferSelect
  readonly representation: typeof schema.knowledgeRepresentation.$inferSelect
  readonly chunks: ReadonlyArray<typeof schema.knowledgeChunk.$inferSelect>
  readonly anchor: typeof schema.knowledgeChunk.$inferSelect
  readonly startPosition: number
  readonly endPosition: number
  readonly hasBefore: boolean
  readonly hasAfter: boolean
  readonly text: string
  readonly textTruncated: boolean
  readonly textCharacters: number
}

const normalizeId = (value: string, field: string) => {
  const normalized = value.trim()
  if (normalized.length === 0) {
    return Effect.fail(new ValidationError({ field, message: `${field} must not be empty` }))
  }
  return Effect.succeed(normalized)
}

const normalizeInteger = (input: {
  readonly value: number | undefined
  readonly defaultValue: number
  readonly maxValue: number
  readonly minimum: number
  readonly field: string
}) => {
  const value = input.value ?? input.defaultValue
  if (!Number.isInteger(value) || value < input.minimum) {
    return Effect.fail(new ValidationError({ field: input.field, message: `${input.field} must be an integer >= ${input.minimum}` }))
  }
  return Effect.succeed(Math.min(value, input.maxValue))
}

const truncateText = (text: string, maxChars: number) => {
  if (text.length <= maxChars) {
    return { text, textTruncated: false }
  }

  return { text: `${text.slice(0, maxChars)}\n[truncated]`, textTruncated: true }
}

export const getKnowledgeContext = (input: {
  readonly userId: string
  readonly objectId: string
  readonly chunkId?: string
  readonly position?: number
  readonly before?: number
  readonly after?: number
  readonly maxChars?: number
}) =>
  Effect.gen(function* () {
    const objectId = yield* normalizeId(input.objectId, 'objectId')
    const chunkId = input.chunkId === undefined ? undefined : yield* normalizeId(input.chunkId, 'chunkId')
    if (chunkId !== undefined && input.position !== undefined) {
      return yield* Effect.fail(new ValidationError({ field: 'position', message: 'Use chunkId or position, not both' }))
    }

    const before = yield* normalizeInteger({ value: input.before, defaultValue: defaultBefore, maxValue: maxContextChunks, minimum: 0, field: 'before' })
    const after = yield* normalizeInteger({ value: input.after, defaultValue: defaultAfter, maxValue: maxContextChunks, minimum: 0, field: 'after' })
    const maxChars = yield* normalizeInteger({ value: input.maxChars, defaultValue: defaultMaxChars, maxValue: maxMaxChars, minimum: 1, field: 'maxChars' })
    const db = yield* Db

    const [object] = yield* db
      .select()
      .from(schema.knowledgeObject)
      .where(
        and(
          eq(schema.knowledgeObject.id, objectId),
          eq(schema.knowledgeObject.userId, input.userId),
          ne(schema.knowledgeObject.contextPolicy, 'archival'),
          eq(schema.knowledgeObject.status, 'ready')
        )
      )
      .limit(1)

    if (object === undefined) {
      return yield* Effect.fail(new NotFoundError({ entity: 'knowledgeObject', id: objectId, message: 'Knowledge object not found' }))
    }

    const [representation] = yield* db
      .select()
      .from(schema.knowledgeRepresentation)
      .where(
        and(
          eq(schema.knowledgeRepresentation.objectId, object.id),
          eq(schema.knowledgeRepresentation.status, 'ready')
        )
      )
      .orderBy(asc(schema.knowledgeRepresentation.createdAt))
      .limit(1)

    if (representation === undefined) {
      return yield* Effect.fail(new NotFoundError({ entity: 'knowledgeRepresentation', id: object.id, message: 'Knowledge representation not found' }))
    }

    const [anchor] = chunkId === undefined
      ? yield* db
        .select()
        .from(schema.knowledgeChunk)
        .where(
          and(
            eq(schema.knowledgeChunk.representationId, representation.id),
            eq(schema.knowledgeChunk.position, input.position ?? 0)
          )
        )
        .limit(1)
      : yield* db
        .select()
        .from(schema.knowledgeChunk)
        .where(
          and(
            eq(schema.knowledgeChunk.id, chunkId),
            eq(schema.knowledgeChunk.representationId, representation.id)
          )
        )
        .limit(1)

    if (anchor === undefined) {
      return yield* Effect.fail(new NotFoundError({ entity: 'knowledgeChunk', id: chunkId ?? String(input.position ?? 0), message: 'Knowledge chunk not found' }))
    }

    const startPosition = Math.max(0, anchor.position - before)
    const endPosition = anchor.position + after
    const chunks = yield* db
      .select()
      .from(schema.knowledgeChunk)
      .where(
        and(
          eq(schema.knowledgeChunk.representationId, representation.id),
          gte(schema.knowledgeChunk.position, startPosition),
          lte(schema.knowledgeChunk.position, endPosition)
        )
      )
      .orderBy(asc(schema.knowledgeChunk.position))

    const [previousChunk] = yield* db
      .select({ id: schema.knowledgeChunk.id })
      .from(schema.knowledgeChunk)
      .where(
        and(
          eq(schema.knowledgeChunk.representationId, representation.id),
          eq(schema.knowledgeChunk.position, startPosition - 1)
        )
      )
      .limit(1)
    const [nextChunk] = yield* db
      .select({ id: schema.knowledgeChunk.id })
      .from(schema.knowledgeChunk)
      .where(
        and(
          eq(schema.knowledgeChunk.representationId, representation.id),
          eq(schema.knowledgeChunk.position, endPosition + 1)
        )
      )
      .limit(1)

    const fullText = chunks.map(chunk => chunk.content).join('\n\n')
    const truncated = truncateText(fullText, maxChars)

    return {
      object,
      representation,
      chunks,
      anchor,
      startPosition,
      endPosition,
      hasBefore: previousChunk !== undefined,
      hasAfter: nextChunk !== undefined,
      text: truncated.text,
      textTruncated: truncated.textTruncated,
      textCharacters: fullText.length
    }
  }).pipe(Effect.withSpan('knowledge.getKnowledgeContext'))
