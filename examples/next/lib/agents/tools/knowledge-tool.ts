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
import type { KnowledgeRecordSummary } from '@/lib/core/knowledge/list-user-knowledge-records'
import type { KnowledgeSearchResult } from '@/lib/core/knowledge/search-user-knowledge'
import type { AgentToolContext } from './tool-context.ts'

type KnowledgeToolError = ToolError | ModelVisibleToolError

const knowledgeListToolName = 'list_knowledge_records'
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

const KnowledgeContextPolicy = Schema.Union([
  Schema.Literal('pinned'),
  Schema.Literal('routable'),
  Schema.Literal('searchable'),
  Schema.Literal('archived')
])

const KnowledgeListParams = Schema.Struct({
  query: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.annotate({ description: 'Optional title filter for knowledge records.' })
  ),
  policy: Schema.optional(Schema.NullOr(KnowledgeContextPolicy)).pipe(
    Schema.annotate({ description: 'Optional context policy filter.' })
  ),
  limit: Schema.optional(Schema.NullOr(Schema.Number)).pipe(
    Schema.annotate({ description: 'Maximum records to return. Defaults to 20; capped at 50.' })
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
    Schema.annotate({ description: 'Adjacent chunks to include around each match. Defaults to 1; capped at 5.' })
  )
})

const KnowledgeContextParams = Schema.Struct({
  recordId: Schema.String.pipe(
    Schema.annotate({ description: 'Knowledge record ID from search_knowledge citations.' })
  ),
  chunkId: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.annotate({ description: 'Optional chunk ID from search_knowledge. Use this to expand a specific citation.' })
  ),
  position: Schema.optional(Schema.NullOr(Schema.Number)).pipe(
    Schema.annotate({ description: 'Optional chunk position to anchor traversal when chunkId is unavailable. Do not pass with chunkId.' })
  ),
  before: Schema.optional(Schema.NullOr(Schema.Number)).pipe(
    Schema.annotate({ description: 'Chunks before the anchor to include. Defaults to 3; capped at 20.' })
  ),
  after: Schema.optional(Schema.NullOr(Schema.Number)).pipe(
    Schema.annotate({ description: 'Chunks after the anchor to include. Defaults to 6; capped at 20.' })
  ),
  maxChars: Schema.optional(Schema.NullOr(Schema.Number)).pipe(
    Schema.annotate({ description: 'Maximum text characters to return. Defaults to 20000; capped at 60000.' })
  )
})

type KnowledgeListParams = typeof KnowledgeListParams.Type
type KnowledgeSearchParams = typeof KnowledgeSearchParams.Type
type KnowledgeContextParams = typeof KnowledgeContextParams.Type

export type KnowledgeListHandler = (input: {
  readonly userId: string
  readonly query?: string
  readonly policy?: typeof KnowledgeContextPolicy.Type
  readonly limit: number
}) => Effect.Effect<ReadonlyArray<KnowledgeRecordSummary>, KnowledgeToolError>

export type KnowledgeSearchHandler = (input: {
  readonly userId: string
  readonly query: string
  readonly limit: number
  readonly minScore?: number
  readonly contextChunks: number
}) => Effect.Effect<ReadonlyArray<KnowledgeSearchResult>, KnowledgeToolError>

export type KnowledgeContextHandler = (input: {
  readonly userId: string
  readonly recordId: string
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

const unknownToMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

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
      return yield* Effect.fail(makeModelVisibleError(knowledgeSearchToolName, 'queries must not be empty'))
    }
    if (queries.length > maxQueries) {
      return yield* Effect.fail(
        makeModelVisibleError(knowledgeSearchToolName, `queries must include at most ${maxQueries} items`)
      )
    }
    const limit = yield* normalizeInteger({ value: params.limit, defaultValue: defaultLimit, maxValue: maxLimit, minimum: 1, name: 'limit' })
    const contextChunks = yield* normalizeInteger({ value: params.contextChunks, defaultValue: defaultContextChunks, maxValue: maxContextChunks, minimum: 0, name: 'contextChunks' })
    const minScore = yield* normalizeMinScore(params.minScore)
    return { queries, limit, contextChunks, minScore }
  })

const normalizeListParams = (params: KnowledgeListParams) =>
  Effect.gen(function* () {
    const limit = yield* normalizeNamedInteger({ value: params.limit, defaultValue: defaultListLimit, maxValue: maxListLimit, minimum: 1, name: 'limit', tool: knowledgeListToolName })
    return { query: optionalText(params.query), policy: params.policy ?? undefined, limit }
  })

const normalizeContextParams = (params: KnowledgeContextParams) =>
  Effect.gen(function* () {
    const recordId = params.recordId.trim()
    if (recordId.length === 0) {
      return yield* Effect.fail(
        makeModelVisibleError(knowledgeContextToolName, 'recordId must not be empty')
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

    const before = yield* normalizeNamedInteger({ value: params.before, defaultValue: defaultBefore, maxValue: maxTraversalChunks, minimum: 0, name: 'before', tool: knowledgeContextToolName })
    const after = yield* normalizeNamedInteger({ value: params.after, defaultValue: defaultAfter, maxValue: maxTraversalChunks, minimum: 0, name: 'after', tool: knowledgeContextToolName })
    const maxChars = yield* normalizeNamedInteger({ value: params.maxChars, defaultValue: defaultMaxChars, maxValue: maxMaxChars, minimum: 1, name: 'maxChars', tool: knowledgeContextToolName })
    return { recordId, chunkId, position, before, after, maxChars }
  })

const resultText = (result: KnowledgeSearchResult) => result.context.map(chunk => chunk.content).join('\n\n')

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
        `Record: ${result.record.title}`,
        `Record ID: ${result.record.id}`,
        `Role: ${result.record.role}`,
        `Policy: ${result.record.contextPolicy}`,
        `Chunk: ${result.chunk.id}`,
        `Score: ${result.score.toFixed(3)}`,
        result.vectorScore === undefined ? undefined : `Vector score: ${result.vectorScore.toFixed(3)}`,
        result.textScore === undefined ? undefined : `Text score: ${result.textScore.toFixed(3)}`,
        resultText(result)
      ].filter(line => line !== undefined).join('\n')
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
    recordId: result.record.id,
    title: result.record.title,
    role: result.record.role,
    contextPolicy: result.record.contextPolicy,
    chunkId: result.chunk.id,
    text: resultText(result)
  }))
})

const formatRecordSummaries = (records: ReadonlyArray<KnowledgeRecordSummary>) => {
  if (records.length === 0) {
    return 'No knowledge records found.'
  }

  return [
    'Knowledge records',
    '',
    ...records.map((record, index) =>
      [
        `Record [${index + 1}]`,
        `Title: ${record.title}`,
        `ID: ${record.id}`,
        `Role: ${record.role}`,
        `Status: ${record.status}`,
        `Policy: ${record.contextPolicy}`,
        `Representations: ${record.representationCount}`,
        `Artifacts: ${record.artifactCount}`,
        `Chunks: ${record.chunkCount}`,
        `Updated: ${record.updatedAt.toISOString()}`,
        record.summary === undefined ? undefined : `Summary: ${record.summary}`,
        record.artifacts.length === 0
          ? undefined
          : `Artifact IDs: ${record.artifacts.map(artifact => artifact.id).join(', ')}`
      ].filter(line => line !== undefined).join('\n')
    )
  ].join('\n\n')
}

const structuredRecordSummaries = (records: ReadonlyArray<KnowledgeRecordSummary>) => ({ records })

const formatContextWindow = (window: KnowledgeContextWindow) =>
  [
    `Knowledge context: ${window.record.title}`,
    '',
    `Record ID: ${window.record.id}`,
    `Representation ID: ${window.representation.id}`,
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
  recordId: window.record.id,
  title: window.record.title,
  representationId: window.representation.id,
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

const searchTool = (search: KnowledgeSearchHandler): ToolModule<AgentToolContext>['tools'][number] =>
  makeTool({
      name: knowledgeSearchToolName,
      description: 'Search durable user knowledge. Use this for source-backed facts, uploaded knowledge, decisions, notes, and non-pinned knowledge not already in context.',
      parameters: KnowledgeSearchParams,
      access: 'read',
      isEnabled: isKnowledgeToolEnabled,
      invalidParamsMessage: error => `Invalid knowledge search arguments: ${unknownToMessage(error)}`,
      execute: ({ call, context, params }) =>
        Effect.gen(function* () {
          const normalized = yield* normalizeParams(params)
          const items = yield* Effect.forEach(
            normalized.queries,
            query => search({
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
            content: ['Knowledge search results', '', ...items.map(item => formatResults(item.query, item.results))].join('\n\n'),
            structuredContent: { queries: items.map(item => structuredResult(item.query, item.results)) }
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
    description: 'List durable user knowledge records and metadata. Use before searching when available uploaded files, notes, decisions, or knowledge record IDs are unclear.',
    parameters: KnowledgeListParams,
    access: 'read',
    isEnabled: isKnowledgeToolEnabled,
    invalidParamsMessage: error => `Invalid knowledge listing arguments: ${unknownToMessage(error)}`,
    execute: ({ call, context, params }) =>
      Effect.gen(function* () {
        const normalized = yield* normalizeListParams(params)
        const records = yield* list({ userId: context.userId, ...normalized })

        return ToolResult.make({
          toolCallId: call.id,
          content: formatRecordSummaries(records),
          structuredContent: structuredRecordSummaries(records)
        })
      }).pipe(
        Effect.mapError(error =>
          error instanceof ToolError || error instanceof ModelVisibleToolError
            ? error
            : makeNamedToolError(knowledgeListToolName, `Knowledge listing failed: ${unknownToMessage(error)}`, 'execution')
        )
      )
  })

const contextTool = (getContext: KnowledgeContextHandler): ToolModule<AgentToolContext>['tools'][number] =>
  makeTool({
    name: knowledgeContextToolName,
    description: 'Read surrounding chunks from a specific durable knowledge record. Use after search_knowledge when the user asks to expand, continue, inspect nearby pages, or see more context from a citation.',
    parameters: KnowledgeContextParams,
    access: 'read',
    isEnabled: isKnowledgeToolEnabled,
    invalidParamsMessage: error => `Invalid knowledge context arguments: ${unknownToMessage(error)}`,
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
            : makeNamedToolError(knowledgeContextToolName, `Knowledge context read failed: ${unknownToMessage(error)}`, 'execution')
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
  const handlers = typeof searchOrHandlers === 'function' ? { search: searchOrHandlers } : searchOrHandlers
  return { id: 'knowledge', tools: knowledgeTools(handlers) }
}
