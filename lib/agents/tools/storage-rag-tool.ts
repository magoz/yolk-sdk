import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk/agent/loop'
import { ToolDef, ToolResult } from '@yolk/agent/protocol'
import type { ToolModule } from '@yolk/agent/tools'
import type { RagSearchResult } from '@yolk/rag/retrieval'
import type { AgentToolContext } from './tool-context.ts'

const storageSearchToolName = 'search_storage'
const defaultLimit = 8
const maxLimit = 20
const defaultContextChunks = 1
const maxContextChunks = 5

const StorageSearchParams = Schema.Struct({
  query: Schema.String,
  limit: Schema.optional(Schema.Number),
  minScore: Schema.optional(Schema.Number),
  contextChunks: Schema.optional(Schema.Number)
})

type StorageSearchParams = typeof StorageSearchParams.Type

export type StorageSearchHandler = (input: {
  readonly userId: string
  readonly query: string
  readonly limit: number
  readonly minScore?: number
  readonly contextChunks: number
}) => Effect.Effect<ReadonlyArray<RagSearchResult>, ToolError>

const storageSearchParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: {
      type: 'string',
      description: 'Question or search query for the user storage knowledge base.'
    },
    limit: {
      type: 'number',
      description: 'Maximum number of matching chunks. Defaults to 8; capped at 20.'
    },
    minScore: {
      type: 'number',
      description: 'Optional cosine similarity threshold from 0 to 1.'
    },
    contextChunks: {
      type: 'number',
      description: 'Adjacent chunks to include around each match. Defaults to 1; capped at 5.'
    }
  },
  required: ['query']
}

const storageSearchToolDef = ToolDef.make({
  name: storageSearchToolName,
  description: [
    'Search the authenticated user storage knowledge base.',
    'Use this when the user asks about notes, documents, saved text, or anything they uploaded to storage.'
  ].join(' '),
  parameters: storageSearchParameters
})

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const makeToolError = (message: string, cause: ToolError['cause']) =>
  new ToolError({
    tool: storageSearchToolName,
    message,
    cause
  })

const decodeStorageSearchParams = (params: unknown) =>
  Schema.decodeUnknownEffect(StorageSearchParams)(params).pipe(
    Effect.mapError(error =>
      makeToolError(`Invalid storage search arguments: ${unknownToMessage(error)}`, 'validation')
    )
  )

const normalizeInteger = (input: {
  readonly value: number | undefined
  readonly defaultValue: number
  readonly maxValue: number
  readonly minimum: number
  readonly name: string
}) => {
  const value = input.value ?? input.defaultValue

  if (!Number.isInteger(value) || value < input.minimum) {
    return Effect.fail(
      makeToolError(`${input.name} must be an integer >= ${input.minimum}`, 'validation')
    )
  }

  return Effect.succeed(Math.min(value, input.maxValue))
}

const normalizeMinScore = (value: number | undefined) => {
  if (value === undefined) {
    return Effect.succeed(undefined)
  }

  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return Effect.fail(makeToolError('minScore must be a finite number from 0 to 1', 'validation'))
  }

  return Effect.succeed(value)
}

const normalizeStorageSearchParams = (params: StorageSearchParams) =>
  Effect.gen(function* () {
    const query = params.query.trim()
    if (query.length === 0) {
      return yield* Effect.fail(makeToolError('query must not be empty', 'validation'))
    }

    const limit = yield* normalizeInteger({
      value: params.limit,
      defaultValue: defaultLimit,
      maxValue: maxLimit,
      minimum: 1,
      name: 'limit'
    })
    const contextChunks = yield* normalizeInteger({
      value: params.contextChunks,
      defaultValue: defaultContextChunks,
      maxValue: maxContextChunks,
      minimum: 0,
      name: 'contextChunks'
    })
    const minScore = yield* normalizeMinScore(params.minScore)

    return { query, limit, minScore, contextChunks }
  })

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

const formatResults = (query: string, results: ReadonlyArray<RagSearchResult>) => {
  if (results.length === 0) {
    return `No storage results found for: ${query}`
  }

  return [
    `Storage search results for: ${query}`,
    '',
    ...results.map((result, index) =>
      [
        `Result ${index + 1}`,
        `Source: ${sourceLabel(result)}`,
        `Score: ${result.score.toFixed(3)}`,
        resultText(result)
      ].join('\n')
    )
  ].join('\n\n')
}

const structuredResult = (query: string, results: ReadonlyArray<RagSearchResult>) => ({
  query,
  results: results.map(result => ({
    score: result.score,
    documentId: result.document.id,
    source: sourceLabel(result),
    chunkId: result.chunk.id,
    text: resultText(result)
  }))
})

export const makeStorageRagToolModule = (
  search: StorageSearchHandler
): ToolModule<AgentToolContext> => ({
  id: 'storage-rag',
  tools: [
    {
      def: storageSearchToolDef,
      access: 'read',
      isEnabled: context => Effect.succeed(context.surface === 'text'),
      execute: ({ call, context }) =>
        Effect.gen(function* () {
          const params = yield* decodeStorageSearchParams(call.params).pipe(
            Effect.flatMap(normalizeStorageSearchParams)
          )
          const results = yield* search({
            userId: context.userId,
            query: params.query,
            limit: params.limit,
            minScore: params.minScore,
            contextChunks: params.contextChunks
          })

          return ToolResult.make({
            toolCallId: call.id,
            content: formatResults(params.query, results),
            structuredContent: structuredResult(params.query, results)
          })
        }).pipe(
          Effect.mapError(error =>
            error instanceof ToolError
              ? error
              : makeToolError(`Storage search failed: ${unknownToMessage(error)}`, 'execution')
          )
        )
    }
  ]
})
