import * as Schema from 'effect/Schema'
import {
  HitlRequest,
  HitlResponse,
  ToolApprovalRequest,
  ToolApprovalResponse
} from '@yolk-sdk/agent/protocol'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

// --- Session config -------------------------------------------------------

export class VoiceServerVadTurnDetection extends Schema.TaggedClass<VoiceServerVadTurnDetection>()(
  'ServerVad',
  {
    threshold: Schema.optional(Schema.Number),
    prefixPaddingMs: Schema.optional(Schema.Number),
    silenceDurationMs: Schema.optional(Schema.Number)
  }
) {}

export class VoiceNoTurnDetection extends Schema.TaggedClass<VoiceNoTurnDetection>()(
  'NoTurnDetection',
  {}
) {}

export const VoiceTurnDetection = Schema.Union([VoiceServerVadTurnDetection, VoiceNoTurnDetection])
export type VoiceTurnDetection = typeof VoiceTurnDetection.Type

export class VoiceInputTranscription extends Schema.Class<VoiceInputTranscription>(
  'VoiceInputTranscription'
)({
  model: NonEmptyTrimmedString,
  language: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String)
}) {}

/**
 * Provider-neutral live voice session configuration.
 *
 * Hosts build this once per session; provider adapters lower it into vendor
 * session payloads. Tools are normal Yolk `ToolDef`-shaped definitions passed
 * separately by the host toolset resolution, so this config stays wire-plain.
 */
export class VoiceSessionConfig extends Schema.Class<VoiceSessionConfig>('VoiceSessionConfig')({
  model: NonEmptyTrimmedString,
  instructions: Schema.String,
  voice: Schema.optional(Schema.String),
  turnDetection: Schema.optional(VoiceTurnDetection),
  inputTranscription: Schema.optional(VoiceInputTranscription)
}) {}

// --- Errors ---------------------------------------------------------------

export const VoiceSessionErrorCode = Schema.Literals([
  'permission_denied',
  'session_setup_failed',
  'transport_failed',
  'provider_error',
  'protocol_error',
  'unknown'
])
export type VoiceSessionErrorCode = typeof VoiceSessionErrorCode.Type

/**
 * Safe, host-visible voice session failure. Never carries raw provider
 * payloads; providers must map failures into `code` + safe `message`.
 */
export class VoiceSessionError extends Schema.TaggedErrorClass<VoiceSessionError>()(
  'VoiceSessionError',
  {
    code: VoiceSessionErrorCode,
    message: Schema.String
  }
) {}

// --- Commands -------------------------------------------------------------

export class VoiceConnect extends Schema.TaggedClass<VoiceConnect>()('Connect', {}) {}

export class VoiceDisconnect extends Schema.TaggedClass<VoiceDisconnect>()('Disconnect', {}) {}

export class VoiceStartAudioInput extends Schema.TaggedClass<VoiceStartAudioInput>()(
  'StartAudioInput',
  {}
) {}

export class VoiceStopAudioInput extends Schema.TaggedClass<VoiceStopAudioInput>()(
  'StopAudioInput',
  {}
) {}

export class VoiceSendText extends Schema.TaggedClass<VoiceSendText>()('SendText', {
  text: NonEmptyTrimmedString
}) {}

export class VoiceSubmitToolOutput extends Schema.TaggedClass<VoiceSubmitToolOutput>()(
  'SubmitToolOutput',
  {
    callId: NonEmptyTrimmedString,
    output: Schema.String
  }
) {}

export class VoiceSubmitHitlResponse extends Schema.TaggedClass<VoiceSubmitHitlResponse>()(
  'SubmitHitlResponse',
  {
    response: HitlResponse
  }
) {}

/**
 * Client-side voice session commands. `SubmitHitlResponse` carries protocol
 * approval responses; question responses are deferred from voice MVP.
 */
export const VoiceCommand = Schema.Union([
  VoiceConnect,
  VoiceDisconnect,
  VoiceStartAudioInput,
  VoiceStopAudioInput,
  VoiceSendText,
  VoiceSubmitToolOutput,
  VoiceSubmitHitlResponse
])
export type VoiceCommand = typeof VoiceCommand.Type

// --- Events ---------------------------------------------------------------

export class VoiceSessionOpening extends Schema.TaggedClass<VoiceSessionOpening>()(
  'SessionOpening',
  {}
) {}

/**
 * Provider session was created or its effective config updated. Optional
 * fields carry provider-confirmed session config when available.
 */
export class VoiceSessionOpened extends Schema.TaggedClass<VoiceSessionOpened>()('SessionOpened', {
  model: Schema.NullOr(Schema.String),
  transcriptionModel: Schema.optional(Schema.NullOr(Schema.String)),
  transcriptionLanguage: Schema.optional(Schema.NullOr(Schema.String))
}) {}

export class VoiceSessionClosed extends Schema.TaggedClass<VoiceSessionClosed>()('SessionClosed', {
  reason: Schema.NullOr(Schema.String)
}) {}

export class VoiceAudioInputStarted extends Schema.TaggedClass<VoiceAudioInputStarted>()(
  'AudioInputStarted',
  {}
) {}

export class VoiceAudioInputStopped extends Schema.TaggedClass<VoiceAudioInputStopped>()(
  'AudioInputStopped',
  {}
) {}

export class VoiceUserTranscriptDelta extends Schema.TaggedClass<VoiceUserTranscriptDelta>()(
  'UserTranscriptDelta',
  {
    itemId: Schema.NullOr(Schema.String),
    delta: Schema.String
  }
) {}

export class VoiceUserTranscriptFinal extends Schema.TaggedClass<VoiceUserTranscriptFinal>()(
  'UserTranscriptFinal',
  {
    itemId: Schema.NullOr(Schema.String),
    text: Schema.String
  }
) {}

export class VoiceAssistantTranscriptDelta extends Schema.TaggedClass<VoiceAssistantTranscriptDelta>()(
  'AssistantTranscriptDelta',
  {
    itemId: Schema.NullOr(Schema.String),
    responseId: Schema.NullOr(Schema.String),
    delta: Schema.String
  }
) {}

export class VoiceAssistantTranscriptFinal extends Schema.TaggedClass<VoiceAssistantTranscriptFinal>()(
  'AssistantTranscriptFinal',
  {
    itemId: Schema.NullOr(Schema.String),
    responseId: Schema.NullOr(Schema.String),
    text: Schema.NullOr(Schema.String)
  }
) {}

export class VoiceAssistantAudioStarted extends Schema.TaggedClass<VoiceAssistantAudioStarted>()(
  'AssistantAudioStarted',
  {
    responseId: Schema.NullOr(Schema.String)
  }
) {}

export class VoiceAssistantAudioStopped extends Schema.TaggedClass<VoiceAssistantAudioStopped>()(
  'AssistantAudioStopped',
  {
    responseId: Schema.NullOr(Schema.String)
  }
) {}

export class VoiceInterrupted extends Schema.TaggedClass<VoiceInterrupted>()('Interrupted', {
  responseId: Schema.NullOr(Schema.String)
}) {}

/**
 * One provider-requested host tool call. Arguments stay a raw JSON string;
 * the server-side tool bridge parses/validates before execution.
 */
export class VoiceToolCall extends Schema.Class<VoiceToolCall>('VoiceToolCall')({
  callId: NonEmptyTrimmedString,
  name: NonEmptyTrimmedString,
  argumentsJson: Schema.String
}) {}

/**
 * Provider requested one or more host tool calls in the same model turn.
 * Same-turn calls form one batch: outputs are submitted per call and the
 * follow-up response turn is requested once per batch.
 */
export class VoiceToolCallsRequested extends Schema.TaggedClass<VoiceToolCallsRequested>()(
  'ToolCallsRequested',
  {
    calls: Schema.NonEmptyArray(VoiceToolCall)
  }
) {}

export class VoiceToolCallExecuting extends Schema.TaggedClass<VoiceToolCallExecuting>()(
  'ToolCallExecuting',
  {
    callId: NonEmptyTrimmedString
  }
) {}

export class VoiceToolCallCompleted extends Schema.TaggedClass<VoiceToolCallCompleted>()(
  'ToolCallCompleted',
  {
    callId: NonEmptyTrimmedString,
    output: Schema.String
  }
) {}

export class VoiceToolCallFailed extends Schema.TaggedClass<VoiceToolCallFailed>()(
  'ToolCallFailed',
  {
    callId: NonEmptyTrimmedString,
    message: Schema.String
  }
) {}

export class VoiceAwaitingInput extends Schema.TaggedClass<VoiceAwaitingInput>()('AwaitingInput', {
  requests: Schema.NonEmptyArray(HitlRequest)
}) {}

export class VoiceErrorEvent extends Schema.TaggedClass<VoiceErrorEvent>()('Error', {
  code: VoiceSessionErrorCode,
  message: Schema.String
}) {}

/**
 * Provider-neutral voice session events. Separate from `AgentEvent` by
 * design; durable projection into protocol messages/events is a host-side
 * step with its own helpers.
 */
export const VoiceEvent = Schema.Union([
  VoiceSessionOpening,
  VoiceSessionOpened,
  VoiceSessionClosed,
  VoiceAudioInputStarted,
  VoiceAudioInputStopped,
  VoiceUserTranscriptDelta,
  VoiceUserTranscriptFinal,
  VoiceAssistantTranscriptDelta,
  VoiceAssistantTranscriptFinal,
  VoiceAssistantAudioStarted,
  VoiceAssistantAudioStopped,
  VoiceInterrupted,
  VoiceToolCallsRequested,
  VoiceToolCallExecuting,
  VoiceToolCallCompleted,
  VoiceToolCallFailed,
  VoiceAwaitingInput,
  VoiceErrorEvent
])
export type VoiceEvent = typeof VoiceEvent.Type

// --- Tool call outcomes ------------------------------------------------------

/** Server executed the tool; `output` is the model-visible JSON string. */
export class VoiceToolCallExecutedOutcome extends Schema.TaggedClass<VoiceToolCallExecutedOutcome>()(
  'Executed',
  {
    callId: NonEmptyTrimmedString,
    output: Schema.String
  }
) {}

/**
 * Tool policy requires manual approval. The tool has not executed; the host
 * surfaces the protocol approval request and resumes through HITL responses.
 */
export class VoiceToolCallApprovalRequiredOutcome extends Schema.TaggedClass<VoiceToolCallApprovalRequiredOutcome>()(
  'ApprovalRequired',
  {
    request: ToolApprovalRequest
  }
) {}

/** Tool call was denied by policy or an explicit approval denial. */
export class VoiceToolCallDeniedOutcome extends Schema.TaggedClass<VoiceToolCallDeniedOutcome>()(
  'Denied',
  {
    callId: NonEmptyTrimmedString,
    /** Model-visible denial output JSON string. */
    output: Schema.String,
    reason: Schema.optional(Schema.String)
  }
) {}

/** Server-side voice tool endpoint response contract. */
export const VoiceToolCallOutcome = Schema.Union([
  VoiceToolCallExecutedOutcome,
  VoiceToolCallApprovalRequiredOutcome,
  VoiceToolCallDeniedOutcome
])
export type VoiceToolCallOutcome = typeof VoiceToolCallOutcome.Type

/**
 * Server-side voice tool endpoint request contract. `sessionId` binds the
 * call to a server-created voice session; hosts must authenticate the caller
 * and re-resolve tool policy for that session before execution. `approval`
 * carries the HITL response when resuming an approval-gated call.
 */
export class VoiceSessionToolCallRequest extends Schema.Class<VoiceSessionToolCallRequest>(
  'VoiceSessionToolCallRequest'
)({
  sessionId: NonEmptyTrimmedString,
  callId: NonEmptyTrimmedString,
  name: NonEmptyTrimmedString,
  argumentsJson: Schema.String,
  approval: Schema.optional(ToolApprovalResponse)
}) {}
