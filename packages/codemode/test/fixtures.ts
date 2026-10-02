import { Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolCall, ToolResult, contentText, type Content } from '@yolk-sdk/agent/protocol'
import {
  makeTool,
  resolveTools,
  type SchemaToolExecutionInput,
  type ToolModule,
  type ToolRegistration
} from '@yolk-sdk/agent/tools'

export type TestContext = { readonly tenant: string }

export const context: TestContext = { tenant: 'tenant_1' }

export const QueryParams = Schema.Struct({ query: Schema.String })

export const HitsOutput = Schema.Struct({
  hits: Schema.Array(Schema.Struct({ id: Schema.String, score: Schema.Number }))
})

type Exposure =
  | { readonly callableBy?: 'all' | 'model' }
  | { readonly callableBy: 'codemode'; readonly discovery?: 'listed' | 'search' }

export type ToolLog = Array<string>

/** A tool that records `<name>:<query>:<tenant>` and answers with text and hits. */
export const queryTool = (
  name: string,
  options: {
    readonly exposure?: Exposure
    readonly structured?: boolean
    readonly description?: string
    readonly log?: ToolLog
    readonly fail?: boolean
  } = {}
): ToolRegistration<TestContext> => {
  const answer = (input: SchemaToolExecutionInput<TestContext, typeof QueryParams.Type>) => {
    const { call, context, params } = input

    options.log?.push(`${name}:${params.query}:${context.tenant}`)

    return Effect.succeed(
      options.fail === true
        ? ToolResult.make({
            toolCallId: call.id,
            content: `${name} failed for ${params.query}`,
            isError: true
          })
        : ToolResult.make({
            toolCallId: call.id,
            content: `${name}:${params.query}`,
            structuredContent: { hits: [{ id: params.query, score: 1 }] }
          })
    )
  }

  const base = {
    name,
    description: options.description ?? `${name} tool`,
    parameters: QueryParams,
    access: 'read' as const,
    execute: answer,
    ...options.exposure
  }

  return options.structured === true
    ? makeTool<TestContext, typeof QueryParams>({ ...base, output: HitsOutput })
    : makeTool<TestContext, typeof QueryParams>(base)
}

export const moduleOf = (
  id: string,
  tools: ReadonlyArray<ToolRegistration<TestContext>>
): ToolModule<TestContext> => ({ id, tools })

export const runCode = (
  modules: ReadonlyArray<ToolModule<TestContext>>,
  code: string,
  options: { readonly name?: string; readonly callId?: string } = {}
) =>
  Effect.gen(function* () {
    const toolSet = yield* resolveTools(modules, context)

    return yield* toolSet.execute(
      ToolCall.make({
        id: options.callId ?? 'call_1',
        name: options.name ?? 'codemode',
        params: { code }
      })
    )
  })

export const text = (content: Content) =>
  Predicate.isString(content) ? content : contentText(content)
