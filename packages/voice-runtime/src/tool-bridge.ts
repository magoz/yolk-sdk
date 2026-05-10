import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolExecutor, type ToolError } from '@yolk/agent-loop'
import { ToolCall, type Content } from '@yolk/protocol'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

export class VoiceToolCallRequest extends Schema.Class<VoiceToolCallRequest>(
  'VoiceToolCallRequest'
)({
  callId: NonEmptyTrimmedString,
  name: NonEmptyTrimmedString,
  arguments: Schema.String
}) {}

export class VoiceToolExecutionResult extends Schema.Class<VoiceToolExecutionResult>(
  'VoiceToolExecutionResult'
)({
  toolCallId: Schema.String,
  output: Schema.String
}) {}

export class VoiceToolBridgeError extends Schema.TaggedErrorClass<VoiceToolBridgeError>()(
  'VoiceToolBridgeError',
  {
    message: Schema.String
  }
) {}

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const parseToolArguments = (raw: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(raw),
    catch: error =>
      new VoiceToolBridgeError({
        message: `Invalid tool arguments JSON: ${unknownToMessage(error)}`
      })
  })

const stringifyToolOutput = (value: unknown) =>
  Effect.try({
    try: () => JSON.stringify(value),
    catch: error =>
      new VoiceToolBridgeError({
        message: `Could not serialize tool output: ${unknownToMessage(error)}`
      })
  })

const contentToSerializable = (content: Content): unknown =>
  typeof content === 'string' ? content : content

const makeVoiceToolExecutionResult = (toolCallId: string, output: string) =>
  VoiceToolExecutionResult.make({ toolCallId, output })

const makeErrorOutput = (message: string) => JSON.stringify({ error: message })

const makeToolErrorResult = (toolCallId: string, error: ToolError | VoiceToolBridgeError) =>
  Effect.succeed(makeVoiceToolExecutionResult(toolCallId, makeErrorOutput(error.message)))

export const executeVoiceToolCall = (input: VoiceToolCallRequest) =>
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

    return makeVoiceToolExecutionResult(input.callId, output)
  }).pipe(
    Effect.catchTag('ToolError', error => makeToolErrorResult(input.callId, error)),
    Effect.catchTag('VoiceToolBridgeError', error => makeToolErrorResult(input.callId, error))
  )
