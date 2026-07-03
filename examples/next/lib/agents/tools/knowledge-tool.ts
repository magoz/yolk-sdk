import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk-sdk/agent/loop'
import { ToolResult } from '@yolk-sdk/agent/protocol'
import {
  makeTool,
  modelVisibleToolError,
  ModelVisibleToolError,
  type ToolModule
} from '@yolk-sdk/agent/tools'
import type { KnowledgeContextWindow } from '@/lib/core/knowledge/get-knowledge-context'
import type { KnowledgeDocumentSummary } from '@/lib/core/knowledge/list-user-knowledge-documents'
import type { KnowledgeSearchResult } from '@/lib/core/knowledge/search-user-knowledge'
import type { KnowledgeAvailability } from '@/lib/core/knowledge/availability'
import type { AgentToolContext } from './tool-context.ts'

type KnowledgeToolError = ToolError | ModelVisibleToolError

const knowledgeListToolName = 'list_knowledge_documents'
const knowledgeSearchToolName = 'search_knowledge'
const knowledgeContextToolName = 'get_knowledge_context'
const defaultLimit = 8
const maxLimit = 20
const defaultContextChunks = 1
const maxContextChunks = 5
const maxQueries = 5
const defaultListLimit = 20
const maxListLimit = 50
const defaultBefore = 3
const defaultAfter = 6
const maxTraversalChunks = 20
const defaultMaxChars = 20_000
const maxMaxChars = 60_000

const KnowledgeAvailabilitySchema = Schema.Union([
  Schema.Literal('pinned'),
  Schema.Literal('searchable'),
  Schema.Literal('archived')
])

const KnowledgeListParams = Schema.Struct({
  query: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.annotate({ description: 'Optional title filter for knowledge documents.' })
  ),
  availability: Schema.optional(Schema.NullOr(KnowledgeAvailabilitySchema)).pipe(
    Schema.annotate({ description: 'Optional availability filter.' })
  ),
  limit: Schema.optional(Schema.NullOr(Schema.Number)).pipe(
    Schema.annotate({ description: 'Maximum documents to return. Defaults to 20; capped at 50.' })
  )
})

const KnowledgeSearchParams = Schema.Struct({
  queries: Schema.Array(Schema.String).pipe(
    Schema.annotate({ description: 'One to five targeted knowledge search queries.' })
  ),
  limit: Schema.optional(Schema.NullOr(Schema.Number)).pipe(
    Schema.annotate({ description: 'Maximum chunks per query. Defaults to 8; capped at 20.' })
  ),
  minScore: Schema.optional(Schema.NullOr(Schema.Number)).pipe(
    Schema.annotate({ description: 'Optional vector similarity threshold from 0 to 1.' })
  ),
  contextChunks: Schema.optional(Schema.NullOr(Schema.Number)).pipe(
    Schema.annotate({
      description: 'Adjacent chunks to include around each match. Defaults to 1; capped at 5.'
    })
  )
})

const KnowledgeContextParams = Schema.Struct({
  documentId: Schema.String.pipe(
    Schema.annotate({ description: 'Knowledge document ID from search_knowledge citations.' })
  ),
  chunkId: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.annotate({
      description:
        'Optional chunk ID from search_knowledge. Use this to expand a specific citation.'
    })
  ),
  position: Schema.optional(Schema.NullOr(Schema.Number)).pipe(
    Schema.annotate({
      description:
        'Optional chunk position to anchor traversal when chunkId is unavailable. Do not pass with chunkId.'
    })
  ),
  before: Schema.optional(Schema.NullOr(Schema.Number)).pipe(
    Schema.annotate({
      description: 'Chunks before the anchor to include. Defaults to 3; capped at 20.'
    })
  ),
  after: Schema.optional(Schema.NullOr(Schema.Number)).pipe(
    Schema.annotate({
      description: 'Chunks after the anchor to include. Defaults to 6; capped at 20.'
    })
  ),
  maxChars: Schema.optional(Schema.NullOr(Schema.Number)).pipe(
    Schema.annotate({
      description: 'Maximum text characters to return. Defaults to 20000; capped at 60000.'
    })
  )
})

type KnowledgeListParams = typeof KnowledgeListParams.Type
type KnowledgeSearchParams = typeof KnowledgeSearchParams.Type
type KnowledgeContextParams = typeof KnowledgeContextParams.Type

export type KnowledgeListHandler = (input: {
  readonly userId: string
  readonly query?: string
  readonly availability?: KnowledgeAvailability
  readonly limit: number
}) => Effect.Effect<ReadonlyArray<KnowledgeDocumentSummary>, KnowledgeToolError>

export type KnowledgeSearchHandler = (input: {
  readonly userId: string
  readonly query: string
  readonly limit: number
  readonly minScore?: number
  readonly contextChunks: number
}) => Effect.Effect<ReadonlyArray<KnowledgeSearchResult>, KnowledgeToolError>

export type KnowledgeContextHandler = (input: {
  readonly userId: string
  readonly documentId: string
  readonly chunkId?: string
  readonly position?: number
  readonly before: number
  readonly after: number
  readonly maxChars: number
}) => Effect.Effect<KnowledgeContextWindow, KnowledgeToolError>

export type KnowledgeToolHandlers = {
  readonly list?: KnowledgeListHandler
  readonly search: KnowledgeSearchHandler
  readonly getContext?: KnowledgeContextHandler
}

const isKnowledgeToolEnabled = (context: AgentToolContext) =>
  Effect.succeed(context.surface === 'text' || context.surface === 'voice')

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const makeToolError = (message: string, cause: ToolError['cause']) =>
  new ToolError({ tool: knowledgeSearchToolName, message, cause })

const makeNamedToolError = (tool: string, message: string, cause: ToolError['cause']) =>
  new ToolError({ tool, message, cause })

const makeModelVisibleError = (tool: string, message: string) =>
  modelVisibleToolError({
    tool,
    message,
    reason: 'validation'
  })

const optionalText = (value: string | null | undefined) => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

const normalizeInteger = (input: {
  readonly value: number | null | undefined
  readonly defaultValue: number
  readonly maxValue: number
  readonly minimum: number
  readonly name: string
}) => {
  const value = input.value ?? input.defaultValue
  if (!Number.isInteger(value) || value < input.minimum) {
    return Effect.fail(
      makeModelVisibleError(
        knowledgeSearchToolName,
        `${input.name} must be an integer >= ${input.minimum}`
      )
    )
  }
  return Effect.succeed(Math.min(value, input.maxValue))
}

const normalizeNamedInteger = (input: {
  readonly value: number | null | undefined
  readonly defaultValue: number
  readonly maxValue: number
  readonly minimum: number
  readonly name: string
  readonly tool: string
}) => {
  const value = input.value ?? input.defaultValue
  if (!Number.isInteger(value) || value < input.minimum) {
    return Effect.fail(
      makeModelVisibleError(input.tool, `${input.name} must be an integer >= ${input.minimum}`)
    )
  }

  return Effect.succeed(Math.min(value, input.maxValue))
}

const normalizeMinScore = (value: number | null | undefined) => {
  if (value === null || value === undefined) {
    return Effect.succeed(undefined)
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return Effect.fail(
      makeModelVisibleError(knowledgeSearchToolName, 'minScore must be a finite number from 0 to 1')
    )
  }
  return Effect.succeed(value)
}

const normalizeParams = (params: KnowledgeSearchParams) =>
  Effect.gen(function* () {
    const queries = params.queries.map(query => query.trim()).filter(query => query.length > 0)
    if (queries.length === 0) {
      return yield* Effect.fail(
        makeModelVisibleError(knowledgeSearchToolName, 'queries must not be empty')
      )
    }
    if (queries.length > maxQueries) {
      return yield* Effect.fail(
        makeModelVisibleError(
          knowledgeSearchToolName,
          `queries must include at most ${maxQueries} items`
        )
      )
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
    return { queries, limit, contextChunks, minScore }
  })

const normalizeListParams = (params: KnowledgeListParams) =>
  Effect.gen(function* () {
    const limit = yield* normalizeNamedInteger({
      value: params.limit,
      defaultValue: defaultListLimit,
      maxValue: maxListLimit,
      minimum: 1,
      name: 'limit',
      tool: knowledgeListToolName
    })
    return {
      query: optionalText(params.query),
      availability: params.availability ?? undefined,
      limit
    }
  })

const normalizeContextParams = (params: KnowledgeContextParams) =>
  Effect.gen(function* () {
    const documentId = params.documentId.trim()
    if (documentId.length === 0) {
      return yield* Effect.fail(
        makeModelVisibleError(knowledgeContextToolName, 'documentId must not be empty')
      )
    }
    const chunkId = params.chunkId?.trim()
    if (chunkId !== undefined && chunkId.length === 0) {
      return yield* Effect.fail(
        makeModelVisibleError(knowledgeContextToolName, 'chunkId must not be empty')
      )
    }
    const position = params.position ?? undefined
    if (chunkId !== undefined && position !== undefined) {
      return yield* Effect.fail(
        makeModelVisibleError(knowledgeContextToolName, 'Use chunkId or position, not both')
      )
    }

    const before = yield* normalizeNamedInteger({
      value: params.before,
      defaultValue: defaultBefore,
      maxValue: maxTraversalChunks,
      minimum: 0,
      name: 'before',
      tool: knowledgeContextToolName
    })
    const after = yield* normalizeNamedInteger({
      value: params.after,
      defaultValue: defaultAfter,
      maxValue: maxTraversalChunks,
      minimum: 0,
      name: 'after',
      tool: knowledgeContextToolName
    })
    const maxChars = yield* normalizeNamedInteger({
      value: params.maxChars,
      defaultValue: defaultMaxChars,
      maxValue: maxMaxChars,
      minimum: 1,
      name: 'maxChars',
      tool: knowledgeContextToolName
    })
    return { documentId, chunkId, position, before, after, maxChars }
  })

const resultText = (result: KnowledgeSearchResult) =>
  result.context.map(chunk => chunk.content).join('\n\n')

const formatResults = (query: string, results: ReadonlyArray<KnowledgeSearchResult>) => {
  if (results.length === 0) {
    return `No knowledge results found for: ${query}`
  }
  return [
    `Knowledge search results for: ${query}`,
    '',
    ...results.map((result, index) =>
      [
        `Citation [${index + 1}]`,
        `Document: ${result.document.title}`,
        `Document ID: ${result.document.id}`,
        `Purpose: ${result.document.purpose}`,
        `Origin: ${result.document.origin}`,
        `Availability: ${result.document.availability}`,
        `Chunk: ${result.chunk.id}`,
        `Score: ${result.score.toFixed(3)}`,
        result.vectorScore === undefined
          ? undefined
          : `Vector score: ${result.vectorScore.toFixed(3)}`,
        result.textScore === undefined ? undefined : `Text score: ${result.textScore.toFixed(3)}`,
        resultText(result)
      ]
        .filter(line => line !== undefined)
        .join('\n')
    )
  ].join('\n\n')
}

const structuredResult = (query: string, results: ReadonlyArray<KnowledgeSearchResult>) => ({
  query,
  results: results.map((result, index) => ({
    citation: index + 1,
    score: result.score,
    vectorScore: result.vectorScore,
    textScore: result.textScore,
    documentId: result.document.id,
    title: result.document.title,
    purpose: result.document.purpose,
    origin: result.document.origin,
    availability: result.document.availability,
    chunkId: result.chunk.id,
    text: resultText(result)
  }))
})

const formatDocumentSummaries = (documents: ReadonlyArray<KnowledgeDocumentSummary>) => {
  if (documents.length === 0) {
    return 'No knowledge documents found.'
  }

  return [
    'Knowledge documents',
    '',
    ...documents.map((document, index) =>
      [
        `Document [${index + 1}]`,
        `Title: ${document.title}`,
        `ID: ${document.id}`,
        `Slug: ${document.slug}`,
        `Purpose: ${document.purpose}`,
        `Origin: ${document.origin}`,
        `Status: ${document.status}`,
        `Availability: ${document.availability}`,
        `Files: ${document.fileCount}`,
        `Chunks: ${document.chunkCount}`,
        `Updated: ${document.updatedAt.toISOString()}`,
        document.summary === undefined ? undefined : `Summary: ${document.summary}`,
        document.files.length === 0
          ? undefined
          : `File IDs: ${document.files.map(file => file.id).join(', ')}`
      ]
        .filter(line => line !== undefined)
        .join('\n')
    )
  ].join('\n\n')
}

const structuredDocumentSummaries = (documents: ReadonlyArray<KnowledgeDocumentSummary>) => ({
  documents
})

const formatContextWindow = (window: KnowledgeContextWindow) =>
  [
    `Knowledge context: ${window.document.title}`,
    '',
    `Document ID: ${window.document.id}`,
    `Anchor chunk: ${window.anchor.id}`,
    `Anchor position: ${window.anchor.position}`,
    `Positions: ${window.startPosition}-${window.endPosition}`,
    `Has before: ${window.hasBefore ? 'yes' : 'no'}`,
    `Has after: ${window.hasAfter ? 'yes' : 'no'}`,
    window.textTruncated
      ? `Extracted text (${window.text.length}/${window.textCharacters} chars, truncated)`
      : `Extracted text (${window.textCharacters} chars)`,
    window.text
  ].join('\n')

const structuredContextWindow = (window: KnowledgeContextWindow) => ({
  documentId: window.document.id,
  title: window.document.title,
  anchorChunkId: window.anchor.id,
  anchorPosition: window.anchor.position,
  startPosition: window.startPosition,
  endPosition: window.endPosition,
  hasBefore: window.hasBefore,
  hasAfter: window.hasAfter,
  text: window.text,
  textTruncated: window.textTruncated,
  textCharacters: window.textCharacters,
  chunks: window.chunks.map(chunk => ({
    id: chunk.id,
    position: chunk.position,
    tokenCount: chunk.tokenCount,
    content: chunk.content
  }))
})

const searchTool = (
  search: KnowledgeSearchHandler
): ToolModule<AgentToolContext>['tools'][number] =>
  makeTool({
    name: knowledgeSearchToolName,
    description:
      'Search durable user knowledge. Use this for source-backed facts, uploaded knowledge, decisions, notes, and non-pinned knowledge not already in context.',
    parameters: KnowledgeSearchParams,
    access: 'read',
    isEnabled: isKnowledgeToolEnabled,
    invalidParamsMessage: error => `Invalid knowledge search arguments: ${unknownToMessage(error)}`,
    execute: ({ call, context, params }) =>
      Effect.gen(function* () {
        const normalized = yield* normalizeParams(params)
        const items = yield* Effect.forEach(
          normalized.queries,
          query =>
            search({
              userId: context.userId,
              query,
              limit: normalized.limit,
              minScore: normalized.minScore,
              contextChunks: normalized.contextChunks
            }).pipe(Effect.map(results => ({ query, results }))),
          { concurrency: 'unbounded' }
        )

        return ToolResult.make({
          toolCallId: call.id,
          content: [
            'Knowledge search results',
            '',
            ...items.map(item => formatResults(item.query, item.results))
          ].join('\n\n'),
          structuredContent: {
            queries: items.map(item => structuredResult(item.query, item.results))
          }
        })
      }).pipe(
        Effect.mapError(error =>
          error instanceof ToolError || error instanceof ModelVisibleToolError
            ? error
            : makeToolError(`Knowledge search failed: ${unknownToMessage(error)}`, 'execution')
        )
      )
  })

const listTool = (list: KnowledgeListHandler): ToolModule<AgentToolContext>['tools'][number] =>
  makeTool({
    name: knowledgeListToolName,
    description:
      'List durable user knowledge documents and metadata. Use before searching when available uploaded files, notes, decisions, or knowledge document IDs are unclear.',
    parameters: KnowledgeListParams,
    access: 'read',
    isEnabled: isKnowledgeToolEnabled,
    invalidParamsMessage: error =>
      `Invalid knowledge listing arguments: ${unknownToMessage(error)}`,
    execute: ({ call, context, params }) =>
      Effect.gen(function* () {
        const normalized = yield* normalizeListParams(params)
        const documents = yield* list({ userId: context.userId, ...normalized })

        return ToolResult.make({
          toolCallId: call.id,
          content: formatDocumentSummaries(documents),
          structuredContent: structuredDocumentSummaries(documents)
        })
      }).pipe(
        Effect.mapError(error =>
          error instanceof ToolError || error instanceof ModelVisibleToolError
            ? error
            : makeNamedToolError(
                knowledgeListToolName,
                `Knowledge listing failed: ${unknownToMessage(error)}`,
                'execution'
              )
        )
      )
  })

const contextTool = (
  getContext: KnowledgeContextHandler
): ToolModule<AgentToolContext>['tools'][number] =>
  makeTool({
    name: knowledgeContextToolName,
    description:
      'Read surrounding chunks from a specific durable knowledge document. Use after search_knowledge when the user asks to expand, continue, inspect nearby pages, or see more context from a citation.',
    parameters: KnowledgeContextParams,
    access: 'read',
    isEnabled: isKnowledgeToolEnabled,
    invalidParamsMessage: error =>
      `Invalid knowledge context arguments: ${unknownToMessage(error)}`,
    execute: ({ call, context, params }) =>
      Effect.gen(function* () {
        const normalized = yield* normalizeContextParams(params)
        const window = yield* getContext({ userId: context.userId, ...normalized })

        return ToolResult.make({
          toolCallId: call.id,
          content: formatContextWindow(window),
          structuredContent: { context: structuredContextWindow(window) }
        })
      }).pipe(
        Effect.mapError(error =>
          error instanceof ToolError || error instanceof ModelVisibleToolError
            ? error
            : makeNamedToolError(
                knowledgeContextToolName,
                `Knowledge context read failed: ${unknownToMessage(error)}`,
                'execution'
              )
        )
      )
  })

const knowledgeTools = (handlers: KnowledgeToolHandlers): ToolModule<AgentToolContext>['tools'] => [
  ...(handlers.list === undefined ? [] : [listTool(handlers.list)]),
  searchTool(handlers.search),
  ...(handlers.getContext === undefined ? [] : [contextTool(handlers.getContext)])
]

export const makeKnowledgeToolModule = (
  searchOrHandlers: KnowledgeSearchHandler | KnowledgeToolHandlers
): ToolModule<AgentToolContext> => {
  const handlers =
    typeof searchOrHandlers === 'function' ? { search: searchOrHandlers } : searchOrHandlers
  return { id: 'knowledge', tools: knowledgeTools(handlers) }
}
