'use client'

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
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

  const voice = useRealtimeVoice({
    messages: state.messages,
    onAgentEvent: handleAgentEvent,
    onUserMessage: handleUserMessage,
    onError: handleAgentError
  })
  const isVoiceMode = voice.isConnecting || voice.isLive
  const inputDisabled = isRunning || isVoiceMode
  const liveActivityCount =
    (isRunning ? 1 : 0) + state.activeToolCalls.length + (voice.isConnecting || voice.isLive ? 1 : 0)

  const runAgent = useCallback(
    async (messages: AgentTranscript) => {
      const controller = new AbortController()
      abortControllerRef.current = controller

      try {
        for await (const event of streamAgentEvents({ sessionId, messages, signal: controller.signal })) {
          handleAgentEvent(event)
        }
      } catch (caught) {
        if (controller.signal.aborted || isAbortError(caught)) {
          handleAgentAbort()
          return
        }

        handleAgentError(errorMessage(caught))
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null
        }
      }
    },
    [handleAgentAbort, handleAgentError, handleAgentEvent, sessionId]
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

  useEffect(() => () => {
    abortControllerRef.current?.abort()
  }, [])

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--color-muted),transparent_34rem)] p-4 md:p-8">
      <audio ref={voice.audioRef} autoPlay className="sr-only" />
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
            voiceStatus={voice.status}
          />
        </section>

        <section className="flex min-h-[34rem] flex-col rounded-3xl border border-foreground/10 bg-card shadow-sm">
          <AgentConversationHeader
            activityVisible={activityVisible}
            activityCount={activityItems.length}
            liveActivityCount={liveActivityCount}
            isRunning={isRunning}
            isVoiceConnecting={voice.isConnecting}
            isVoiceLive={voice.isLive}
            onToggleActivity={handleActivityToggle}
          />

          {activityVisible ? (
            <AgentActivityPanel
              items={activityItems}
              textStatus={state.status}
              voiceStatus={voice.status}
              activeToolCallCount={state.activeToolCalls.length}
              toolResultCount={state.toolResults.length}
              error={state.error}
            />
          ) : null}

          <AgentConversation
            messages={state.messages}
            voiceUserDraft={voice.userDraft}
            assistantDraft={state.text}
            error={state.error}
          />

          <AgentComposer
            input={input}
            inputDisabled={inputDisabled}
            isRunning={isRunning}
            isVoiceMode={isVoiceMode}
            isVoiceConnecting={voice.isConnecting}
            isVoiceLive={voice.isLive}
            onInputChange={handleInputChange}
            onSubmit={handleSubmit}
            onStop={handleStop}
            onToggleVoice={voice.toggleSession}
          />
        </section>
      </div>
    </main>
  )
}
