import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk/agent/loop'
import type { ToolRegistration } from '@yolk/agent/tools'
import { ToolDef, ToolResult } from '@yolk/agent/protocol'
import type { RagRetriever } from './retrieval.ts'
import { packRagContext } from './retrieval.ts'

const RagToolParams = Schema.Struct({
  query: Schema.String
})

export type MakeRagToolOptions = {
  readonly name: string
  readonly description: string
  readonly limit: number
}

export const defaultRagToolOptions: MakeRagToolOptions = {
  name: 'search_knowledge',
  description: 'Search the configured knowledge index.',
  limit: 8
}

export const makeRagTool = <Context>(
  retriever: RagRetriever,
  options: MakeRagToolOptions = defaultRagToolOptions
): ToolRegistration<Context> => ({
  def: new ToolDef({
    name: options.name,
    description: options.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string' }
      }
    }
  }),
  access: 'read',
  execute: input =>
    Schema.decodeUnknownEffect(RagToolParams)(input.call.params).pipe(
      Effect.flatMap(params =>
        retriever.retrieve({ scope: { _tag: 'RagSets', ids: [] }, query: params.query, limit: options.limit }).pipe(
          Effect.map(results => packRagContext(params.query, results))
        )
      ),
      Effect.map(context =>
        new ToolResult({
          toolCallId: input.call.id,
          content: context.text,
          structuredContent: context
        })
      ),
      Effect.mapError(error =>
        new ToolError({
          tool: input.call.name,
          message: error.message,
          cause: 'execution'
        })
      )
    )
})
