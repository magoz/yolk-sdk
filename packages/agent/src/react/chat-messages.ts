import { Array as Arr, Data, Equal, Match, Option, Predicate } from 'effect'
import type { AgentToolRun } from '@yolk-sdk/agent/client'
import { isActiveToolRun, toolRunCall, toolRunId, toolRunRequestId } from '../client/state.ts'
import {
  isInstructionMessage,
  AssistantAgentMessage,
  AssistantReasoningPart,
  AssistantTextPart,
  HostToolCallPart,
  ProviderToolCallPart,
  ProviderToolResultPart,
  type InputRequest,
  type InputResponse,
  type InteractionRequest,
  type InteractionResponse,
  type QuestionRequest,
  type QuestionResponse,
  type ToolApprovalRequest,
  ToolResult,
  ToolResultMessage,
  toolResultMessageFromResult,
  ToolCall,
  UserMessage,
  appendTextToContent,
  contentParts,
  formatInputResponseContent,
  formatQuestionResponseContent,
  inputResponseStructuredContent,
  isContentEmpty,
  questionResponseStructuredContent,
  type AgentEvent,
  type AgentMessage,
  type AssistantPart,
  type Content,
  type MessageAnnotations,
  type MessageAuthor,
  type MessageEnvelope
} from '@yolk-sdk/agent/protocol'

export type ChatPartState = 'streaming' | 'done'

export type ChatToolState =
  | { readonly _tag: 'Called' }
  | { readonly _tag: 'InputStreaming'; readonly input: string }
  | { readonly _tag: 'ApprovalRequested'; readonly request?: ToolApprovalRequest }
  | { readonly _tag: 'Denied'; readonly reason: string }
  | { readonly _tag: 'QuestionRequested'; readonly request: QuestionRequest }
  | {
      readonly _tag: 'QuestionAnswered'
      readonly response: QuestionResponse
      readonly request?: QuestionRequest
    }
  | {
      readonly _tag: 'QuestionCancelled'
      readonly response: QuestionResponse
      readonly request?: QuestionRequest
    }
  | { readonly _tag: 'InputRequested'; readonly request: InputRequest }
  | {
      readonly _tag: 'InputSubmitted'
      readonly response: InputResponse
      readonly request?: InputRequest
    }
  | {
      readonly _tag: 'InputCancelled'
      readonly response: InputResponse
      readonly request?: InputRequest
    }
  | { readonly _tag: 'InteractionRequested'; readonly request: InteractionRequest }
  | {
      readonly _tag: 'InteractionSubmitted'
      readonly response: InteractionResponse
      readonly request?: InteractionRequest
    }
  | {
      readonly _tag: 'InteractionCancelled'
      readonly response: InteractionResponse
      readonly request?: InteractionRequest
    }
  | { readonly _tag: 'Running'; readonly startedAtMs: number }
  | {
      readonly _tag: 'Completed'
      readonly result: ToolResult
      readonly startedAtMs?: number
      readonly endedAtMs?: number
    }
  | {
      readonly _tag: 'Accepted'
      readonly result: ToolResult
      readonly resultEnvelope?: MessageEnvelope
      readonly startedAtMs?: number
      readonly endedAtMs?: number
    }
  | {
      readonly _tag: 'Errored'
      readonly message: string
      readonly startedAtMs?: number
      readonly endedAtMs?: number
    }
  | { readonly _tag: 'ProviderCompleted'; readonly result: ToolResult }

export const ChatToolState = Data.taggedEnum<ChatToolState>()

export type AgentChatPart =
  | {
      readonly _tag: 'Text'
      readonly id: string
      readonly content: Content
      readonly state: ChatPartState
    }
  | {
      readonly _tag: 'Reasoning'
      readonly id: string
      readonly text: string
      readonly state: ChatPartState
    }
  | {
      readonly _tag: 'ToolCall'
      readonly id: string
      readonly call: ToolCall
      readonly state: ChatToolState
    }
  | {
      readonly _tag: 'ToolResult'
      readonly id: string
      readonly toolCallId: string
      readonly name: string
      readonly content: Content
      readonly isError?: boolean
      readonly acceptance?: ToolResult['acceptance']
      readonly structuredContent?: unknown
    }
  | { readonly _tag: 'Error'; readonly id: string; readonly message: string }

export const AgentChatPart = Data.taggedEnum<AgentChatPart>()

export type AgentChatMessage = {
  readonly id: string
  readonly turnId: string
  readonly sequence: number
  readonly role: 'user' | 'assistant' | 'system'
  readonly createdAtMs?: number
  readonly author?: MessageAuthor
  readonly annotations?: MessageAnnotations
  readonly parts: ReadonlyArray<AgentChatPart>
  /**
   * Host instruction messages (ADR 0007) that followed this message in the transcript. Never
   * rendered; `toAgentMessages` emits them right after this message, so a transcript rebuilt from
   * chat messages keeps them and the loop does not re-append them.
   */
  readonly instructionsAfter?: ReadonlyArray<UserMessage>
}

export type DeleteChatTurnResult =
  | { readonly _tag: 'NotFound' }
  | {
      readonly _tag: 'Deleted'
      readonly turnStartMessageId: string
      readonly deletedMessageIds: ReadonlyArray<string>
      readonly messages: ReadonlyArray<AgentChatMessage>
    }

export const DeleteChatTurnResult = Data.taggedEnum<DeleteChatTurnResult>()

export type EditChatUserMessageResult =
  | { readonly _tag: 'NotFound' }
  | { readonly _tag: 'NotUserMessage' }
  | {
      readonly _tag: 'Edited'
      readonly messageId: string
      readonly messages: ReadonlyArray<AgentChatMessage>
    }

export const EditChatUserMessageResult = Data.taggedEnum<EditChatUserMessageResult>()

export type RegenerateChatMessagesResult =
  | { readonly _tag: 'NotFound' }
  | {
      readonly _tag: 'Regenerated'
      readonly messages: ReadonlyArray<AgentChatMessage>
    }

export const RegenerateChatMessagesResult = Data.taggedEnum<RegenerateChatMessagesResult>()

export type ApplyAgentEventToChatMessagesOptions = {
  readonly nowMs?: number
}

const messageId = (sequence: number, role: AgentChatMessage['role']) =>
  `message-${sequence}-${role}`

const turnId = (sequence: number) => `turn-${sequence}`

const lastTurnId = (messages: ReadonlyArray<AgentChatMessage>) => messages.at(-1)?.turnId

const nextMessageSequence = (messages: ReadonlyArray<AgentChatMessage>) =>
  messages.reduce((max, message) => Math.max(max, message.sequence), -1) + 1

type ChatMessageEnvelopeFields = {
  createdAtMs?: MessageEnvelope['createdAtMs']
  author?: MessageEnvelope['author']
  annotations?: MessageEnvelope['annotations']
}

const chatMessageEnvelope = (message: MessageEnvelope) => {
  const fields: ChatMessageEnvelopeFields = {}

  if (message.createdAtMs !== undefined) {
    fields.createdAtMs = message.createdAtMs
  }

  if (message.author !== undefined) {
    fields.author = message.author
  }

  if (message.annotations !== undefined) {
    fields.annotations = message.annotations
  }

  return fields
}

const userChatMessage = (message: UserMessage, sequence: number): AgentChatMessage => ({
  id: messageId(sequence, 'user'),
  turnId: turnId(sequence),
  sequence,
  role: 'user',
  ...chatMessageEnvelope(message),
  parts: [
    AgentChatPart.Text({
      id: `message-${sequence}-user-text`,
      content: message.content,
      state: 'done'
    })
  ]
})

export type BuildAgentChatMessagesInput = {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly userDraft: string
  readonly assistantDraft: string
  readonly reasoningDraft: string
  readonly toolRuns: ReadonlyArray<AgentToolRun>
  readonly error: string | null
}

const toolRunNameEntry = (run: AgentToolRun): ReadonlyArray<readonly [string, string]> =>
  Match.value(run).pipe(
    Match.withReturnType<ReadonlyArray<readonly [string, string]>>(),
    Match.tag('InputStreaming', current =>
      current.name === undefined ? [] : [[current.id, current.name]]
    ),
    Match.tag('Denied', () => []),
    Match.tag('QuestionAnswered', 'QuestionCancelled', current =>
      current.request === undefined ? [] : [[current.request.call.id, current.request.call.name]]
    ),
    Match.tag('QuestionRequested', current => [
      [current.request.call.id, current.request.call.name]
    ]),
    Match.tag('InputRequested', current => [[current.request.call.id, current.request.call.name]]),
    Match.tag('InputSubmitted', 'InputCancelled', current =>
      current.request === undefined ? [] : [[current.request.call.id, current.request.call.name]]
    ),
    Match.tag('InteractionRequested', current => [
      [current.request.call.id, current.request.call.name]
    ]),
    Match.tag('InteractionSubmitted', 'InteractionCancelled', current =>
      current.request === undefined ? [] : [[current.request.call.id, current.request.call.name]]
    ),
    Match.tag(
      'InputReady',
      'ApprovalRequested',
      'Executing',
      'Accepted',
      'Completed',
      'Errored',
      'ProviderCompleted',
      current => [[current.call.id, current.call.name]]
    ),
    Match.exhaustive
  )

const assistantToolNameEntries = (
  message: AgentMessage
): ReadonlyArray<readonly [string, string]> =>
  Predicate.isTagged(message, 'Assistant')
    ? message.parts.flatMap(part =>
        Predicate.isTagged(part, 'HostToolCall') || Predicate.isTagged(part, 'ProviderToolCall')
          ? [[part.call.id, part.call.name]]
          : []
      )
    : []

const collectToolNames = (
  messages: ReadonlyArray<AgentMessage>,
  toolRuns: ReadonlyArray<AgentToolRun>
): ReadonlyMap<string, string> =>
  new Map([...toolRuns.flatMap(toolRunNameEntry), ...messages.flatMap(assistantToolNameEntries)])

// Schema.Class.make retains excess own properties; select only result payload fields.
type ToolResultFromMessageFields = {
  toolCallId: ToolResultMessage['toolCallId']
  content: ToolResultMessage['content']
  isError?: ToolResultMessage['isError']
  structuredContent?: ToolResultMessage['structuredContent']
  acceptance?: ToolResultMessage['acceptance']
}

const toolResultFromMessage = (message: ToolResultMessage): ToolResult =>
  ToolResult.make(
    (() => {
      const fields: ToolResultFromMessageFields = {
        toolCallId: message.toolCallId,
        content: message.content
      }

      if (message.isError !== undefined) {
        fields.isError = message.isError
      }

      if (message.structuredContent !== undefined) {
        fields.structuredContent = message.structuredContent
      }

      if (message.acceptance !== undefined) {
        fields.acceptance = message.acceptance
      }

      return fields
    })()
  )

/**
 * A tool call part of an assistant message in `buildAgentChatMessages`' input: `key` names the part
 * (`assistantToolPartKey`), `messageIndex` its message.
 */
type ToolCallSlot = {
  readonly key: string
  readonly messageIndex: number
  readonly call: ToolCall
}

const assistantToolPartKey = (messageIndex: number, partIndex: number) =>
  `${messageIndex}:${partIndex}`

const collectToolCallSlots = (messages: ReadonlyArray<AgentMessage>): ReadonlyArray<ToolCallSlot> =>
  messages.flatMap((message, messageIndex) =>
    Predicate.isTagged(message, 'Assistant')
      ? message.parts.flatMap((part, partIndex) =>
          Predicate.isTagged(part, 'HostToolCall') || Predicate.isTagged(part, 'ProviderToolCall')
            ? [
                {
                  key: assistantToolPartKey(messageIndex, partIndex),
                  messageIndex,
                  call: part.call
                }
              ]
            : []
        )
      : []
  )

const findLastSlot = (
  slots: ReadonlyArray<ToolCallSlot>,
  predicate: (slot: ToolCallSlot) => boolean
): ToolCallSlot | undefined => Option.getOrUndefined(Arr.findLast(slots, predicate))

/** A result message paired with the tool call part it belongs to (`collectToolResultPairs`). */
type PairedToolResult = {
  readonly key: string
  readonly message: ToolResultMessage
  readonly messageIndex: number
}

/**
 * The tool call part each `ToolResult` message belongs to: the last part with its id before it
 * (providers reuse call ids across turns, so a result never reaches another turn's call, earlier
 * or later). A result with no part before it pairs with none and shows as its own message; a part
 * no result follows has none (several results: the last).
 */
const collectToolResultPairs = (
  messages: ReadonlyArray<AgentMessage>,
  slots: ReadonlyArray<ToolCallSlot>
): ReadonlyArray<PairedToolResult> =>
  messages.flatMap((message, messageIndex) => {
    if (!Predicate.isTagged(message, 'ToolResult')) return []

    const slot = findLastSlot(
      slots,
      current => current.messageIndex < messageIndex && current.call.id === message.toolCallId
    )

    return slot === undefined ? [] : [{ key: slot.key, message, messageIndex }]
  })

/** A run placed on a part, with its index in `toolRuns`. */
type PlacedToolRun = {
  readonly run: AgentToolRun
  readonly index: number
}

/**
 * Whether a run holding no call (`answer`) is the answer to `run`: a denial to a pending approval,
 * another answer to the run holding the request it answers (`requestId`).
 */
const answersToolRun = (answer: AgentToolRun, run: AgentToolRun) => {
  if (Predicate.isTagged(answer, 'Denied')) return Predicate.isTagged(run, 'ApprovalRequested')

  const requestId = toolRunRequestId(answer)

  return requestId !== undefined && toolRunRequestId(run) === requestId
}

/**
 * The run each tool call part shows. `toolRuns` can hold one run per turn for a reused call id
 * (`reduceAgentEvents`), and snapshot hosts pass runs of several turns (pending requests, accepted
 * interactions), so a run goes to one part, later runs first (the last run of a call is its
 * latest), each part taking at most one:
 *
 * - A run holding a call (`toolRunCall`: its own, or its request's) takes the last part holding the
 *   same call (id, name and arguments equal) no later run took; when no part holds it (arguments a
 *   host normalized), the last untaken part with its id and name and no result message, so a
 *   pending request is never hidden. A different name is another turn's call: it shows nowhere.
 * - Then a run holding no call (an input still streaming, an answer or denial without its request)
 *   that answers an earlier run on a part (`answersToolRun`) replaces it there, as the later state
 *   of that call (unless a later answer already did); else it takes the last untaken part with its
 *   id: one without a result message first when the run still waits on its result
 *   (`isActiveToolRun`: an input streaming, a submitted interaction), any otherwise (a settled
 *   answer or denial).
 *
 * A part no run reaches keeps the state its messages give it.
 */
const collectToolRunsByPart = (
  slots: ReadonlyArray<ToolCallSlot>,
  runs: ReadonlyArray<AgentToolRun>,
  results: ReadonlyMap<string, PairedToolResult>
): ReadonlyMap<string, AgentToolRun> => {
  const latestFirst = Arr.reverse(runs.map((run, index): PlacedToolRun => ({ run, index })))

  const place = (
    placed: ReadonlyMap<string, PlacedToolRun>,
    slot: ToolCallSlot | undefined,
    run: PlacedToolRun
  ): ReadonlyMap<string, PlacedToolRun> =>
    slot === undefined ? placed : new Map([...placed, [slot.key, run]])

  const untaken =
    (placed: ReadonlyMap<string, PlacedToolRun>, matches: (slot: ToolCallSlot) => boolean) =>
    (slot: ToolCallSlot) =>
      !placed.has(slot.key) && matches(slot)

  const withoutResult = (slot: ToolCallSlot) => !results.has(slot.key)

  const byCall = latestFirst.reduce<ReadonlyMap<string, PlacedToolRun>>((placed, current) => {
    const call = toolRunCall(current.run)

    if (call === undefined) return placed

    const exact = (slot: ToolCallSlot) => Equal.equals(slot.call, call)

    if (slots.some(exact))
      return place(placed, findLastSlot(slots, untaken(placed, exact)), current)

    return place(
      placed,
      findLastSlot(
        slots,
        untaken(
          placed,
          slot => slot.call.id === call.id && slot.call.name === call.name && withoutResult(slot)
        )
      ),
      current
    )
  }, new Map())

  const placed = latestFirst.reduce<ReadonlyMap<string, PlacedToolRun>>((placed, current) => {
    if (toolRunCall(current.run) !== undefined) return placed

    const id = toolRunId(current.run)
    const withId = (slot: ToolCallSlot) => slot.call.id === id

    const answered = findLastSlot(slots, slot => {
      const claimant = byCall.get(slot.key)

      return (
        withId(slot) &&
        claimant !== undefined &&
        claimant.index < current.index &&
        answersToolRun(current.run, claimant.run)
      )
    })

    if (answered !== undefined) {
      // A later answer of the same call already replaced the run it answers.
      return placed.get(answered.key) === byCall.get(answered.key)
        ? place(placed, answered, current)
        : placed
    }

    // A run still waiting on its result (an input streaming, a submitted interaction the server has
    // not run) belongs to a part without one; a settled answer to the plain last part, as before.
    const waiting = isActiveToolRun(current.run)

    return place(
      placed,
      (waiting
        ? findLastSlot(
            slots,
            untaken(placed, slot => withId(slot) && withoutResult(slot))
          )
        : undefined) ?? findLastSlot(slots, untaken(placed, withId)),
      current
    )
  }, byCall)

  return new Map(Arr.map([...placed], ([key, current]) => [key, current.run] as const))
}

const questionRequestFromToolState = (state: ChatToolState): QuestionRequest | undefined =>
  Match.value(state).pipe(
    Match.tag('QuestionRequested', current => current.request),
    Match.tag('QuestionAnswered', 'QuestionCancelled', current => current.request),
    Match.tag(
      'Called',
      'InputStreaming',
      'InputRequested',
      'InputSubmitted',
      'InputCancelled',
      'InteractionRequested',
      'InteractionSubmitted',
      'InteractionCancelled',
      'ApprovalRequested',
      'Denied',
      'Running',
      'Accepted',
      'Completed',
      'Errored',
      'ProviderCompleted',
      () => undefined
    ),
    Match.exhaustive
  )

const inputRequestFromToolState = (state: ChatToolState): InputRequest | undefined =>
  Match.value(state).pipe(
    Match.tag('InputRequested', current => current.request),
    Match.tag('InputSubmitted', 'InputCancelled', current => current.request),
    Match.tag(
      'Called',
      'InputStreaming',
      'ApprovalRequested',
      'Denied',
      'QuestionRequested',
      'QuestionAnswered',
      'QuestionCancelled',
      'InteractionRequested',
      'InteractionSubmitted',
      'InteractionCancelled',
      'Running',
      'Accepted',
      'Completed',
      'Errored',
      'ProviderCompleted',
      () => undefined
    ),
    Match.exhaustive
  )

const interactionRequestFromToolState = (state: ChatToolState): InteractionRequest | undefined =>
  Match.value(state).pipe(
    Match.tag('InteractionRequested', current => current.request),
    Match.tag('InteractionSubmitted', 'InteractionCancelled', current => current.request),
    Match.tag(
      'Called',
      'InputStreaming',
      'InputRequested',
      'InputSubmitted',
      'InputCancelled',
      'ApprovalRequested',
      'Denied',
      'QuestionRequested',
      'QuestionAnswered',
      'QuestionCancelled',
      'Running',
      'Accepted',
      'Completed',
      'Errored',
      'ProviderCompleted',
      () => undefined
    ),
    Match.exhaustive
  )

type QuestionTerminalState = Extract<
  ChatToolState,
  { readonly _tag: 'QuestionAnswered' | 'QuestionCancelled' }
>

const preserveQuestionRequest = (
  request: QuestionRequest | undefined,
  state: QuestionTerminalState
): QuestionTerminalState =>
  state.request !== undefined || request === undefined ? state : { ...state, request }

type InputTerminalState = Extract<
  ChatToolState,
  { readonly _tag: 'InputSubmitted' | 'InputCancelled' }
>

const preserveInputRequest = (
  request: InputRequest | undefined,
  state: InputTerminalState
): InputTerminalState =>
  state.request !== undefined || request === undefined ? state : { ...state, request }

type InteractionTerminalState = Extract<
  ChatToolState,
  { readonly _tag: 'InteractionSubmitted' | 'InteractionCancelled' }
>

const preserveInteractionRequest = (
  request: InteractionRequest | undefined,
  state: InteractionTerminalState
): InteractionTerminalState =>
  state.request !== undefined || request === undefined ? state : { ...state, request }

const toolStateFor = (
  run: AgentToolRun | undefined,
  message: ToolResultMessage | undefined
): ChatToolState => {
  const result = message === undefined ? undefined : toolResultFromMessage(message)

  // Persisted acknowledgements outrank stale transient runs after hydration.
  if (message?.acceptance !== undefined && result !== undefined) {
    return ChatToolState.Accepted({ result, resultEnvelope: chatMessageEnvelope(message) })
  }

  if (Predicate.isTagged(run, 'Executing')) {
    return ChatToolState.Running({ startedAtMs: run.startedAtMs })
  }

  if (Predicate.isTagged(run, 'InputStreaming')) {
    return ChatToolState.InputStreaming({ input: run.input })
  }

  if (Predicate.isTagged(run, 'ApprovalRequested')) {
    return ChatToolState.ApprovalRequested({ request: run.request })
  }

  if (Predicate.isTagged(run, 'Denied')) {
    return ChatToolState.Denied({ reason: run.reason })
  }

  if (Predicate.isTagged(run, 'InputRequested')) {
    return ChatToolState.InputRequested({ request: run.request })
  }

  if (Predicate.isTagged(run, 'InputSubmitted')) {
    return preserveInputRequest(
      run.request,
      ChatToolState.InputSubmitted({ response: run.response })
    )
  }

  if (Predicate.isTagged(run, 'InputCancelled')) {
    return preserveInputRequest(
      run.request,
      ChatToolState.InputCancelled({ response: run.response })
    )
  }

  if (Predicate.isTagged(run, 'InteractionRequested')) {
    return ChatToolState.InteractionRequested({ request: run.request })
  }

  if (Predicate.isTagged(run, 'InteractionSubmitted')) {
    return preserveInteractionRequest(
      run.request,
      ChatToolState.InteractionSubmitted({ response: run.response })
    )
  }

  if (Predicate.isTagged(run, 'InteractionCancelled')) {
    return preserveInteractionRequest(
      run.request,
      ChatToolState.InteractionCancelled({ response: run.response })
    )
  }

  if (Predicate.isTagged(run, 'QuestionRequested')) {
    return ChatToolState.QuestionRequested({ request: run.request })
  }

  if (Predicate.isTagged(run, 'QuestionAnswered')) {
    return preserveQuestionRequest(
      run.request,
      ChatToolState.QuestionAnswered({ response: run.response })
    )
  }

  if (Predicate.isTagged(run, 'QuestionCancelled')) {
    return preserveQuestionRequest(
      run.request,
      ChatToolState.QuestionCancelled({ response: run.response })
    )
  }

  if (Predicate.isTagged(run, 'Completed')) {
    return ChatToolState.Completed({
      result: run.result,
      startedAtMs: run.startedAtMs,
      endedAtMs: run.endedAtMs
    })
  }

  if (Predicate.isTagged(run, 'Accepted')) {
    return ChatToolState.Accepted({
      result: run.result,
      startedAtMs: run.startedAtMs,
      endedAtMs: run.endedAtMs
    })
  }

  if (Predicate.isTagged(run, 'Errored')) {
    return ChatToolState.Errored({ message: run.message, endedAtMs: run.endedAtMs })
  }

  if (Predicate.isTagged(run, 'ProviderCompleted')) {
    return ChatToolState.ProviderCompleted({ result: run.result })
  }

  if (result !== undefined) {
    return result.acceptance === undefined
      ? ChatToolState.Completed({ result })
      : ChatToolState.Accepted({ result })
  }

  return ChatToolState.Called()
}

/** Each tool call part's run and result message, by `assistantToolPartKey`. */
type ToolPartSources = {
  readonly toolResultsByPart: ReadonlyMap<string, PairedToolResult>
  readonly toolRunsByPart: ReadonlyMap<string, AgentToolRun>
}

const noToolPartSources: ToolPartSources = {
  toolResultsByPart: new Map(),
  toolRunsByPart: new Map()
}

const assistantPartsFromMessage = ({
  message,
  messageIndex,
  sources
}: {
  readonly message: Extract<AgentMessage, { readonly _tag: 'Assistant' }>
  readonly messageIndex: number
  readonly sources: ToolPartSources
}): ReadonlyArray<AgentChatPart> => {
  return message.parts.flatMap((part, partIndex): ReadonlyArray<AgentChatPart> =>
    Match.value(part).pipe(
      Match.withReturnType<ReadonlyArray<AgentChatPart>>(),
      Match.tag('Reasoning', current =>
        current.text.length > 0
          ? [
              AgentChatPart.Reasoning({
                id: `message-${messageIndex}-reasoning-${partIndex}`,
                text: current.text,
                state: 'done'
              })
            ]
          : []
      ),
      Match.tag('Text', current => [
        AgentChatPart.Text({
          id: `message-${messageIndex}-assistant-text-${partIndex}`,
          content: current.content,
          state: 'done'
        })
      ]),
      Match.tag('HostToolCall', 'ProviderToolCall', current => [
        AgentChatPart.ToolCall({
          id: `message-${messageIndex}-tool-call-${current.call.id}`,
          call: current.call,
          state: toolStateFor(
            sources.toolRunsByPart.get(assistantToolPartKey(messageIndex, partIndex)),
            sources.toolResultsByPart.get(assistantToolPartKey(messageIndex, partIndex))?.message
          )
        })
      ]),
      Match.tag('ProviderToolResult', current => [
        {
          ...toolResultMessageFromResult(current.result),
          id: `message-${messageIndex}-provider-tool-result-${current.toolCallId}`,
          toolCallId: current.toolCallId,
          name: current.toolCallId
        }
      ]),
      Match.exhaustive
    )
  )
}

const assistantChatMessage = (
  message: AssistantAgentMessage,
  sequence: number,
  currentTurnId: string,
  parts: ReadonlyArray<AgentChatPart> = assistantPartsFromMessage({
    message,
    messageIndex: sequence,
    sources: noToolPartSources
  })
): AgentChatMessage => ({
  id: messageId(sequence, 'assistant'),
  turnId: currentTurnId,
  sequence,
  role: 'assistant',
  ...chatMessageEnvelope(message),
  parts
})

const hasStreamingPart = (message: AgentChatMessage) =>
  message.parts.some(
    part =>
      (Predicate.isTagged(part, 'Text') || Predicate.isTagged(part, 'Reasoning')) &&
      part.state === 'streaming'
  )

const hasStreamingTextPart = (message: AgentChatMessage) =>
  message.parts.some(part => Predicate.isTagged(part, 'Text') && part.state === 'streaming')

const hasToolCall = (message: AgentChatMessage, callId: string) =>
  message.parts.some(part => Predicate.isTagged(part, 'ToolCall') && part.call.id === callId)

const isOpenToolState = (state: ChatToolState) =>
  Predicate.isTagged(state, 'Called') ||
  Predicate.isTagged(state, 'InputStreaming') ||
  Predicate.isTagged(state, 'ApprovalRequested') ||
  Predicate.isTagged(state, 'QuestionRequested') ||
  Predicate.isTagged(state, 'InputRequested') ||
  Predicate.isTagged(state, 'InteractionRequested') ||
  Predicate.isTagged(state, 'Running')

const hasOpenToolCall = (message: AgentChatMessage) =>
  message.parts.some(part => Predicate.isTagged(part, 'ToolCall') && isOpenToolState(part.state))

/**
 * Chat messages an event may not change: those another model-step execution still holds as its
 * output (`applyExecutionEventToChatMessages`). Its own output then goes to a new message.
 */
type ForeignMessages = ReadonlySet<string>

const noForeignMessages: ForeignMessages = new Set()

/**
 * Where an event may match or place a tool call: from the index `from`, outside `foreign`. With
 * `replays`, a host event acting on a call the turn does not hold (a replay of an earlier turn's
 * event without event id, or a late tool-batch event after the next turn started) acts on the
 * earlier part it replays (`matchedToolCallIndex`) instead of adding one.
 */
type ToolPartScope = {
  readonly from: number
  readonly foreign: ForeignMessages
  readonly replays: boolean
}

const findLastMessageIndex = (
  messages: ReadonlyArray<AgentChatMessage>,
  predicate: (message: AgentChatMessage, index: number) => boolean
) =>
  messages.reduce(
    (lastIndex, message, index) => (predicate(message, index) ? index : lastIndex),
    -1
  )

const indexOfMessage = (messages: ReadonlyArray<AgentChatMessage>, id: Option.Option<string>) =>
  Option.match(id, {
    onNone: () => -1,
    onSome: messageId => messages.findIndex(message => message.id === messageId)
  })

const lastUserIndex = (messages: ReadonlyArray<AgentChatMessage>) =>
  findLastMessageIndex(messages, message => message.role === 'user')

/**
 * Where the current model turn's output starts in the chat: after this message (none: the chat was
 * empty when it started), or `undefined` when no start was seen.
 */
export type ChatTurnAnchor = Option.Option<string> | undefined

/**
 * The index of the first chat message a turn's tool events may match a call in: providers reuse
 * call ids across turns, so a call is matched only after its turn's start, never in an earlier
 * turn. Without a known start (none seen, or its message is gone) every message, the last one
 * holding the call winning, as replays of an earlier call without event ids expect.
 */
const turnStartIndex = (messages: ReadonlyArray<AgentChatMessage>, anchor: ChatTurnAnchor) => {
  if (anchor === undefined) return 0

  const index = indexOfMessage(messages, anchor)

  return Option.isSome(anchor) && index === -1 ? 0 : index + 1
}

/** The last message at or after `from`, outside `foreign`, holding the call (`-1`: none). */
const toolCallMessageIndex = (
  messages: ReadonlyArray<AgentChatMessage>,
  callId: string,
  scope: ToolPartScope
) =>
  findLastMessageIndex(
    messages,
    (message, index) =>
      index >= scope.from && !scope.foreign.has(message.id) && hasToolCall(message, callId)
  )

type ToolCallPart = Extract<AgentChatPart, { readonly _tag: 'ToolCall' }>

/** The earlier part a host event replays when its turn does not hold the call. */
type ReplayedPart = (part: ToolCallPart) => boolean

/** A tool-batch or request event replays the part holding the same call it names. */
const sameCall =
  (call: ToolCall): ReplayedPart =>
  part =>
    Equal.equals(part.call, call)

/** The request a call's state carries (pending or answered), if any. */
const toolStateRequestId = (state: ChatToolState): string | undefined =>
  Match.value(state).pipe(
    Match.tag(
      'ApprovalRequested',
      'QuestionAnswered',
      'QuestionCancelled',
      'InputSubmitted',
      'InputCancelled',
      'InteractionSubmitted',
      'InteractionCancelled',
      current => current.request?.requestId
    ),
    Match.tag(
      'QuestionRequested',
      'InputRequested',
      'InteractionRequested',
      current => current.request.requestId
    ),
    Match.tag(
      'Called',
      'InputStreaming',
      'Denied',
      'Running',
      'Accepted',
      'Completed',
      'Errored',
      'ProviderCompleted',
      () => undefined
    ),
    Match.exhaustive
  )

/** An answer replays the part holding the request it answers. */
const answeredRequest =
  (requestId: string): ReplayedPart =>
  part =>
    toolStateRequestId(part.state) === requestId

/**
 * The message an event acts on a call in: the last one of its turn (`scope`) holding the call;
 * else, for a host event that may replay one (`scope.replays`), the last earlier message holding
 * the part it replays (`replayed`: the same call, or the request an answer answers). A later turn's
 * call reusing the id is another call: the turn then adds it, and an answer changes nothing.
 */
const matchedToolCallIndex = (
  messages: ReadonlyArray<AgentChatMessage>,
  callId: string,
  scope: ToolPartScope,
  replayed: ReplayedPart
) => {
  const index = toolCallMessageIndex(messages, callId, scope)

  if (index !== -1 || !scope.replays) return index

  return findLastMessageIndex(
    messages,
    (message, messageIndex) =>
      messageIndex < scope.from &&
      !scope.foreign.has(message.id) &&
      message.parts.some(
        part => Predicate.isTagged(part, 'ToolCall') && part.call.id === callId && replayed(part)
      )
  )
}

/** The chat message an event of the turn that started after `anchor` matches a call in. */
export const turnToolCallMessage = (
  messages: ReadonlyArray<AgentChatMessage>,
  callId: string,
  anchor: ChatTurnAnchor
): AgentChatMessage | undefined =>
  messages[
    toolCallMessageIndex(messages, callId, {
      from: turnStartIndex(messages, anchor),
      foreign: noForeignMessages,
      replays: false
    })
  ]

/**
 * The chat message a host event of the latest turn (started after `anchor`) acting on `call` (the
 * tool batch) updates: its turn's, else the earlier one holding the same call it replays.
 */
export const hostToolCallMessage = (
  messages: ReadonlyArray<AgentChatMessage>,
  call: ToolCall,
  anchor: ChatTurnAnchor
): AgentChatMessage | undefined =>
  messages[
    matchedToolCallIndex(
      messages,
      call.id,
      { from: turnStartIndex(messages, anchor), foreign: noForeignMessages, replays: true },
      sameCall(call)
    )
  ]

/**
 * Whether a turn that started after `anchor` is still the chat's latest: that message is still
 * there (or the chat was empty) and no user message followed it.
 */
export const isLatestTurnAnchor = (
  messages: ReadonlyArray<AgentChatMessage>,
  anchor: Option.Option<string>
) => {
  const index = indexOfMessage(messages, anchor)

  return (Option.isNone(anchor) || index !== -1) && lastUserIndex(messages) <= index
}

const findMessageIndex = (messages: ReadonlyArray<AgentChatMessage>, messageId: string) =>
  messages.findIndex(message => message.id === messageId)

export const deleteChatTurn = (
  messages: ReadonlyArray<AgentChatMessage>,
  messageId: string
): DeleteChatTurnResult => {
  const targetIndex = findMessageIndex(messages, messageId)

  if (targetIndex === -1) {
    return DeleteChatTurnResult.NotFound()
  }

  const target = messages[targetIndex]

  if (target === undefined) {
    return DeleteChatTurnResult.NotFound()
  }

  const deletedMessages = messages.filter(message => message.turnId === target.turnId)
  const turnStartMessage = deletedMessages[0]

  return DeleteChatTurnResult.Deleted({
    turnStartMessageId: turnStartMessage?.id ?? target.id,
    deletedMessageIds: deletedMessages.map(message => message.id),
    messages: messages.filter(message => message.turnId !== target.turnId)
  })
}

export const regenerateChatMessagesFrom = (
  messages: ReadonlyArray<AgentChatMessage>,
  messageId: string
): RegenerateChatMessagesResult => {
  const targetIndex = findMessageIndex(messages, messageId)

  if (targetIndex === -1) {
    return RegenerateChatMessagesResult.NotFound()
  }

  const target = messages[targetIndex]

  if (target === undefined) {
    return RegenerateChatMessagesResult.NotFound()
  }

  return RegenerateChatMessagesResult.Regenerated({
    messages: messages.slice(0, target.role === 'user' ? targetIndex + 1 : targetIndex)
  })
}

export const editChatUserMessage = (
  messages: ReadonlyArray<AgentChatMessage>,
  messageId: string,
  content: Content
): EditChatUserMessageResult => {
  const targetIndex = findMessageIndex(messages, messageId)

  if (targetIndex === -1) {
    return EditChatUserMessageResult.NotFound()
  }

  const target = messages[targetIndex]

  if (target === undefined) {
    return EditChatUserMessageResult.NotFound()
  }

  if (target.role !== 'user') {
    return EditChatUserMessageResult.NotUserMessage()
  }

  return EditChatUserMessageResult.Edited({
    messageId: target.id,
    messages: [
      ...messages.slice(0, targetIndex),
      {
        ...target,
        parts: [
          AgentChatPart.Text({
            id: `message-${target.sequence}-user-text`,
            content,
            state: 'done'
          })
        ]
      }
    ]
  })
}

const lastAssistantIndex = (
  messages: ReadonlyArray<AgentChatMessage>,
  foreign: ForeignMessages = noForeignMessages,
  from = 0
) => {
  const index = findLastMessageIndex(messages, message => message.role === 'assistant')

  return index === -1 || index < from || foreign.has(messages[index]?.id ?? '')
    ? Option.none<number>()
    : Option.some(index)
}

const targetAssistantIndex = (
  messages: ReadonlyArray<AgentChatMessage>,
  foreign: ForeignMessages
) =>
  Option.filter(lastAssistantIndex(messages, foreign), index => hasStreamingPart(messages[index]))

const appendAssistantPart = (
  messages: ReadonlyArray<AgentChatMessage>,
  part: AgentChatPart,
  foreign: ForeignMessages
): ReadonlyArray<AgentChatMessage> =>
  Option.match(targetAssistantIndex(messages, foreign), {
    onNone: () => {
      const sequence = nextMessageSequence(messages)
      const currentTurnId = lastTurnId(messages) ?? turnId(sequence)

      return [
        ...messages,
        {
          id: messageId(sequence, 'assistant'),
          turnId: currentTurnId,
          sequence,
          role: 'assistant',
          parts: [part]
        }
      ]
    },
    onSome: index =>
      messages.map((message, messageIndex) =>
        messageIndex === index ? { ...message, parts: [...message.parts, part] } : message
      )
  })

const appendAssistantTextDelta = (
  messages: ReadonlyArray<AgentChatMessage>,
  input: { readonly delta: string; readonly textSoFar?: string },
  foreign: ForeignMessages
): ReadonlyArray<AgentChatMessage> => {
  const index = targetAssistantIndex(messages, foreign)
  const content = input.textSoFar ?? input.delta

  if (Option.isNone(index)) {
    const sequence = nextMessageSequence(messages)

    return appendAssistantPart(
      messages,
      AgentChatPart.Text({
        id: `message-${sequence}-assistant-text`,
        content,
        state: 'streaming'
      }),
      foreign
    )
  }

  return messages.map((message, messageIndex) =>
    messageIndex === index.value
      ? {
          ...message,
          parts: hasStreamingTextPart(message)
            ? message.parts.map(part =>
                Predicate.isTagged(part, 'Text') && part.state === 'streaming'
                  ? {
                      ...part,
                      content: input.textSoFar ?? appendTextToContent(part.content, input.delta)
                    }
                  : part
              )
            : [
                ...message.parts,
                AgentChatPart.Text({
                  id: `message-${message.sequence}-assistant-text`,
                  content,
                  state: 'streaming'
                })
              ]
        }
      : message
  )
}

const appendAssistantReasoningDelta = (
  messages: ReadonlyArray<AgentChatMessage>,
  input: { readonly delta: string; readonly reasoningSoFar?: string },
  foreign: ForeignMessages
): ReadonlyArray<AgentChatMessage> => {
  const index = targetAssistantIndex(messages, foreign)
  const text = input.reasoningSoFar ?? input.delta

  if (Option.isNone(index)) {
    const sequence = nextMessageSequence(messages)

    return appendAssistantPart(
      messages,
      AgentChatPart.Reasoning({
        id: `message-${sequence}-reasoning`,
        text,
        state: 'streaming'
      }),
      foreign
    )
  }

  return messages.map((message, messageIndex) =>
    messageIndex === index.value
      ? {
          ...message,
          parts: message.parts.some(
            part => Predicate.isTagged(part, 'Reasoning') && part.state === 'streaming'
          )
            ? message.parts.map(part =>
                Predicate.isTagged(part, 'Reasoning') && part.state === 'streaming'
                  ? { ...part, text: input.reasoningSoFar ?? `${part.text}${input.delta}` }
                  : part
              )
            : [
                ...message.parts,
                AgentChatPart.Reasoning({
                  id: `message-${message.sequence}-reasoning`,
                  text,
                  state: 'streaming'
                })
              ]
        }
      : message
  )
}

const mergeToolState = (existing: ChatToolState, next: ChatToolState): ChatToolState => {
  if (Predicate.isTagged(next, 'Errored')) {
    return {
      ...next,
      startedAtMs:
        next.startedAtMs ??
        (Predicate.isTagged(existing, 'Running') ||
        Predicate.isTagged(existing, 'Completed') ||
        Predicate.isTagged(existing, 'Accepted') ||
        Predicate.isTagged(existing, 'Errored')
          ? existing.startedAtMs
          : undefined),
      endedAtMs:
        next.endedAtMs ?? (Predicate.isTagged(existing, 'Errored') ? existing.endedAtMs : undefined)
    }
  }

  if (
    Predicate.isTagged(next, 'QuestionAnswered') ||
    Predicate.isTagged(next, 'QuestionCancelled')
  ) {
    return preserveQuestionRequest(questionRequestFromToolState(existing), next)
  }

  if (Predicate.isTagged(next, 'InputSubmitted') || Predicate.isTagged(next, 'InputCancelled')) {
    return preserveInputRequest(inputRequestFromToolState(existing), next)
  }

  if (
    Predicate.isTagged(next, 'InteractionSubmitted') ||
    Predicate.isTagged(next, 'InteractionCancelled')
  ) {
    return preserveInteractionRequest(interactionRequestFromToolState(existing), next)
  }

  if (Predicate.isTagged(next, 'Denied') || Predicate.isTagged(next, 'ProviderCompleted')) {
    return next
  }

  if (Predicate.isTagged(next, 'Completed') || Predicate.isTagged(next, 'Accepted')) {
    const snapshot = { ...next }

    const merged =
      Predicate.isTagged(next, 'Accepted') &&
      Predicate.isTagged(existing, 'Accepted') &&
      next.resultEnvelope === undefined &&
      existing.resultEnvelope !== undefined
        ? { ...snapshot, resultEnvelope: existing.resultEnvelope }
        : snapshot

    return {
      ...merged,
      startedAtMs:
        next.startedAtMs ??
        (Predicate.isTagged(existing, 'Running') ||
        Predicate.isTagged(existing, 'Completed') ||
        Predicate.isTagged(existing, 'Accepted')
          ? existing.startedAtMs
          : undefined),
      endedAtMs:
        next.endedAtMs ??
        (Predicate.isTagged(existing, 'Completed') || Predicate.isTagged(existing, 'Accepted')
          ? existing.endedAtMs
          : undefined)
    }
  }

  // A start of a finished call is kept out by `keepsToolState` (same call only, as the client).
  return next
}

const appendToolCallPart = (
  messages: ReadonlyArray<AgentChatMessage>,
  call: ToolCall,
  state: ChatToolState,
  scope: ToolPartScope
): ReadonlyArray<AgentChatMessage> => {
  const index = Option.filter(
    lastAssistantIndex(messages, scope.foreign, scope.from),
    assistantIndex => {
      const message = messages[assistantIndex]

      return hasStreamingPart(message) || hasOpenToolCall(message)
    }
  )

  return Option.match(index, {
    onNone: () => {
      const sequence = nextMessageSequence(messages)
      const currentTurnId = lastTurnId(messages) ?? turnId(sequence)

      return [
        ...messages,
        {
          id: messageId(sequence, 'assistant'),
          turnId: currentTurnId,
          sequence,
          role: 'assistant',
          parts: [AgentChatPart.ToolCall({ id: `tool-call-${call.id}`, call, state })]
        }
      ]
    },
    onSome: assistantIndex =>
      messages.map((message, messageIndex) =>
        messageIndex === assistantIndex
          ? {
              ...message,
              parts: [
                ...message.parts,
                AgentChatPart.ToolCall({ id: `tool-call-${call.id}`, call, state })
              ]
            }
          : message
      )
  })
}

const isRequestToolState = (state: ChatToolState) =>
  Predicate.isTagged(state, 'ApprovalRequested') ||
  Predicate.isTagged(state, 'QuestionRequested') ||
  Predicate.isTagged(state, 'InputRequested') ||
  Predicate.isTagged(state, 'InteractionRequested')

/**
 * Whether a call is past its human request: the request answered or cancelled, the approval
 * denied, or the call finished (completed, accepted, errored, provider result). Before it: the
 * model's stream, pending requests, and a running call, which has no result yet, so the loop asks
 * again when a run stopped while it ran (an abort) and the next one resumes it.
 */
const isPastRequestToolState = (state: ChatToolState): boolean =>
  Match.value(state).pipe(
    Match.tag(
      'Called',
      'InputStreaming',
      'ApprovalRequested',
      'QuestionRequested',
      'InputRequested',
      'InteractionRequested',
      'Running',
      () => false
    ),
    Match.tag(
      'Denied',
      'QuestionAnswered',
      'QuestionCancelled',
      'InputSubmitted',
      'InputCancelled',
      'InteractionSubmitted',
      'InteractionCancelled',
      'Completed',
      'Accepted',
      'Errored',
      'ProviderCompleted',
      () => true
    ),
    Match.exhaustive
  )

/** A finished call the tool batch ran: a replayed start of it must not reopen it. */
const isFinishedToolState = (state: ChatToolState) =>
  Predicate.isTagged(state, 'Completed') ||
  Predicate.isTagged(state, 'Accepted') ||
  Predicate.isTagged(state, 'Errored')

/**
 * Whether a call's part keeps its state when an event sets `state` for `call`: an accepted call
 * ignores open states (replays of its start or request), a finished call (completed, accepted,
 * errored) ignores a start of the same call (a replayed tool-batch event), and a call past its
 * request ignores a request for the same call. The loop asks for a call only until it has a result
 * or an answer it used: an invalid input re-pends the same request while the part still pends (the
 * server emits `InputSubmitted` only for a valid payload, and the chat reducer never applies an
 * input or interaction answer locally), and a later turn reusing the id asks on its own part. So
 * such a request, with or without event id, is a replay; a request or start naming another call
 * with the id is that call's and applies. Hosts never re-ask a call whose answer or denial the chat
 * applied locally (`patterns/AGENT_HITL.md`). `reduceAgentEvents` keeps the same fences
 * (`keepsToolRun`).
 */
const keepsToolState = (part: ToolCallPart, call: ToolCall, state: ChatToolState) =>
  (Predicate.isTagged(part.state, 'Accepted') && isOpenToolState(state)) ||
  (Predicate.isTagged(state, 'Running') &&
    isFinishedToolState(part.state) &&
    sameCall(call)(part)) ||
  (isRequestToolState(state) && isPastRequestToolState(part.state) && sameCall(call)(part))

/**
 * Whether the call a tool-batch event names (`call`, of the latest turn started after `anchor`) is
 * already finished (`hostToolCallMessage`, `isFinishedToolState`): a start of it is a replay.
 */
export const isFinishedToolCall = (
  messages: ReadonlyArray<AgentChatMessage>,
  call: ToolCall,
  anchor: ChatTurnAnchor
) =>
  hostToolCallMessage(messages, call, anchor)?.parts.some(
    part =>
      Predicate.isTagged(part, 'ToolCall') &&
      sameCall(call)(part) &&
      isFinishedToolState(part.state)
  ) === true

/**
 * Whether the call a request names (`call`, of the latest turn started after `anchor`) is already
 * past its request (`hostToolCallMessage`): such a request is a replay and changes nothing.
 */
export const isPastRequestToolCall = (
  messages: ReadonlyArray<AgentChatMessage>,
  call: ToolCall,
  anchor: ChatTurnAnchor
) =>
  hostToolCallMessage(messages, call, anchor)?.parts.some(
    part =>
      Predicate.isTagged(part, 'ToolCall') &&
      sameCall(call)(part) &&
      isPastRequestToolState(part.state)
  ) === true

/** Sets a call's state in its turn (`scope`), or adds the call there when the turn has none. */
const upsertToolCallPart = (
  messages: ReadonlyArray<AgentChatMessage>,
  call: ToolCall,
  state: ChatToolState,
  scope: ToolPartScope
): ReadonlyArray<AgentChatMessage> => {
  const existingIndex = matchedToolCallIndex(messages, call.id, scope, sameCall(call))

  if (existingIndex !== -1) {
    return messages.map((message, messageIndex) =>
      messageIndex === existingIndex
        ? {
            ...message,
            parts: message.parts.map(part =>
              Predicate.isTagged(part, 'ToolCall') && part.call.id === call.id
                ? keepsToolState(part, call, state)
                  ? part
                  : { ...part, call, state: mergeToolState(part.state, state) }
                : part
            )
          }
        : message
    )
  }

  return appendToolCallPart(messages, call, state, scope)
}

/** Updates the state of a call a host event acts on (`matchedToolCallIndex`); never adds one. */
const updateToolCallState = (
  messages: ReadonlyArray<AgentChatMessage>,
  callId: string,
  scope: ToolPartScope,
  replayed: ReplayedPart,
  update: (state: ChatToolState) => ChatToolState
): ReadonlyArray<AgentChatMessage> => {
  const index = matchedToolCallIndex(messages, callId, scope, replayed)

  return index === -1
    ? messages
    : messages.map((message, messageIndex) =>
        messageIndex === index
          ? {
              ...message,
              parts: message.parts.map(part =>
                Predicate.isTagged(part, 'ToolCall') && part.call.id === callId
                  ? { ...part, state: update(part.state) }
                  : part
              )
            }
          : message
      )
}

const inputStreamingToolCall = (id: string, name: string | undefined) =>
  ToolCall.make({ id, name: name ?? id, params: {} })

const appendToolInputDelta = (
  messages: ReadonlyArray<AgentChatMessage>,
  id: string,
  delta: string,
  scope: ToolPartScope
): ReadonlyArray<AgentChatMessage> =>
  messages.map((message, index) => ({
    ...message,
    parts:
      index < scope.from || scope.foreign.has(message.id)
        ? message.parts
        : message.parts.map(part =>
            Predicate.isTagged(part, 'ToolCall') &&
            part.call.id === id &&
            Predicate.isTagged(part.state, 'InputStreaming')
              ? { ...part, state: { ...part.state, input: `${part.state.input}${delta}` } }
              : part
          )
  }))

const finalizeAssistantParts = (
  parts: ReadonlyArray<AgentChatPart>
): ReadonlyArray<AgentChatPart> =>
  parts.map(part =>
    Match.value(part).pipe(
      Match.withReturnType<AgentChatPart>(),
      Match.tag('Text', 'Reasoning', current => ({
        ...current,
        state: 'done' satisfies ChatPartState
      })),
      Match.tag('Error', 'ToolCall', 'ToolResult', current => current),
      Match.exhaustive
    )
  )

const toolStateEntry = (part: AgentChatPart): ReadonlyArray<readonly [string, ChatToolState]> =>
  Predicate.isTagged(part, 'ToolCall') ? [[part.call.id, part.state]] : []

const toolStateByCallId = (parts: ReadonlyArray<AgentChatPart>) =>
  new Map(parts.flatMap(toolStateEntry))

const partsFromAssistantMessage = (
  message: AssistantAgentMessage,
  messageIndex: number,
  existingParts: ReadonlyArray<AgentChatPart>,
  acceptedCallIds: ReadonlySet<string>
) => {
  const states = toolStateByCallId(existingParts)

  const parts = assistantPartsFromMessage({
    message,
    messageIndex,
    sources: noToolPartSources
  }).flatMap((part): ReadonlyArray<AgentChatPart> => {
    if (!Predicate.isTagged(part, 'ToolCall')) return [part]

    if (acceptedCallIds.has(part.call.id)) {
      const accepted = existingParts.find(
        existing =>
          Predicate.isTagged(existing, 'ToolCall') &&
          existing.call.id === part.call.id &&
          Predicate.isTagged(existing.state, 'Accepted')
      )

      // An accepted call belongs to its original message, never a replay's new target.
      return accepted === undefined ? [] : [accepted]
    }

    return [{ ...part, state: states.get(part.call.id) ?? part.state }]
  })

  const preservesAcknowledgement =
    existingParts.some(
      part => Predicate.isTagged(part, 'ToolCall') && Predicate.isTagged(part.state, 'Accepted')
    ) ||
    message.parts.some(
      part =>
        (Predicate.isTagged(part, 'HostToolCall') ||
          Predicate.isTagged(part, 'ProviderToolCall')) &&
        acceptedCallIds.has(part.call.id)
    )

  // Partial/mixed replay cannot delete sibling calls already witnessed in this message, and no
  // message deletes a call a host step acted on: a tool batch that ran another execution's call
  // while this one streamed placed it here.
  const kept = existingParts.filter(
    existing =>
      Predicate.isTagged(existing, 'ToolCall') &&
      (preservesAcknowledgement || isHostToolState(existing.state)) &&
      !parts.some(part => Predicate.isTagged(part, 'ToolCall') && part.call.id === existing.call.id)
  )

  return kept.length === 0 ? parts : [...parts, ...kept]
}

/** A state a host event set, not the model's stream (input, a call, a provider result). */
const isHostToolState = (state: ChatToolState) =>
  !Predicate.isTagged(state, 'Called') &&
  !Predicate.isTagged(state, 'InputStreaming') &&
  !Predicate.isTagged(state, 'ProviderCompleted')

/** Puts an `AssistantMessage` in its turn (`scope`): an earlier turn's message is never replaced. */
const appendOrReplaceAssistantMessage = (
  messages: ReadonlyArray<AgentChatMessage>,
  message: AssistantAgentMessage,
  scope: ToolPartScope
) => {
  const acceptedCallIds = new Set(
    messages.flatMap((current, index) =>
      (index < scope.from ? [] : current.parts).flatMap(part =>
        Predicate.isTagged(part, 'ToolCall') && Predicate.isTagged(part.state, 'Accepted')
          ? [part.call.id]
          : []
      )
    )
  )

  const isAcceptedCallReplay = (part: AssistantPart) =>
    (Predicate.isTagged(part, 'HostToolCall') || Predicate.isTagged(part, 'ProviderToolCall')) &&
    acceptedCallIds.has(part.call.id)

  // A call-only replay must not replace the assistant message and drop active siblings.
  if (message.parts.length > 0 && message.parts.every(isAcceptedCallReplay)) return messages

  const messageToolCallIds = message.parts.flatMap(part =>
    Predicate.isTagged(part, 'HostToolCall') || Predicate.isTagged(part, 'ProviderToolCall')
      ? [part.call.id]
      : []
  )

  const replayIndex = message.parts.some(isAcceptedCallReplay)
    ? findLastMessageIndex(
        messages,
        (current, index) =>
          index >= scope.from &&
          current.role === 'assistant' &&
          !scope.foreign.has(current.id) &&
          messageToolCallIds.some(callId => hasToolCall(current, callId))
      )
    : -1

  const index =
    replayIndex !== -1
      ? Option.some(replayIndex)
      : Option.filter(lastAssistantIndex(messages, scope.foreign, scope.from), assistantIndex => {
          const current = messages[assistantIndex]

          return (
            hasStreamingPart(current) ||
            messageToolCallIds.some(callId => hasToolCall(current, callId))
          )
        })

  return Option.match(index, {
    onNone: () => {
      const parts = message.parts.filter(part => !isAcceptedCallReplay(part))

      if (parts.length === 0) return messages
      const sequence = nextMessageSequence(messages)

      return [
        ...messages,
        assistantChatMessage(
          AssistantAgentMessage.make({ ...message, parts }),
          sequence,
          lastTurnId(messages) ?? turnId(sequence)
        )
      ]
    },
    onSome: assistantIndex =>
      messages.map((current, messageIndex) =>
        messageIndex === assistantIndex
          ? {
              ...current,
              parts: partsFromAssistantMessage(
                message,
                current.sequence,
                current.parts,
                acceptedCallIds
              )
            }
          : current
      )
  })
}

const appendOrphanToolResult = (
  messages: ReadonlyArray<AgentChatMessage>,
  result: ToolResult
): ReadonlyArray<AgentChatMessage> => {
  const sequence = nextMessageSequence(messages)
  const currentTurnId = lastTurnId(messages) ?? turnId(sequence)

  return [
    ...messages,
    {
      id: `message-${sequence}-tool-result-message`,
      turnId: currentTurnId,
      sequence,
      role: 'system',
      parts: [
        {
          ...toolResultMessageFromResult(result),
          id: `tool-result-${result.toolCallId}`,
          name: result.toolCallId
        }
      ]
    }
  ]
}

const clearTransientParts = (
  messages: ReadonlyArray<AgentChatMessage>
): ReadonlyArray<AgentChatMessage> =>
  messages.flatMap(message => {
    const parts = message.parts.filter(part => !Predicate.isTagged(part, 'Error'))

    return parts.length > 0 ? [{ ...message, parts }] : []
  })

const isUnfinishedStreamPart = (part: AgentChatPart) =>
  ((Predicate.isTagged(part, 'Text') || Predicate.isTagged(part, 'Reasoning')) &&
    part.state === 'streaming') ||
  (Predicate.isTagged(part, 'ToolCall') && Predicate.isTagged(part.state, 'InputStreaming'))

/**
 * A model response ends with its `AssistantMessage`, so a response still streaming at the tail
 * when the next one starts belongs to a superseded execution (a retried or redelivered model
 * step): drop its unfinished parts, and the message when nothing else remains.
 */
const discardUnfinishedStream = (
  messages: ReadonlyArray<AgentChatMessage>
): ReadonlyArray<AgentChatMessage> => {
  const last = messages.at(-1)

  if (last === undefined || last.role !== 'assistant') return messages

  const parts = last.parts.filter(part => !isUnfinishedStreamPart(part))

  if (parts.length === last.parts.length) return messages

  const kept = messages.slice(0, -1)

  return parts.length === 0 ? kept : [...kept, { ...last, parts }]
}

/** What a model-step execution produced in the chat, for removal when it is superseded. */
export type AgentChatExecutionOutput = Data.TaggedEnum<{
  /** A chat message it created. */
  Message: { readonly messageId: string }
  /** A tool part it touched first, in `messageId`; `prior` is the part it replaced, if any. */
  ToolPart: {
    readonly callId: string
    readonly messageId: string
    readonly prior: Option.Option<AgentChatPart>
  }
  /**
   * A message it did not create that its `AssistantMessage` replaced, with the message as it was:
   * one in its turn (another execution's, or one the tool batch added, holding a call id a provider
   * reused), or any message when no start was seen.
   */
  ReplacedMessage: { readonly prior: AgentChatMessage }
  /**
   * Where its turn's output starts: after this chat message (none: the chat was empty). Recorded
   * at its start, from the execution it superseded when there is one.
   */
  After: { readonly messageId: Option.Option<string> }
  /**
   * Where its turn's output ends: this chat message was the last when a later turn of its run
   * started (none: the chat was empty). Recorded on an execution kept for reconciling.
   */
  Until: { readonly messageId: Option.Option<string> }
}>

export const AgentChatExecutionOutput = Data.taggedEnum<AgentChatExecutionOutput>()

const toolPartKey = (messageId: string, callId: string) => JSON.stringify([messageId, callId])

/** Where an execution's turn starts (`After`), or `undefined` when its output has none. */
export const executionTurnAnchor = (
  outputs: ReadonlyArray<AgentChatExecutionOutput>
): ChatTurnAnchor =>
  outputs.flatMap(output => (Predicate.isTagged(output, 'After') ? [output.messageId] : []))[0]

const createdMessageIds = (outputs: ReadonlyArray<AgentChatExecutionOutput>) =>
  new Set(
    outputs.flatMap(output => (Predicate.isTagged(output, 'Message') ? [output.messageId] : []))
  )

/**
 * The anchor of an execution's turn in `messages`: the index of the message its output follows
 * (`-1`: the chat was empty), or `undefined` when its output has no `After` (states built before
 * it) or that message is gone.
 */
const anchorIndex = (
  messages: ReadonlyArray<AgentChatMessage>,
  outputs: ReadonlyArray<AgentChatExecutionOutput>
) => {
  const after = executionTurnAnchor(outputs)

  if (after === undefined) return undefined

  const index = indexOfMessage(messages, after)

  return Option.isSome(after) && index === -1 ? undefined : index
}

/**
 * The index of the first message of an execution's turn: after its anchor; without one, after the
 * user message its turn answers (the last one before the first message it created; a user message
 * that followed the turn does not move it), else after the last user message.
 */
const turnOutputStart = (
  messages: ReadonlyArray<AgentChatMessage>,
  outputs: ReadonlyArray<AgentChatExecutionOutput>
) => {
  const anchor = anchorIndex(messages, outputs)

  if (anchor !== undefined) return anchor + 1

  const created = createdMessageIds(outputs)
  const first = messages.findIndex(message => created.has(message.id))

  return lastUserIndex(first === -1 ? messages : messages.slice(0, first)) + 1
}

/**
 * A message as it was before an execution's `AssistantMessage` replaced it (`prior`), keeping the
 * current part of each of its calls a host event acted on since (the tool batch ran it): the
 * replacement took that part over through a reused call id, and the host's state is the latest.
 */
const restoredMessage = (
  current: AgentChatMessage,
  prior: AgentChatMessage | undefined,
  unacknowledged: ReadonlySet<string>
): AgentChatMessage => {
  if (prior === undefined) return current

  const currentParts = new Map(
    current.parts.flatMap(part =>
      Predicate.isTagged(part, 'ToolCall') && !unacknowledged.has(part.call.id)
        ? [[part.call.id, part]]
        : []
    )
  )

  return {
    ...prior,
    parts: prior.parts.map(part =>
      Predicate.isTagged(part, 'ToolCall') ? (currentParts.get(part.call.id) ?? part) : part
    )
  }
}

/**
 * Removes a model-step execution's provisional output: the text and reasoning of the chat messages
 * it created, and each tool part it touched whose call no other event acknowledged
 * (`unacknowledged`), restored to the part it replaced (providers reuse call ids across turns) or
 * else removed. Only its own parts are touched, and nothing up to the user message its turn
 * answers (`turnOutputStart`); a user message that followed the turn does not protect it. A
 * message left with no parts goes too.
 */
export const discardChatExecutionOutput = (
  messages: ReadonlyArray<AgentChatMessage>,
  outputs: ReadonlyArray<AgentChatExecutionOutput>,
  unacknowledged: ReadonlySet<string>
): ReadonlyArray<AgentChatMessage> => {
  if (outputs.length === 0) return messages

  const created = createdMessageIds(outputs)

  const touched = new Map<string, Option.Option<AgentChatPart>>()

  for (const output of outputs) {
    if (Predicate.isTagged(output, 'ToolPart') && unacknowledged.has(output.callId)) {
      touched.set(toolPartKey(output.messageId, output.callId), output.prior)
    }
  }

  const replaced = new Map(
    outputs.flatMap(output =>
      Predicate.isTagged(output, 'ReplacedMessage') ? [[output.prior.id, output.prior]] : []
    )
  )

  const kept = lastUserIndex(messages.slice(0, turnOutputStart(messages, outputs)))

  return messages.flatMap((current, index) => {
    if (index <= kept) return [current]

    const message = restoredMessage(current, replaced.get(current.id), unacknowledged)
    const owned = created.has(message.id)

    const parts = message.parts.flatMap((part): ReadonlyArray<AgentChatPart> => {
      if (Predicate.isTagged(part, 'ToolCall')) {
        const prior = touched.get(toolPartKey(message.id, part.call.id))

        if (prior !== undefined) return Option.toArray(prior)

        return owned && unacknowledged.has(part.call.id) ? [] : [part]
      }

      return owned && (Predicate.isTagged(part, 'Text') || Predicate.isTagged(part, 'Reasoning'))
        ? []
        : [part]
    })

    if (
      parts.length === message.parts.length &&
      parts.every((part, i) => part === message.parts[i])
    )
      return [message]

    return parts.length === 0 ? [] : [{ ...message, parts }]
  })
}

/**
 * Shows a turn's committed answer instead of the one its shown execution produced (`AgentEnd` /
 * `AgentAwaitingInput` messages, for a turn that ran more than once): removes the execution's
 * output, takes the part of each committed tool call from the turn's messages (keeping its state,
 * such as a completed call or a pending question), and puts the committed message where the turn
 * starts. The turn's messages are those after its anchor (`After`) through the last one before a
 * later turn started (`Until`; the chat's end while none did), so a later turn's call or committed
 * answer is never taken. A message left with no parts goes. Without its anchor (states built
 * before it, or a host removed that message) the turn starts after the user message it answers
 * (`turnOutputStart`) and the answer goes where the execution's first message was, else last.
 */
export const replaceWithCommittedAnswer = (
  messages: ReadonlyArray<AgentChatMessage>,
  outputs: ReadonlyArray<AgentChatExecutionOutput>,
  calls: ReadonlySet<string>,
  answer: AssistantAgentMessage
): ReadonlyArray<AgentChatMessage> => {
  const anchor = anchorIndex(messages, outputs)
  const start = turnOutputStart(messages, outputs)

  const until = outputs.flatMap(output =>
    Predicate.isTagged(output, 'Until') ? [output.messageId] : []
  )[0]

  const untilIndex = until === undefined ? -1 : indexOfMessage(messages, until)

  // A later turn's start that the chat no longer shows bounds nothing: the turn runs to the end.
  const end =
    until === undefined || (Option.isSome(until) && untilIndex === -1)
      ? messages.length - 1
      : untilIndex

  const turn = new Set(messages.slice(start, end + 1).map(message => message.id))
  const position = new Map(messages.map((message, index) => [message.id, index]))
  const created = createdMessageIds(outputs)

  const firstCreated = messages.findIndex(
    (message, index) => index >= start && created.has(message.id)
  )

  const at = anchor !== undefined ? start : firstCreated === -1 ? messages.length : firstCreated

  const answerCalls = new Set(
    answer.parts.flatMap(part =>
      Predicate.isTagged(part, 'HostToolCall') || Predicate.isTagged(part, 'ProviderToolCall')
        ? [part.call.id]
        : []
    )
  )

  const states = new Map<string, ChatToolState>()

  const taken = discardChatExecutionOutput(messages, outputs, calls).flatMap(message => {
    if (!turn.has(message.id)) return [message]

    const parts = message.parts.filter(part => {
      if (
        !Predicate.isTagged(part, 'ToolCall') ||
        !answerCalls.has(part.call.id) ||
        states.has(part.call.id)
      )
        return true

      states.set(part.call.id, part.state)

      return false
    })

    if (parts.length === message.parts.length) return [message]

    return parts.length === 0 ? [] : [{ ...message, parts }]
  })

  const found = taken.findIndex(message => (position.get(message.id) ?? 0) >= at)
  const insert = found === -1 ? taken.length : found
  const sequence = nextMessageSequence(messages)
  const neighbour = taken[insert - 1] ?? taken[insert]
  const shown = assistantChatMessage(answer, sequence, neighbour?.turnId ?? turnId(sequence))

  const committed = {
    ...shown,
    parts: shown.parts.map(part =>
      Predicate.isTagged(part, 'ToolCall')
        ? { ...part, state: states.get(part.call.id) ?? part.state }
        : part
    )
  }

  return [...taken.slice(0, insert), committed, ...taken.slice(insert)]
}

/**
 * Ends every assistant message's streaming text and reasoning (a settled or other run's draft, or
 * one a user message followed), so a new stream starts its own message and never appends to it.
 */
const finalizeUnfinishedStream = (
  messages: ReadonlyArray<AgentChatMessage>
): ReadonlyArray<AgentChatMessage> =>
  messages.some(message => message.role === 'assistant' && hasStreamingPart(message))
    ? messages.map(message =>
        message.role === 'assistant' && hasStreamingPart(message)
          ? { ...message, parts: finalizeAssistantParts(message.parts) }
          : message
      )
    : messages

const finalizeStreamingParts = (
  messages: ReadonlyArray<AgentChatMessage>
): ReadonlyArray<AgentChatMessage> =>
  messages.map(message =>
    message.role === 'assistant'
      ? { ...message, parts: finalizeAssistantParts(message.parts) }
      : message
  )

const appendRunMessagesIfEmpty = (
  messages: ReadonlyArray<AgentChatMessage>,
  runMessages: ReadonlyArray<AgentMessage>
) => {
  const lastUserMessageIndex = findLastMessageIndex(messages, message => message.role === 'user')

  const hasAssistantAfterLastUser = messages.some(
    (message, index) => message.role === 'assistant' && index > lastUserMessageIndex
  )

  if (runMessages.length === 0 || hasAssistantAfterLastUser) {
    return messages
  }

  return [
    ...messages,
    ...buildAgentChatMessages({
      messages: runMessages,
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [],
      error: null
    })
  ]
}

export const appendProtocolMessage = (
  messages: ReadonlyArray<AgentChatMessage>,
  message: AgentMessage
) => {
  const sequence = nextMessageSequence(messages)

  return Match.value(message).pipe(
    // Host instruction messages (ADR 0007) are model context, never shown as user input.
    Match.tag('User', current =>
      isInstructionMessage(current)
        ? withInstructionAfterLast(messages, current)
        : [...messages, userChatMessage(current, sequence)]
    ),
    Match.tag('Assistant', current => [
      ...messages,
      assistantChatMessage(current, sequence, lastTurnId(messages) ?? turnId(sequence))
    ]),
    Match.tag('ToolResult', current => {
      const result = toolResultFromMessage(current)

      const isInteractionOutcome =
        Predicate.isObject(result.structuredContent) &&
        'type' in result.structuredContent &&
        result.structuredContent.type === 'interaction_outcome'

      // The result settles the last message holding its call: a provider can reuse the id in
      // several turns, and the latest is the one a hydrated or merged result answers.
      if (
        (current.acceptance !== undefined || isInteractionOutcome) &&
        messages.some(existing => hasToolCall(existing, current.toolCallId))
      ) {
        return updateToolCallState(
          messages,
          current.toolCallId,
          { from: 0, foreign: noForeignMessages, replays: false },
          () => false,
          state =>
            mergeToolState(
              state,
              current.acceptance !== undefined
                ? ChatToolState.Accepted({ result, resultEnvelope: chatMessageEnvelope(current) })
                : ChatToolState.Completed({ result })
            )
        )
      }

      return appendOrphanToolResult(messages, result)
    }),
    Match.exhaustive
  )
}

export const markChatError = (
  messages: ReadonlyArray<AgentChatMessage>,
  message: string
): ReadonlyArray<AgentChatMessage> => [
  ...messages.filter(
    chatMessage => !chatMessage.parts.some(part => Predicate.isTagged(part, 'Error'))
  ),
  {
    id: 'error-message',
    turnId: 'error-turn',
    sequence: nextMessageSequence(messages),
    role: 'system',
    parts: [AgentChatPart.Error({ id: 'error', message })]
  }
]

/**
 * Applies one event without tracking `eventId` replay state.
 *
 * Prefer `applyAgentEventToChatProjection` for durable streams that can replay
 * or overlap. Append-only text and reasoning deltas are not idempotent here.
 * Without the projection's turn starts, tool events match the last message holding a call, so a
 * call id a provider reused can update an earlier turn's call.
 */
export const applyAgentEventToChatMessages = (
  messages: ReadonlyArray<AgentChatMessage>,
  event: AgentEvent,
  options: ApplyAgentEventToChatMessagesOptions = {}
): ReadonlyArray<AgentChatMessage> =>
  applyExecutionEventToChatMessages(messages, event, options, {
    foreign: noForeignMessages,
    turn: undefined,
    modelTurn: undefined,
    runOutput: undefined
  })

/**
 * What an event may change: the model's stream never a message in `foreign` (another model-step
 * execution's output, an earlier turn's answer kept for reconciling), and a tool call only in the
 * event's turn: host events after `turn`, the model's after `modelTurn` (providers reuse call ids
 * across turns). Before a run's first model turn (`AgentChatTurnStart.run`), `runOutput` holds the
 * run's messages: a model tool event then replays an earlier run's and acts on a call before them
 * when one holds its id, else as usual (a host that streams without `LLMStreamStart`).
 */
type ChatEventScope = {
  readonly foreign: ForeignMessages
  readonly turn: ChatTurnAnchor
  readonly modelTurn: ChatTurnAnchor
  readonly runOutput: ForeignMessages | undefined
}

/**
 * The chat messages after a run's start (`anchor`; none: every message); none when the anchor
 * message is gone.
 */
export const messagesAfterAnchor = (
  messages: ReadonlyArray<AgentChatMessage>,
  anchor: Option.Option<string>
): ForeignMessages => {
  const index = indexOfMessage(messages, anchor)

  return Option.isSome(anchor) && index === -1
    ? noForeignMessages
    : new Set(messages.slice(index + 1).map(message => message.id))
}

/**
 * Applies one event of a turn (`scope`): its tool events match a call only in that turn, and its
 * stream's output never changes a message in `scope.foreign`, even through a call id a provider
 * reused; it goes to a message of its own.
 */
export const applyExecutionEventToChatMessages = (
  messages: ReadonlyArray<AgentChatMessage>,
  event: AgentEvent,
  options: ApplyAgentEventToChatMessagesOptions,
  scope: ChatEventScope
): ReadonlyArray<AgentChatMessage> => {
  const eventTimeMs = event.createdAtMs ?? options.nowMs ?? 0
  const foreign = scope.foreign

  // The model's stream never changes another execution's output; a host step acts on any call.
  const model: ToolPartScope = {
    from: turnStartIndex(messages, scope.modelTurn),
    foreign,
    replays: false
  }

  // Requests, the tool batch and answers act on a call the model placed, maybe a replay of one.
  const host: ToolPartScope = {
    from: turnStartIndex(messages, scope.turn),
    foreign: noForeignMessages,
    replays: true
  }

  // Before a run's first model turn, a model tool event replays an earlier run's: a call before the
  // run's messages comes first, never the resumed batch's call reusing its id.
  const replayed: ToolPartScope | undefined =
    scope.runOutput === undefined
      ? undefined
      : { from: 0, foreign: new Set([...foreign, ...scope.runOutput]), replays: false }

  const modelScope = (callId: string): ToolPartScope =>
    replayed !== undefined && toolCallMessageIndex(messages, callId, replayed) !== -1
      ? replayed
      : model

  const upsertModelToolCallPart = (call: ToolCall, state: ChatToolState) =>
    upsertToolCallPart(messages, call, state, modelScope(call.id))

  return Match.value(event)
    .pipe(
      Match.tag('AgentStart', () => clearTransientParts(messages)),
      Match.tag('LLMTextDelta', current =>
        appendAssistantTextDelta(
          messages,
          { delta: current.text, textSoFar: current.textSoFar },
          foreign
        )
      ),
      Match.tag('LLMReasoningDelta', current =>
        appendAssistantReasoningDelta(
          messages,
          { delta: current.text, reasoningSoFar: current.reasoningSoFar },
          foreign
        )
      ),
      // The live projection keeps one reasoning part per streaming message; the final
      // `AssistantMessage` brings the replay state and one part per block.
      Match.tag('LLMReasoningReplay', () => messages),
      Match.tag('ToolInputEnd', current =>
        upsertModelToolCallPart(current.call, ChatToolState.Called())
      ),
      Match.tag('UserMessage', current => appendProtocolMessage(messages, current.message)),
      Match.tag('AssistantMessage', current =>
        appendOrReplaceAssistantMessage(messages, current.message, model)
      ),
      Match.tag('ToolInputStart', current =>
        upsertModelToolCallPart(
          inputStreamingToolCall(current.id, current.name),
          ChatToolState.InputStreaming({ input: '' })
        )
      ),
      Match.tag('ToolInputDelta', current =>
        appendToolInputDelta(messages, current.id, current.delta, modelScope(current.id))
      ),
      Match.tag('ToolApprovalRequested', current =>
        upsertToolCallPart(
          messages,
          current.call,
          ChatToolState.ApprovalRequested({ request: current.request }),
          host
        )
      ),
      Match.tag('ToolApprovalGranted', () => messages)
    )
    .pipe(
      Match.tag('ToolApprovalDenied', current =>
        updateToolCallState(
          messages,
          current.toolCallId,
          host,
          part => Predicate.isTagged(part.state, 'ApprovalRequested'),
          () => ChatToolState.Denied({ reason: current.reason })
        )
      ),
      Match.tag('QuestionRequested', current =>
        upsertToolCallPart(
          messages,
          current.request.call,
          ChatToolState.QuestionRequested({ request: current.request }),
          host
        )
      ),
      Match.tag('InputRequested', current =>
        upsertToolCallPart(
          messages,
          current.request.call,
          ChatToolState.InputRequested({ request: current.request }),
          host
        )
      ),
      Match.tag('InteractionRequested', current =>
        upsertToolCallPart(
          messages,
          current.request.call,
          ChatToolState.InteractionRequested({ request: current.request }),
          host
        )
      ),
      Match.tag('InputSubmitted', current =>
        updateToolCallState(
          messages,
          current.response.toolCallId,
          host,
          answeredRequest(current.response.requestId),
          state =>
            preserveInputRequest(
              inputRequestFromToolState(state),
              ChatToolState.InputSubmitted({ response: current.response })
            )
        )
      ),
      Match.tag('InputCancelled', current =>
        updateToolCallState(
          messages,
          current.response.toolCallId,
          host,
          answeredRequest(current.response.requestId),
          state =>
            preserveInputRequest(
              inputRequestFromToolState(state),
              ChatToolState.InputCancelled({ response: current.response })
            )
        )
      ),
      Match.tag('InteractionSubmitted', current =>
        updateToolCallState(
          messages,
          current.response.toolCallId,
          host,
          answeredRequest(current.response.requestId),
          state =>
            preserveInteractionRequest(
              interactionRequestFromToolState(state),
              ChatToolState.InteractionSubmitted({ response: current.response })
            )
        )
      ),
      Match.tag('InteractionCancelled', current =>
        updateToolCallState(
          messages,
          current.response.toolCallId,
          host,
          answeredRequest(current.response.requestId),
          state =>
            preserveInteractionRequest(
              interactionRequestFromToolState(state),
              ChatToolState.InteractionCancelled({ response: current.response })
            )
        )
      ),
      Match.tag('QuestionAnswered', current =>
        updateToolCallState(
          messages,
          current.response.toolCallId,
          host,
          answeredRequest(current.response.requestId),
          state =>
            preserveQuestionRequest(
              questionRequestFromToolState(state),
              ChatToolState.QuestionAnswered({ response: current.response })
            )
        )
      ),
      Match.tag('QuestionCancelled', current =>
        updateToolCallState(
          messages,
          current.response.toolCallId,
          host,
          answeredRequest(current.response.requestId),
          state =>
            preserveQuestionRequest(
              questionRequestFromToolState(state),
              ChatToolState.QuestionCancelled({ response: current.response })
            )
        )
      ),
      Match.tag('ToolExecutionStarted', current =>
        upsertToolCallPart(
          messages,
          current.call,
          ChatToolState.Running({ startedAtMs: eventTimeMs }),
          host
        )
      ),
      Match.tag('ToolExecutionAccepted', 'ToolExecutionCompleted', current =>
        upsertToolCallPart(
          messages,
          current.call,
          Predicate.isTagged(current, 'ToolExecutionAccepted')
            ? ChatToolState.Accepted({ result: current.result, endedAtMs: eventTimeMs })
            : ChatToolState.Completed({ result: current.result, endedAtMs: eventTimeMs }),
          host
        )
      ),
      Match.tag('ToolExecutionError', current =>
        upsertToolCallPart(
          messages,
          current.call,
          ChatToolState.Errored({ message: current.message, endedAtMs: eventTimeMs }),
          host
        )
      ),
      Match.tag('ProviderToolResult', current =>
        upsertModelToolCallPart(
          current.call,
          ChatToolState.ProviderCompleted({ result: current.result })
        )
      ),
      Match.tag('AgentError', current => markChatError(messages, current.message)),
      Match.tag('AgentEnd', current =>
        appendRunMessagesIfEmpty(finalizeStreamingParts(messages), current.messages)
      ),
      Match.tag('AgentAwaitingInput', current =>
        current.requests.reduce(
          (pending, request) =>
            upsertToolCallPart(
              pending,
              request.call,
              Match.value(request).pipe(
                Match.tag('ToolApprovalRequest', request =>
                  ChatToolState.ApprovalRequested({ request })
                ),
                Match.tag('QuestionRequest', request =>
                  ChatToolState.QuestionRequested({ request })
                ),
                Match.tag('InputRequest', request => ChatToolState.InputRequested({ request })),
                Match.tag('InteractionRequest', request =>
                  ChatToolState.InteractionRequested({ request })
                ),
                Match.exhaustive
              ),
              host
            ),
          appendRunMessagesIfEmpty(finalizeStreamingParts(messages), current.messages)
        )
      ),
      // A tagged start's predecessor output is handled by execution routing (chat-core); a draft
      // still streaming then belongs to another run or a settled execution, so it is kept as done.
      Match.tag('LLMStreamStart', current =>
        current.executionId === undefined
          ? discardUnfinishedStream(messages)
          : finalizeUnfinishedStream(messages)
      ),
      Match.tag(
        'AgentRetry',
        'CompactionEnd',
        'CompactionStart',
        'LLMStreamEnd',
        'SubagentCompleted',
        'SubagentStarted',
        'TurnEnd',
        'TurnStart',
        'UsageUpdate',
        () => messages
      ),
      Match.exhaustive
    )
}

const chatMessagesFromProtocolMessage = ({
  message,
  sequence,
  currentTurnId,
  toolNames,
  pairedResults,
  sources
}: {
  readonly message: AgentMessage
  readonly sequence: number
  readonly currentTurnId: string
  readonly toolNames: ReadonlyMap<string, string>
  /** The indices of the result messages a tool call part shows; the others show on their own. */
  readonly pairedResults: ReadonlySet<number>
  readonly sources: ToolPartSources
}): ReadonlyArray<AgentChatMessage> =>
  Match.value(message).pipe(
    Match.withReturnType<ReadonlyArray<AgentChatMessage>>(),
    Match.tag('User', current =>
      isInstructionMessage(current) ? [] : [userChatMessage(current, sequence)]
    ),
    Match.tag('Assistant', current => [
      {
        id: messageId(sequence, 'assistant'),
        turnId: currentTurnId,
        sequence,
        role: 'assistant',
        parts: assistantPartsFromMessage({
          message: current,
          messageIndex: sequence,
          sources
        })
      }
    ]),
    Match.tag('ToolResult', current =>
      pairedResults.has(sequence)
        ? []
        : [
            {
              id: `message-${sequence}-tool-result-message`,
              turnId: currentTurnId,
              sequence,
              role: 'system',
              parts: [
                {
                  ...toolResultMessageFromResult(current),
                  id: `message-${sequence}-tool-result-${current.toolCallId}`,
                  name: toolNames.get(current.toolCallId) ?? current.toolCallId
                }
              ]
            }
          ]
    ),
    Match.exhaustive
  )

const draftUserMessage = (userDraft: string): ReadonlyArray<AgentChatMessage> =>
  userDraft.length > 0
    ? [
        {
          id: 'draft-user',
          turnId: 'draft-user-turn',
          sequence: -1,
          role: 'user',
          parts: [
            AgentChatPart.Text({
              id: 'draft-user-text',
              content: userDraft,
              state: 'streaming'
            })
          ]
        }
      ]
    : []

const draftReasoningPart = (reasoningDraft: string): ReadonlyArray<AgentChatPart> =>
  reasoningDraft.length > 0
    ? [
        AgentChatPart.Reasoning({
          id: 'draft-reasoning',
          text: reasoningDraft,
          state: 'streaming'
        })
      ]
    : []

const draftTextPart = (assistantDraft: string): ReadonlyArray<AgentChatPart> =>
  assistantDraft.length > 0
    ? [
        AgentChatPart.Text({
          id: 'draft-assistant-text',
          content: assistantDraft,
          state: 'streaming'
        })
      ]
    : []

const draftAssistantPart = ({
  reasoningDraft,
  assistantDraft
}: {
  readonly reasoningDraft: string
  readonly assistantDraft: string
}): ReadonlyArray<AgentChatPart> => [
  ...draftReasoningPart(reasoningDraft),
  ...draftTextPart(assistantDraft)
]

const draftAssistantMessage = ({
  reasoningDraft,
  assistantDraft
}: {
  readonly reasoningDraft: string
  readonly assistantDraft: string
}): ReadonlyArray<AgentChatMessage> => {
  const parts = draftAssistantPart({ reasoningDraft, assistantDraft })

  return parts.length > 0
    ? [
        {
          id: 'draft-assistant',
          turnId: 'draft-assistant-turn',
          sequence: -1,
          role: 'assistant',
          parts
        }
      ]
    : []
}

const errorChatMessage = (message: string | null): ReadonlyArray<AgentChatMessage> =>
  message === null
    ? []
    : [
        {
          id: 'error-message',
          turnId: 'error-turn',
          sequence: -1,
          role: 'system',
          parts: [AgentChatPart.Error({ id: 'error', message })]
        }
      ]

export const buildAgentChatMessages = ({
  messages,
  userDraft,
  assistantDraft,
  reasoningDraft,
  toolRuns,
  error
}: BuildAgentChatMessagesInput): ReadonlyArray<AgentChatMessage> => {
  const toolNames = collectToolNames(messages, toolRuns)
  const slots = collectToolCallSlots(messages)
  const resultPairs = collectToolResultPairs(messages, slots)
  const toolResultsByPart = new Map(resultPairs.map(pair => [pair.key, pair] as const))
  const pairedResults = new Set(resultPairs.map(pair => pair.messageIndex))

  const sources: ToolPartSources = {
    toolResultsByPart,
    toolRunsByPart: collectToolRunsByPart(slots, toolRuns, toolResultsByPart)
  }

  const builtMessages = messages.reduce<ReadonlyArray<AgentChatMessage>>(
    (current, message, index) => {
      if (isInstructionMessage(message)) return withInstructionAfterLast(current, message)

      const currentTurnId = Predicate.isTagged(message, 'User')
        ? turnId(index)
        : (lastTurnId(current) ?? turnId(index))

      return [
        ...current,
        ...chatMessagesFromProtocolMessage({
          message,
          sequence: index,
          currentTurnId,
          toolNames,
          pairedResults,
          sources
        })
      ]
    },
    []
  )

  return [
    ...builtMessages,
    ...draftUserMessage(userDraft),
    ...draftAssistantMessage({ reasoningDraft, assistantDraft }),
    ...errorChatMessage(error)
  ]
}

const collectContent = (parts: ReadonlyArray<AgentChatPart>): Content => {
  const contentPartsList = parts
    .filter(part => Predicate.isTagged(part, 'Text'))
    .flatMap(part => contentParts(part.content))

  const onlyPart = contentPartsList[0]

  if (
    onlyPart !== undefined &&
    contentPartsList.length === 1 &&
    Predicate.isTagged(onlyPart, 'Text')
  ) {
    return onlyPart.text
  }

  return contentPartsList
}

const collectToolResultMessages = (parts: ReadonlyArray<AgentChatPart>) =>
  parts.flatMap(part =>
    Match.value(part).pipe(
      Match.tag('ToolCall', current => {
        if (
          Predicate.isTagged(current.state, 'Completed') ||
          Predicate.isTagged(current.state, 'Accepted')
        ) {
          return [
            toolResultMessageFromResult(
              current.state.result,
              Predicate.isTagged(current.state, 'Accepted')
                ? current.state.resultEnvelope
                : undefined
            )
          ]
        }

        if (Predicate.isTagged(current.state, 'Denied')) {
          return [
            ToolResultMessage.make({
              toolCallId: current.call.id,
              content: `Tool call denied: ${current.state.reason}`,
              isError: true,
              structuredContent: { type: 'tool_approval_denied', reason: current.state.reason }
            })
          ]
        }

        if (
          Predicate.isTagged(current.state, 'QuestionAnswered') ||
          Predicate.isTagged(current.state, 'QuestionCancelled')
        ) {
          const response = current.state.response

          return [
            ToolResultMessage.make({
              toolCallId: response.toolCallId,
              content: formatQuestionResponseContent(response, current.state.request?.questions),
              isError: response.outcome === 'cancelled' ? true : undefined,
              structuredContent: questionResponseStructuredContent(response)
            })
          ]
        }

        if (
          Predicate.isTagged(current.state, 'InputSubmitted') ||
          Predicate.isTagged(current.state, 'InputCancelled')
        ) {
          const response = current.state.response
          const name = current.state.request?.call.name ?? response.toolCallId

          return [
            ToolResultMessage.make({
              toolCallId: response.toolCallId,
              content: formatInputResponseContent(response, name),
              isError: response.outcome === 'cancelled' ? true : undefined,
              structuredContent: inputResponseStructuredContent(response, name)
            })
          ]
        }

        // Interaction acceptance is never a synthetic tool result: submitted
        // interactions settle only through a server execution result. Only
        // Completed/Accepted states (real results) project above.
        if (
          Predicate.isTagged(current.state, 'InteractionRequested') ||
          Predicate.isTagged(current.state, 'InteractionSubmitted') ||
          Predicate.isTagged(current.state, 'InteractionCancelled')
        ) {
          return []
        }

        return []
      }),
      Match.tag('ToolResult', current => [toolResultMessageFromResult(current)]),
      Match.tag('Error', 'Reasoning', 'Text', () => []),
      Match.exhaustive
    )
  )

const assistantProtocolPartsFromChatParts = (
  parts: ReadonlyArray<AgentChatPart>
): ReadonlyArray<AssistantPart> =>
  parts.flatMap((part): ReadonlyArray<AssistantPart> =>
    Match.value(part).pipe(
      Match.tag('Text', current =>
        isContentEmpty(current.content)
          ? []
          : [AssistantTextPart.make({ content: current.content })]
      ),
      Match.tag('Reasoning', current =>
        current.text.length === 0 ? [] : [AssistantReasoningPart.make({ text: current.text })]
      ),
      Match.tag('ToolCall', current =>
        Predicate.isTagged(current.state, 'ProviderCompleted')
          ? [
              ProviderToolCallPart.make({ call: current.call }),
              ProviderToolResultPart.make({
                toolCallId: current.call.id,
                result: current.state.result
              })
            ]
          : [HostToolCallPart.make({ call: current.call })]
      ),
      Match.tag('Error', 'ToolResult', () => []),
      Match.exhaustive
    )
  )

const assistantMessageFromParts = (message: AgentChatMessage) => {
  const parts = message.parts
  const assistantParts = assistantProtocolPartsFromChatParts(parts)

  if (assistantParts.length === 0) {
    return Option.none<AgentMessage>()
  }

  return Option.some(
    AssistantAgentMessage.make({ ...chatMessageEnvelope(message), parts: assistantParts })
  )
}

const protocolMessagesFromChatMessage = (
  message: AgentChatMessage
): ReadonlyArray<AgentMessage> => [
  ...ownProtocolMessages(message),
  ...(message.instructionsAfter ?? [])
]

/**
 * Attaches a host instruction message to the last chat message (`instructionsAfter`). A
 * transcript that starts with one has no message to carry it: the loop then appends it again.
 */
const withInstructionAfterLast = (
  messages: ReadonlyArray<AgentChatMessage>,
  instruction: UserMessage
): ReadonlyArray<AgentChatMessage> => {
  const last = messages.at(-1)

  if (last === undefined) return messages

  return [
    ...messages.slice(0, -1),
    { ...last, instructionsAfter: [...(last.instructionsAfter ?? []), instruction] }
  ]
}

const ownProtocolMessages = (message: AgentChatMessage): ReadonlyArray<AgentMessage> => {
  switch (message.role) {
    case 'user': {
      const content = collectContent(message.parts)

      return isContentEmpty(content)
        ? []
        : [UserMessage.make({ ...chatMessageEnvelope(message), content })]
    }

    case 'assistant':
      return [
        ...Arr.getSomes([assistantMessageFromParts(message)]),
        ...collectToolResultMessages(message.parts)
      ]
    case 'system':
      return collectToolResultMessages(message.parts)
  }
}

export const toAgentMessages = (messages: ReadonlyArray<AgentChatMessage>) =>
  Arr.flatMap(messages, protocolMessagesFromChatMessage)
