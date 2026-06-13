'use client'

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import Image from 'next/image'
import { Streamdown } from 'streamdown'
import {
  BotIcon,
  BrainIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  PencilIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  SparklesIcon,
  Trash2Icon,
  WrenchIcon
} from 'lucide-react'
import {
  QuestionAnswer,
  QuestionResponse,
  ToolApprovalResponse,
  attachmentSourceDataUrl,
  contentParts,
  contentText,
  type Content,
  type ContentPart,
  type QuestionPrompt,
  type ToolCall
} from '@yolk-sdk/agent/protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { contentPreview, unknownPreview } from './agent-format'
import { canSaveEditedMessage, editDraftText, editKeyAction } from './message-edit-model'
import type { AgentChatItem, ToolDuration, ToolRunState } from '@yolk-sdk/agent/react'

const chatRowClass = 'mx-auto w-full max-w-3xl'

function UtilityIcon({ role }: { readonly role: 'assistant' | 'reasoning' | 'tool' | 'error' }) {
  const Icon =
    role === 'reasoning'
      ? BrainIcon
      : role === 'tool'
        ? WrenchIcon
        : role === 'error'
          ? CircleAlertIcon
          : BotIcon

  return (
    <div
      className={cn(
        'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border shadow-xs',
        role === 'reasoning'
          ? 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-200'
          : role === 'tool'
            ? 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300'
            : role === 'error'
              ? 'border-destructive/20 bg-destructive/10 text-destructive'
              : 'border-foreground/10 bg-background text-muted-foreground'
      )}
      aria-hidden
    >
      <Icon className="size-3.5" />
    </div>
  )
}

function UtilityCard({
  role,
  title,
  badge,
  children
}: {
  readonly role: 'reasoning' | 'tool' | 'error'
  readonly title: string
  readonly badge: string
  readonly children: string
}) {
  return (
    <div className={chatRowClass}>
      <div className="flex gap-3">
        <UtilityIcon role={role} />
        <div
          className={cn(
            'min-w-0 flex-1 rounded-2xl border px-3.5 py-3 shadow-xs',
            role === 'reasoning'
              ? 'border-sky-500/20 bg-sky-500/5 text-sky-950 dark:text-sky-100'
              : role === 'tool'
                ? 'border-amber-500/20 bg-amber-500/5 text-amber-900 dark:text-amber-200'
                : 'border-destructive/20 bg-destructive/5 text-destructive'
          )}
        >
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant={role === 'error' ? 'destructive' : 'outline'}>{badge}</Badge>
            <span className="font-medium text-foreground">{title}</span>
          </div>
          <div className="mt-2 whitespace-pre-wrap break-words text-xs leading-5">{children}</div>
        </div>
      </div>
    </div>
  )
}

const formatToolDuration = (duration: ToolDuration) => {
  if (duration._tag === 'Unknown') {
    return 'done'
  }

  if (duration.milliseconds < 1000) {
    return `${duration.milliseconds}ms`
  }

  return `${(duration.milliseconds / 1000).toFixed(1)}s`
}

const toolStateLabel = (state: ToolRunState) => {
  switch (state._tag) {
    case 'InputStreaming':
      return 'input'
    case 'ApprovalRequested':
      return 'approval'
    case 'Denied':
      return 'denied'
    case 'QuestionRequested':
      return 'question'
    case 'QuestionAnswered':
      return 'answered'
    case 'QuestionCancelled':
      return 'cancelled'
    case 'Running':
      return 'running'
    case 'Called':
      return 'called'
    case 'Completed':
      return state.result.isError === true ? 'error' : formatToolDuration(state.duration)
    case 'Errored':
      return 'error'
    case 'ProviderCompleted':
      return state.result.isError === true ? 'error' : 'done'
  }
}

const toolStateHasError = (state: ToolRunState) => {
  switch (state._tag) {
    case 'Completed':
    case 'ProviderCompleted':
      return state.result.isError === true
    case 'Denied':
    case 'Errored':
    case 'QuestionCancelled':
      return true
    case 'ApprovalRequested':
    case 'Called':
    case 'InputStreaming':
    case 'QuestionAnswered':
    case 'QuestionRequested':
    case 'Running':
      return false
  }
}

const optionLabel = (question: QuestionPrompt, optionId: string) =>
  question.options?.find(option => option.id === optionId)?.label ?? optionId

const questionForAnswer = (
  questions: ReadonlyArray<QuestionPrompt>,
  answer: QuestionAnswer
) => questions.find(question => question.id === answer.questionId)

const questionAnswerLine = (
  answer: QuestionAnswer,
  questions: ReadonlyArray<QuestionPrompt>
) => {
  const question = questionForAnswer(questions, answer)
  const prompt = question?.prompt ?? answer.questionId
  const selected = answer.optionIds?.map(optionId =>
    question === undefined ? optionId : optionLabel(question, optionId)
  ) ?? []
  const custom = answer.customAnswer?.trim()
  const values = custom === undefined || custom.length === 0 ? selected : [...selected, custom]

  return values.length === 0 ? `${prompt}: answered` : `${prompt}: ${values.join(', ')}`
}

const questionAnswerPreview = (
  response: QuestionResponse,
  questions: ReadonlyArray<QuestionPrompt>
) => {
  const answers = response.answers ?? []

  if (answers.length === 0) {
    return 'answered'
  }

  return answers.map(answer => questionAnswerLine(answer, questions)).join('\n')
}

const toolStateContent = (state: ToolRunState) => {
  switch (state._tag) {
    case 'Completed':
    case 'ProviderCompleted':
      return contentPreview(state.result.content)
    case 'Denied':
      return state.reason
    case 'QuestionAnswered':
      return questionAnswerPreview(state.response, state.request?.questions ?? [])
    case 'QuestionCancelled':
      return state.response.reason ?? 'cancelled'
    case 'Errored':
      return state.message
    case 'ApprovalRequested':
    case 'Called':
    case 'InputStreaming':
    case 'QuestionRequested':
    case 'Running':
      return undefined
  }
}

const toolResultLabel = (isError: boolean) => (isError ? 'tool error' : 'tool result')

const toolResultRole = (isError: boolean) => (isError ? 'error' : 'tool')

const toolResultBadgeVariant = (isError: boolean) => (isError ? 'destructive' : 'outline')

const objectField = (input: unknown, key: string) =>
  input !== null && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined

const stringField = (input: unknown, key: string) => {
  const value = objectField(input, key)

  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const numberField = (input: unknown, key: string) => {
  const value = objectField(input, key)

  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const resultStructuredContent = (state: ToolRunState) => {
  switch (state._tag) {
    case 'Completed':
    case 'ProviderCompleted':
      return state.result.structuredContent
    case 'ApprovalRequested':
    case 'Called':
    case 'Denied':
    case 'Errored':
    case 'InputStreaming':
    case 'QuestionAnswered':
    case 'QuestionCancelled':
    case 'QuestionRequested':
    case 'Running':
      return undefined
  }
}

const taskMetadata = (call: ToolCall, state: ToolRunState) => {
  if (call.name !== 'task') {
    return undefined
  }

  const structured = resultStructuredContent(state)
  const description = stringField(structured, 'description') ?? stringField(call.params, 'description')
  const subagentType = stringField(structured, 'subagent_type') ?? stringField(call.params, 'subagent_type')

  return {
    description,
    subagentType,
    subagentRunId: stringField(structured, 'subagent_run_id'),
    startedAtMs: numberField(structured, 'started_at_ms'),
    endedAtMs: numberField(structured, 'ended_at_ms'),
    durationMs: numberField(structured, 'duration_ms'),
    status: stringField(structured, 'status'),
    model: stringField(structured, 'model')
  }
}

const timestampLabel = (milliseconds: number) => new Date(milliseconds).toLocaleTimeString()

const toolResultTitle = (name: string, isError: boolean) => (isError ? `${name} failed` : name)

const approvalRequestId = (call: ToolCall, state: Extract<ToolRunState, { readonly _tag: 'ApprovalRequested' }>) =>
  state.request?.requestId ?? `approval:${call.id}`

type QuestionDraft = {
  readonly questionId: string
  readonly optionIds: ReadonlyArray<string>
  readonly customAnswer: string
}

const initialQuestionDrafts = (questions: ReadonlyArray<QuestionPrompt>): ReadonlyArray<QuestionDraft> =>
  questions.map(question => ({ questionId: question.id, optionIds: [], customAnswer: '' }))

const draftForQuestion = (drafts: ReadonlyArray<QuestionDraft>, questionId: string) =>
  drafts.find(draft => draft.questionId === questionId) ?? {
    questionId,
    optionIds: [],
    customAnswer: ''
  }

const questionOptions = (question: QuestionPrompt) => question.options ?? []

const questionAllowsCustom = (question: QuestionPrompt) =>
  question.allowCustom === true || questionOptions(question).length === 0

const questionRequiresAnswer = (question: QuestionPrompt) => question.required !== false

const hasQuestionAnswer = (draft: QuestionDraft) =>
  draft.optionIds.length > 0 || draft.customAnswer.trim().length > 0

const canSubmitQuestionDrafts = (
  questions: ReadonlyArray<QuestionPrompt>,
  drafts: ReadonlyArray<QuestionDraft>
) =>
  drafts.some(hasQuestionAnswer) &&
  questions.every(question =>
    questionRequiresAnswer(question)
      ? hasQuestionAnswer(draftForQuestion(drafts, question.id))
      : true
  )

const answerFromDraft = (draft: QuestionDraft) => {
  const customAnswer = draft.customAnswer.trim()

  return QuestionAnswer.make({
    questionId: draft.questionId,
    optionIds: draft.optionIds.length > 0 ? draft.optionIds : undefined,
    customAnswer: customAnswer.length > 0 ? customAnswer : undefined
  })
}

function ApprovalControls({
  call,
  state,
  disabled,
  onResponse
}: {
  readonly call: ToolCall
  readonly state: Extract<ToolRunState, { readonly _tag: 'ApprovalRequested' }>
  readonly disabled: boolean
  readonly onResponse: (response: ToolApprovalResponse) => void
}) {
  const requestId = approvalRequestId(call, state)
  const handleApprove = useCallback(() => {
    onResponse(
      ToolApprovalResponse.make({
        requestId,
        toolCallId: call.id,
        decision: 'approved',
        source: 'user'
      })
    )
  }, [call.id, onResponse, requestId])
  const handleDeny = useCallback(() => {
    onResponse(
      ToolApprovalResponse.make({
        requestId,
        toolCallId: call.id,
        decision: 'denied',
        source: 'user',
        reason: 'Denied by user'
      })
    )
  }, [call.id, onResponse, requestId])

  return (
    <div className="border-t border-amber-500/15 px-3.5 py-3" role="group" aria-label={`Approve ${call.name}`}>
      <div className="text-xs leading-5 text-muted-foreground">
        This tool needs approval before it runs.
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" size="sm" className="min-h-11" disabled={disabled} onClick={handleApprove}>
          Approve
        </Button>
        <Button type="button" variant="outline" size="sm" className="min-h-11" disabled={disabled} onClick={handleDeny}>
          Deny
        </Button>
      </div>
    </div>
  )
}

function QuestionControls({
  state,
  disabled,
  onResponse
}: {
  readonly state: Extract<ToolRunState, { readonly _tag: 'QuestionRequested' }>
  readonly disabled: boolean
  readonly onResponse: (response: QuestionResponse) => void
}) {
  const request = state.request
  const [drafts, setDrafts] = useState(() => initialQuestionDrafts(request.questions))
  const canSubmit = canSubmitQuestionDrafts(request.questions, drafts)
  const updateOption = useCallback((question: QuestionPrompt, optionId: string) => {
    setDrafts(current =>
      current.map(draft => {
        if (draft.questionId !== question.id) {
          return draft
        }

        const optionIds = question.multiple === true
          ? draft.optionIds.includes(optionId)
            ? draft.optionIds.filter(id => id !== optionId)
            : [...draft.optionIds, optionId]
          : [optionId]

        return { ...draft, optionIds }
      })
    )
  }, [])
  const updateCustomAnswer = useCallback((questionId: string, value: string) => {
    setDrafts(current =>
      current.map(draft =>
        draft.questionId === questionId ? { ...draft, customAnswer: value } : draft
      )
    )
  }, [])
  const handleSubmit = useCallback(() => {
    if (!canSubmit) {
      return
    }

    onResponse(
      QuestionResponse.make({
        requestId: request.requestId,
        toolCallId: request.toolCallId,
        outcome: 'answered',
        source: 'user',
        answers: drafts.filter(hasQuestionAnswer).map(answerFromDraft)
      })
    )
  }, [canSubmit, drafts, onResponse, request.requestId, request.toolCallId])
  const handleCancel = useCallback(() => {
    onResponse(
      QuestionResponse.make({
        requestId: request.requestId,
        toolCallId: request.toolCallId,
        outcome: 'cancelled',
        source: 'user',
        reason: 'Cancelled by user'
      })
    )
  }, [onResponse, request.requestId, request.toolCallId])

  return (
    <div className="space-y-4 border-t border-amber-500/15 px-3.5 py-3">
      {request.questions.map(question => {
        const draft = draftForQuestion(drafts, question.id)
        const options = questionOptions(question)
        const inputType = question.multiple === true ? 'checkbox' : 'radio'
        const inputName = `${request.requestId}-${question.id}`

        return (
          <fieldset key={question.id} className="space-y-2">
            <legend className="text-sm font-medium text-foreground">{question.prompt}</legend>
            {options.length === 0 ? null : (
              <div className="space-y-2">
                {options.map(option => (
                  <label
                    key={option.id}
                    className="flex min-h-11 cursor-pointer gap-3 rounded-xl border border-foreground/10 bg-background/50 px-3 py-2 text-sm text-foreground"
                  >
                    <input
                      type={inputType}
                      name={inputName}
                      checked={draft.optionIds.includes(option.id)}
                      disabled={disabled}
                      onChange={() => updateOption(question, option.id)}
                      className="mt-1"
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">{option.label}</span>
                      {option.description === undefined ? null : (
                        <span className="block text-xs leading-5 text-muted-foreground">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {questionAllowsCustom(question) ? (
              <textarea
                value={draft.customAnswer}
                disabled={disabled}
                onChange={event => updateCustomAnswer(question.id, event.currentTarget.value)}
                className="min-h-24 w-full resize-none rounded-xl border border-foreground/10 bg-background/70 px-3 py-2 text-sm leading-6 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Type custom answer…"
                aria-label={`Custom answer for ${question.prompt}`}
              />
            ) : null}
          </fieldset>
        )
      })}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" className="min-h-11" disabled={disabled || !canSubmit} onClick={handleSubmit}>
          Submit answer
        </Button>
        <Button type="button" variant="outline" size="sm" className="min-h-11" disabled={disabled} onClick={handleCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function ToolRunCard({
  id,
  call,
  state,
  hitlDisabled,
  onToolApprovalResponse,
  onQuestionResponse
}: {
  readonly id: string
  readonly call: ToolCall
  readonly state: ToolRunState
  readonly hitlDisabled: boolean
  readonly onToolApprovalResponse: (response: ToolApprovalResponse) => void
  readonly onQuestionResponse: (response: QuestionResponse) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const isRunning = state._tag === 'Running'
  const isError = toolStateHasError(state)
  const output = toolStateContent(state)
  const task = taskMetadata(call, state)
  const title = task?.description === undefined ? call.name : `Task: ${task.description}`
  const detailsId = `${id}-details`
  const handleToggle = useCallback(() => {
    setExpanded(current => !current)
  }, [])

  return (
    <div className={chatRowClass}>
      <div className="flex gap-3">
        <UtilityIcon role={isError ? 'error' : 'tool'} />
        <div
          className={cn(
            'min-w-0 flex-1 overflow-hidden rounded-2xl border shadow-xs',
            isError
              ? 'border-destructive/20 bg-destructive/5 text-destructive'
              : 'border-amber-500/20 bg-amber-500/5 text-amber-900 dark:text-amber-200'
          )}
        >
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={handleToggle}
            className="flex min-h-11 w-full items-center gap-2 px-3.5 py-2.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Badge variant={toolResultBadgeVariant(isError)}>
              {isError ? 'tool error' : 'tool'}
            </Badge>
            {isRunning ? (
              <LoaderCircleIcon
                className="size-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
                aria-hidden
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">{title}</span>
            <span
              role={isRunning ? 'status' : undefined}
              aria-live={isRunning ? 'polite' : undefined}
              className="shrink-0 tabular-nums text-muted-foreground"
            >
              {toolStateLabel(state)}
            </span>
            <ChevronDownIcon
              className={cn(
                'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out',
                expanded ? 'rotate-180' : 'rotate-0'
              )}
              aria-hidden
            />
          </button>
          {expanded ? (
            <div id={detailsId} className="border-t border-amber-500/15 px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-foreground">{title}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{call.id}</span>
              </div>
              {task === undefined ? null : (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  {task.subagentType === undefined ? null : <span>type {task.subagentType}</span>}
                  {task.subagentRunId === undefined ? null : <span>run {task.subagentRunId}</span>}
                  {task.model === undefined ? null : <span>model {task.model}</span>}
                  {task.startedAtMs === undefined ? null : <span>start {timestampLabel(task.startedAtMs)}</span>}
                  {task.endedAtMs === undefined ? null : <span>end {timestampLabel(task.endedAtMs)}</span>}
                  {task.durationMs === undefined ? null : <span>duration {formatToolDuration({ _tag: 'Known', milliseconds: task.durationMs })}</span>}
                </div>
              )}
              <div className="mt-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
                Input
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-muted-foreground">
                {unknownPreview(call.params)}
              </div>
              {output === undefined ? null : (
                <>
                  <div className="mt-3 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
                    Output
                  </div>
                  <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-5">
                    {output}
                  </div>
                </>
              )}
            </div>
          ) : null}
          {state._tag === 'ApprovalRequested' ? (
            <ApprovalControls
              call={call}
              state={state}
              disabled={hitlDisabled}
              onResponse={onToolApprovalResponse}
            />
          ) : null}
          {state._tag === 'QuestionRequested' ? (
            <QuestionControls
              state={state}
              disabled={hitlDisabled}
              onResponse={onQuestionResponse}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ToolResultCard({
  name,
  content,
  isError
}: {
  readonly name: string
  readonly content: string
  readonly isError: boolean
}) {
  return (
    <UtilityCard
      role={toolResultRole(isError)}
      title={toolResultTitle(name, isError)}
      badge={toolResultLabel(isError)}
    >
      {content}
    </UtilityCard>
  )
}

function ReasoningCard({ text }: { readonly text: string }) {
  return (
    <UtilityCard role="reasoning" title="Summary" badge="reasoning">
      {text}
    </UtilityCard>
  )
}

function MessageCard({
  content,
  role,
  messageId,
  actionsDisabled,
  onDeleteTurn,
  onEditUserMessage,
  onRegenerateFrom
}: {
  readonly content: Content
  readonly role: 'user' | 'assistant'
  readonly messageId: string
  readonly actionsDisabled: boolean
  readonly onDeleteTurn: (messageId: string) => void
  readonly onEditUserMessage: (messageId: string, content: string) => void
  readonly onRegenerateFrom: (messageId: string) => void
}) {
  const parts = contentParts(content)
  const currentText = contentText(content)
  const editHelpId = useId()
  const editTextareaRef = useRef<HTMLTextAreaElement>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editedContent, setEditedContent] = useState(currentText)
  const hasVisibleContent = parts.some(part => part._tag !== 'Text' || part.text.length > 0)
  const canEdit = role === 'user' && parts.every(part => part._tag === 'Text')
  const canSaveEdit = canSaveEditedMessage({
    currentText,
    draftText: editedContent,
    disabled: actionsDisabled
  })
  const handleDelete = useCallback(() => {
    onDeleteTurn(messageId)
  }, [messageId, onDeleteTurn])
  const handleEditStart = useCallback(() => {
    setEditedContent(currentText)
    setIsEditing(true)
  }, [currentText, setEditedContent, setIsEditing])
  const handleEditCancel = useCallback(() => {
    setIsEditing(false)
    setEditedContent(currentText)
  }, [currentText, setEditedContent, setIsEditing])
  const handleEditSubmit = useCallback(() => {
    if (!canSaveEdit) {
      return
    }

    onEditUserMessage(messageId, editDraftText(editedContent))
    setIsEditing(false)
  }, [canSaveEdit, editedContent, messageId, onEditUserMessage, setIsEditing])
  const handleEditKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const action = editKeyAction(event)

      if (action === 'none') {
        return
      }

      event.preventDefault()

      if (action === 'cancel') {
        handleEditCancel()
        return
      }

      handleEditSubmit()
    },
    [handleEditCancel, handleEditSubmit]
  )
  const handleRegenerate = useCallback(() => {
    onRegenerateFrom(messageId)
  }, [messageId, onRegenerateFrom])

  useEffect(() => {
    if (!isEditing) {
      return
    }

    const textarea = editTextareaRef.current

    textarea?.focus()
    textarea?.setSelectionRange(textarea.value.length, textarea.value.length)
  }, [isEditing])

  if (!hasVisibleContent) {
    return null
  }

  if (role === 'user') {
    return (
      <div className={chatRowClass}>
        <div className="flex justify-end">
          <div className="flex max-w-[78%] flex-col items-end gap-2">
            {isEditing ? (
              <div className="w-full min-w-64 rounded-2xl rounded-br-md border border-primary/20 bg-background p-2 shadow-xs">
                <textarea
                  ref={editTextareaRef}
                  value={editedContent}
                  onChange={event => setEditedContent(event.currentTarget.value)}
                  onKeyDown={handleEditKeyDown}
                  className="min-h-24 w-full resize-none rounded-xl bg-transparent px-2 py-2 text-sm leading-6 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Edit message"
                  aria-describedby={editHelpId}
                />
                <div
                  id={editHelpId}
                  className="mt-1 px-2 text-[11px] leading-5 text-muted-foreground"
                >
                  Enter saves. Shift+Enter adds a line. Escape cancels.
                </div>
                <div className="mt-2 flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={handleEditCancel}>
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!canSaveEdit}
                    onClick={handleEditSubmit}
                  >
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-primary/15 bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground shadow-xs">
                <MessageContentParts parts={parts} role="user" />
              </div>
            )}
            <MessageActions
              role="user"
              disabled={actionsDisabled}
              canEdit={canEdit}
              onDelete={handleDelete}
              onEdit={handleEditStart}
              onRegenerate={handleRegenerate}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={chatRowClass}>
      <div className="min-w-0 px-1 py-1">
        <div className="mb-1.5 flex min-h-11 flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
          <div className="flex items-center gap-2">
            <BotIcon className="size-3" />
            Assistant
          </div>
          <MessageActions
            role="assistant"
            disabled={actionsDisabled}
            canEdit={false}
            onDelete={handleDelete}
            onEdit={handleEditStart}
            onRegenerate={handleRegenerate}
          />
        </div>
        <div className="whitespace-pre-wrap break-words text-sm leading-7 text-foreground">
          <MessageContentParts parts={parts} role="assistant" />
        </div>
      </div>
    </div>
  )
}

function MessageActions({
  role,
  disabled,
  canEdit,
  onDelete,
  onEdit,
  onRegenerate
}: {
  readonly role: 'user' | 'assistant'
  readonly disabled: boolean
  readonly canEdit: boolean
  readonly onDelete: () => void
  readonly onEdit: () => void
  readonly onRegenerate: () => void
}) {
  return (
    <div className="flex items-center gap-1" aria-label={`${role} message actions`}>
      {canEdit ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="min-h-11 min-w-11 text-muted-foreground hover:text-foreground"
          disabled={disabled}
          aria-label="Edit message"
          onClick={onEdit}
        >
          <PencilIcon className="size-3.5" aria-hidden />
        </Button>
      ) : null}
      {role === 'assistant' ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="min-h-11 min-w-11 text-muted-foreground hover:text-foreground"
          disabled={disabled}
          aria-label="Regenerate response"
          onClick={onRegenerate}
        >
          <RotateCcwIcon className="size-3.5" aria-hidden />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="min-h-11 min-w-11 text-muted-foreground hover:text-destructive"
        disabled={disabled}
        aria-label="Delete turn"
        onClick={onDelete}
      >
        <Trash2Icon className="size-3.5" aria-hidden />
      </Button>
    </div>
  )
}

function MarkdownText({ text, className }: { readonly text: string; readonly className?: string }) {
  return (
    <Streamdown
      className={cn('break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}
      controls={false}
      mode="streaming"
    >
      {text}
    </Streamdown>
  )
}

function MessageContentParts({
  parts,
  role
}: {
  readonly parts: ReadonlyArray<ContentPart>
  readonly role: 'user' | 'assistant'
}) {
  return (
    <div className="space-y-2">
      {parts.map((part, index) => {
        switch (part._tag) {
          case 'Text':
            return part.text.length > 0 ? (
              <MarkdownText key={`text-${index}`} text={part.text} />
            ) : null
          case 'Image':
            const imageUrl = attachmentSourceDataUrl(part.source, part.mimeType)
            if (imageUrl._tag === 'None') {
              return (
                <div
                  key={`image-${index}`}
                  className="rounded-xl border border-foreground/10 bg-background/20 px-3 py-2 text-xs"
                >
                  Image attachment
                </div>
              )
            }

            return (
              <Image
                key={`image-${index}`}
                src={imageUrl.value}
                alt={role === 'user' ? 'Uploaded image' : 'Generated image'}
                width={640}
                height={360}
                unoptimized
                className="max-h-80 rounded-xl border border-foreground/10 object-contain shadow-xs"
              />
            )
          case 'Audio':
            return (
              <div
                key={`audio-${index}`}
                className="rounded-xl border border-foreground/10 bg-background/20 px-3 py-2 text-xs"
              >
                Audio attachment
              </div>
            )
        }
      })}
    </div>
  )
}

function DraftCard({ text, role }: { readonly text: string; readonly role: 'user' | 'assistant' }) {
  if (role === 'user') {
    return (
      <div className={chatRowClass}>
        <div className="flex justify-end">
          <div className="max-w-[78%] animate-pulse whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-primary/15 bg-primary/80 px-4 py-3 text-sm leading-6 text-primary-foreground shadow-xs">
            {text}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={chatRowClass}>
      <div className="min-w-0 px-1 py-1">
        <div className="mb-1.5 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
          <BotIcon className="size-3" />
          Assistant
        </div>
        <MarkdownText
          text={text}
          className="animate-pulse whitespace-pre-wrap text-sm leading-7 text-foreground"
        />
      </div>
    </div>
  )
}

function AssistantStatusCard({ label }: { readonly label: string }) {
  return (
    <div className={chatRowClass}>
      <div className="min-w-0 px-1 py-1">
        <div
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-2 rounded-full border border-foreground/10 bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground shadow-xs"
        >
          <LoaderCircleIcon
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          <span>{label}</span>
          <span className="flex w-5 items-center gap-0.5" aria-hidden>
            <span className="size-1 rounded-full bg-current opacity-40 motion-safe:animate-pulse" />
            <span className="size-1 rounded-full bg-current opacity-60 motion-safe:animate-pulse [animation-delay:120ms]" />
            <span className="size-1 rounded-full bg-current opacity-80 motion-safe:animate-pulse [animation-delay:240ms]" />
          </span>
        </div>
      </div>
    </div>
  )
}

function AgentChatItemView({
  item,
  showInlineTools,
  showReasoning,
  actionsDisabled,
  hitlDisabled,
  onDeleteTurn,
  onEditUserMessage,
  onRegenerateFrom,
  onToolApprovalResponse,
  onQuestionResponse
}: {
  readonly item: AgentChatItem
  readonly showInlineTools: boolean
  readonly showReasoning: boolean
  readonly actionsDisabled: boolean
  readonly hitlDisabled: boolean
  readonly onDeleteTurn: (messageId: string) => void
  readonly onEditUserMessage: (messageId: string, content: string) => void
  readonly onRegenerateFrom: (messageId: string) => void
  readonly onToolApprovalResponse: (response: ToolApprovalResponse) => void
  readonly onQuestionResponse: (response: QuestionResponse) => void
}) {
  switch (item._tag) {
    case 'UserMessage':
      return (
        <MessageCard
          content={item.content}
          role="user"
          messageId={item.messageId}
          actionsDisabled={actionsDisabled}
          onDeleteTurn={onDeleteTurn}
          onEditUserMessage={onEditUserMessage}
          onRegenerateFrom={onRegenerateFrom}
        />
      )
    case 'AssistantMessage':
      return (
        <MessageCard
          content={item.content}
          role="assistant"
          messageId={item.messageId}
          actionsDisabled={actionsDisabled}
          onDeleteTurn={onDeleteTurn}
          onEditUserMessage={onEditUserMessage}
          onRegenerateFrom={onRegenerateFrom}
        />
      )
    case 'Reasoning':
      return showReasoning ? <ReasoningCard text={item.text} /> : null
    case 'ToolRun':
      return showInlineTools ? (
        <ToolRunCard
          id={item.id}
          call={item.call}
          state={item.state}
          hitlDisabled={hitlDisabled}
          onToolApprovalResponse={onToolApprovalResponse}
          onQuestionResponse={onQuestionResponse}
        />
      ) : null
    case 'ToolResult':
      return showInlineTools ? (
        <ToolResultCard
          name={item.name}
          content={contentPreview(item.content)}
          isError={item.isError === true}
        />
      ) : null
    case 'UserDraft':
      return <DraftCard text={item.text} role="user" />
    case 'AssistantDraft':
      return <DraftCard text={item.text} role="assistant" />
    case 'AssistantStatus':
      return <AssistantStatusCard label={item.label} />
    case 'Error':
      return (
        <UtilityCard role="error" title="Request failed" badge="error">
          {item.message}
        </UtilityCard>
      )
  }
}

type AgentConversationProps = {
  readonly items: ReadonlyArray<AgentChatItem>
  readonly showInlineTools: boolean
  readonly showReasoning: boolean
  readonly actionsDisabled: boolean
  readonly hitlDisabled: boolean
  readonly onDeleteTurn: (messageId: string) => void
  readonly onEditUserMessage: (messageId: string, content: string) => void
  readonly onRegenerateFrom: (messageId: string) => void
  readonly onToolApprovalResponse: (response: ToolApprovalResponse) => void
  readonly onQuestionResponse: (response: QuestionResponse) => void
}

export function AgentConversation({
  items,
  showInlineTools,
  showReasoning,
  actionsDisabled,
  hitlDisabled,
  onDeleteTurn,
  onEditUserMessage,
  onRegenerateFrom,
  onToolApprovalResponse,
  onQuestionResponse
}: AgentConversationProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current

    if (viewport === null) {
      return
    }

    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    stickToBottomRef.current = distanceFromBottom < 96
  }, [])

  useEffect(() => {
    if (stickToBottomRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    }
  }, [items])

  return (
    <div
      ref={viewportRef}
      onScroll={handleScroll}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6"
    >
      {items.length === 0 ? (
        <div className="flex min-h-full items-center justify-center py-12">
          <Card
            size="sm"
            className="w-full max-w-lg border-dashed bg-background/60 text-center shadow-none"
          >
            <CardHeader>
              <div className="mx-auto mb-2 grid size-10 place-items-center rounded-full border border-primary/15 bg-primary/10 text-primary">
                <SparklesIcon className="size-5" />
              </div>
              <CardTitle>Ask anything</CardTitle>
              <CardDescription>
                Try “summarize https://example.com” or “search latest AI news”.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      ) : null}

      <div className="space-y-5">
        {items.map(item => (
          <AgentChatItemView
            key={item.id}
            item={item}
            showInlineTools={showInlineTools}
            showReasoning={showReasoning}
            actionsDisabled={actionsDisabled}
            hitlDisabled={hitlDisabled}
            onDeleteTurn={onDeleteTurn}
            onEditUserMessage={onEditUserMessage}
            onRegenerateFrom={onRegenerateFrom}
            onToolApprovalResponse={onToolApprovalResponse}
            onQuestionResponse={onQuestionResponse}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
