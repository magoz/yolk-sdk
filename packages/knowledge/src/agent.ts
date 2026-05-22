import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk-sdk/agent/loop'
import { ToolResult } from '@yolk-sdk/agent/protocol'
import { makeTool, type ToolRegistration } from '@yolk-sdk/agent/tools'
import type { KnowledgeScope } from './records.ts'
import type { KnowledgeSearchScope } from './documents.ts'
import type { KnowledgeSearcher } from './search.ts'
import { packKnowledgeSearchContext } from './search.ts'

export type ResolveKnowledgeScope<Context> = (context: Context) => KnowledgeScope

export type KnowledgeAgentContextOptions = {
  readonly maxPinnedContextCharacters: number
}

export const defaultKnowledgeAgentContextOptions: KnowledgeAgentContextOptions = {
  maxPinnedContextCharacters: 6000
}

const KnowledgeSearchToolParams = Schema.Struct({
  query: Schema.Trimmed.pipe(
    Schema.check(Schema.isNonEmpty()),
    Schema.annotate({ description: 'Search query for the configured knowledge search.' })
  )
})

const isToolError = Schema.is(ToolError)

export type KnowledgeSearchToolScopeResolver<Context> =
  | KnowledgeSearchScope
  | ((context: Context) => Effect.Effect<KnowledgeSearchScope, ToolError>)

export type MakeKnowledgeSearchToolOptions<Context> = {
  readonly scope: KnowledgeSearchToolScopeResolver<Context>
  readonly name?: string
  readonly description?: string
  readonly limit?: number
  readonly minScore?: number
  readonly contextChunks?: number
}

const resolveScope = <Context>(resolver: KnowledgeSearchToolScopeResolver<Context>, context: Context) => {
  if (typeof resolver === 'function') {
    return resolver(context)
  }

  return Effect.succeed(resolver)
}

export const makeKnowledgeSearchTool = <Context>(
  searcher: KnowledgeSearcher,
  options: MakeKnowledgeSearchToolOptions<Context>
): ToolRegistration<Context> => {
  const name = options.name ?? 'search_knowledge'

  return makeTool({
    name,
    description: options.description ?? 'Search the configured knowledge search.',
    parameters: KnowledgeSearchToolParams,
    access: 'read',
    invalidParamsMessage: error => error instanceof Error ? error.message : String(error),
    execute: input =>
      resolveScope(options.scope, input.context).pipe(
        Effect.flatMap(scope =>
          searcher.search({
            scope,
            query: input.params.query,
            limit: options.limit,
            minScore: options.minScore,
            contextChunks: options.contextChunks
          })
        ),
        Effect.map(results => packKnowledgeSearchContext(input.params.query, results)),
        Effect.map(
          context =>
            ToolResult.make({
              toolCallId: input.call.id,
              content: context.text,
              structuredContent: context
            })
        ),
        Effect.mapError(error => {
          if (isToolError(error)) {
            return error
          }

          return new ToolError({
            tool: input.call.name,
            message: error.message,
            cause: 'execution'
          })
        })
      )
  })
}
