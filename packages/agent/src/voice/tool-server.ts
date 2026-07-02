import { Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import type { ToolExecutor } from '@yolk-sdk/agent/loop'
import {
  ToolApprovalRequest,
  ToolCall,
  type ToolApprovalResponse,
  type ToolDef
} from '@yolk-sdk/agent/protocol'
import {
  VoiceToolCallApprovalRequiredOutcome,
  VoiceToolCallDeniedOutcome,
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

const encodeDenialOutput = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)

/** Model-visible denial output for a denied voice tool call. */
export const voiceToolDenialOutput = (call: VoiceToolCall, reason?: string) =>
  encodeDenialOutput({
    error: `Tool ${call.name} was denied${reason === undefined ? '' : `: ${reason}`}. Do not retry it.`
  }).pipe(Effect.orElseSucceed(() => '{"error":"Tool was denied. Do not retry it."}'))

const approvalMatchesCall = (approval: ToolApprovalResponse, call: VoiceToolCall) =>
  approval.toolCallId === call.callId &&
  approval.requestId === voiceApprovalRequestId(call.callId)

/**
 * Server-side voice tool handler: applies approval policy from the session's
 * resolved toolset, then executes through the ambient `ToolExecutor`.
 *
 * Approval resume: when the call requires manual approval, a matching
 * approved `approval` response executes the tool and a matching denial
 * returns a `Denied` outcome with model-visible output. Missing or
 * mismatched responses return `ApprovalRequired` again; the tool never
 * executes without a valid matching approval. Hosts own authentication,
 * session binding, toolset resolution, and persistence around this call.
 */
export const handleVoiceToolCall = (input: {
  readonly call: VoiceToolCall
  readonly tools: ReadonlyArray<ToolDef>
  readonly approval?: ToolApprovalResponse
}): Effect.Effect<VoiceToolCallOutcome, never, ToolExecutor> =>
  Effect.suspend((): Effect.Effect<VoiceToolCallOutcome, never, ToolExecutor> => {
    const decision = decideVoiceToolCall(input.tools, input.call)

    switch (decision._tag) {
      case 'Execute':
        return executeCall(input.call)
      case 'RequireApproval': {
        if (input.approval === undefined || !approvalMatchesCall(input.approval, input.call)) {
          return Effect.succeed(
            VoiceToolCallApprovalRequiredOutcome.make({ request: decision.request })
          )
        }

        if (input.approval.decision === 'denied') {
          return voiceToolDenialOutput(input.call, input.approval.reason).pipe(
            Effect.map(output =>
              VoiceToolCallDeniedOutcome.make({
                callId: input.call.callId,
                output,
                reason: input.approval?.reason
              })
            )
          )
        }

        return executeCall(input.call)
      }
    }
  })
