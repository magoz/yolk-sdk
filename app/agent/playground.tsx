'use client'

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Effect, Stream } from 'effect'
import { UserMessage, type AgentEvent, type AgentMessage } from '@yolk/protocol'
import {
  applyAgentEvent,
  appendAgentMessage,
  initialAgentClientState,
  markAgentAborted,
  markAgentError,
  streamAgentEvents,
  submitAgentUserMessage,
  type AgentClientState,
  type AgentTranscript
} from '@yolk/client'
import { Badge } from '@/components/ui/badge'
import { agentTextReasoningEffort } from '@/lib/agents/text-agent-config'
import {
  AgentActivityPanel,
  activityItemFromAgentEvent,
  maxActivityItems,
  type AgentActivityItem
} from './agent-activity'
import { AgentComposer } from './agent-composer'
import { AgentConversation } from './agent-conversation'
import { AgentConversationHeader } from './agent-conversation-header'
import { AgentStatusPanel } from './agent-status'
import { useRealtimeVoice } from './use-realtime-voice'

type AgentPlaygroundProps = {
  readonly sessionId: string
  readonly openAiCodexConnected: boolean
}

const hasMessageReasoning = (message: AgentMessage) =>
  message._tag === 'Assistant' && message.reasoning !== undefined && message.reasoning.length > 0

type AgentUiAction =
  | { readonly _tag: 'Submit'; readonly message: UserMessage }
  | { readonly _tag: 'AppendMessage'; readonly message: AgentMessage }
  | { readonly _tag: 'Event'; readonly event: AgentEvent }
  | { readonly _tag: 'Error'; readonly message: string }
  | { readonly _tag: 'Abort' }

const reducer = (state: AgentClientState, action: AgentUiAction): AgentClientState => {
  switch (action._tag) {
    case 'Submit':
      return submitAgentUserMessage(state, action.message)
    case 'AppendMessage':
      return { ...state, messages: appendAgentMessage(state.messages, action.message), error: null }
    case 'Event':
      return applyAgentEvent(state, action.event)
    case 'Error':
      return markAgentError(state, action.message)
    case 'Abort':
      return markAgentAborted(state)
  }
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Agent request failed'

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError'

export function AgentPlayground({ sessionId, openAiCodexConnected }: AgentPlaygroundProps) {
  const [state, dispatch] = useReducer(reducer, initialAgentClientState)
  const [input, setInput] = useState('')
  const [activityVisible, setActivityVisible] = useState(false)
  const [showInlineTools, setShowInlineTools] = useState(true)
  const [showReasoning, setShowReasoning] = useState(true)
  const [reasoningEffort, setReasoningEffort] = useState(agentTextReasoningEffort)
  const [activityItems, setActivityItems] = useState<ReadonlyArray<AgentActivityItem>>([])
  const abortControllerRef = useRef<AbortController | null>(null)
  const nextActivityIdRef = useRef(0)
  const isRunning = state.status === 'running'

  const recordActivity = useCallback((item: Omit<AgentActivityItem, 'id'>) => {
    const id = nextActivityIdRef.current
    nextActivityIdRef.current += 1
    setActivityItems(current => [...current.slice(-(maxActivityItems - 1)), { id, ...item }])
  }, [])

  const handleAgentEvent = useCallback(
    (event: AgentEvent) => {
      const item = activityItemFromAgentEvent(event)

      if (item !== null) {
        recordActivity(item)
      }

      dispatch({ _tag: 'Event', event })
    },
    [recordActivity]
  )

  const handleAgentError = useCallback(
    (message: string) => {
      recordActivity({ title: 'Request error', detail: message, tone: 'error' })
      dispatch({ _tag: 'Error', message })
    },
    [recordActivity]
  )

  const handleAgentAbort = useCallback(() => {
    recordActivity({ title: 'Run aborted', detail: 'User stopped the active response.', tone: 'neutral' })
    dispatch({ _tag: 'Abort' })
  }, [recordActivity])

  const handleUserMessage = useCallback((message: UserMessage) => {
    dispatch({ _tag: 'AppendMessage', message })
  }, [])

  const {
    audioRef,
    status: voiceStatus,
    userDraft: voiceUserDraft,
    isConnecting: isVoiceConnecting,
    isLive: isVoiceLive,
    toggleSession: toggleVoice
  } = useRealtimeVoice({
    messages: state.messages,
    onAgentEvent: handleAgentEvent,
    onUserMessage: handleUserMessage,
    onError: handleAgentError
  })
  const isVoiceMode = isVoiceConnecting || isVoiceLive
  const inputDisabled = isRunning || isVoiceMode
  const hasReasoningSummary = state.reasoning.length > 0 || state.messages.some(hasMessageReasoning)
  const liveActivityCount =
    (isRunning ? 1 : 0) + state.activeToolCalls.length + (isVoiceConnecting || isVoiceLive ? 1 : 0)

  const runAgent = useCallback(
    (messages: AgentTranscript) => {
      const controller = new AbortController()
      abortControllerRef.current = controller
      const clearController = Effect.sync(() => {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null
        }
      })

      Effect.runFork(
        Stream.fromAsyncIterable(
          streamAgentEvents({ sessionId, messages, reasoningEffort, signal: controller.signal }),
          error => error
        ).pipe(
          Stream.runForEach(event => Effect.sync(() => handleAgentEvent(event))),
          Effect.matchEffect({
            onFailure: caught =>
              Effect.sync(() => {
                if (controller.signal.aborted || isAbortError(caught)) {
                  handleAgentAbort()
                  return
                }

                handleAgentError(errorMessage(caught))
              }),
            onSuccess: () => Effect.void
          }),
          Effect.ensuring(clearController)
        )
      )
    },
    [handleAgentAbort, handleAgentError, handleAgentEvent, reasoningEffort, sessionId]
  )

  const handleSubmit = useCallback(() => {
    const content = input.trim()

    if (content.length === 0 || inputDisabled || abortControllerRef.current !== null) {
      return
    }

    const message = UserMessage.make({ content })
    const messages = appendAgentMessage(state.messages, message)

    setInput('')
    recordActivity({ title: 'Prompt submitted', detail: content, tone: 'neutral' })
    dispatch({ _tag: 'Submit', message })
    void runAgent(messages)
  }, [input, inputDisabled, recordActivity, runAgent, state.messages])

  const handleInputChange = useCallback((value: string) => {
    setInput(value)
  }, [])

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort()
  }, [])

  const handleActivityToggle = useCallback(() => {
    setActivityVisible(current => !current)
  }, [])

  const handleInlineToolsChange = useCallback((checked: boolean) => {
    setShowInlineTools(checked)
  }, [])

  const handleReasoningChange = useCallback((checked: boolean) => {
    setShowReasoning(checked)
  }, [])

  useEffect(() => () => {
    abortControllerRef.current?.abort()
  }, [])

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--color-muted),transparent_34rem)] p-4 md:p-8">
      <audio ref={audioRef} autoPlay className="sr-only" />
      <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl gap-6 lg:grid-cols-[0.82fr_1.18fr]">
        <section className="flex flex-col justify-between rounded-3xl border border-foreground/10 bg-background/80 p-6 shadow-sm backdrop-blur md:p-8">
          <div className="space-y-5">
            <Badge variant="outline" className="uppercase tracking-[0.18em]">
              Agent console
            </Badge>
            <div className="space-y-3">
              <h1 className="text-4xl font-semibold tracking-tight md:text-6xl">Yolk agent</h1>
              <p className="max-w-md text-sm leading-6 text-muted-foreground md:text-base">
                Unified text and voice agent using one client-owned transcript. No durable
                persistence yet; calculator tool calls are enabled.
              </p>
            </div>
          </div>

          <AgentStatusPanel
            sessionId={sessionId}
            openAiCodexConnected={openAiCodexConnected}
            textStatus={state.status}
            voiceStatus={voiceStatus}
            reasoningEffort={reasoningEffort}
            reasoningEffortDisabled={isRunning}
            onReasoningEffortChange={setReasoningEffort}
          />
        </section>

        <section className="flex min-h-[34rem] flex-col rounded-3xl border border-foreground/10 bg-card shadow-sm">
          <AgentConversationHeader
            activityVisible={activityVisible}
            activityCount={activityItems.length}
            liveActivityCount={liveActivityCount}
            showInlineTools={showInlineTools}
            showReasoning={showReasoning}
            hasReasoningSummary={hasReasoningSummary}
            isRunning={isRunning}
            isVoiceConnecting={isVoiceConnecting}
            isVoiceLive={isVoiceLive}
            onToggleActivity={handleActivityToggle}
            onShowInlineToolsChange={handleInlineToolsChange}
            onShowReasoningChange={handleReasoningChange}
          />

          {activityVisible ? (
            <AgentActivityPanel
              items={activityItems}
              textStatus={state.status}
              voiceStatus={voiceStatus}
              activeToolCallCount={state.activeToolCalls.length}
              toolResultCount={state.toolResults.length}
              error={state.error}
            />
          ) : null}

          <AgentConversation
            messages={state.messages}
            voiceUserDraft={voiceUserDraft}
            assistantDraft={state.text}
            reasoningDraft={state.reasoning}
            error={state.error}
            showInlineTools={showInlineTools}
            showReasoning={showReasoning}
          />

          <AgentComposer
            input={input}
            inputDisabled={inputDisabled}
            isRunning={isRunning}
            isVoiceMode={isVoiceMode}
            isVoiceConnecting={isVoiceConnecting}
            isVoiceLive={isVoiceLive}
            onInputChange={handleInputChange}
            onSubmit={handleSubmit}
            onStop={handleStop}
            onToggleVoice={toggleVoice}
          />
        </section>
      </div>
    </main>
  )
}
