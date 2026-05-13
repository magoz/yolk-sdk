'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Array as Arr, Effect, Option } from 'effect'
import { UserMessage, addAgentUsage, zeroAgentUsage, type AgentEvent } from '@yolk/protocol'
import {
  buildAgentChatItems,
  getActiveChatToolParts,
  getAgentChatLiveActivityCount,
  getCompletedChatToolParts,
  useAgentChat,
  type AgentChatTransport
} from '@yolk/react'
import { streamCloudflareAgentEvents } from '@yolk/client'
import { agentTextCapabilities, agentTextReasoningEffort } from '@/lib/agents/text-agent-config'
import { defaultOpenAiRealtimeTranscriptionModel } from '@/lib/agents/realtime/openai-realtime'
import { AgentActivityPanel } from './agent-activity'
import {
  activityItemFromAgentEvent,
  maxActivityItems,
  type AgentActivityItem
} from './agent-activity-model'
import { AgentComposer } from './agent-composer'
import { loadAgentCommands, renderAgentCommand } from './command-client'
import {
  contentFromInput,
  isFailedImageAttachment,
  isReadyImageAttachment,
  type ImageAttachment
} from './image-attachment-content'
import { AgentConsoleDialog } from './agent-console-dialog'
import { AgentConversation } from './agent-conversation'
import { AgentConversationHeader } from './agent-conversation-header'
import { truncate } from './agent-format'
import { type AgentCommandSummary } from './slash-command-model'
import type { AgentCompactionState } from './agent-usage-meter'
import { useRealtimeVoice, type VoiceDebugEvent } from './use-realtime-voice'

export type AgentRuntimeInfo =
  | {
      readonly _tag: 'Next'
      readonly label: string
      readonly detail: string
    }
  | {
      readonly _tag: 'Cloudflare'
      readonly label: string
      readonly detail: string
      readonly webSocketUrl: string
    }

type AgentPlaygroundProps = {
  readonly sessionId: string
  readonly openAiCodexConnected: boolean
  readonly runtime: AgentRuntimeInfo
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

const readyImageAttachmentFromFile = async (file: File): Promise<ImageAttachment> => {
  const blob = await compressedImageBlob(file)
  const previewUrl = await blobToDataUrl(blob)

  return {
    _tag: 'Ready',
    id: imageAttachmentId(file),
    name: file.name,
    mimeType: blob.type.length > 0 ? blob.type : file.type,
    previewUrl,
    data: base64FromDataUrl(previewUrl)
  }
}

const failedImageAttachmentFromFile = (file: File, reason: string): ImageAttachment => ({
  _tag: 'Failed',
  id: imageAttachmentId(file),
  name: file.name,
  mimeType: file.type.length > 0 ? file.type : 'unknown',
  reason,
  file
})

const readyImageAttachmentCount = (attachments: ReadonlyArray<ImageAttachment>) =>
  Arr.filter(attachments, isReadyImageAttachment).length

const attachmentReadyLabel = (count: number) => `${count} image${count === 1 ? '' : 's'}`

const sourceImageCanBeReady = (file: File) =>
  file.type.startsWith('image/') && file.size <= maxSourceImageBytes

const readyCandidateCountBefore = (files: ReadonlyArray<File>, index: number) =>
  Arr.filter(Arr.take(files, index), sourceImageCanBeReady).length

const processImageFile = async (
  file: File,
  readySlotAvailable: boolean
): Promise<ImageAttachment> => {
  if (!file.type.startsWith('image/')) {
    return failedImageAttachmentFromFile(file, 'Unsupported file type.')
  }

  if (file.size > maxSourceImageBytes) {
    return failedImageAttachmentFromFile(file, 'Image must be 15MB or smaller.')
  }

  if (!readySlotAvailable) {
    return failedImageAttachmentFromFile(file, `Attach up to ${maxImageAttachments} images.`)
  }

  try {
    const attachment = await readyImageAttachmentFromFile(file)

    if (attachment._tag === 'Ready' && attachment.data.length === 0) {
      return failedImageAttachmentFromFile(file, 'Could not decode image.')
    }

    if (attachment._tag === 'Ready' && attachment.data.length > maxEncodedImageBytes) {
      return failedImageAttachmentFromFile(file, 'Compressed image is still too large.')
    }

    return attachment
  } catch {
    return failedImageAttachmentFromFile(file, 'Could not read image.')
  }
}

const processImageFiles = (
  files: ReadonlyArray<File>,
  currentAttachments: ReadonlyArray<ImageAttachment>
) => {
  const currentReadyCount = readyImageAttachmentCount(currentAttachments)

  return Promise.all(
    Arr.map(files, (file, index) => {
      const readySlotAvailable =
        sourceImageCanBeReady(file) &&
        currentReadyCount + readyCandidateCountBefore(files, index) < maxImageAttachments
      return processImageFile(file, readySlotAvailable)
    })
  )
}

export function AgentPlayground({
  sessionId,
  openAiCodexConnected,
  runtime
}: AgentPlaygroundProps) {
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
  const [commands, setCommands] = useState<ReadonlyArray<AgentCommandSummary>>([])
  const [isCommandRendering, setIsCommandRendering] = useState(false)
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

  useEffect(() => {
    let active = true

    Effect.runPromise(loadAgentCommands())
      .then(loadedCommands => {
        if (!active) {
          return
        }

        setCommands(loadedCommands)
      })
      .catch(() => {
        if (active) {
          setCommands([])
        }
      })

    return () => {
      active = false
    }
  }, [])

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
  const cloudflareTransport = useMemo<AgentChatTransport | undefined>(() => {
    if (runtime._tag !== 'Cloudflare') {
      return undefined
    }

    return request =>
      streamCloudflareAgentEvents({
        webSocketUrl: runtime.webSocketUrl,
        messages: request.messages,
        reasoningEffort: request.reasoningEffort,
        signal: request.signal
      })
  }, [runtime])

  const agentChat = useAgentChat({
    sessionId,
    reasoningEffort,
    transport: cloudflareTransport,
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
    editUserMessage,
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
                  turnId: 'draft-user-turn',
                  sequence: -1,
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
    const readyImages = readyImageAttachmentCount(imageAttachments)
    const content = contentFromInput(input, imageAttachments)

    if (submitDisabled || !canSubmitContent(content)) {
      return
    }

    recordActivity({
      title: readyImages === 0 ? 'Prompt submitted' : 'Image prompt submitted',
      detail: readyImages === 0 ? input.trim() : attachmentReadyLabel(readyImages),
      tone: 'neutral'
    })
    const result = submitMessage(UserMessage.make({ content }))

    if (result._tag === 'Submitted') {
      setInput('')
      setImageAttachments([])
    }
  }, [canSubmitContent, imageAttachments, input, recordActivity, submitDisabled, submitMessage])

  const handleSlashCommandSubmit = useCallback(
    (command: string, argumentsText: string) => {
      if (submitDisabled || isCommandRendering) {
        return
      }

      setIsCommandRendering(true)
      Effect.runPromise(renderAgentCommand(command, argumentsText))
        .then(renderedContent => {
          if (!canSubmitContent(renderedContent)) {
            recordActivity({ title: 'Command empty', detail: `/${command}`, tone: 'error' })
            return
          }

          recordActivity({
            title: 'Command submitted',
            detail: `/${command}`,
            tone: 'neutral'
          })
          const result = submitMessage(UserMessage.make({ content: renderedContent }))

          if (result._tag === 'Submitted') {
            setInput('')
            setImageAttachments([])
          }
        })
        .catch(() => {
          recordActivity({ title: 'Command failed', detail: `/${command}`, tone: 'error' })
        })
        .finally(() => {
          setIsCommandRendering(false)
        })
    },
    [canSubmitContent, isCommandRendering, recordActivity, submitDisabled, submitMessage]
  )

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

  const handleEditUserMessage = useCallback(
    (messageId: string, content: string) => {
      if (messageActionsDisabled) {
        return
      }

      const result = editUserMessage(messageId, content)

      if (result._tag === 'Edited') {
        recordActivity({
          title: 'Message edited',
          detail: result.messageId,
          tone: 'neutral'
        })
      }
    },
    [editUserMessage, messageActionsDisabled, recordActivity]
  )

  const handleImageAttachmentsChange = useCallback(
    (files: ReadonlyArray<File>) => {
      if (files.length === 0) {
        return
      }

      processImageFiles(files, imageAttachments).then(attachments => {
        const readyAttachments = Arr.filter(attachments, isReadyImageAttachment)
        const failedAttachments = Arr.filter(attachments, isFailedImageAttachment)

        if (attachments.length === 0) {
          return
        }

        setImageAttachments(current => [...current, ...attachments])

        if (readyAttachments.length > 0) {
          recordActivity({
            title: readyAttachments.length === 1 ? 'Image attached' : 'Images attached',
            detail: Arr.map(readyAttachments, attachment => attachment.name).join(', '),
            tone: 'neutral'
          })
        }

        if (failedAttachments.length > 0) {
          recordActivity({
            title: failedAttachments.length === 1 ? 'Image failed' : 'Images failed',
            detail: Arr.map(
              failedAttachments,
              attachment => `${attachment.name}: ${attachment.reason}`
            ).join(', '),
            tone: 'error'
          })
        }
      })
    },
    [imageAttachments, recordActivity]
  )

  const handleRemoveImageAttachment = useCallback((id: string) => {
    setImageAttachments(current =>
      Arr.filter(current, imageAttachment => imageAttachment.id !== id)
    )
  }, [])

  const handleRetryImageAttachment = useCallback(
    (id: string) => {
      Option.match(
        Arr.findFirst(imageAttachments, imageAttachment => imageAttachment.id === id),
        {
          onNone: () => undefined,
          onSome: attachment => {
            if (attachment._tag !== 'Failed') {
              return
            }

            const remainingAttachments = Arr.filter(
              imageAttachments,
              imageAttachment => imageAttachment.id !== id
            )
            setImageAttachments(remainingAttachments)
            processImageFiles([attachment.file], remainingAttachments).then(attachments => {
              setImageAttachments(current => [...current, ...attachments])

              Option.match(Arr.findFirst(attachments, isFailedImageAttachment), {
                onNone: () =>
                  recordActivity({
                    title: 'Image retry succeeded',
                    detail: attachment.name,
                    tone: 'neutral'
                  }),
                onSome: failedAttachment =>
                  recordActivity({
                    title: 'Image retry failed',
                    detail: `${failedAttachment.name}: ${failedAttachment.reason}`,
                    tone: 'error'
                  })
              })
            })
          }
        }
      )
    },
    [imageAttachments, recordActivity]
  )

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
            runtimeLabel={runtime.label}
            runtimeDetail={runtime.detail}
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
            onEditUserMessage={handleEditUserMessage}
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
            commands={commands}
            isCommandRendering={isCommandRendering}
            onInputChange={handleInputChange}
            onImageAttachmentsChange={handleImageAttachmentsChange}
            onRemoveImageAttachment={handleRemoveImageAttachment}
            onRetryImageAttachment={handleRetryImageAttachment}
            onSlashCommandSubmit={handleSlashCommandSubmit}
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
