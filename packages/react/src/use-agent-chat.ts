'use client'

import { useCallback, useEffect, useReducer, useRef } from 'react'
import { Effect, Fiber, Option, Stream } from 'effect'
import {
  appendAgentMessage,
  streamAgentEventStream,
  type AgentTranscript,
  type StreamAgentEventsRequest
} from '@yolk-sdk/agent/client'
import {
  UserMessage,
  isContentEmpty,
  type AgentEvent,
  type AgentMessage,
  type AgentReasoningEffort,
  type Content,
  type HitlResponse,
  type QuestionResponse,
  type ToolApprovalResponse
} from '@yolk-sdk/agent/protocol'
import {
  hasAgentChatReasoningSummary,
  initialAgentChatState,
  reduceAgentChatState
} from './chat-core.ts'
import {
  deleteChatTurn,
  editChatUserMessage,
  regenerateChatMessagesFrom,
  toAgentMessages
} from './chat-messages.ts'

export type AgentChatTransportRequest = Omit<StreamAgentEventsRequest, 'signal'> & {
  readonly signal: AbortSignal
}

export type AgentChatTransport = (request: AgentChatTransportRequest) => AsyncIterable<AgentEvent>

export type UseAgentChatOptions = {
  readonly sessionId: string
  readonly endpoint?: string
  readonly initialMessages?: ReadonlyArray<AgentMessage>
  readonly model?: string
  readonly reasoningEffort?: AgentReasoningEffort
  readonly transport?: AgentChatTransport
  readonly onEvent?: (event: AgentEvent) => void
  readonly onError?: (message: string) => void
  readonly onAbort?: () => void
  readonly nowMs?: () => number
}

export type AgentChatSubmitResult =
  | {
      readonly _tag: 'Submitted'
      readonly content: Content
      readonly message: UserMessage
      readonly messages: AgentTranscript
    }
  | { readonly _tag: 'Ignored' }

export type AgentChatDeleteTurnResult =
  | {
      readonly _tag: 'Deleted'
      readonly turnStartMessageId: string
      readonly deletedMessageIds: ReadonlyArray<string>
    }
  | { readonly _tag: 'Ignored' }

export type AgentChatRegenerateResult =
  | {
      readonly _tag: 'Regenerated'
      readonly messageId: string
      readonly messages: AgentTranscript
    }
  | { readonly _tag: 'Ignored' }

export type AgentChatEditUserMessageResult =
  | {
      readonly _tag: 'Edited'
      readonly messageId: string
      readonly messages: AgentTranscript
    }
  | { readonly _tag: 'Ignored' }

export type AgentChatHitlResponseResult =
  | {
      readonly _tag: 'Submitted'
      readonly response: HitlResponse
      readonly messages: AgentTranscript
    }
  | { readonly _tag: 'Ignored' }

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Agent request failed'

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError'

const defaultNowMs = () => globalThis.performance?.now() ?? 0

const transcriptFromChatMessages = (messages: ReadonlyArray<AgentMessage>) => {
  const first = messages[0]

  return first === undefined
    ? Option.none<AgentTranscript>()
    : Option.some<AgentTranscript>([first, ...messages.slice(1)])
}

export function useAgentChat({
  sessionId,
  endpoint,
  initialMessages,
  model,
  reasoningEffort,
  transport,
  onEvent,
  onError,
  onAbort,
  nowMs = defaultNowMs
}: UseAgentChatOptions) {
  const [state, dispatch] = useReducer(reduceAgentChatState, initialMessages ?? [], messages =>
    messages.reduce(
      (current, message) => reduceAgentChatState(current, { _tag: 'HydrateMessage', message }),
      initialAgentChatState
    )
  )
  const abortControllerRef = useRef<AbortController | null>(null)
  const fiberRef = useRef<Fiber.Fiber<void, never> | null>(null)
  const isRunning = state.status === 'running'
  const isWaiting = state.status === 'waiting'

  const applyEvent = useCallback(
    (event: AgentEvent) => {
      onEvent?.(event)
      dispatch({ _tag: 'Event', event, nowMs: nowMs() })
    },
    [nowMs, onEvent]
  )

  const fail = useCallback(
    (message: string) => {
      onError?.(message)
      dispatch({ _tag: 'Error', message })
    },
    [onError]
  )

  const markAborted = useCallback(() => {
    onAbort?.()
    dispatch({ _tag: 'Abort' })
  }, [onAbort])

  const appendMessage = useCallback((message: AgentMessage) => {
    dispatch({ _tag: 'AppendMessage', message })
  }, [])

  const makeTransportRequest = useCallback(
    (
      messages: AgentTranscript,
      signal: AbortSignal,
      hitlResponses?: ReadonlyArray<HitlResponse>
    ): AgentChatTransportRequest => {
      const base =
        endpoint === undefined ? { sessionId, messages } : { endpoint, sessionId, messages }

      return { ...base, hitlResponses, model, reasoningEffort, signal }
    },
    [endpoint, model, reasoningEffort, sessionId]
  )

  const runAgent = useCallback(
    (messages: AgentTranscript, hitlResponses?: ReadonlyArray<HitlResponse>) => {
      const controller = new AbortController()
      abortControllerRef.current = controller
      const clearController = Effect.sync(() => {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null
          fiberRef.current = null
        }
      })
      const eventStream =
        transport === undefined
          ? streamAgentEventStream(makeTransportRequest(messages, controller.signal, hitlResponses))
          : Stream.fromAsyncIterable(
              transport(makeTransportRequest(messages, controller.signal, hitlResponses)),
              error => error
            )

      const fiber = Effect.runFork(
        eventStream.pipe(
          Stream.runForEach(event => Effect.sync(() => applyEvent(event))),
          Effect.matchEffect({
            onFailure: caught =>
              Effect.sync(() => {
                if (controller.signal.aborted || isAbortError(caught)) {
                  markAborted()
                  return
                }

                fail(errorMessage(caught))
              }),
            onSuccess: () => Effect.void
          }),
          Effect.ensuring(clearController)
        )
      )
      fiberRef.current = fiber
    },
    [applyEvent, fail, makeTransportRequest, markAborted, transport]
  )

  const canSubmitText = useCallback(
    (value: string) =>
      value.trim().length > 0 && !isRunning && !isWaiting && abortControllerRef.current === null,
    [isRunning, isWaiting]
  )

  const canSubmitContent = useCallback(
    (content: Content) =>
      !isContentEmpty(content) && !isRunning && !isWaiting && abortControllerRef.current === null,
    [isRunning, isWaiting]
  )

  const canSubmitHitlResponse = useCallback(
    () => isWaiting && !isRunning && abortControllerRef.current === null,
    [isRunning, isWaiting]
  )

  const submitMessage = useCallback(
    (message: UserMessage): AgentChatSubmitResult => {
      if (!canSubmitContent(message.content)) {
        return { _tag: 'Ignored' }
      }

      const messages = appendAgentMessage(toAgentMessages(state.chatMessages), message)

      dispatch({ _tag: 'Submit', message })
      runAgent(messages)

      return { _tag: 'Submitted', content: message.content, message, messages }
    },
    [canSubmitContent, runAgent, state.chatMessages]
  )

  const submitText = useCallback(
    (value: string): AgentChatSubmitResult => {
      const content = value.trim()

      if (!canSubmitText(content)) {
        return { _tag: 'Ignored' }
      }

      return submitMessage(UserMessage.make({ content }))
    },
    [canSubmitText, submitMessage]
  )

  const deleteTurn = useCallback(
    (messageId: string): AgentChatDeleteTurnResult => {
      if (isRunning || isWaiting || abortControllerRef.current !== null) {
        return { _tag: 'Ignored' }
      }

      const next = deleteChatTurn(state.chatMessages, messageId)

      if (next._tag === 'NotFound') {
        return { _tag: 'Ignored' }
      }

      dispatch({ _tag: 'DeleteTurn', messageId })

      return {
        _tag: 'Deleted',
        turnStartMessageId: next.turnStartMessageId,
        deletedMessageIds: next.deletedMessageIds
      }
    },
    [isRunning, isWaiting, state.chatMessages]
  )

  const regenerateFrom = useCallback(
    (messageId: string): AgentChatRegenerateResult => {
      if (isRunning || isWaiting || abortControllerRef.current !== null) {
        return { _tag: 'Ignored' }
      }

      const next = regenerateChatMessagesFrom(state.chatMessages, messageId)

      if (next._tag === 'NotFound') {
        return { _tag: 'Ignored' }
      }

      const messages = toAgentMessages(next.messages)
      const transcript = transcriptFromChatMessages(messages)

      return Option.match(transcript, {
        onNone: () => ({ _tag: 'Ignored' }),
        onSome: value => {
          dispatch({ _tag: 'RegenerateFrom', messageId })
          runAgent(value)

          return { _tag: 'Regenerated', messageId, messages: value }
        }
      })
    },
    [isRunning, isWaiting, runAgent, state.chatMessages]
  )

  const editUserMessage = useCallback(
    (messageId: string, content: Content): AgentChatEditUserMessageResult => {
      if (isContentEmpty(content) || isRunning || isWaiting || abortControllerRef.current !== null) {
        return { _tag: 'Ignored' }
      }

      const next = editChatUserMessage(state.chatMessages, messageId, content)

      if (next._tag !== 'Edited') {
        return { _tag: 'Ignored' }
      }

      const messages = toAgentMessages(next.messages)
      const transcript = transcriptFromChatMessages(messages)

      return Option.match(transcript, {
        onNone: () => ({ _tag: 'Ignored' }),
        onSome: value => {
          dispatch({ _tag: 'EditUserMessage', messageId, content })
          runAgent(value)

          return { _tag: 'Edited', messageId: next.messageId, messages: value }
        }
      })
    },
    [isRunning, isWaiting, runAgent, state.chatMessages]
  )

  const submitHitlResponse = useCallback(
    (response: HitlResponse): AgentChatHitlResponseResult => {
      if (!canSubmitHitlResponse()) {
        return { _tag: 'Ignored' }
      }

      const transcript = transcriptFromChatMessages(toAgentMessages(state.chatMessages))

      return Option.match(transcript, {
        onNone: () => ({ _tag: 'Ignored' }),
        onSome: messages => {
          dispatch({ _tag: 'SubmitHitlResponse', response })
          runAgent(messages, [response])

          return { _tag: 'Submitted', response, messages }
        }
      })
    },
    [canSubmitHitlResponse, runAgent, state.chatMessages]
  )

  const submitToolApprovalResponse = useCallback(
    (response: ToolApprovalResponse): AgentChatHitlResponseResult => submitHitlResponse(response),
    [submitHitlResponse]
  )

  const submitQuestionResponse = useCallback(
    (response: QuestionResponse): AgentChatHitlResponseResult => submitHitlResponse(response),
    [submitHitlResponse]
  )

  const stop = useCallback(() => {
    const controller = abortControllerRef.current
    const fiber = fiberRef.current
    if (controller === null && fiber === null && !isRunning) {
      return
    }
    controller?.abort()
    if (fiber !== null) {
      Effect.runFork(Fiber.interrupt(fiber))
    }
    markAborted()
  }, [isRunning, markAborted])

  useEffect(
    () => () => {
      abortControllerRef.current?.abort()
      const fiber = fiberRef.current
      if (fiber !== null) {
        Effect.runFork(Fiber.interrupt(fiber))
      }
    },
    []
  )

  return {
    state,
    chatMessages: state.chatMessages,
    messages: toAgentMessages(state.chatMessages),
    hasReasoningSummary: hasAgentChatReasoningSummary(state),
    status: state.status,
    error: state.error,
    isRunning,
    isWaiting,
    canSubmitText,
    canSubmitContent,
    canSubmitHitlResponse,
    submitMessage,
    submitText,
    submitToolApprovalResponse,
    submitQuestionResponse,
    deleteTurn,
    regenerateFrom,
    editUserMessage,
    stop,
    applyEvent,
    appendMessage,
    fail
  }
}
