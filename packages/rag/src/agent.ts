import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk/agent/loop'
import { makeTool, type ToolRegistration } from '@yolk/agent/tools'
import { ToolResult } from '@yolk/agent/protocol'
import type { RagSearchScope } from './documents.ts'
import type { RagRetriever } from './retrieval.ts'
import { packRagContext } from './retrieval.ts'

const RagToolParams = Schema.Struct({
  query: Schema.Trimmed.pipe(
    Schema.check(Schema.isNonEmpty()),
    Schema.annotate({ description: 'Search query for the configured knowledge index.' })
  )
})

const isToolError = Schema.is(ToolError)

export type RagToolScopeResolver<Context> =
  | RagSearchScope
  | ((context: Context) => Effect.Effect<RagSearchScope, ToolError>)

export type MakeRagToolOptions<Context> = {
  readonly scope: RagToolScopeResolver<Context>
  readonly name?: string
  readonly description?: string
  readonly limit?: number
  readonly minScore?: number
  readonly contextChunks?: number
}

const resolveScope = <Context>(resolver: RagToolScopeResolver<Context>, context: Context) => {
  if (typeof resolver === 'function') {
    return resolver(context)
  }

  return Effect.succeed(resolver)
}

export const makeRagTool = <Context>(
  retriever: RagRetriever,
  options: MakeRagToolOptions<Context>
): ToolRegistration<Context> => {
  const name = options.name ?? 'search_knowledge'

  return makeTool({
    name,
    description: options.description ?? 'Search the configured knowledge index.',
    parameters: RagToolParams,
    access: 'read',
    invalidParamsMessage: error => error instanceof Error ? error.message : String(error),
    execute: input =>
      resolveScope(options.scope, input.context).pipe(
        Effect.flatMap(scope =>
          retriever.retrieve({
            scope,
            query: input.params.query,
            limit: options.limit,
            minScore: options.minScore,
            contextChunks: options.contextChunks
          })
        ),
        Effect.map(results => packRagContext(input.params.query, results)),
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
