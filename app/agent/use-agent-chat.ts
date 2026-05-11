'use client'

import { useCallback, useEffect, useReducer, useRef } from 'react'
import { Effect, Stream } from 'effect'
import { streamAgentEvents, type AgentTranscript } from '@yolk/client'
import {
  UserMessage,
  isContentEmpty,
  type AgentEvent,
  type AgentMessage,
  type Content,
  type AgentReasoningEffort
} from '@yolk/protocol'
import {
  hasAgentChatReasoningSummary,
  initialAgentChatState,
  reduceAgentChatState
} from './agent-chat-core'
import { toAgentMessages } from './agent-chat-messages'

export type AgentChatTransportRequest = {
  readonly sessionId: string
  readonly messages: AgentTranscript
  readonly reasoningEffort?: AgentReasoningEffort
  readonly signal: AbortSignal
}

export type AgentChatTransport = (request: AgentChatTransportRequest) => AsyncIterable<AgentEvent>

export type UseAgentChatOptions = {
  readonly sessionId: string
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

const appendTranscriptMessage = (
  messages: ReadonlyArray<AgentMessage>,
  message: AgentMessage
): AgentTranscript => {
  const first = messages[0]

  if (first === undefined) {
    return [message]
  }

  return [first, ...messages.slice(1), message]
}

export function useAgentChat({
  sessionId,
  reasoningEffort,
  transport,
  onEvent,
  onError,
  onAbort
}: UseAgentChatOptions) {
  const [state, dispatch] = useReducer(reduceAgentChatState, initialAgentChatState)
  const abortControllerRef = useRef<AbortController | null>(null)
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
    (messages: AgentTranscript, signal: AbortSignal): AgentChatTransportRequest =>
      reasoningEffort === undefined
        ? { sessionId, messages, signal }
        : { sessionId, messages, reasoningEffort, signal },
    [reasoningEffort, sessionId]
  )

  const runAgent = useCallback(
    (messages: AgentTranscript) => {
      const controller = new AbortController()
      const runTransport = transport ?? streamAgentEvents
      abortControllerRef.current = controller
      const clearController = Effect.sync(() => {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null
        }
      })

      Effect.runFork(
        Stream.fromAsyncIterable(
          runTransport(makeTransportRequest(messages, controller.signal)),
          error => error
        ).pipe(
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

      const messages = appendTranscriptMessage(toAgentMessages(state.chatMessages), message)

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
    abortControllerRef.current?.abort()
  }, [])

  useEffect(
    () => () => {
      abortControllerRef.current?.abort()
    },
    []
  )

  return {
    state,
    messages: toAgentMessages(state.chatMessages),
    status: state.status,
    error: state.error,
    isRunning,
    hasReasoningSummary: hasAgentChatReasoningSummary(state),
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
