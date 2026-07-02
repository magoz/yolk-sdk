import { Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import type { ToolExecutor } from '@yolk-sdk/agent/loop'
import { ToolApprovalRequest, ToolCall, type ToolDef } from '@yolk-sdk/agent/protocol'
import {
  VoiceToolCallApprovalRequiredOutcome,
  VoiceToolCallExecutedOutcome,
  type VoiceToolCall,
  type VoiceToolCallOutcome
} from './protocol.ts'
import { executeVoiceToolCall, VoiceToolCallRequest } from './tool-bridge.ts'

/** Pure approval decision for one voice tool call against a resolved toolset. */
export type VoiceToolCallDecision =
  | { readonly _tag: 'Execute' }
  | { readonly _tag: 'RequireApproval'; readonly request: ToolApprovalRequest }

/** Matches the loop's deterministic approval request id convention. */
export const voiceApprovalRequestId = (callId: string) => `approval:${callId}`

const decodeArgumentsOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

const argumentsForApprovalDisplay = (argumentsJson: string): unknown =>
  Option.getOrElse(decodeArgumentsOption(argumentsJson), () => ({ argumentsJson }))

/**
 * Decide whether a voice tool call may execute now or requires manual
 * approval, based on `ToolDef.approval` in the session's resolved toolset.
 * Unknown tools fall through to `Execute`; the executor returns a
 * model-visible not-found failure. Approval request params are best-effort
 * display data; execution still parses/validates through the tool bridge.
 */
export const decideVoiceToolCall = (
  tools: ReadonlyArray<ToolDef>,
  call: VoiceToolCall
): VoiceToolCallDecision => {
  const def = tools.find(tool => tool.name === call.name)

  if (def?.approval?.mode !== 'manual') {
    return { _tag: 'Execute' }
  }

  return {
    _tag: 'RequireApproval',
    request: ToolApprovalRequest.make({
      requestId: voiceApprovalRequestId(call.callId),
      toolCallId: call.callId,
      call: ToolCall.make({
        id: call.callId,
        name: call.name,
        params: argumentsForApprovalDisplay(call.argumentsJson)
      }),
      policy: def.approval
    })
  }
}

const executeCall = (call: VoiceToolCall) =>
  executeVoiceToolCall(
    VoiceToolCallRequest.make({
      callId: call.callId,
      name: call.name,
      arguments: call.argumentsJson
    })
  ).pipe(
    Effect.map(result =>
      VoiceToolCallExecutedOutcome.make({
        callId: result.toolCallId,
        output: result.output
      })
    )
  )

/**
 * Server-side voice tool handler: applies approval policy from the session's
 * resolved toolset, then executes through the ambient `ToolExecutor`. Hosts
 * own authentication, session binding, toolset resolution, and persistence
 * around this call.
 */
export const handleVoiceToolCall = (input: {
  readonly call: VoiceToolCall
  readonly tools: ReadonlyArray<ToolDef>
}): Effect.Effect<VoiceToolCallOutcome, never, ToolExecutor> =>
  Effect.suspend((): Effect.Effect<VoiceToolCallOutcome, never, ToolExecutor> => {
    const decision = decideVoiceToolCall(input.tools, input.call)

    switch (decision._tag) {
      case 'RequireApproval':
        return Effect.succeed(
          VoiceToolCallApprovalRequiredOutcome.make({ request: decision.request })
        )
      case 'Execute':
        return executeCall(input.call)
    }
  })
