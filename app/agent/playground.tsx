'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { Option } from 'effect'
import { UserMessage, type AgentEvent } from '@yolk/protocol'
import { agentTextReasoningEffort } from '@/lib/agents/text-agent-config'
import { defaultOpenAiRealtimeTranscriptionModel } from '@/lib/agents/realtime/openai-realtime'
import { AgentActivityPanel } from './agent-activity'
import {
  activityItemFromAgentEvent,
  maxActivityItems,
  type AgentActivityItem
} from './agent-activity-model'
import {
  getActiveChatToolParts,
  getAgentChatLiveActivityCount,
  getCompletedChatToolParts
} from './agent-chat-core'
import { AgentComposer } from './agent-composer'
import { contentFromInput, type ImageAttachment } from './image-attachment-content'
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

const maxImageAttachmentBytes = 5 * 1024 * 1024

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }

      reject(new Error('Could not read image'))
    })
    reader.addEventListener('error', () => reject(new Error('Could not read image')))
    reader.readAsDataURL(file)
  })

const base64FromDataUrl = (dataUrl: string) => {
  const separatorIndex = dataUrl.indexOf(',')

  return separatorIndex === -1 ? '' : dataUrl.slice(separatorIndex + 1)
}

export function AgentPlayground({ sessionId, openAiCodexConnected }: AgentPlaygroundProps) {
  const [input, setInput] = useState('')
  const [imageAttachment, setImageAttachment] = useState<ImageAttachment | null>(null)
  const [activityVisible, setActivityVisible] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [showInlineTools, setShowInlineTools] = useState(true)
  const [showReasoning, setShowReasoning] = useState(true)
  const [reasoningEffort, setReasoningEffort] = useState(agentTextReasoningEffort)
  const [transcriptionModel, setTranscriptionModel] = useState(
    defaultOpenAiRealtimeTranscriptionModel
  )
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
  const {
    state,
    isRunning,
    canSubmitContent,
    submitMessage,
    stop,
    applyEvent,
    appendMessage,
    fail
  } = agentChat

  const {
    audioRef,
    status: voiceStatus,
    userDraft: voiceUserDraft,
    isConnecting: isVoiceConnecting,
    isLive: isVoiceLive,
    toggleSession: toggleVoice
  } = useRealtimeVoice({
    messages: agentChat.messages,
    transcriptionModel,
    onAgentEvent: applyEvent,
    onUserMessage: appendMessage,
    onError: fail,
    onDebug: recordVoiceDebug
  })
  const isVoiceMode = isVoiceConnecting || isVoiceLive
  const submitDisabled = isRunning || isVoiceMode
  const activeToolParts = useMemo(
    () => getActiveChatToolParts(state.chatMessages),
    [state.chatMessages]
  )
  const completedToolParts = useMemo(
    () => getCompletedChatToolParts(state.chatMessages),
    [state.chatMessages]
  )
  const activeToolRunCount = activeToolParts.length
  const completedToolRunCount = completedToolParts.length
  const liveActivityCount = getAgentChatLiveActivityCount({
    isTextRunning: isRunning,
    activeToolCallCount: activeToolRunCount,
    isVoiceActive: isVoiceMode
  })
  const activeToolLabel = useMemo(() => {
    const firstRun = activeToolParts[0]

    if (firstRun === undefined) {
      return Option.none()
    }

    return Option.some(
      activeToolParts.length === 1
        ? `Running ${firstRun.call.name}`
        : `Running ${activeToolParts.length} tools`
    )
  }, [activeToolParts])
  const chatItems = useMemo(
    () =>
      buildAgentChatItems({
        messages:
          voiceUserDraft.length > 0
            ? [
                ...state.chatMessages,
                {
                  id: 'draft-user',
                  role: 'user',
                  parts: [
                    {
                      _tag: 'Text',
                      id: 'draft-user-text',
                      content: voiceUserDraft,
                      state: 'streaming'
                    }
                  ]
                }
              ]
            : state.chatMessages,
        isRunning,
        activeToolLabel
      }),
    [activeToolLabel, isRunning, state.chatMessages, voiceUserDraft]
  )

  const handleSubmit = useCallback(() => {
    const content = contentFromInput(input, imageAttachment)

    if (submitDisabled || !canSubmitContent(content)) {
      return
    }

    recordActivity({
      title: imageAttachment === null ? 'Prompt submitted' : 'Image prompt submitted',
      detail: imageAttachment === null ? input.trim() : imageAttachment.name,
      tone: 'neutral'
    })
    const result = submitMessage(UserMessage.make({ content }))

    if (result._tag === 'Submitted') {
      setInput('')
      setImageAttachment(null)
    }
  }, [canSubmitContent, imageAttachment, input, recordActivity, submitDisabled, submitMessage])

  const handleImageAttachmentChange = useCallback(
    (file: File | null) => {
      if (file === null) {
        return
      }

      if (!file.type.startsWith('image/')) {
        recordActivity({ title: 'Image rejected', detail: 'Unsupported file type.', tone: 'error' })
        return
      }

      if (file.size > maxImageAttachmentBytes) {
        recordActivity({
          title: 'Image rejected',
          detail: 'Image must be 5MB or smaller.',
          tone: 'error'
        })
        return
      }

      readFileAsDataUrl(file)
        .then(previewUrl => {
          const data = base64FromDataUrl(previewUrl)

          if (data.length === 0) {
            recordActivity({
              title: 'Image rejected',
              detail: 'Could not decode image.',
              tone: 'error'
            })
            return
          }

          setImageAttachment({ name: file.name, mimeType: file.type, previewUrl, data })
          recordActivity({ title: 'Image attached', detail: file.name, tone: 'neutral' })
        })
        .catch(() => {
          recordActivity({
            title: 'Image rejected',
            detail: 'Could not read image.',
            tone: 'error'
          })
        })
    },
    [recordActivity]
  )

  const handleRemoveImageAttachment = useCallback(() => {
    setImageAttachment(null)
  }, [])

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
              activeToolCallCount={activeToolRunCount}
              toolResultCount={completedToolRunCount}
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
            imageAttachment={imageAttachment}
            onInputChange={handleInputChange}
            onImageAttachmentChange={handleImageAttachmentChange}
            onRemoveImageAttachment={handleRemoveImageAttachment}
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
