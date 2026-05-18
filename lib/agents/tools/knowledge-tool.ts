import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk/agent/loop'
import { ToolResult } from '@yolk/agent/protocol'
import { makeTool, type ToolModule } from '@yolk/agent/tools'
import type { KnowledgeSearchResult } from '@/lib/core/knowledge/search-user-knowledge'
import type { AgentToolContext } from './tool-context.ts'

const knowledgeSearchToolName = 'search_knowledge'
const defaultLimit = 8
const maxLimit = 20
const defaultContextChunks = 1
const maxContextChunks = 5
const maxQueries = 5

const KnowledgeSearchParams = Schema.Struct({
  queries: Schema.Array(Schema.String).pipe(
    Schema.annotate({ description: 'One to five targeted knowledge search queries.' })
  ),
  limit: Schema.optional(Schema.Number).pipe(
    Schema.annotate({ description: 'Maximum chunks per query. Defaults to 8; capped at 20.' })
  ),
  minScore: Schema.optional(Schema.Number).pipe(
    Schema.annotate({ description: 'Optional vector similarity threshold from 0 to 1.' })
  ),
  contextChunks: Schema.optional(Schema.Number).pipe(
    Schema.annotate({ description: 'Adjacent chunks to include around each match. Defaults to 1; capped at 5.' })
  )
})

type KnowledgeSearchParams = typeof KnowledgeSearchParams.Type

export type KnowledgeSearchHandler = (input: {
  readonly userId: string
  readonly query: string
  readonly limit: number
  readonly minScore?: number
  readonly contextChunks: number
}) => Effect.Effect<ReadonlyArray<KnowledgeSearchResult>, ToolError>

const isKnowledgeToolEnabled = (context: AgentToolContext) =>
  Effect.succeed(context.surface === 'text' || context.surface === 'voice')

const unknownToMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

const makeToolError = (message: string, cause: ToolError['cause']) =>
  new ToolError({ tool: knowledgeSearchToolName, message, cause })

const normalizeInteger = (input: {
  readonly value: number | undefined
  readonly defaultValue: number
  readonly maxValue: number
  readonly minimum: number
  readonly name: string
}) => {
  const value = input.value ?? input.defaultValue
  if (!Number.isInteger(value) || value < input.minimum) {
    return Effect.fail(makeToolError(`${input.name} must be an integer >= ${input.minimum}`, 'validation'))
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

const normalizeParams = (params: KnowledgeSearchParams) =>
  Effect.gen(function* () {
    const queries = params.queries.map(query => query.trim()).filter(query => query.length > 0)
    if (queries.length === 0) {
      return yield* Effect.fail(makeToolError('queries must not be empty', 'validation'))
    }
    if (queries.length > maxQueries) {
      return yield* Effect.fail(makeToolError(`queries must include at most ${maxQueries} items`, 'validation'))
    }
    const limit = yield* normalizeInteger({ value: params.limit, defaultValue: defaultLimit, maxValue: maxLimit, minimum: 1, name: 'limit' })
    const contextChunks = yield* normalizeInteger({ value: params.contextChunks, defaultValue: defaultContextChunks, maxValue: maxContextChunks, minimum: 0, name: 'contextChunks' })
    const minScore = yield* normalizeMinScore(params.minScore)
    return { queries, limit, contextChunks, minScore }
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
        `Object: ${result.object.title}`,
        `Object ID: ${result.object.id}`,
        `Role: ${result.object.role}`,
        `Policy: ${result.object.contextPolicy}`,
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
    objectId: result.object.id,
    title: result.object.title,
    role: result.object.role,
    contextPolicy: result.object.contextPolicy,
    chunkId: result.chunk.id,
    text: resultText(result)
  }))
})

export const makeKnowledgeToolModule = (search: KnowledgeSearchHandler): ToolModule<AgentToolContext> => ({
  id: 'knowledge',
  tools: [
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
          Effect.mapError(error => error instanceof ToolError ? error : makeToolError(`Knowledge search failed: ${unknownToMessage(error)}`, 'execution'))
        )
    })
  ]
})
