import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk/agent/loop'
import { ToolResult } from '@yolk/agent/protocol'
import { EmptyToolParams, makeTool, type ToolModule } from '@yolk/agent/tools'
import type { RagSearchResult } from '@yolk/rag/retrieval'
import type { AgentToolContext } from './tool-context.ts'

const storageSearchToolName = 'search_storage'
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
  queries: Schema.Array(Schema.String).pipe(
    Schema.annotate({
      description: 'One to five targeted storage search queries. Use one item for simple searches; use multiple query rewrites for broad or high-recall searches.'
    })
  ),
  limit: Schema.optional(Schema.Number).pipe(
    Schema.annotate({ description: 'Maximum chunks per query. Defaults to 8; capped at 20.' })
  ),
  minScore: Schema.optional(Schema.Number).pipe(
    Schema.annotate({ description: 'Optional vector similarity threshold from 0 to 1. Hybrid keyword matches may still contribute.' })
  ),
  contextChunks: Schema.optional(Schema.Number).pipe(
    Schema.annotate({ description: 'Adjacent chunks to include around each match. Defaults to 1; capped at 5.' })
  )
})

const StorageListSourcesParams = EmptyToolParams

const StorageGetSourceParams = Schema.Struct({
  id: Schema.String.pipe(
    Schema.annotate({ description: 'Storage source ID from search citations or list_storage_sources.' })
  ),
  maxChars: Schema.optional(Schema.Number).pipe(
    Schema.annotate({ description: 'Maximum extracted text characters to return. Defaults to 12000; capped at 40000.' })
  )
})

type StorageSearchParams = typeof StorageSearchParams.Type
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

const storageSearchToolDescription = [
  'Search the authenticated user storage knowledge base with one or more queries.',
  'Uses hybrid vector + keyword retrieval for semantic matches and exact terms.',
  'Use one query for focused searches and multiple query rewrites for broad, ambiguous, or high-recall questions.'
].join(' ')

const storageListSourcesToolDescription = [
  'List the authenticated user storage sources and indexing status.',
  'Use before searching when source names, uploaded files, or available knowledge are unclear.'
].join(' ')

const storageGetSourceToolDescription = [
  'Read one authenticated user storage source by ID.',
  'Use after search_storage or list_storage_sources when you need fuller source context before answering.',
  'Returns metadata plus extracted text capped by maxChars.'
].join(' ')

const isStorageToolEnabled = (context: AgentToolContext) =>
  Effect.succeed(context.surface === 'text' || context.surface === 'voice')

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const makeToolError = (message: string, cause: ToolError['cause'], tool = storageSearchToolName) =>
  new ToolError({
    tool,
    message,
    cause
  })

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

const formatSearchResults = (
  items: ReadonlyArray<{ readonly query: string; readonly results: ReadonlyArray<RagSearchResult> }>
) =>
  [
    'Storage search results',
    '',
    ...items.map(item => formatResults(item.query, item.results))
  ].join('\n\n')

const structuredSearchResult = (
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

const searchTool = (search: StorageSearchHandler): ToolModule<AgentToolContext>['tools'][number] => makeTool({
  name: storageSearchToolName,
  description: storageSearchToolDescription,
  parameters: StorageSearchParams,
  access: 'read',
  isEnabled: isStorageToolEnabled,
  invalidParamsMessage: error => `Invalid storage search arguments: ${unknownToMessage(error)}`,
  execute: ({ call, context, params }) =>
    Effect.gen(function* () {
      const normalizedParams = yield* normalizeStorageSearchParams(params)
      const items = yield* Effect.forEach(
        normalizedParams.queries,
        query =>
          search({
            userId: context.userId,
            query,
            limit: normalizedParams.limit,
            minScore: normalizedParams.minScore,
            contextChunks: normalizedParams.contextChunks
          }).pipe(Effect.map(results => ({ query, results }))),
        { concurrency: 'unbounded' }
      )

      return ToolResult.make({
        toolCallId: call.id,
        content: formatSearchResults(items),
        structuredContent: structuredSearchResult(items)
      })
    }).pipe(
      Effect.mapError(error =>
        error instanceof ToolError
          ? error
          : makeToolError(`Storage search failed: ${unknownToMessage(error)}`, 'execution')
      )
    )
})

const listSourcesTool = (
  listSources: StorageListSourcesHandler
): ToolModule<AgentToolContext>['tools'][number] => makeTool({
  name: storageListSourcesToolName,
  description: storageListSourcesToolDescription,
  parameters: StorageListSourcesParams,
  access: 'read',
  isEnabled: isStorageToolEnabled,
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

const getSourceTool = (getSource: StorageGetSourceHandler): ToolModule<AgentToolContext>['tools'][number] => makeTool({
  name: storageGetSourceToolName,
  description: storageGetSourceToolDescription,
  parameters: StorageGetSourceParams,
  access: 'read',
  isEnabled: isStorageToolEnabled,
  invalidParamsMessage: error => `Invalid storage source read arguments: ${unknownToMessage(error)}`,
  execute: ({ call, context, params }) =>
    Effect.gen(function* () {
      const normalizedParams = yield* normalizeStorageGetSourceParams(params)
      const source = yield* getSource({
        userId: context.userId,
        id: normalizedParams.id,
        maxChars: normalizedParams.maxChars
      })

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
  const requiredTools = [searchTool(handlers.search)]
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
