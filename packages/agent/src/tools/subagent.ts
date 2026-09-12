import { Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk-sdk/agent/loop'
import {
  addAgentUsage,
  assistantContent,
  AgentUsage,
  contentText,
  isTerminalAgentEvent,
  makeSubagentRunId,
  ToolResult,
  type AgentErrorCode,
  type AgentEvent,
  type AgentMessage,
  type AgentReasoningEffort,
  type HitlRequest,
  type ProviderErrorInfo,
  type ToolCall,
  zeroAgentUsage
} from '@yolk-sdk/agent/protocol'
import { subagentToolName } from '../protocol/tool.ts'
import {
  makeTool,
  modelVisibleToolError,
  type ModelVisibleToolError,
  type ToolModule,
  type ToolRegistration,
  type ToolRegistryError
} from './registry.ts'

export { subagentToolName }

const SubagentToolBaseFields = {
  description: Schema.String.pipe(
    Schema.annotate({ description: 'A short 3-5 word description of the task.' })
  ),
  prompt: Schema.String.pipe(
    Schema.annotate({
      description:
        'The complete task instructions for the subagent, including all context it needs.'
    })
  ),
  subagent_type: Schema.String.pipe(
    Schema.annotate({ description: 'The specialized subagent type to use for this task.' })
  )
}

export type SubagentToolParams = {
  readonly description: string
  readonly prompt: string
  readonly subagent_type: string
  readonly model?: string
  readonly reasoning_effort?: AgentReasoningEffort
  readonly background?: boolean
}

export type SubagentDefinition = {
  readonly name: string
  readonly description: string
}

export type SubagentModelDefinition = {
  readonly id: string
  readonly description: string
}

export type SubagentReasoningEffortDefinition = {
  readonly value: AgentReasoningEffort
  readonly description: string
}

export type SubagentRuntimeSelectionOptions = {
  /** Opt-in only: inline hosts do not advertise background execution. */
  readonly background?: boolean
  readonly models?: ReadonlyArray<SubagentModelDefinition>
  readonly reasoningEfforts?: ReadonlyArray<SubagentReasoningEffortDefinition>
}

export type SubagentContext = {
  readonly subagent?: boolean
}

export type SubagentExecutionInput<Context> = {
  readonly call: ToolCall
  readonly context: Context
  readonly params: SubagentToolParams
}

export type SubagentToolOptions<Context> = SubagentRuntimeSelectionOptions & {
  readonly subagents: ReadonlyArray<SubagentDefinition>
  readonly isEnabled?: (context: Context) => Effect.Effect<boolean, ToolRegistryError>
  readonly execute: (input: SubagentExecutionInput<Context>) => Effect.Effect<ToolResult, ToolError>
}

export type SubagentRunError = {
  readonly code: AgentErrorCode
  readonly message: string
  readonly retryable: boolean
  readonly provider?: ProviderErrorInfo
}

export type SubagentRunStatus = 'completed' | 'awaiting_input' | 'error'

export type SubagentRunResult = {
  readonly status: SubagentRunStatus
  readonly text: string
  readonly usage?: AgentUsage
  readonly turns?: number
  readonly requests?: ReadonlyArray<HitlRequest>
  readonly error?: SubagentRunError
}

export type SubagentToolResultInput = {
  readonly callId: string
  readonly output: string
  readonly subagentType: string
  readonly description: string
  readonly subagentRunId: string
  readonly startedAtMs: number
  readonly endedAtMs: number
  readonly model: string
  readonly reasoningEffort?: AgentReasoningEffort
  readonly usage?: AgentUsage
  readonly turns?: number
  readonly status?: SubagentRunStatus
  readonly requests?: ReadonlyArray<HitlRequest>
  readonly error?: SubagentRunError
  readonly isError?: boolean
}

type SubagentToolParamsFields = {
  readonly description: string
  readonly prompt: string
  readonly subagent_type: string
  model?: string
  reasoning_effort?: AgentReasoningEffort
  background?: boolean
}

type SubagentProviderMetadataFields = {
  readonly provider: string
  readonly kind: ProviderErrorInfo['kind']
  status?: number
  provider_code?: string
  retry_after_ms?: number
}

type SubagentUsageInputMetadataFields = {
  readonly total: number
  uncached?: number
  cache_read?: number
  cache_write?: number
}

type SubagentUsageOutputMetadataFields = {
  readonly total: number
  text?: number
  reasoning?: number
}

type SubagentUsageMetadataFields = {
  readonly input: SubagentUsageInputMetadataFields
  readonly output: SubagentUsageOutputMetadataFields
}

type SubagentErrorMetadataFields = {
  readonly code: AgentErrorCode
  readonly message: string
  readonly retryable: boolean
  provider?: SubagentProviderMetadataFields
}

type SubagentRunErrorFields = {
  readonly code: AgentErrorCode
  readonly message: string
  readonly retryable: boolean
  provider?: ProviderErrorInfo
}

type SubagentRunResultFields = {
  readonly status: SubagentRunStatus
  readonly text: string
  usage?: AgentUsage
  turns?: number
  requests?: ReadonlyArray<HitlRequest>
  error?: SubagentRunErrorFields
}

type SubagentToolResultStructuredContentFields = {
  readonly subagent_run_id: string
  readonly subagent_type: string
  readonly description: string
  readonly started_at_ms: number
  readonly ended_at_ms: number
  readonly duration_ms: number
  readonly status: SubagentRunStatus
  readonly model: string
  reasoning_effort?: AgentReasoningEffort
  usage?: SubagentUsageMetadataFields
  turns?: number
  hitl_requests?: ReadonlyArray<HitlRequest>
  error?: SubagentErrorMetadataFields
}

type SubagentAcceptedStructuredContentFields = {
  readonly type: 'subagent_accepted'
  readonly status: 'accepted'
  readonly subagent_run_id: string
  readonly workflow_run_id: string
  parent_run_id?: string
}

type SubagentAgentInputUsageFields = {
  readonly total: number
  uncached?: number
  cacheRead?: number
  cacheWrite?: number
}

type SubagentAgentOutputUsageFields = {
  readonly total: number
  text?: number
  reasoning?: number
}

const subagentToolError = (message: string, cause: ToolError['cause']) =>
  new ToolError({
    tool: subagentToolName,
    message,
    cause
  })

const subagentModelVisibleError = (message: string) =>
  modelVisibleToolError({
    tool: subagentToolName,
    message,
    reason: 'validation'
  })

const enumRecord = <Value extends string>(
  values: ReadonlyArray<Value>
): Readonly<Record<string, Value>> => Object.fromEntries(values.map(value => [value, value]))

const optionalRuntimeSelection = <Value extends string>(input: {
  readonly values: ReadonlyArray<Value>
  readonly description: string
}) =>
  Schema.optionalKey(
    Schema.Enum(enumRecord(input.values)).pipe(Schema.annotate({ description: input.description }))
  )

const configuredSubagentToolParams = (options: SubagentRuntimeSelectionOptions) => {
  const fields = {
    ...SubagentToolBaseFields,
    background: Schema.optionalKey(
      Schema.Boolean.pipe(
        Schema.annotate({
          description:
            'Return an accepted handle immediately; use subagent_status or subagent_wait to read the result.'
        })
      )
    )
  }

  const model =
    options.models === undefined || options.models.length === 0
      ? undefined
      : optionalRuntimeSelection({
          values: options.models.map(item => item.id),
          description: 'Model for this subagent. Omit to inherit the host runtime model.'
        })

  const reasoningEffort =
    options.reasoningEfforts === undefined || options.reasoningEfforts.length === 0
      ? undefined
      : optionalRuntimeSelection({
          values: options.reasoningEfforts.map(item => item.value),
          description:
            'Reasoning effort for this subagent. Omit to inherit the host runtime effort.'
        })

  if (model !== undefined && reasoningEffort !== undefined) {
    return options.background === true
      ? Schema.Struct({ ...fields, model, reasoning_effort: reasoningEffort })
      : Schema.Struct({ ...SubagentToolBaseFields, model, reasoning_effort: reasoningEffort })
  }

  if (model !== undefined) {
    return options.background === true
      ? Schema.Struct({ ...fields, model })
      : Schema.Struct({ ...SubagentToolBaseFields, model })
  }

  if (reasoningEffort !== undefined) {
    return options.background === true
      ? Schema.Struct({ ...fields, reasoning_effort: reasoningEffort })
      : Schema.Struct({ ...SubagentToolBaseFields, reasoning_effort: reasoningEffort })
  }

  return options.background === true ? Schema.Struct(fields) : Schema.Struct(SubagentToolBaseFields)
}

const trimmedSubagentParams = (params: SubagentToolParams): SubagentToolParams => {
  const trimmed: SubagentToolParamsFields = {
    description: params.description.trim(),
    prompt: params.prompt.trim(),
    subagent_type: params.subagent_type.trim()
  }

  if (params.background !== undefined) {
    trimmed.background = params.background
  }

  if (params.model !== undefined) {
    trimmed.model = params.model
  }

  if (params.reasoning_effort !== undefined) {
    trimmed.reasoning_effort = params.reasoning_effort
  }

  return trimmed
}

const validateSubagentParams = (
  params: SubagentToolParams
): Effect.Effect<SubagentToolParams, ModelVisibleToolError> => {
  const trimmed = trimmedSubagentParams(params)

  if (trimmed.description.length === 0) {
    return Effect.fail(subagentModelVisibleError('description must not be empty'))
  }

  if (trimmed.prompt.length === 0) {
    return Effect.fail(subagentModelVisibleError('prompt must not be empty'))
  }

  if (trimmed.subagent_type.length === 0) {
    return Effect.fail(subagentModelVisibleError('subagent_type must not be empty'))
  }

  return Effect.succeed(trimmed)
}

const findSubagent = (subagents: ReadonlyArray<SubagentDefinition>, name: string) =>
  subagents.find(subagent => subagent.name === name)

const requireKnownSubagent = (
  subagents: ReadonlyArray<SubagentDefinition>,
  name: string
): Effect.Effect<SubagentDefinition, ModelVisibleToolError> => {
  const subagent = findSubagent(subagents, name)

  return subagent === undefined
    ? Effect.fail(subagentModelVisibleError(`Unknown subagent type: ${name}`))
    : Effect.succeed(subagent)
}

const subagentDescription = (subagent: SubagentDefinition) =>
  `- ${subagent.name}: ${subagent.description}`

const modelDescription = (model: SubagentModelDefinition) => `- ${model.id}: ${model.description}`

const reasoningEffortDescription = (effort: SubagentReasoningEffortDefinition) =>
  `- ${effort.value}: ${effort.description}`

const subagentToolDescription = (
  options: SubagentRuntimeSelectionOptions & {
    readonly subagents: ReadonlyArray<SubagentDefinition>
  }
) =>
  [
    'Launch a new agent to handle complex, multistep tasks autonomously.',
    'Use this when delegating focused work to a specialized subagent would save context or allow parallel exploration.',
    'To run subagents in parallel, call this subagent tool multiple times in the same assistant response.',
    'Yolk runs same-turn subagent calls concurrently automatically.',
    'A fresh subagent only sees the prompt you provide, so include all required context.',
    'Subagents can use their normal tools but cannot launch further subagents in v1.',
    options.subagents.length === 0
      ? 'No subagent types are currently available.'
      : `Available subagent types:\n${options.subagents.map(subagentDescription).join('\n')}`,
    options.models === undefined || options.models.length === 0
      ? undefined
      : [
          'Available subagent models:',
          options.models.map(modelDescription).join('\n'),
          'Omit model to inherit the host runtime model.'
        ].join('\n'),
    options.reasoningEfforts === undefined || options.reasoningEfforts.length === 0
      ? undefined
      : [
          'Available subagent reasoning efforts:',
          options.reasoningEfforts.map(reasoningEffortDescription).join('\n'),
          'Omit reasoning_effort to inherit the host runtime effort.'
        ].join('\n')
  ]
    .filter(section => section !== undefined)
    .join('\n\n')

export const makeSubagentToolRegistration = <Context>(
  options: SubagentToolOptions<Context>
): ToolRegistration<Context> =>
  makeTool({
    name: subagentToolName,
    description: subagentToolDescription(options),
    parameters: configuredSubagentToolParams(options),
    access: 'read',
    isEnabled: options.isEnabled,
    invalidParamsMessage: error =>
      `Invalid subagent arguments: ${error instanceof Error ? error.message : String(error)}`,
    execute: ({ call, context, params }) =>
      Effect.gen(function* () {
        if (call.name !== subagentToolName) {
          return yield* Effect.fail(
            subagentToolError(`Tool is not configured: ${call.name}`, 'not_found')
          )
        }

        const normalizedParams = yield* validateSubagentParams(params)
        yield* requireKnownSubagent(options.subagents, normalizedParams.subagent_type)

        return yield* options.execute({ call, context, params: normalizedParams })
      })
  })

export const makeSubagentToolDef = (
  subagents: ReadonlyArray<SubagentDefinition>,
  runtimeSelections: SubagentRuntimeSelectionOptions = {}
) =>
  makeSubagentToolRegistration({
    subagents,
    ...runtimeSelections,
    execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: '' }))
  }).def

export const makeSubagentToolModule = <Context>(
  options: SubagentToolOptions<Context>
): ToolModule<Context> => ({
  id: subagentToolName,
  tools: [makeSubagentToolRegistration(options)]
})

export const makeNonRecursiveSubagentToolModule = <Context extends SubagentContext>(
  options: SubagentToolOptions<Context>
): ToolModule<Context> =>
  makeSubagentToolModule({
    ...options,
    isEnabled: context =>
      context.subagent === true
        ? Effect.succeed(false)
        : options.isEnabled === undefined
          ? Effect.succeed(true)
          : options.isEnabled(context)
  })

export const formatSubagentResult = (output: string) =>
  ['<subagent_result>', output, '</subagent_result>'].join('\n')

export const subagentToolRunId = makeSubagentRunId

const latestAssistantText = (messages: ReadonlyArray<AgentMessage>) => {
  const assistant = [...messages]
    .reverse()
    .find(message => Predicate.isTagged(message, 'Assistant'))

  return assistant === undefined ? '' : contentText(assistantContent(assistant))
}

const subagentProviderMetadata = (provider: ProviderErrorInfo): SubagentProviderMetadataFields => {
  const metadata: SubagentProviderMetadataFields = {
    provider: provider.provider,
    kind: provider.kind
  }

  if (provider.status !== undefined) {
    metadata.status = provider.status
  }

  if (provider.providerCode !== undefined) {
    metadata.provider_code = provider.providerCode
  }

  if (provider.retryAfterMs !== undefined) {
    metadata.retry_after_ms = provider.retryAfterMs
  }

  return metadata
}

const subagentUsageInputMetadata = (usage: AgentUsage): SubagentUsageInputMetadataFields => {
  const input: SubagentUsageInputMetadataFields = {
    total: usage.input.total
  }

  if (usage.input.uncached !== undefined) {
    input.uncached = usage.input.uncached
  }

  if (usage.input.cacheRead !== undefined) {
    input.cache_read = usage.input.cacheRead
  }

  if (usage.input.cacheWrite !== undefined) {
    input.cache_write = usage.input.cacheWrite
  }

  return input
}

const subagentUsageOutputMetadata = (usage: AgentUsage): SubagentUsageOutputMetadataFields => {
  const output: SubagentUsageOutputMetadataFields = {
    total: usage.output.total
  }

  if (usage.output.text !== undefined) {
    output.text = usage.output.text
  }

  if (usage.output.reasoning !== undefined) {
    output.reasoning = usage.output.reasoning
  }

  return output
}

const subagentUsageMetadata = (usage: AgentUsage): SubagentUsageMetadataFields => ({
  input: subagentUsageInputMetadata(usage),
  output: subagentUsageOutputMetadata(usage)
})

const subagentErrorMetadata = (error: SubagentRunError): SubagentErrorMetadataFields => {
  const metadata: SubagentErrorMetadataFields = {
    code: error.code,
    message: error.message,
    retryable: error.retryable
  }

  if (error.provider !== undefined) {
    metadata.provider = subagentProviderMetadata(error.provider)
  }

  return metadata
}

const SubagentUsageMetadata = Schema.Struct({
  input: Schema.Struct({
    total: Schema.Number,
    uncached: Schema.optional(Schema.Number),
    cache_read: Schema.optional(Schema.Number),
    cache_write: Schema.optional(Schema.Number)
  }),
  output: Schema.Struct({
    total: Schema.Number,
    text: Schema.optional(Schema.Number),
    reasoning: Schema.optional(Schema.Number)
  })
})

const SubagentStructuredUsage = Schema.Struct({
  subagent_run_id: Schema.String,
  subagent_type: Schema.String,
  usage: SubagentUsageMetadata
})

const subagentAgentInputUsageFromMetadata = (
  usage: SubagentUsageMetadataFields
): SubagentAgentInputUsageFields => {
  const input: SubagentAgentInputUsageFields = {
    total: usage.input.total
  }

  if (usage.input.uncached !== undefined) {
    input.uncached = usage.input.uncached
  }

  if (usage.input.cache_read !== undefined) {
    input.cacheRead = usage.input.cache_read
  }

  if (usage.input.cache_write !== undefined) {
    input.cacheWrite = usage.input.cache_write
  }

  return input
}

const subagentAgentOutputUsageFromMetadata = (
  usage: SubagentUsageMetadataFields
): SubagentAgentOutputUsageFields => {
  const output: SubagentAgentOutputUsageFields = {
    total: usage.output.total
  }

  if (usage.output.text !== undefined) {
    output.text = usage.output.text
  }

  if (usage.output.reasoning !== undefined) {
    output.reasoning = usage.output.reasoning
  }

  return output
}

export const subagentUsageFromToolResult = (result: ToolResult): AgentUsage | undefined => {
  if (
    !Schema.is(SubagentStructuredUsage)(result.structuredContent) ||
    result.structuredContent.subagent_run_id !== subagentToolRunId(result.toolCallId)
  ) {
    return undefined
  }

  const usage = result.structuredContent.usage

  return AgentUsage.make({
    input: subagentAgentInputUsageFromMetadata(usage),
    output: subagentAgentOutputUsageFromMetadata(usage)
  })
}

const subagentRunErrorFromAgentError = (error: SubagentRunError): SubagentRunErrorFields => {
  const result: SubagentRunErrorFields = {
    code: error.code,
    message: error.message,
    retryable: error.retryable
  }

  if (error.provider !== undefined) {
    result.provider = error.provider
  }

  return result
}

export const subagentResultFromEvents = (events: ReadonlyArray<AgentEvent>): SubagentRunResult => {
  const terminal = [...events].reverse().find(isTerminalAgentEvent)
  const usageUpdates = events.filter(event => Predicate.isTagged(event, 'UsageUpdate'))

  const usage = usageUpdates.reduce(
    (total, event) => addAgentUsage(total, event.usage),
    zeroAgentUsage
  )

  const turns = events.reduce(
    (latest, event) =>
      Predicate.isTagged(event, 'TurnStart') ? Math.max(latest, event.turn) : latest,
    0
  )

  if (terminal === undefined) {
    const message = 'Subagent stream ended without a terminal event.'

    const result: SubagentRunResultFields = {
      status: 'error',
      text: `Subagent failed: ${message}`
    }

    if (usageUpdates.length !== 0) {
      result.usage = usage
    }

    if (turns !== 0) {
      result.turns = turns
    }

    result.error = {
      code: 'invalid_response',
      message,
      retryable: false
    }

    return result
  }

  if (Predicate.isTagged(terminal, 'AgentError')) {
    const result: SubagentRunResultFields = {
      status: 'error',
      text: `Subagent failed: ${terminal.message}`
    }

    if (usageUpdates.length !== 0) {
      result.usage = usage
    }

    if (turns !== 0) {
      result.turns = turns
    }

    result.error = subagentRunErrorFromAgentError(terminal)

    return result
  }

  const text = latestAssistantText(terminal.messages).trim()

  const result: SubagentRunResultFields = {
    status: Predicate.isTagged(terminal, 'AgentAwaitingInput') ? 'awaiting_input' : 'completed',
    text: text.length === 0 ? 'Subagent completed without a final text response.' : text,
    usage: terminal.usage,
    turns: terminal.turns
  }

  if (Predicate.isTagged(terminal, 'AgentAwaitingInput')) {
    result.requests = terminal.requests
  }

  return result
}

export const subagentResultText = (events: ReadonlyArray<AgentEvent>) =>
  subagentResultFromEvents(events).text

const subagentToolResultStructuredContent = (
  input: SubagentToolResultInput,
  status: SubagentRunStatus
): SubagentToolResultStructuredContentFields => {
  const structuredContent: SubagentToolResultStructuredContentFields = {
    subagent_run_id: input.subagentRunId,
    subagent_type: input.subagentType,
    description: input.description,
    started_at_ms: input.startedAtMs,
    ended_at_ms: input.endedAtMs,
    duration_ms: Math.max(0, input.endedAtMs - input.startedAtMs),
    status,
    model: input.model
  }

  if (input.reasoningEffort !== undefined) {
    structuredContent.reasoning_effort = input.reasoningEffort
  }

  if (input.usage !== undefined) {
    structuredContent.usage = subagentUsageMetadata(input.usage)
  }

  if (input.turns !== undefined) {
    structuredContent.turns = input.turns
  }

  if (input.requests !== undefined) {
    structuredContent.hitl_requests = input.requests
  }

  if (input.error !== undefined) {
    structuredContent.error = subagentErrorMetadata(input.error)
  }

  return structuredContent
}

export const makeSubagentToolResult = (input: SubagentToolResultInput) => {
  const isError = input.isError === true || input.error !== undefined || input.status === 'error'
  const status = isError ? 'error' : (input.status ?? 'completed')

  return ToolResult.make({
    toolCallId: input.callId,
    content: formatSubagentResult(input.output),
    isError: isError ? true : undefined,
    structuredContent: subagentToolResultStructuredContent(input, status)
  })
}

const subagentAcceptedStructuredContent = (input: {
  readonly callId: string
  readonly workflowRunId: string
  readonly parentRunId?: string
}): SubagentAcceptedStructuredContentFields => {
  const structuredContent: SubagentAcceptedStructuredContentFields = {
    type: 'subagent_accepted',
    status: 'accepted',
    subagent_run_id: makeSubagentRunId(input.callId),
    workflow_run_id: input.workflowRunId
  }

  if (input.parentRunId !== undefined) {
    structuredContent.parent_run_id = input.parentRunId
  }

  return structuredContent
}

/** Acceptance is a tool completion, never a child completion or usage delta. */
export const makeSubagentAcceptedToolResult = (input: {
  readonly callId: string
  readonly workflowRunId: string
  readonly parentRunId?: string
}) =>
  ToolResult.make({
    toolCallId: input.callId,
    content: `Subagent accepted. Use subagent_status or subagent_wait with tool_call_id=${input.callId}${input.parentRunId === undefined ? '' : ` and parent_run_id=${input.parentRunId}`}.`,
    structuredContent: subagentAcceptedStructuredContent(input)
  })
