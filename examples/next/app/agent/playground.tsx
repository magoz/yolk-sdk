'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Array as Arr, Effect, Option } from 'effect'
import {
  UserMessage,
  addAgentUsage,
  assistantContent,
  contentPreview,
  zeroAgentUsage,
  type AgentEvent,
  type QuestionResponse,
  type ToolApprovalResponse
} from '@yolk-sdk/agent/protocol'
import {
  buildAgentChatItems,
  getActiveChatToolParts,
  getAgentChatLiveActivityCount,
  getCompletedChatToolParts,
  useAgentChat,
  type AgentChatTransport
} from '@yolk-sdk/agent/react'
import {
  AgentTransportError,
  cancelAgentRun,
  streamAgentEventsUntilTerminal,
  streamAgentRunEventsUntilTerminal,
  streamAgentRunHitlResponseEventsUntilTerminal,
  streamCloudflareAgentEvents
} from '@yolk-sdk/agent/client'
import {
  agentTextCapabilities,
  agentTextModel,
  agentTextReasoningEffort,
  type AgentTextModel
} from '@/lib/agents/text-agent-config'
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
  isFailedAttachment,
  isReadyAttachment,
  isReadyDocumentAttachment,
  isReadyImageAttachment,
  type AgentAttachment
} from './attachment-content'
import { AgentConsoleDialog } from './agent-console-dialog'
import { AgentConversation } from './agent-conversation'
import { AgentConversationHeader } from './agent-conversation-header'
import { truncate } from './agent-format'
import { type AgentCommandSummary } from './slash-command-model'
import type { AgentCompactionState } from './agent-usage-meter'
import { useHoldToSpeak } from './use-hold-to-speak'
import { useRealtimeVoice, type VoiceDebugEvent } from './use-realtime-voice'
import { type VoiceInputMode } from './voice-input-mode'
import { isAgentTextBusy, isWorkflowResumeDisabled } from './workflow-ui-state'

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
  | {
      readonly _tag: 'Workflow'
      readonly label: string
      readonly detail: string
    }

type AgentPlaygroundProps = {
  readonly sessionId: string
  readonly openAiCodexConnected: boolean
  readonly anthropicClaudeConnected: boolean
  readonly runtime: AgentRuntimeInfo
}

const maxImageAttachments = 4
const maxDocumentAttachments = 4
const maxSourceImageBytes = 15 * 1024 * 1024
const maxEncodedImageBytes = 5 * 1024 * 1024
const maxSourceDocumentBytes = 10 * 1024 * 1024
const maxEncodedDocumentBytes = 14 * 1024 * 1024
const maxImageEdgePixels = 1600

const imageOutputType = (mimeType: string) =>
  mimeType === 'image/png' ? 'image/png' : 'image/jpeg'

const attachmentId = (file: File) => `${file.name}-${file.size}-${file.lastModified}`

const documentMimeTypeForFile = (file: File) =>
  file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    ? 'application/pdf'
    : file.type

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

const readyImageAttachmentFromFile = async (file: File): Promise<AgentAttachment> => {
  const blob = await compressedImageBlob(file)
  const previewUrl = await blobToDataUrl(blob)

  return {
    _tag: 'Ready',
    kind: 'image',
    id: attachmentId(file),
    name: file.name,
    mimeType: blob.type.length > 0 ? blob.type : file.type,
    previewUrl,
    data: base64FromDataUrl(previewUrl)
  }
}

const readyDocumentAttachmentFromFile = async (file: File): Promise<AgentAttachment> => {
  const dataUrl = await blobToDataUrl(file)

  return {
    _tag: 'Ready',
    kind: 'document',
    id: attachmentId(file),
    name: file.name,
    mimeType: documentMimeTypeForFile(file),
    data: base64FromDataUrl(dataUrl)
  }
}

const failedAttachmentFromFile = (file: File, reason: string): AgentAttachment => ({
  _tag: 'Failed',
  kind: file.type.startsWith('image/') ? 'image' : 'document',
  id: attachmentId(file),
  name: file.name,
  mimeType: file.type.length > 0 ? file.type : 'unknown',
  reason,
  file
})

const readyImageAttachmentCount = (attachments: ReadonlyArray<AgentAttachment>) =>
  Arr.filter(attachments, isReadyImageAttachment).length

const readyDocumentAttachmentCount = (attachments: ReadonlyArray<AgentAttachment>) =>
  Arr.filter(attachments, isReadyDocumentAttachment).length

const readyAttachmentCount = (attachments: ReadonlyArray<AgentAttachment>) =>
  Arr.filter(attachments, isReadyAttachment).length

const attachmentReadyLabel = (count: number) => `${count} attachment${count === 1 ? '' : 's'}`

async function* missingWorkflowRunIdAgentEvents(): AsyncGenerator<AgentEvent, void, void> {
  throw new AgentTransportError({
    message: 'Workflow HITL response requires an active run id',
    cause: 'missing_workflow_run_id'
  })
}

const sourceImageCanBeReady = (file: File) =>
  file.type.startsWith('image/') && file.size <= maxSourceImageBytes

const sourceDocumentCanBeReady = (file: File) =>
  documentMimeTypeForFile(file) === 'application/pdf' && file.size <= maxSourceDocumentBytes

const readyImageCandidateCountBefore = (files: ReadonlyArray<File>, index: number) =>
  Arr.filter(Arr.take(files, index), sourceImageCanBeReady).length

const readyDocumentCandidateCountBefore = (files: ReadonlyArray<File>, index: number) =>
  Arr.filter(Arr.take(files, index), sourceDocumentCanBeReady).length

const processImageFile = async (
  file: File,
  readySlotAvailable: boolean
): Promise<AgentAttachment> => {
  if (!file.type.startsWith('image/')) {
    return failedAttachmentFromFile(file, 'Unsupported file type.')
  }

  if (file.size > maxSourceImageBytes) {
    return failedAttachmentFromFile(file, 'Image must be 15MB or smaller.')
  }

  if (!readySlotAvailable) {
    return failedAttachmentFromFile(file, `Attach up to ${maxImageAttachments} images.`)
  }

  try {
    const attachment = await readyImageAttachmentFromFile(file)

    if (attachment._tag === 'Ready' && attachment.data.length === 0) {
      return failedAttachmentFromFile(file, 'Could not decode image.')
    }

    if (attachment._tag === 'Ready' && attachment.data.length > maxEncodedImageBytes) {
      return failedAttachmentFromFile(file, 'Compressed image is still too large.')
    }

    return attachment
  } catch {
    return failedAttachmentFromFile(file, 'Could not read image.')
  }
}

const processDocumentFile = async (
  file: File,
  readySlotAvailable: boolean
): Promise<AgentAttachment> => {
  if (documentMimeTypeForFile(file) !== 'application/pdf') {
    return failedAttachmentFromFile(file, 'Unsupported file type.')
  }

  if (file.size > maxSourceDocumentBytes) {
    return failedAttachmentFromFile(file, 'PDF must be 10MB or smaller.')
  }

  if (!readySlotAvailable) {
    return failedAttachmentFromFile(file, `Attach up to ${maxDocumentAttachments} PDFs.`)
  }

  try {
    const attachment = await readyDocumentAttachmentFromFile(file)

    if (attachment._tag === 'Ready' && attachment.data.length === 0) {
      return failedAttachmentFromFile(file, 'Could not decode PDF.')
    }

    if (attachment._tag === 'Ready' && attachment.data.length > maxEncodedDocumentBytes) {
      return failedAttachmentFromFile(file, 'PDF is too large.')
    }

    return attachment
  } catch {
    return failedAttachmentFromFile(file, 'Could not read PDF.')
  }
}

const processAttachmentFile = (
  file: File,
  files: ReadonlyArray<File>,
  index: number,
  currentAttachments: ReadonlyArray<AgentAttachment>
) => {
  const currentReadyImageCount = readyImageAttachmentCount(currentAttachments)
  const currentReadyDocumentCount = readyDocumentAttachmentCount(currentAttachments)
  const readyImageSlotAvailable =
    sourceImageCanBeReady(file) &&
    currentReadyImageCount + readyImageCandidateCountBefore(files, index) < maxImageAttachments
  const readyDocumentSlotAvailable =
    sourceDocumentCanBeReady(file) &&
    currentReadyDocumentCount + readyDocumentCandidateCountBefore(files, index) <
      maxDocumentAttachments

  if (file.type.startsWith('image/')) {
    return processImageFile(file, readyImageSlotAvailable)
  }

  return processDocumentFile(file, readyDocumentSlotAvailable)
}

const processAttachmentFiles = (
  files: ReadonlyArray<File>,
  currentAttachments: ReadonlyArray<AgentAttachment>
) => {
  return Promise.all(
    Arr.map(files, (file, index) => processAttachmentFile(file, files, index, currentAttachments))
  )
}

export function AgentPlayground({
  sessionId,
  openAiCodexConnected,
  anthropicClaudeConnected,
  runtime
}: AgentPlaygroundProps) {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<ReadonlyArray<AgentAttachment>>([])
  const [activityVisible, setActivityVisible] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [showInlineTools, setShowInlineTools] = useState(true)
  const [showReasoning, setShowReasoning] = useState(true)
  const [textModel, setTextModel] = useState<AgentTextModel>(agentTextModel)
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
  const [workflowRunId, setWorkflowRunId] = useState<string | null>(null)
  const [isWorkflowResuming, setIsWorkflowResuming] = useState(false)
  const nextActivityIdRef = useRef(0)
  const workflowResumeAbortRef = useRef<AbortController | null>(null)
  const refreshedCommandToolRunIdsRef = useRef(new Set<string>())

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
        case 'AgentAwaitingInput':
          setUsage(event.usage)
          setHasUsage(true)
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
        case 'QuestionAnswered':
        case 'QuestionCancelled':
        case 'QuestionRequested':
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

  const refreshCommands = useCallback(() => {
    let active = true

    void Effect.runPromise(loadAgentCommands())
      .then(loadedCommands => {
        if (active) {
          setCommands(loadedCommands)
        }
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

  useEffect(() => {
    return refreshCommands()
  }, [refreshCommands])

  const recordVoiceDebug = useCallback(
    (event: VoiceDebugEvent) => {
      switch (event._tag) {
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
        hitlResponses: request.hitlResponses,
        model: request.model,
        reasoningEffort: request.reasoningEffort,
        signal: request.signal
      })
  }, [runtime])
  const workflowTransport = useMemo<AgentChatTransport | undefined>(() => {
    if (runtime._tag !== 'Workflow') {
      return undefined
    }

    return request => {
      const hitlResponse = request.hitlResponses?.[0]

      if (hitlResponse !== undefined) {
        if (workflowRunId === null) {
          return missingWorkflowRunIdAgentEvents()
        }

        return streamAgentRunHitlResponseEventsUntilTerminal({
          endpoint: `/api/agent/workflow/${encodeURIComponent(workflowRunId)}`,
          hitlResponses: [hitlResponse],
          signal: request.signal,
          onResponse: response => {
            const runId = response.headers['x-workflow-run-id']

            recordActivity({
              title: 'Workflow HITL resume started',
              detail: runId ?? workflowRunId,
              tone: 'neutral'
            })
          }
        })
      }

      return streamAgentEventsUntilTerminal({
        ...request,
        endpoint: '/api/agent/workflow',
        onRunId: runId => {
          setWorkflowRunId(runId)
          recordActivity({ title: 'Workflow run started', detail: runId, tone: 'neutral' })
        }
      })
    }
  }, [recordActivity, runtime, workflowRunId])
  const agentTransport = cloudflareTransport ?? workflowTransport

  const [voiceInputMode, setVoiceInputMode] = useState<VoiceInputMode>('realtime')
  const speakNextRunRef = useRef(false)
  const submitTranscriptRef = useRef<(text: string) => void>(() => {})
  const holdToSpeak = useHoldToSpeak({
    onTranscript: text => submitTranscriptRef.current(text),
    onError: message =>
      recordActivity({ title: 'Hold to speak failed', detail: truncate(message), tone: 'error' })
  })
  const speakAssistantReply = holdToSpeak.speak
  const handleAgentEvent = useCallback(
    (event: AgentEvent) => {
      recordAgentEvent(event)

      if (!speakNextRunRef.current) {
        return
      }

      if (event._tag === 'AgentError') {
        speakNextRunRef.current = false
        return
      }

      if (event._tag !== 'AgentEnd') {
        return
      }

      speakNextRunRef.current = false

      const lastAssistant = Arr.findLast(event.messages, message => message._tag === 'Assistant')

      if (Option.isNone(lastAssistant) || lastAssistant.value._tag !== 'Assistant') {
        return
      }

      const text = contentPreview(assistantContent(lastAssistant.value))

      if (text.trim().length > 0) {
        speakAssistantReply(text)
      }
    },
    [recordAgentEvent, speakAssistantReply]
  )

  const agentChat = useAgentChat({
    sessionId,
    model: textModel,
    reasoningEffort,
    transport: agentTransport,
    onEvent: handleAgentEvent,
    onError: recordAgentError,
    onAbort: recordAgentAbort
  })
  const {
    state,
    isRunning,
    isWaiting,
    canSubmitContent,
    submitMessage,
    submitToolApprovalResponse,
    submitQuestionResponse,
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
    stopSession: stopVoiceSession,
    toggleSession: toggleVoice
  } = useRealtimeVoice({
    sessionId,
    messages: agentChat.messages,
    transcriptionModel,
    onAgentEvent: applyEvent,
    onUserMessage: appendMessage,
    onError: fail,
    onDebug: recordVoiceDebug
  })
  const isVoiceMode = isVoiceConnecting || isVoiceLive
  const isHoldBusy = holdToSpeak.isRecording || holdToSpeak.isTranscribing

  useEffect(() => {
    submitTranscriptRef.current = text => {
      const result = submitMessage(UserMessage.make({ content: text }))

      if (result._tag === 'Submitted') {
        speakNextRunRef.current = true
        recordActivity({
          title: 'Hold to speak transcript',
          detail: truncate(text),
          tone: 'neutral'
        })
        return
      }

      recordActivity({
        title: 'Hold to speak transcript ignored',
        detail: truncate(text),
        tone: 'error'
      })
    }
  }, [recordActivity, submitMessage])

  const handleVoiceInputModeChange = useCallback(
    (mode: VoiceInputMode) => {
      setVoiceInputMode(mode)

      if (mode === 'hold' && (isVoiceConnecting || isVoiceLive)) {
        stopVoiceSession()
      }

      if (mode === 'realtime') {
        speakNextRunRef.current = false
        holdToSpeak.stopPlayback()
      }
    },
    [holdToSpeak, isVoiceConnecting, isVoiceLive, stopVoiceSession]
  )
  const isTextBusy = isAgentTextBusy({ isRunning, isWaiting, isWorkflowResuming })
  const imageInputSupported = agentTextCapabilities.input.image
  const documentInputSupported = agentTextCapabilities.input.document
  const submitDisabled = isTextBusy || isVoiceMode || isHoldBusy
  const messageActionsDisabled = isTextBusy || isVoiceMode || isHoldBusy
  const hitlActionsDisabled = isRunning || isWorkflowResuming || isVoiceMode
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
    isTextRunning: isTextBusy,
    activeToolCallCount: activeToolRunCount,
    isVoiceActive: isVoiceMode
  })
  const activeToolLabel = useMemo(() => {
    const firstRun = activeToolParts[0]

    if (firstRun === undefined) {
      return Option.none()
    }

    return Option.some(
      isWaiting
        ? activeToolParts.length === 1
          ? `Waiting for ${firstRun.call.name}`
          : `Waiting for ${activeToolParts.length} inputs`
        : activeToolParts.length === 1
          ? `Running ${firstRun.call.name}`
          : `Running ${activeToolParts.length} tools`
    )
  }, [activeToolParts, isWaiting])
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
        isRunning: isTextBusy,
        activeToolLabel
      }),
    [activeToolLabel, isTextBusy, state.chatMessages, voiceUserDraft]
  )

  useEffect(() => {
    const completedManageSkillRuns = Arr.filter(
      chatItems,
      item =>
        item._tag === 'ToolRun' &&
        item.call.name === 'manage_skills' &&
        (item.state._tag === 'Completed' || item.state._tag === 'ProviderCompleted') &&
        !refreshedCommandToolRunIdsRef.current.has(item.id)
    )

    if (completedManageSkillRuns.length === 0) {
      return
    }

    completedManageSkillRuns.forEach(item => refreshedCommandToolRunIdsRef.current.add(item.id))

    return refreshCommands()
  }, [chatItems, refreshCommands])

  const handleSubmit = useCallback(() => {
    const readyAttachments = readyAttachmentCount(attachments)
    const content = contentFromInput(input, attachments)

    if (submitDisabled || !canSubmitContent(content)) {
      return
    }

    recordActivity({
      title: readyAttachments === 0 ? 'Prompt submitted' : 'Attachment prompt submitted',
      detail: readyAttachments === 0 ? input.trim() : attachmentReadyLabel(readyAttachments),
      tone: 'neutral'
    })
    const result = submitMessage(UserMessage.make({ content }))

    if (result._tag === 'Submitted') {
      setInput('')
      setAttachments([])
    }
  }, [attachments, canSubmitContent, input, recordActivity, submitDisabled, submitMessage])

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
            setAttachments([])
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

  const handleResumeWorkflowRun = useCallback(() => {
    if (
      runtime._tag !== 'Workflow' ||
      workflowRunId === null ||
      state.status === 'done' ||
      isRunning ||
      isWorkflowResuming
    ) {
      return
    }

    setIsWorkflowResuming(true)
    const abortController = new AbortController()
    workflowResumeAbortRef.current = abortController
    recordActivity({
      title: 'Workflow stream resume requested',
      detail: workflowRunId,
      tone: 'neutral'
    })

    const endpoint = `/api/agent/workflow/${encodeURIComponent(workflowRunId)}`

    Effect.runPromise(
      Effect.promise(async () => {
        for await (const event of streamAgentRunEventsUntilTerminal({
          endpoint,
          signal: abortController.signal
        })) {
          applyEvent(event)
        }
      })
    )
      .then(() => {
        recordActivity({ title: 'Workflow stream resumed', detail: workflowRunId, tone: 'success' })
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : 'Workflow resume failed'
        fail(message)
      })
      .finally(() => {
        if (workflowResumeAbortRef.current === abortController) {
          workflowResumeAbortRef.current = null
        }
        setIsWorkflowResuming(false)
      })
  }, [
    applyEvent,
    fail,
    isRunning,
    isWorkflowResuming,
    recordActivity,
    runtime,
    state.status,
    workflowRunId
  ])

  const handleStop = useCallback(() => {
    const runId = workflowRunId

    workflowResumeAbortRef.current?.abort('Workflow stream stopped')
    workflowResumeAbortRef.current = null
    stop()

    if (runtime._tag !== 'Workflow' || runId === null) {
      return
    }

    const endpoint = `/api/agent/workflow/${encodeURIComponent(runId)}`
    recordActivity({ title: 'Workflow cancel requested', detail: runId, tone: 'neutral' })

    cancelAgentRun({ endpoint })
      .then(() => {
        recordActivity({ title: 'Workflow canceled', detail: runId, tone: 'success' })
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : 'Workflow cancel failed'
        recordActivity({ title: 'Workflow cancel failed', detail: message, tone: 'error' })
      })
  }, [recordActivity, runtime, stop, workflowRunId])

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

  const handleToolApprovalResponse = useCallback(
    (response: ToolApprovalResponse) => {
      if (hitlActionsDisabled) {
        return
      }

      const result = submitToolApprovalResponse(response)

      if (result._tag === 'Submitted') {
        recordActivity({
          title: response.decision === 'approved' ? 'Tool approved' : 'Tool denied',
          detail: response.toolCallId,
          tone: response.decision === 'approved' ? 'success' : 'neutral'
        })
      }
    },
    [hitlActionsDisabled, recordActivity, submitToolApprovalResponse]
  )

  const handleQuestionResponse = useCallback(
    (response: QuestionResponse) => {
      if (hitlActionsDisabled) {
        return
      }

      const result = submitQuestionResponse(response)

      if (result._tag === 'Submitted') {
        recordActivity({
          title: response.outcome === 'answered' ? 'Question answered' : 'Question cancelled',
          detail: response.toolCallId,
          tone: response.outcome === 'answered' ? 'success' : 'neutral'
        })
      }
    },
    [hitlActionsDisabled, recordActivity, submitQuestionResponse]
  )

  const handleAttachmentsChange = useCallback(
    (files: ReadonlyArray<File>) => {
      if (files.length === 0) {
        return
      }

      processAttachmentFiles(files, attachments).then(processedAttachments => {
        const readyAttachments = Arr.filter(processedAttachments, isReadyAttachment)
        const failedAttachments = Arr.filter(processedAttachments, isFailedAttachment)

        if (processedAttachments.length === 0) {
          return
        }

        setAttachments(current => [...current, ...processedAttachments])

        if (readyAttachments.length > 0) {
          recordActivity({
            title: readyAttachments.length === 1 ? 'Attachment added' : 'Attachments added',
            detail: Arr.map(readyAttachments, attachment => attachment.name).join(', '),
            tone: 'neutral'
          })
        }

        if (failedAttachments.length > 0) {
          recordActivity({
            title: failedAttachments.length === 1 ? 'Attachment failed' : 'Attachments failed',
            detail: Arr.map(
              failedAttachments,
              attachment => `${attachment.name}: ${attachment.reason}`
            ).join(', '),
            tone: 'error'
          })
        }
      })
    },
    [attachments, recordActivity]
  )

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments(current => Arr.filter(current, attachment => attachment.id !== id))
  }, [])

  const handleRetryAttachment = useCallback(
    (id: string) => {
      Option.match(
        Arr.findFirst(attachments, attachment => attachment.id === id),
        {
          onNone: () => undefined,
          onSome: attachment => {
            if (attachment._tag !== 'Failed') {
              return
            }

            const remainingAttachments = Arr.filter(
              attachments,
              currentAttachment => currentAttachment.id !== id
            )
            setAttachments(remainingAttachments)
            processAttachmentFiles([attachment.file], remainingAttachments).then(
              processedAttachments => {
                setAttachments(current => [...current, ...processedAttachments])

                Option.match(Arr.findFirst(processedAttachments, isFailedAttachment), {
                  onNone: () =>
                    recordActivity({
                      title: 'Attachment retry succeeded',
                      detail: attachment.name,
                      tone: 'neutral'
                    }),
                  onSome: failedAttachment =>
                    recordActivity({
                      title: 'Attachment retry failed',
                      detail: `${failedAttachment.name}: ${failedAttachment.reason}`,
                      tone: 'error'
                    })
                })
              }
            )
          }
        }
      )
    },
    [attachments, recordActivity]
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
    <main className="h-[calc(100dvh-3.5rem)] min-h-0 overflow-hidden bg-[radial-gradient(circle_at_top_left,var(--color-muted),transparent_34rem),linear-gradient(135deg,var(--color-background),var(--color-muted))] p-2 sm:p-4 md:p-6">
      <audio ref={audioRef} autoPlay className="sr-only" />
      <audio ref={holdToSpeak.attachAudioElement} className="sr-only" />
      <div className="mx-auto h-full max-w-5xl overflow-hidden rounded-[2rem] border border-foreground/10 bg-background/85 shadow-2xl shadow-foreground/10 backdrop-blur">
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
            isRunning={isTextBusy}
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
              errorInfo={state.errorInfo}
              retryInfo={state.retryInfo}
              workflowRunId={workflowRunId}
              workflowResumeDisabled={isWorkflowResumeDisabled({
                status: state.status,
                isTextBusy
              })}
              onResumeWorkflowRun={handleResumeWorkflowRun}
            />
          ) : null}

          <AgentConversation
            items={chatItems}
            showInlineTools={showInlineTools}
            showReasoning={showReasoning}
            actionsDisabled={messageActionsDisabled}
            hitlDisabled={hitlActionsDisabled}
            onDeleteTurn={handleDeleteTurn}
            onEditUserMessage={handleEditUserMessage}
            onRegenerateFrom={handleRegenerateFrom}
            onToolApprovalResponse={handleToolApprovalResponse}
            onQuestionResponse={handleQuestionResponse}
          />

          <AgentComposer
            input={input}
            submitDisabled={submitDisabled}
            isRunning={isTextBusy}
            isVoiceMode={isVoiceMode}
            isVoiceConnecting={isVoiceConnecting}
            isVoiceLive={isVoiceLive}
            voiceInputMode={voiceInputMode}
            isHoldRecording={holdToSpeak.isRecording}
            isHoldTranscribing={holdToSpeak.isTranscribing}
            imageInputSupported={imageInputSupported}
            documentInputSupported={documentInputSupported}
            textModel={textModel}
            textModelDisabled={isTextBusy}
            reasoningEffort={reasoningEffort}
            reasoningEffortDisabled={isTextBusy}
            attachments={attachments}
            commands={commands}
            isCommandRendering={isCommandRendering}
            onInputChange={handleInputChange}
            onTextModelChange={setTextModel}
            onReasoningEffortChange={setReasoningEffort}
            onAttachmentsChange={handleAttachmentsChange}
            onRemoveAttachment={handleRemoveAttachment}
            onRetryAttachment={handleRetryAttachment}
            onSlashCommandSubmit={handleSlashCommandSubmit}
            onSubmit={handleSubmit}
            onStop={handleStop}
            onToggleVoice={toggleVoice}
            onHoldStart={holdToSpeak.startRecording}
            onHoldEnd={holdToSpeak.stopRecording}
          />
        </section>
      </div>
      <AgentConsoleDialog
        open={consoleOpen}
        sessionId={sessionId}
        openAiCodexConnected={openAiCodexConnected}
        anthropicClaudeConnected={anthropicClaudeConnected}
        textStatus={state.status}
        voiceStatus={voiceStatus}
        usage={usage}
        hasUsage={hasUsage}
        contextTokens={contextTokens}
        compaction={compaction}
        textModel={textModel}
        textModelDisabled={isTextBusy}
        reasoningEffort={reasoningEffort}
        reasoningEffortDisabled={isTextBusy}
        transcriptionModel={transcriptionModel}
        transcriptionModelDisabled={isVoiceMode || voiceInputMode === 'hold'}
        voiceInputMode={voiceInputMode}
        voiceInputModeDisabled={isVoiceMode || isHoldBusy}
        showInlineTools={showInlineTools}
        showReasoning={showReasoning}
        onOpenChange={handleConsoleOpenChange}
        onTextModelChange={setTextModel}
        onReasoningEffortChange={setReasoningEffort}
        onTranscriptionModelChange={setTranscriptionModel}
        onVoiceInputModeChange={handleVoiceInputModeChange}
        onShowInlineToolsChange={handleInlineToolsChange}
        onShowReasoningChange={handleReasoningChange}
      />
    </main>
  )
}
