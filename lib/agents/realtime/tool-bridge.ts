import { Data, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolExecutor, type ToolError } from '@yolk/agent-loop'
import { ToolCall, type Content } from '@yolk/protocol'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

export class RealtimeToolCallRequest extends Schema.Class<RealtimeToolCallRequest>(
  'RealtimeToolCallRequest'
)({
  callId: NonEmptyTrimmedString,
  name: NonEmptyTrimmedString,
  arguments: Schema.String
}) {}

export class RealtimeToolBridgeError extends Data.TaggedError('RealtimeToolBridgeError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type RealtimeFunctionCallOutputEvent = {
  readonly type: 'conversation.item.create'
  readonly item: {
    readonly type: 'function_call_output'
    readonly call_id: string
    readonly output: string
  }
}

export type RealtimeToolExecutionResponse = {
  readonly event: RealtimeFunctionCallOutputEvent
}

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const parseToolArguments = (raw: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(raw),
    catch: error =>
      new RealtimeToolBridgeError({
        message: `Invalid tool arguments JSON: ${unknownToMessage(error)}`,
        cause: error
      })
  })

const stringifyToolOutput = (value: unknown) =>
  Effect.try({
    try: () => JSON.stringify(value),
    catch: error =>
      new RealtimeToolBridgeError({
        message: `Could not serialize tool output: ${unknownToMessage(error)}`,
        cause: error
      })
  })

const contentToSerializable = (content: Content): unknown =>
  typeof content === 'string' ? content : content

export const makeRealtimeFunctionCallOutputEvent = (
  callId: string,
  output: string
): RealtimeFunctionCallOutputEvent => ({
  type: 'conversation.item.create',
  item: {
    type: 'function_call_output',
    call_id: callId,
    output
  }
})

const makeRealtimeToolResponse = (callId: string, output: string): RealtimeToolExecutionResponse => ({
  event: makeRealtimeFunctionCallOutputEvent(callId, output)
})

const makeErrorOutput = (message: string) => JSON.stringify({ error: message })

const makeToolErrorResponse = (callId: string, error: ToolError | RealtimeToolBridgeError) =>
  Effect.succeed(makeRealtimeToolResponse(callId, makeErrorOutput(error.message)))

export const executeRealtimeToolCall = (input: RealtimeToolCallRequest) =>
  Effect.gen(function* () {
    const executor = yield* ToolExecutor
    const params = yield* parseToolArguments(input.arguments)
    const result = yield* executor.execute(
      ToolCall.make({
        id: input.callId,
        name: input.name,
        params
      })
    )
    const output = yield* stringifyToolOutput({ result: contentToSerializable(result.content) })

    return makeRealtimeToolResponse(input.callId, output)
  }).pipe(
    Effect.catchTag('ToolError', error => makeToolErrorResponse(input.callId, error)),
    Effect.catchTag('RealtimeToolBridgeError', error => makeToolErrorResponse(input.callId, error))
  )
