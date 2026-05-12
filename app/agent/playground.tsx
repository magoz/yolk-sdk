'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { Option } from 'effect'
import { UserMessage, addAgentUsage, zeroAgentUsage, type AgentEvent } from '@yolk/protocol'
import {
  buildAgentChatItems,
  getActiveChatToolParts,
  getAgentChatLiveActivityCount,
  getCompletedChatToolParts,
  useAgentChat
} from '@yolk/react'
import { agentTextCapabilities, agentTextReasoningEffort } from '@/lib/agents/text-agent-config'
import { defaultOpenAiRealtimeTranscriptionModel } from '@/lib/agents/realtime/openai-realtime'
import { AgentActivityPanel } from './agent-activity'
import {
  activityItemFromAgentEvent,
  maxActivityItems,
  type AgentActivityItem
} from './agent-activity-model'
import { AgentComposer } from './agent-composer'
import { contentFromInput, type ImageAttachment } from './image-attachment-content'
import { AgentConsoleDialog } from './agent-console-dialog'
import { AgentConversation } from './agent-conversation'
import { AgentConversationHeader } from './agent-conversation-header'
import { truncate } from './agent-format'
import type { AgentCompactionState } from './agent-usage-meter'
import { useRealtimeVoice, type VoiceDebugEvent } from './use-realtime-voice'

type AgentPlaygroundProps = {
  readonly sessionId: string
  readonly openAiCodexConnected: boolean
}

const maxImageAttachments = 4
const maxSourceImageBytes = 15 * 1024 * 1024
const maxEncodedImageBytes = 5 * 1024 * 1024
const maxImageEdgePixels = 1600

const imageOutputType = (mimeType: string) =>
  mimeType === 'image/png' ? 'image/png' : 'image/jpeg'

const imageAttachmentId = (file: File) => `${file.name}-${file.size}-${file.lastModified}`

const blobToDataUrl = (blob: Blob) =>
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
    reader.readAsDataURL(blob)
  })

const canvasBlob = (canvas: HTMLCanvasElement, mimeType: string) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      blob => {
        if (blob === null) {
          reject(new Error('Could not compress image'))
          return
        }

        resolve(blob)
      },
      mimeType,
      0.86
    )
  })

const compressedImageBlob = async (file: File) => {
  if (file.type === 'image/gif') {
    return file
  }

  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxImageEdgePixels / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')

  if (context === null) {
    bitmap.close()
    throw new Error('Could not prepare image')
  }

  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  return canvasBlob(canvas, imageOutputType(file.type))
}

const base64FromDataUrl = (dataUrl: string) => {
  const separatorIndex = dataUrl.indexOf(',')

  return separatorIndex === -1 ? '' : dataUrl.slice(separatorIndex + 1)
}

const attachmentFromFile = async (file: File): Promise<ImageAttachment> => {
  const blob = await compressedImageBlob(file)
  const previewUrl = await blobToDataUrl(blob)

  return {
    id: imageAttachmentId(file),
    name: file.name,
    mimeType: blob.type.length > 0 ? blob.type : file.type,
    previewUrl,
    data: base64FromDataUrl(previewUrl)
  }
}

export function AgentPlayground({ sessionId, openAiCodexConnected }: AgentPlaygroundProps) {
  const [input, setInput] = useState('')
  const [imageAttachments, setImageAttachments] = useState<ReadonlyArray<ImageAttachment>>([])
  const [activityVisible, setActivityVisible] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [showInlineTools, setShowInlineTools] = useState(true)
  const [showReasoning, setShowReasoning] = useState(true)
  const [reasoningEffort, setReasoningEffort] = useState(agentTextReasoningEffort)
  const [transcriptionModel, setTranscriptionModel] = useState(
    defaultOpenAiRealtimeTranscriptionModel
  )
  const [usage, setUsage] = useState(zeroAgentUsage)
  const [hasUsage, setHasUsage] = useState(false)
  const [contextTokens, setContextTokens] = useState<number | null>(null)
  const [compaction, setCompaction] = useState<AgentCompactionState>({ _tag: 'Idle' })
  const [activityItems, setActivityItems] = useState<ReadonlyArray<AgentActivityItem>>([])
  const nextActivityIdRef = useRef(0)

  const recordActivity = useCallback((item: Omit<AgentActivityItem, 'id'>) => {
    const id = nextActivityIdRef.current
    nextActivityIdRef.current += 1
    setActivityItems(current => [...current.slice(-(maxActivityItems - 1)), { id, ...item }])
  }, [])

  const recordAgentEvent = useCallback(
    (event: AgentEvent) => {
      switch (event._tag) {
        case 'AgentStart':
          setUsage(zeroAgentUsage)
          setHasUsage(false)
          setContextTokens(null)
          setCompaction({ _tag: 'Idle' })
          break
        case 'UsageUpdate':
          setUsage(current => addAgentUsage(current, event.usage))
          setContextTokens(event.usage.input.total)
          setHasUsage(true)
          break
        case 'AgentEnd':
          setUsage(event.usage)
          setHasUsage(true)
          break
        case 'CompactionStart':
          setCompaction({ _tag: 'Compacting', strategy: event.strategy })
          break
        case 'CompactionEnd':
          setCompaction({
            _tag: 'Compacted',
            strategy: event.strategy,
            beforeTokens: event.beforeTokens,
            afterTokens: event.afterTokens
          })
          setContextTokens(event.afterTokens ?? null)
          break
        case 'AgentError':
        case 'AgentRetry':
        case 'AssistantMessage':
        case 'LLMReasoningDelta':
        case 'LLMStreamEnd':
        case 'LLMStreamStart':
        case 'LLMTextDelta':
        case 'ProviderToolResult':
        case 'ToolApprovalDenied':
        case 'ToolApprovalGranted':
        case 'ToolApprovalRequested':
        case 'ToolExecutionCompleted':
        case 'ToolExecutionError':
        case 'ToolExecutionStarted':
        case 'ToolInputDelta':
        case 'ToolInputEnd':
        case 'ToolInputStart':
        case 'TurnEnd':
        case 'TurnStart':
          break
      }

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
        case 'TransportReady':
          recordActivity({
            title: 'Voice transport ready',
            detail: `peer=${event.peerConnectionState} · data=${event.dataChannelState}`,
            tone: 'success'
          })
          return
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
    deleteTurn,
    regenerateFrom,
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
  const imageInputSupported = agentTextCapabilities.input.image
  const submitDisabled = isRunning || isVoiceMode
  const messageActionsDisabled = isRunning || isVoiceMode
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
    const content = contentFromInput(input, imageAttachments)

    if (submitDisabled || !canSubmitContent(content)) {
      return
    }

    recordActivity({
      title: imageAttachments.length === 0 ? 'Prompt submitted' : 'Image prompt submitted',
      detail:
        imageAttachments.length === 0
          ? input.trim()
          : `${imageAttachments.length} image${imageAttachments.length === 1 ? '' : 's'}`,
      tone: 'neutral'
    })
    const result = submitMessage(UserMessage.make({ content }))

    if (result._tag === 'Submitted') {
      setInput('')
      setImageAttachments([])
    }
  }, [canSubmitContent, imageAttachments, input, recordActivity, submitDisabled, submitMessage])

  const handleDeleteTurn = useCallback(
    (messageId: string) => {
      if (messageActionsDisabled) {
        return
      }

      const result = deleteTurn(messageId)

      if (result._tag === 'Deleted') {
        recordActivity({
          title: 'Turn deleted',
          detail: result.turnStartMessageId,
          tone: 'neutral'
        })
      }
    },
    [deleteTurn, messageActionsDisabled, recordActivity]
  )

  const handleRegenerateFrom = useCallback(
    (messageId: string) => {
      if (messageActionsDisabled) {
        return
      }

      const result = regenerateFrom(messageId)

      if (result._tag === 'Regenerated') {
        recordActivity({
          title: 'Response regenerated',
          detail: result.messageId,
          tone: 'neutral'
        })
      }
    },
    [messageActionsDisabled, recordActivity, regenerateFrom]
  )

  const handleImageAttachmentsChange = useCallback(
    (files: ReadonlyArray<File>) => {
      if (files.length === 0) {
        return
      }

      const availableSlots = maxImageAttachments - imageAttachments.length
      const acceptedFiles = files
        .filter(file => {
          if (!file.type.startsWith('image/')) {
            recordActivity({
              title: 'Image rejected',
              detail: `${file.name}: unsupported file type.`,
              tone: 'error'
            })
            return false
          }

          if (file.size > maxSourceImageBytes) {
            recordActivity({
              title: 'Image rejected',
              detail: `${file.name}: image must be 15MB or smaller.`,
              tone: 'error'
            })
            return false
          }

          return true
        })
        .slice(0, Math.max(0, availableSlots))

      if (acceptedFiles.length < files.length && availableSlots <= files.length) {
        recordActivity({
          title: 'Image limit reached',
          detail: `Attach up to ${maxImageAttachments} images.`,
          tone: 'error'
        })
      }

      Promise.all(acceptedFiles.map(attachmentFromFile))
        .then(attachments => {
          const readyAttachments = attachments.filter(attachment => {
            if (attachment.data.length === 0) {
              recordActivity({
                title: 'Image rejected',
                detail: `${attachment.name}: could not decode image.`,
                tone: 'error'
              })
              return false
            }

            if (attachment.data.length > maxEncodedImageBytes) {
              recordActivity({
                title: 'Image rejected',
                detail: `${attachment.name}: compressed image is still too large.`,
                tone: 'error'
              })
              return false
            }

            return true
          })

          if (readyAttachments.length === 0) {
            return
          }

          setImageAttachments(current => [...current, ...readyAttachments])
          recordActivity({
            title: readyAttachments.length === 1 ? 'Image attached' : 'Images attached',
            detail: readyAttachments.map(attachment => attachment.name).join(', '),
            tone: 'neutral'
          })
        })
        .catch(() => {
          recordActivity({
            title: 'Image rejected',
            detail: 'Could not read image.',
            tone: 'error'
          })
        })
    },
    [imageAttachments.length, recordActivity]
  )

  const handleRemoveImageAttachment = useCallback((index: number) => {
    setImageAttachments(current =>
      current.filter((_, attachmentIndex) => attachmentIndex !== index)
    )
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
            usage={usage}
            hasUsage={hasUsage}
            contextTokens={contextTokens}
            compaction={compaction}
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
            actionsDisabled={messageActionsDisabled}
            onDeleteTurn={handleDeleteTurn}
            onRegenerateFrom={handleRegenerateFrom}
          />

          <AgentComposer
            input={input}
            submitDisabled={submitDisabled}
            isRunning={isRunning}
            isVoiceMode={isVoiceMode}
            isVoiceConnecting={isVoiceConnecting}
            isVoiceLive={isVoiceLive}
            imageInputSupported={imageInputSupported}
            imageAttachments={imageAttachments}
            onInputChange={handleInputChange}
            onImageAttachmentsChange={handleImageAttachmentsChange}
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
        usage={usage}
        hasUsage={hasUsage}
        contextTokens={contextTokens}
        compaction={compaction}
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
