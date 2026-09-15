import { Effect, Predicate } from 'effect'
import { VoiceToolDispatch } from '../background-execution-internal.ts'
import * as Schema from 'effect/Schema'
import { ToolExecutor, type ToolError } from '@yolk-sdk/agent/loop'
import { ToolCall, type Content } from '@yolk-sdk/agent/protocol'

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

const unknownToMessage = (error: Schema.SchemaError) => String(error)

const parseToolArguments = (raw: string) =>
  Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(raw).pipe(
    Effect.mapError(
      error =>
        new VoiceToolBridgeError({
          message: `Invalid tool arguments JSON: ${unknownToMessage(error)}`
        })
    )
  )

const toolOutputSerializeError = (error: Schema.SchemaError) =>
  new VoiceToolBridgeError({
    message: `Could not serialize tool output: ${unknownToMessage(error)}`
  })

const truncateVoiceToolResult = (value: string) => {
  if (value.length <= maxVoiceToolResultCharacters) {
    return value
  }

  return `${value.slice(0, maxVoiceToolResultCharacters)}\n\n[truncated for voice; summarize from available excerpt]`
}

const contentToSerializable = (content: Content): Content =>
  Predicate.isString(content) ? truncateVoiceToolResult(content) : content

const stringifyToolSuccessOutput = (content: Content) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)({
    result: contentToSerializable(content)
  }).pipe(Effect.mapError(toolOutputSerializeError))

const makeVoiceToolExecutionResult = (toolCallId: string, output: string) =>
  VoiceToolExecutionResult.make({ toolCallId, output })

const makeToolErrorResult = (toolCallId: string, error: ToolError | VoiceToolBridgeError) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)({ error: error.message }).pipe(
    Effect.mapError(toolOutputSerializeError),
    Effect.catchTag('VoiceToolBridgeError', () => Effect.succeed('{"error":"Tool failed"}')),
    Effect.map(output => makeVoiceToolExecutionResult(toolCallId, output))
  )

export const executeVoiceToolCall = (input: VoiceToolCallRequest) =>
  Effect.gen(function* () {
    const executor = yield* ToolExecutor
    const params = yield* parseToolArguments(input.arguments)

    const result = yield* Effect.suspend(() =>
      executor.execute(
        ToolCall.make({
          id: input.callId,
          name: input.name,
          params
        })
      )
    ).pipe(Effect.provideService(VoiceToolDispatch, true))

    const output = yield* stringifyToolSuccessOutput(result.content)

    return makeVoiceToolExecutionResult(input.callId, output)
  }).pipe(
    Effect.catchTag('ToolError', error => makeToolErrorResult(input.callId, error)),
    Effect.catchTag('VoiceToolBridgeError', error => makeToolErrorResult(input.callId, error))
  )
