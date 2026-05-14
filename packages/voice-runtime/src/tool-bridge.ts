import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolExecutor, type ToolError } from '@yolk/agent/loop'
import { ToolCall, type Content } from '@yolk/agent/protocol'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))
const maxVoiceToolResultCharacters = 6000

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
  Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(raw).pipe(
    Effect.mapError(
      error =>
        new VoiceToolBridgeError({
          message: `Invalid tool arguments JSON: ${unknownToMessage(error)}`
        })
    )
  )

const stringifyToolOutput = (value: unknown) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(value).pipe(
    Effect.mapError(
      error =>
        new VoiceToolBridgeError({
          message: `Could not serialize tool output: ${unknownToMessage(error)}`
        })
    )
  )

const truncateVoiceToolResult = (value: string) => {
  if (value.length <= maxVoiceToolResultCharacters) {
    return value
  }

  return `${value.slice(0, maxVoiceToolResultCharacters)}\n\n[truncated for voice; summarize from available excerpt]`
}

const contentToSerializable = (content: Content): unknown =>
  typeof content === 'string' ? truncateVoiceToolResult(content) : content

const makeVoiceToolExecutionResult = (toolCallId: string, output: string) =>
  VoiceToolExecutionResult.make({ toolCallId, output })

const makeToolErrorResult = (toolCallId: string, error: ToolError | VoiceToolBridgeError) =>
  stringifyToolOutput({ error: error.message }).pipe(
    Effect.catchTag('VoiceToolBridgeError', () => Effect.succeed('{"error":"Tool failed"}')),
    Effect.map(output => makeVoiceToolExecutionResult(toolCallId, output))
  )

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
