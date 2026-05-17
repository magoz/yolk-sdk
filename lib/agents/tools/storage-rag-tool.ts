import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk/agent/loop'
import { ToolDef, ToolResult } from '@yolk/agent/protocol'
import type { ToolModule } from '@yolk/agent/tools'
import type { RagSearchResult } from '@yolk/rag/retrieval'
import type { AgentToolContext } from './tool-context.ts'

const storageSearchToolName = 'search_storage'
const storageMultiSearchToolName = 'search_storage_many'
const storageListSourcesToolName = 'list_storage_sources'
const storageGetSourceToolName = 'get_storage_source'
const defaultLimit = 8
const maxLimit = 20
const defaultContextChunks = 1
const maxContextChunks = 5
const maxQueries = 5
const defaultSourceMaxChars = 12_000
const maxSourceMaxChars = 40_000

const StorageSearchParams = Schema.Struct({
  query: Schema.String,
  limit: Schema.optional(Schema.Number),
  minScore: Schema.optional(Schema.Number),
  contextChunks: Schema.optional(Schema.Number)
})

const StorageMultiSearchParams = Schema.Struct({
  queries: Schema.Array(Schema.String),
  limit: Schema.optional(Schema.Number),
  minScore: Schema.optional(Schema.Number),
  contextChunks: Schema.optional(Schema.Number)
})

const StorageGetSourceParams = Schema.Struct({
  id: Schema.String,
  maxChars: Schema.optional(Schema.Number)
})

type StorageSearchParams = typeof StorageSearchParams.Type
type StorageMultiSearchParams = typeof StorageMultiSearchParams.Type
type StorageGetSourceParams = typeof StorageGetSourceParams.Type

export type StorageSourceSummary = {
  readonly id: string
  readonly name: string
  readonly sourceType: string
  readonly status?: string
  readonly summary?: string
  readonly chunkCount?: number
  readonly tokenCount?: number
  readonly createdAt: string
}

export type StorageSourceDetail = StorageSourceSummary & {
  readonly mediaType?: string
  readonly byteSize?: number
  readonly contentHash?: string
  readonly text: string
  readonly textTruncated: boolean
  readonly textCharacters: number
}

export type StorageSearchHandler = (input: {
  readonly userId: string
  readonly query: string
  readonly limit: number
  readonly minScore?: number
  readonly contextChunks: number
}) => Effect.Effect<ReadonlyArray<RagSearchResult>, ToolError>

export type StorageListSourcesHandler = (input: {
  readonly userId: string
}) => Effect.Effect<ReadonlyArray<StorageSourceSummary>, ToolError>

export type StorageGetSourceHandler = (input: {
  readonly userId: string
  readonly id: string
  readonly maxChars: number
}) => Effect.Effect<StorageSourceDetail, ToolError>

export type StorageRagToolHandlers = {
  readonly search: StorageSearchHandler
  readonly listSources?: StorageListSourcesHandler
  readonly getSource?: StorageGetSourceHandler
}

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
      description: 'Optional vector similarity threshold from 0 to 1. Hybrid keyword matches may still contribute.'
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
    'Uses hybrid vector + keyword retrieval for semantic matches and exact terms.',
    'Use this when the user asks about notes, documents, saved text, or anything they uploaded to storage.'
  ].join(' '),
  parameters: storageSearchParameters
})

const storageMultiSearchParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    queries: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Two to five targeted storage search queries. Use query rewrites, exact terms, filenames, names, errors, dates, or synonyms.'
    },
    limit: {
      type: 'number',
      description: 'Maximum chunks per query. Defaults to 8; capped at 20.'
    },
    minScore: {
      type: 'number',
      description: 'Optional vector similarity threshold from 0 to 1. Hybrid keyword matches may still contribute.'
    },
    contextChunks: {
      type: 'number',
      description: 'Adjacent chunks to include around each match. Defaults to 1; capped at 5.'
    }
  },
  required: ['queries']
}

const storageMultiSearchToolDef = ToolDef.make({
  name: storageMultiSearchToolName,
  description: [
    'Run multiple targeted searches over the authenticated user storage knowledge base.',
    'Prefer this over a single search for broad, ambiguous, or high-recall questions.',
    'Use distinct query rewrites to cover exact terms, semantic variants, filenames, and likely source titles.'
  ].join(' '),
  parameters: storageMultiSearchParameters
})

const storageListSourcesToolDef = ToolDef.make({
  name: storageListSourcesToolName,
  description: [
    'List the authenticated user storage sources and indexing status.',
    'Use before searching when source names, uploaded files, or available knowledge are unclear.'
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {},
    required: []
  }
})

const storageGetSourceToolDef = ToolDef.make({
  name: storageGetSourceToolName,
  description: [
    'Read one authenticated user storage source by ID.',
    'Use after search_storage or list_storage_sources when you need fuller source context before answering.',
    'Returns metadata plus extracted text capped by maxChars.'
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: {
        type: 'string',
        description: 'Storage source ID from search citations or list_storage_sources.'
      },
      maxChars: {
        type: 'number',
        description: 'Maximum extracted text characters to return. Defaults to 12000; capped at 40000.'
      }
    },
    required: ['id']
  }
})

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const makeToolError = (message: string, cause: ToolError['cause'], tool = storageSearchToolName) =>
  new ToolError({
    tool,
    message,
    cause
  })

const decodeStorageSearchParams = (params: unknown) =>
  Schema.decodeUnknownEffect(StorageSearchParams)(params).pipe(
    Effect.mapError(error =>
      makeToolError(`Invalid storage search arguments: ${unknownToMessage(error)}`, 'validation')
    )
  )

const decodeStorageMultiSearchParams = (params: unknown) =>
  Schema.decodeUnknownEffect(StorageMultiSearchParams)(params).pipe(
    Effect.mapError(error =>
      makeToolError(`Invalid storage multi-search arguments: ${unknownToMessage(error)}`, 'validation')
    )
  )

const decodeStorageGetSourceParams = (params: unknown) =>
  Schema.decodeUnknownEffect(StorageGetSourceParams)(params).pipe(
    Effect.mapError(error =>
      makeToolError(
        `Invalid storage source read arguments: ${unknownToMessage(error)}`,
        'validation',
        storageGetSourceToolName
      )
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

const normalizeStorageMultiSearchParams = (params: StorageMultiSearchParams) =>
  Effect.gen(function* () {
    const queries = params.queries.map(query => query.trim()).filter(query => query.length > 0)
    if (queries.length === 0) {
      return yield* Effect.fail(makeToolError('queries must not be empty', 'validation'))
    }
    if (queries.length > maxQueries) {
      return yield* Effect.fail(makeToolError(`queries must include at most ${maxQueries} items`, 'validation'))
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

    return { queries, limit, minScore, contextChunks }
  })

const normalizeStorageGetSourceParams = (params: StorageGetSourceParams) =>
  Effect.gen(function* () {
    const id = params.id.trim()
    if (id.length === 0) {
      return yield* Effect.fail(makeToolError('id must not be empty', 'validation', storageGetSourceToolName))
    }

    const maxChars = yield* normalizeInteger({
      value: params.maxChars,
      defaultValue: defaultSourceMaxChars,
      maxValue: maxSourceMaxChars,
      minimum: 1,
      name: 'maxChars'
    })

    return { id, maxChars }
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
        `Citation [${index + 1}]`,
        `Source: ${sourceLabel(result)}`,
        `Document: ${result.document.id}`,
        `Chunk: ${result.chunk.id}`,
        `Score: ${result.score.toFixed(3)}`,
        result.scores?.vector === undefined ? undefined : `Vector score: ${result.scores.vector.toFixed(3)}`,
        result.scores?.text === undefined ? undefined : `Text score: ${result.scores.text.toFixed(3)}`,
        resultText(result)
      ].filter(line => line !== undefined).join('\n')
    )
  ].join('\n\n')
}

const structuredResult = (query: string, results: ReadonlyArray<RagSearchResult>) => ({
  query,
  results: results.map((result, index) => ({
    score: result.score,
    scores: result.scores,
    citation: index + 1,
    documentId: result.document.id,
    source: sourceLabel(result),
    chunkId: result.chunk.id,
    text: resultText(result)
  }))
})

const formatMultiResults = (
  items: ReadonlyArray<{ readonly query: string; readonly results: ReadonlyArray<RagSearchResult> }>
) =>
  [
    'Storage multi-search results',
    '',
    ...items.map(item => formatResults(item.query, item.results))
  ].join('\n\n')

const structuredMultiResult = (
  items: ReadonlyArray<{ readonly query: string; readonly results: ReadonlyArray<RagSearchResult> }>
) => ({
  queries: items.map(item => structuredResult(item.query, item.results))
})

const formatSources = (sources: ReadonlyArray<StorageSourceSummary>) => {
  if (sources.length === 0) {
    return 'No storage sources found.'
  }

  return [
    'Storage sources',
    '',
    ...sources.map((source, index) =>
      [
        `Source [${index + 1}]`,
        `Name: ${source.name}`,
        `ID: ${source.id}`,
        `Type: ${source.sourceType}`,
        source.status === undefined ? undefined : `Status: ${source.status}`,
        source.chunkCount === undefined ? undefined : `Chunks: ${source.chunkCount}`,
        source.tokenCount === undefined ? undefined : `Tokens: ${source.tokenCount}`,
        `Created: ${source.createdAt}`,
        source.summary === undefined ? undefined : `Summary: ${source.summary}`
      ].filter(line => line !== undefined).join('\n')
    )
  ].join('\n\n')
}

const formatSourceDetail = (source: StorageSourceDetail) =>
  [
    `Storage source: ${source.name}`,
    '',
    `ID: ${source.id}`,
    `Type: ${source.sourceType}`,
    source.mediaType === undefined ? undefined : `Media type: ${source.mediaType}`,
    source.byteSize === undefined ? undefined : `Bytes: ${source.byteSize}`,
    source.status === undefined ? undefined : `Status: ${source.status}`,
    source.chunkCount === undefined ? undefined : `Chunks: ${source.chunkCount}`,
    source.tokenCount === undefined ? undefined : `Tokens: ${source.tokenCount}`,
    source.contentHash === undefined ? undefined : `Content hash: ${source.contentHash}`,
    `Created: ${source.createdAt}`,
    source.summary === undefined ? undefined : `Summary: ${source.summary}`,
    source.textTruncated
      ? `Extracted text (${source.text.length}/${source.textCharacters} chars, truncated)`
      : `Extracted text (${source.textCharacters} chars)`,
    source.text
  ].filter(line => line !== undefined).join('\n')

const searchTool = (search: StorageSearchHandler): ToolModule<AgentToolContext>['tools'][number] => ({
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
})

const multiSearchTool = (search: StorageSearchHandler): ToolModule<AgentToolContext>['tools'][number] => ({
  def: storageMultiSearchToolDef,
  access: 'read',
  isEnabled: context => Effect.succeed(context.surface === 'text'),
  execute: ({ call, context }) =>
    Effect.gen(function* () {
      const params = yield* decodeStorageMultiSearchParams(call.params).pipe(
        Effect.flatMap(normalizeStorageMultiSearchParams)
      )
      const items = yield* Effect.forEach(
        params.queries,
        query =>
          search({
            userId: context.userId,
            query,
            limit: params.limit,
            minScore: params.minScore,
            contextChunks: params.contextChunks
          }).pipe(Effect.map(results => ({ query, results }))),
        { concurrency: 'unbounded' }
      )

      return ToolResult.make({
        toolCallId: call.id,
        content: formatMultiResults(items),
        structuredContent: structuredMultiResult(items)
      })
    }).pipe(
      Effect.mapError(error =>
        error instanceof ToolError
          ? error
          : makeToolError(
              `Storage multi-search failed: ${unknownToMessage(error)}`,
              'execution',
              storageMultiSearchToolName
            )
      )
    )
})

const listSourcesTool = (
  listSources: StorageListSourcesHandler
): ToolModule<AgentToolContext>['tools'][number] => ({
  def: storageListSourcesToolDef,
  access: 'read',
  isEnabled: context => Effect.succeed(context.surface === 'text'),
  execute: ({ call, context }) =>
    listSources({ userId: context.userId }).pipe(
      Effect.map(sources =>
        ToolResult.make({
          toolCallId: call.id,
          content: formatSources(sources),
          structuredContent: { sources }
        })
      ),
      Effect.mapError(error =>
        error instanceof ToolError
          ? error
          : makeToolError(
              `Storage source listing failed: ${unknownToMessage(error)}`,
              'execution',
              storageListSourcesToolName
            )
      )
    )
})

const getSourceTool = (getSource: StorageGetSourceHandler): ToolModule<AgentToolContext>['tools'][number] => ({
  def: storageGetSourceToolDef,
  access: 'read',
  isEnabled: context => Effect.succeed(context.surface === 'text'),
  execute: ({ call, context }) =>
    Effect.gen(function* () {
      const params = yield* decodeStorageGetSourceParams(call.params).pipe(
        Effect.flatMap(normalizeStorageGetSourceParams)
      )
      const source = yield* getSource({ userId: context.userId, id: params.id, maxChars: params.maxChars })

      return ToolResult.make({
        toolCallId: call.id,
        content: formatSourceDetail(source),
        structuredContent: { source }
      })
    }).pipe(
      Effect.mapError(error =>
        error instanceof ToolError
          ? error
          : makeToolError(
              `Storage source read failed: ${unknownToMessage(error)}`,
              'execution',
              storageGetSourceToolName
            )
      )
    )
})

const storageTools = (handlers: StorageRagToolHandlers): ToolModule<AgentToolContext>['tools'] => {
  const requiredTools = [searchTool(handlers.search), multiSearchTool(handlers.search)]
  const sourceTools = [
    ...(handlers.listSources === undefined ? [] : [listSourcesTool(handlers.listSources)]),
    ...(handlers.getSource === undefined ? [] : [getSourceTool(handlers.getSource)])
  ]

  return [...requiredTools, ...sourceTools]
}

export const makeStorageRagToolModule = (
  searchOrHandlers: StorageSearchHandler | StorageRagToolHandlers
): ToolModule<AgentToolContext> => {
  const handlers = typeof searchOrHandlers === 'function' ? { search: searchOrHandlers } : searchOrHandlers

  return {
    id: 'storage-rag',
    tools: storageTools(handlers)
  }
}
