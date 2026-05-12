'use client'

import { useCallback, useEffect, useReducer, useRef } from 'react'
import { Effect, Fiber, Stream } from 'effect'
import {
  appendAgentMessage,
  streamAgentEventStream,
  type AgentTranscript,
  type StreamAgentEventsRequest
} from '@yolk/client'
import {
  UserMessage,
  isContentEmpty,
  type AgentEvent,
  type AgentMessage,
  type AgentReasoningEffort,
  type Content
} from '@yolk/protocol'
import {
  hasAgentChatReasoningSummary,
  initialAgentChatState,
  reduceAgentChatState
} from './chat-core.ts'
import { toAgentMessages } from './chat-messages.ts'

export type AgentChatTransportRequest = Omit<StreamAgentEventsRequest, 'signal'> & {
  readonly signal: AbortSignal
}

export type AgentChatTransport = (request: AgentChatTransportRequest) => AsyncIterable<AgentEvent>

export type UseAgentChatOptions = {
  readonly sessionId: string
  readonly endpoint?: string
  readonly initialMessages?: ReadonlyArray<AgentMessage>
  readonly reasoningEffort?: AgentReasoningEffort
  readonly transport?: AgentChatTransport
  readonly onEvent?: (event: AgentEvent) => void
  readonly onError?: (message: string) => void
  readonly onAbort?: () => void
}

export type AgentChatSubmitResult =
  | {
      readonly _tag: 'Submitted'
      readonly content: Content
      readonly message: UserMessage
      readonly messages: AgentTranscript
    }
  | { readonly _tag: 'Ignored' }

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Agent request failed'

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError'

export function useAgentChat({
  sessionId,
  endpoint,
  initialMessages,
  reasoningEffort,
  transport,
  onEvent,
  onError,
  onAbort
}: UseAgentChatOptions) {
  const [state, dispatch] = useReducer(reduceAgentChatState, initialMessages ?? [], messages =>
    messages.reduce(
      (current, message) => reduceAgentChatState(current, { _tag: 'AppendMessage', message }),
      initialAgentChatState
    )
  )
  const abortControllerRef = useRef<AbortController | null>(null)
  const fiberRef = useRef<Fiber.Fiber<void, never> | null>(null)
  const isRunning = state.status === 'running'

  const applyEvent = useCallback(
    (event: AgentEvent) => {
      onEvent?.(event)
      dispatch({ _tag: 'Event', event })
    },
    [onEvent]
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
    (messages: AgentTranscript, signal: AbortSignal): AgentChatTransportRequest => {
      const base =
        endpoint === undefined ? { sessionId, messages } : { endpoint, sessionId, messages }

      return reasoningEffort === undefined
        ? { ...base, signal }
        : { ...base, reasoningEffort, signal }
    },
    [endpoint, reasoningEffort, sessionId]
  )

  const runAgent = useCallback(
    (messages: AgentTranscript) => {
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
          ? streamAgentEventStream(makeTransportRequest(messages, controller.signal))
          : Stream.fromAsyncIterable(
              transport(makeTransportRequest(messages, controller.signal)),
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
    (value: string) => value.trim().length > 0 && !isRunning && abortControllerRef.current === null,
    [isRunning]
  )

  const canSubmitContent = useCallback(
    (content: Content) =>
      !isContentEmpty(content) && !isRunning && abortControllerRef.current === null,
    [isRunning]
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

  const stop = useCallback(() => {
    const controller = abortControllerRef.current
    const fiber = fiberRef.current
    if (controller === null && fiber === null) {
      return
    }
    controller?.abort()
    if (fiber !== null) {
      Effect.runFork(Fiber.interrupt(fiber))
    }
    markAborted()
  }, [markAborted])

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
    canSubmitText,
    canSubmitContent,
    submitMessage,
    submitText,
    stop,
    applyEvent,
    appendMessage,
    fail
  }
}
