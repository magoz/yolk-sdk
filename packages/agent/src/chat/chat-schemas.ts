import { Data } from 'effect'
import * as Schema from 'effect/Schema'
import {
  AgentStatus,
  BackgroundToolAccepted,
  Content,
  InputRequest,
  InputResponse,
  InteractionRequest,
  InteractionResponse,
  MessageAnnotations,
  MessageAuthor,
  QuestionRequest,
  QuestionResponse,
  SubagentStatusEntry,
  ToolApprovalRequest,
  ToolCall,
  ToolResult,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import { AgentExecutionsSchema } from '../client/executions.ts'
import { HitlPauses } from '../client/hitl-pauses.ts'
import { AgentChatSessionEvent } from './chat-session-events.ts'

/*
 * The chat projection's state as Effect Schemas: the types the projection uses are derived from
 * them, and `Schema.toCodecJson(schema)` gives each a JSON form (options as `{ _tag, value }`,
 * `seenEventIds` as an array of ids, `hitlPauses` as an array of entries) for hosts that keep or
 * send it. The tagged unions keep their `Data.taggedEnum` constructors under the type's name
 * (`ChatToolState.Running({ startedAtMs })`); their Schemas carry a `Schema` suffix, as every
 * Schema here does.
 */

export const ChatPartStateSchema = Schema.Literals(['streaming', 'done'])

export type ChatPartState = typeof ChatPartStateSchema.Type

/** A tool part's state: where its call is between the model's input and its result. */
export const ChatToolStateSchema = Schema.Union([
  Schema.TaggedStruct('Called', {}),
  Schema.TaggedStruct('InputStreaming', { input: Schema.String }),
  Schema.TaggedStruct('ApprovalRequested', { request: Schema.optional(ToolApprovalRequest) }),
  Schema.TaggedStruct('Denied', {
    reason: Schema.String,
    /** The approval request it denies, when that was seen (it names the denied call). */
    request: Schema.optional(ToolApprovalRequest)
  }),
  Schema.TaggedStruct('QuestionRequested', { request: QuestionRequest }),
  Schema.TaggedStruct('QuestionAnswered', {
    response: QuestionResponse,
    request: Schema.optional(QuestionRequest)
  }),
  Schema.TaggedStruct('QuestionCancelled', {
    response: QuestionResponse,
    request: Schema.optional(QuestionRequest)
  }),
  Schema.TaggedStruct('InputRequested', { request: InputRequest }),
  Schema.TaggedStruct('InputSubmitted', {
    response: InputResponse,
    request: Schema.optional(InputRequest)
  }),
  Schema.TaggedStruct('InputCancelled', {
    response: InputResponse,
    request: Schema.optional(InputRequest)
  }),
  Schema.TaggedStruct('InteractionRequested', { request: InteractionRequest }),
  Schema.TaggedStruct('InteractionSubmitted', {
    response: InteractionResponse,
    request: Schema.optional(InteractionRequest)
  }),
  Schema.TaggedStruct('InteractionCancelled', {
    response: InteractionResponse,
    request: Schema.optional(InteractionRequest)
  }),
  Schema.TaggedStruct('Running', { startedAtMs: Schema.Number }),
  Schema.TaggedStruct('Completed', {
    result: ToolResult,
    startedAtMs: Schema.optional(Schema.Number),
    endedAtMs: Schema.optional(Schema.Number)
  }),
  Schema.TaggedStruct('Accepted', {
    result: ToolResult,
    resultEnvelope: Schema.optional(
      Schema.Struct({
        createdAtMs: Schema.optional(Schema.Number),
        author: Schema.optional(MessageAuthor),
        annotations: Schema.optional(MessageAnnotations)
      })
    ),
    startedAtMs: Schema.optional(Schema.Number),
    endedAtMs: Schema.optional(Schema.Number)
  }),
  Schema.TaggedStruct('Errored', {
    message: Schema.String,
    startedAtMs: Schema.optional(Schema.Number),
    endedAtMs: Schema.optional(Schema.Number)
  }),
  Schema.TaggedStruct('ProviderCompleted', { result: ToolResult })
])

export type ChatToolState = typeof ChatToolStateSchema.Type

export const ChatToolState = Data.taggedEnum<ChatToolState>()

/** One part of a chat message: text, reasoning, a tool call with its state, a result, an error. */
export const AgentChatPartSchema = Schema.Union([
  Schema.TaggedStruct('Text', { id: Schema.String, content: Content, state: ChatPartStateSchema }),
  Schema.TaggedStruct('Reasoning', {
    id: Schema.String,
    text: Schema.String,
    state: ChatPartStateSchema
  }),
  Schema.TaggedStruct('ToolCall', {
    id: Schema.String,
    call: ToolCall,
    state: ChatToolStateSchema
  }),
  Schema.TaggedStruct('ToolResult', {
    id: Schema.String,
    toolCallId: Schema.String,
    name: Schema.String,
    content: Content,
    isError: Schema.optional(Schema.Boolean),
    acceptance: Schema.optional(BackgroundToolAccepted),
    structuredContent: Schema.optional(Schema.Unknown)
  }),
  Schema.TaggedStruct('Error', { id: Schema.String, message: Schema.String })
])

export type AgentChatPart = typeof AgentChatPartSchema.Type

export const AgentChatPart = Data.taggedEnum<AgentChatPart>()

export const AgentChatMessageSchema = Schema.Struct({
  id: Schema.String,
  turnId: Schema.String,
  sequence: Schema.Number,
  role: Schema.Literals(['user', 'assistant', 'system']),
  createdAtMs: Schema.optional(Schema.Number),
  author: Schema.optional(MessageAuthor),
  annotations: Schema.optional(MessageAnnotations),
  parts: Schema.Array(AgentChatPartSchema),
  /**
   * Host instruction messages (ADR 0007) that followed this message in the transcript. Never
   * rendered; `toAgentMessages` emits them right after this message, so a transcript rebuilt from
   * chat messages keeps them and the loop does not re-append them.
   */
  instructionsAfter: Schema.optional(Schema.Array(UserMessage))
})

export type AgentChatMessage = typeof AgentChatMessageSchema.Type

/** What a model-step execution produced in the chat, for removal when it is superseded. */
export const AgentChatExecutionOutputSchema = Schema.Union([
  /** A chat message it created. */
  Schema.TaggedStruct('Message', { messageId: Schema.String }),
  /** A tool part it touched first, in `messageId`; `prior` is the part it replaced, if any. */
  Schema.TaggedStruct('ToolPart', {
    callId: Schema.String,
    messageId: Schema.String,
    prior: Schema.Option(AgentChatPartSchema)
  }),
  /**
   * A message it did not create that its `AssistantMessage` replaced, with the message as it was:
   * one in its turn (another execution's, or one the tool batch added, holding a call id a provider
   * reused), or any message when no start was seen.
   */
  Schema.TaggedStruct('ReplacedMessage', { prior: AgentChatMessageSchema }),
  /**
   * Where its turn's output starts: after this chat message (none: the chat was empty). Recorded
   * at its start, from the execution it superseded when there is one.
   */
  Schema.TaggedStruct('After', { messageId: Schema.Option(Schema.String) }),
  /**
   * Where its turn's output ends: this chat message was the last when a later turn of its run
   * started (none: the chat was empty). Recorded on an execution kept for reconciling.
   */
  Schema.TaggedStruct('Until', { messageId: Schema.Option(Schema.String) })
])

export type AgentChatExecutionOutput = typeof AgentChatExecutionOutputSchema.Type

export const AgentChatExecutionOutput = Data.taggedEnum<AgentChatExecutionOutput>()

/** A chat projection's model-step executions (`AgentExecutions<AgentChatExecutionOutput>`). */
export const AgentChatExecutionsSchema = AgentExecutionsSchema(AgentChatExecutionOutputSchema)

/**
 * The start of the latest model turn a chat projection saw (its `LLMStreamStart`, tagged or not),
 * or of the run (`AgentStart`, the chat reducer's local submit/HITL/regenerate/edit:
 * `runTurnStart`). Providers reuse tool call ids across turns, so the turn's tool events match a
 * call only in the messages after `after`: the model's stream (its own execution's start, when
 * tagged) and host events (the tool batch, approvals, questions and their answers act on the latest
 * turn's calls; on a miss, on the earlier part holding the same call or the request an answer
 * answers, as a resumed run's tool batch does before its first model turn).
 */
export const AgentChatTurnStartSchema = Schema.Struct({
  /** The start's `streamId` (`''` when none). */
  streamId: Schema.String,
  /** The `LLMStreamStart`'s turn; `0` for a run start (the loop numbers model turns from 1). */
  turn: Schema.Number,
  /** The turn's output follows this chat message (none: the chat was empty). */
  after: Schema.Option(Schema.String),
  /**
   * A run start, before the run's first model turn: it bounds host events. The model's tool events
   * before the run's first `LLMStreamStart` replay an earlier run's (a run's own model output
   * follows a start), so they act on a call before the run's messages when one holds their id, else
   * as usual (`ChatEventScope.runOutput`). The run's first `LLMStreamStart` starts a new turn, never
   * retries this one.
   */
  run: Schema.optional(Schema.Literal(true))
})

export type AgentChatTurnStart = typeof AgentChatTurnStartSchema.Type

const projectionFields = {
  chatMessages: Schema.Array(AgentChatMessageSchema),
  /**
   * The `eventId`s of the events applied so far: a replayed event (a reconnect re-reading from an
   * earlier cursor, an overlapping stream) is skipped. A persistent set, so each event costs the
   * same however long the stream ran; its JSON form is the array of ids.
   */
  seenEventIds: Schema.HashSet(Schema.String),
  /**
   * Model-step executions seen on this stream (events carrying `executionId`), with the chat
   * message ids and tool calls each produced. Carry it with `seenEventIds` between events; absent
   * in states built before it.
   */
  executions: Schema.optional(AgentChatExecutionsSchema),
  /**
   * The latest model turn's start (`AgentChatTurnStart`); carry it with `seenEventIds`. Absent
   * until a start (or `AgentStart`) is seen and in states built before it: tool events then match
   * the last message holding a call, in any turn.
   */
  turnStart: Schema.optional(AgentChatTurnStartSchema)
}

/**
 * A replay-safe chat projection of a durable stream (`stepAgentChatProjection`): the chat, the
 * event ids applied, the model-step executions and the latest turn's start. Keep the whole state
 * between events; `Schema.toCodecJson(AgentChatEventProjectionStateSchema)` is its JSON form.
 */
export const AgentChatEventProjectionStateSchema = Schema.Struct(projectionFields)

export type AgentChatEventProjectionState = typeof AgentChatEventProjectionStateSchema.Type

/** The `useAgentChat` reducer's state (`reduceAgentChatState`): the projection plus run status. */
export const AgentChatStateSchema = Schema.Struct({
  /** Run status; failures and pending retries live here (`Failed`, `Working(Retrying)`). */
  status: AgentStatus,
  subagents: Schema.Array(SubagentStatusEntry),
  sessionEvents: Schema.Array(AgentChatSessionEvent),
  ...projectionFields,
  /**
   * The pause each request was last asked in (`rememberHitlPause` over every `AgentAwaitingInput`,
   * seen or not): `useAgentChat` puts it on the transport request of an answer (`pause`). Reset
   * with `seenEventIds`; absent in states built before it.
   */
  hitlPauses: Schema.optional(HitlPauses)
})

export type AgentChatState = typeof AgentChatStateSchema.Type
