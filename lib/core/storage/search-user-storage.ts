import { Effect } from 'effect'
import { retrieveRag, type RagSearchResult } from '@yolk/rag/retrieval'
import { ValidationError } from '@/lib/core/errors'
import { ensureUserRagSet } from './ensure-user-rag-set'

const defaultLimit = 6
const maxLimit = 12
const defaultContextChunks = 1
const maxContextChunks = 3

export type UserStorageSearchResult = {
  readonly citation: number
  readonly source: string
  readonly documentId: string
  readonly chunkId: string
  readonly score: number
  readonly vectorScore?: number
  readonly textScore?: number
  readonly fusedScore?: number
  readonly text: string
}

export type UserStorageSearchOutput = {
  readonly query: string
  readonly results: ReadonlyArray<UserStorageSearchResult>
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
    return Effect.fail(
      new ValidationError({
        field: input.field,
        message: `${input.field} must be an integer >= ${input.minimum}`
      })
    )
  }

  return Effect.succeed(Math.min(value, input.maxValue))
}

const sourceLabel = (result: RagSearchResult) => {
  const title = result.document.title
  if (title !== undefined && title.length > 0) {
    return title
  }

  switch (result.document.source._tag) {
    case 'File':
      return result.document.source.name ?? result.document.source.ref
    case 'Url':
      return result.document.source.url
    case 'Text':
      return result.document.source.label ?? result.document.id
  }
}

const resultText = (result: RagSearchResult) =>
  result.context?.map(chunk => chunk.content).join('\n\n') ?? result.chunk.content

export const searchUserStorage = (input: {
  readonly userId: string
  readonly query: string
  readonly limit?: number
  readonly contextChunks?: number
}) =>
  Effect.gen(function* () {
    const query = input.query.trim()
    if (query.length === 0) {
      return yield* Effect.fail(
        new ValidationError({ field: 'query', message: 'Search query is required' })
      )
    }

    const limit = yield* normalizeInteger({
      value: input.limit,
      defaultValue: defaultLimit,
      maxValue: maxLimit,
      minimum: 1,
      field: 'limit'
    })
    const contextChunks = yield* normalizeInteger({
      value: input.contextChunks,
      defaultValue: defaultContextChunks,
      maxValue: maxContextChunks,
      minimum: 0,
      field: 'contextChunks'
    })
    const ragSet = yield* ensureUserRagSet({ userId: input.userId })
    const results = yield* retrieveRag({
      scope: { _tag: 'RagSet', id: ragSet.id },
      query,
      limit,
      contextChunks
    })

    return {
      query,
      results: results.map((result, index) => ({
        citation: index + 1,
        source: sourceLabel(result),
        documentId: result.document.id,
        chunkId: result.chunk.id,
        score: result.score,
        vectorScore: result.scores?.vector,
        textScore: result.scores?.text,
        fusedScore: result.scores?.fused,
        text: resultText(result)
      }))
    } satisfies UserStorageSearchOutput
  }).pipe(Effect.withSpan('storage.searchUserStorage'))
