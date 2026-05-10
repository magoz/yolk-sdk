'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import type { AgentEvent } from '@yolk/protocol'
import { agentTextReasoningEffort } from '@/lib/agents/text-agent-config'
import { defaultOpenAiRealtimeTranscriptionModel } from '@/lib/agents/realtime/openai-realtime'
import { AgentActivityPanel } from './agent-activity'
import {
  activityItemFromAgentEvent,
  maxActivityItems,
  type AgentActivityItem
} from './agent-activity-model'
import { getAgentChatLiveActivityCount } from './agent-chat-core'
import { AgentComposer } from './agent-composer'
import { AgentConsoleDialog } from './agent-console-dialog'
import { AgentConversation } from './agent-conversation'
import { AgentConversationHeader } from './agent-conversation-header'
import { buildAgentChatItems } from './agent-chat-items'
import { truncate } from './agent-format'
import { useAgentChat } from './use-agent-chat'
import { useRealtimeVoice, type VoiceDebugEvent } from './use-realtime-voice'

type AgentPlaygroundProps = {
  readonly sessionId: string
  readonly openAiCodexConnected: boolean
}

export function AgentPlayground({ sessionId, openAiCodexConnected }: AgentPlaygroundProps) {
  const [input, setInput] = useState('')
  const [activityVisible, setActivityVisible] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [showInlineTools, setShowInlineTools] = useState(true)
  const [showReasoning, setShowReasoning] = useState(true)
  const [reasoningEffort, setReasoningEffort] = useState(agentTextReasoningEffort)
  const [transcriptionModel, setTranscriptionModel] = useState(defaultOpenAiRealtimeTranscriptionModel)
  const [activityItems, setActivityItems] = useState<ReadonlyArray<AgentActivityItem>>([])
  const nextActivityIdRef = useRef(0)

  const recordActivity = useCallback((item: Omit<AgentActivityItem, 'id'>) => {
    const id = nextActivityIdRef.current
    nextActivityIdRef.current += 1
    setActivityItems(current => [...current.slice(-(maxActivityItems - 1)), { id, ...item }])
  }, [])

  const recordAgentEvent = useCallback(
    (event: AgentEvent) => {
      const item = activityItemFromAgentEvent(event)

      if (item !== null) {
        recordActivity(item)
      }
    },
    [recordActivity]
  )

  const recordAgentError = useCallback(
    (message: string) => {
      recordActivity({ title: 'Request error', detail: message, tone: 'error' })
    },
    [recordActivity]
  )

  const recordAgentAbort = useCallback(() => {
    recordActivity({
      title: 'Run aborted',
      detail: 'User stopped the active response.',
      tone: 'neutral'
    })
  }, [recordActivity])

  const recordVoiceDebug = useCallback(
    (event: VoiceDebugEvent) => {
      switch (event._tag) {
        case 'SessionOpened':
          recordActivity({
            title: 'Voice session opened',
            detail: `${event.seededMessageCount} seeded messages`,
            tone: 'neutral'
          })
          return
        case 'SessionConfigured':
          recordActivity({
            title: `Realtime ${event.eventType}`,
            detail: [
              `model=${event.model ?? 'unknown'}`,
              `transcription=${event.transcriptionModel ?? 'off'}`,
              `language=${event.transcriptionLanguage ?? 'auto'}`
            ].join(' · '),
            tone: 'neutral'
          })
          return
        case 'InputTranscript':
          recordActivity({
            title: `Input transcript ${event.itemId ?? 'unknown item'}`,
            detail: truncate(event.transcript),
            tone: 'neutral'
          })
          return
        case 'OutputTranscript':
          recordActivity({
            title: `Output transcript ${event.responseId ?? 'unknown response'}`,
            detail: truncate(event.transcript),
            tone: 'neutral'
          })
          return
        case 'ResponseDone':
          recordActivity({
            title: `Realtime response ${event.responseId ?? 'unknown'}`,
            detail: `status=${event.status ?? 'unknown'}`,
            tone: 'neutral'
          })
          return
      }
    },
    [recordActivity]
  )

  const agentChat = useAgentChat({
    sessionId,
    reasoningEffort,
    onEvent: recordAgentEvent,
    onError: recordAgentError,
    onAbort: recordAgentAbort
  })
  const { state, isRunning, canSubmitText, submitText, stop, applyEvent, appendMessage, fail } =
    agentChat

  const {
    audioRef,
    status: voiceStatus,
    userDraft: voiceUserDraft,
    isConnecting: isVoiceConnecting,
    isLive: isVoiceLive,
    toggleSession: toggleVoice
  } = useRealtimeVoice({
    messages: state.messages,
    transcriptionModel,
    onAgentEvent: applyEvent,
    onUserMessage: appendMessage,
    onError: fail,
    onDebug: recordVoiceDebug
  })
  const isVoiceMode = isVoiceConnecting || isVoiceLive
  const submitDisabled = isRunning || isVoiceMode
  const liveActivityCount = getAgentChatLiveActivityCount({
    isTextRunning: isRunning,
    activeToolCallCount: state.activeToolCalls.length,
    isVoiceActive: isVoiceMode
  })
  const chatItems = useMemo(
    () =>
      buildAgentChatItems({
        messages: state.messages,
        userDraft: voiceUserDraft,
        assistantDraft: state.text,
        reasoningDraft: state.reasoning,
        activeToolCalls: state.activeToolCalls,
        completedToolCalls: state.completedToolCalls,
        liveToolResults: state.toolResults,
        isRunning,
        error: state.error
      }),
    [
      isRunning,
      state.activeToolCalls,
      state.completedToolCalls,
      state.error,
      state.messages,
      state.reasoning,
      state.text,
      state.toolResults,
      voiceUserDraft
    ]
  )

  const handleSubmit = useCallback(() => {
    const content = input.trim()

    if (submitDisabled || !canSubmitText(content)) {
      return
    }

    recordActivity({ title: 'Prompt submitted', detail: content, tone: 'neutral' })
    const result = submitText(input)

    if (result._tag === 'Submitted') {
      setInput('')
    }
  }, [canSubmitText, input, recordActivity, submitDisabled, submitText])

  const handleInputChange = useCallback((value: string) => {
    setInput(value)
  }, [])

  const handleActivityToggle = useCallback(() => {
    setActivityVisible(current => !current)
  }, [])

  const handleConsoleOpen = useCallback(() => {
    setConsoleOpen(true)
  }, [])

  const handleConsoleOpenChange = useCallback((open: boolean) => {
    setConsoleOpen(open)
  }, [])

  const handleInlineToolsChange = useCallback((checked: boolean) => {
    setShowInlineTools(checked)
  }, [])

  const handleReasoningChange = useCallback((checked: boolean) => {
    setShowReasoning(checked)
  }, [])

  return (
    <main className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,var(--color-muted),transparent_34rem),linear-gradient(135deg,var(--color-background),var(--color-muted))] p-2 sm:p-4 md:p-6">
      <audio ref={audioRef} autoPlay className="sr-only" />
      <div className="mx-auto h-[calc(100vh-1rem)] max-w-5xl overflow-hidden rounded-[2rem] border border-foreground/10 bg-background/85 shadow-2xl shadow-foreground/10 backdrop-blur md:h-[calc(100vh-3rem)]">
        <section className="flex h-full min-h-0 min-w-0 flex-col bg-card/80">
          <AgentConversationHeader
            activityVisible={activityVisible}
            activityCount={activityItems.length}
            liveActivityCount={liveActivityCount}
            textStatus={state.status}
            voiceStatus={voiceStatus}
            isRunning={isRunning}
            isVoiceConnecting={isVoiceConnecting}
            isVoiceLive={isVoiceLive}
            onToggleActivity={handleActivityToggle}
            onOpenConsole={handleConsoleOpen}
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
            items={chatItems}
            showInlineTools={showInlineTools}
            showReasoning={showReasoning}
          />

          <AgentComposer
            input={input}
            submitDisabled={submitDisabled}
            isRunning={isRunning}
            isVoiceMode={isVoiceMode}
            isVoiceConnecting={isVoiceConnecting}
            isVoiceLive={isVoiceLive}
            onInputChange={handleInputChange}
            onSubmit={handleSubmit}
            onStop={stop}
            onToggleVoice={toggleVoice}
          />
        </section>
      </div>
      <AgentConsoleDialog
        open={consoleOpen}
        sessionId={sessionId}
        openAiCodexConnected={openAiCodexConnected}
        textStatus={state.status}
        voiceStatus={voiceStatus}
        reasoningEffort={reasoningEffort}
        reasoningEffortDisabled={isRunning}
        transcriptionModel={transcriptionModel}
        transcriptionModelDisabled={isVoiceMode}
        showInlineTools={showInlineTools}
        showReasoning={showReasoning}
        onOpenChange={handleConsoleOpenChange}
        onReasoningEffortChange={setReasoningEffort}
        onTranscriptionModelChange={setTranscriptionModel}
        onShowInlineToolsChange={handleInlineToolsChange}
        onShowReasoningChange={handleReasoningChange}
      />
    </main>
  )
}
