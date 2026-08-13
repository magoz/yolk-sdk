import { Effect } from 'effect'
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
import {
  makeTool,
  modelVisibleToolError,
  type ModelVisibleToolError,
  type ToolModule,
  type ToolRegistration,
  type ToolRegistryError
} from './registry.ts'

export const subagentToolName = 'subagent'

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
    return Schema.Struct({
      ...SubagentToolBaseFields,
      model,
      reasoning_effort: reasoningEffort
    })
  }

  if (model !== undefined) {
    return Schema.Struct({ ...SubagentToolBaseFields, model })
  }

  if (reasoningEffort !== undefined) {
    return Schema.Struct({ ...SubagentToolBaseFields, reasoning_effort: reasoningEffort })
  }

  return Schema.Struct(SubagentToolBaseFields)
}

const trimmedSubagentParams = (params: SubagentToolParams): SubagentToolParams => ({
  description: params.description.trim(),
  prompt: params.prompt.trim(),
  subagent_type: params.subagent_type.trim(),
  ...(params.model === undefined ? {} : { model: params.model }),
  ...(params.reasoning_effort === undefined ? {} : { reasoning_effort: params.reasoning_effort })
})

const validateSubagentParams = (
  params: SubagentToolParams
): Effect.Effect<
  {
    readonly description: string
    readonly prompt: string
    readonly subagent_type: string
  },
  ModelVisibleToolError
> => {
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
  id: 'subagent',
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
  const assistant = [...messages].reverse().find(message => message._tag === 'Assistant')

  return assistant === undefined ? '' : contentText(assistantContent(assistant))
}

const subagentProviderMetadata = (provider: ProviderErrorInfo) => ({
  provider: provider.provider,
  kind: provider.kind,
  ...(provider.status === undefined ? {} : { status: provider.status }),
  ...(provider.providerCode === undefined ? {} : { provider_code: provider.providerCode }),
  ...(provider.retryAfterMs === undefined ? {} : { retry_after_ms: provider.retryAfterMs })
})

const subagentUsageMetadata = (usage: AgentUsage) => ({
  input: {
    total: usage.input.total,
    ...(usage.input.uncached === undefined ? {} : { uncached: usage.input.uncached }),
    ...(usage.input.cacheRead === undefined ? {} : { cache_read: usage.input.cacheRead }),
    ...(usage.input.cacheWrite === undefined ? {} : { cache_write: usage.input.cacheWrite })
  },
  output: {
    total: usage.output.total,
    ...(usage.output.text === undefined ? {} : { text: usage.output.text }),
    ...(usage.output.reasoning === undefined ? {} : { reasoning: usage.output.reasoning })
  }
})

const subagentErrorMetadata = (error: SubagentRunError) => ({
  code: error.code,
  message: error.message,
  retryable: error.retryable,
  ...(error.provider === undefined ? {} : { provider: subagentProviderMetadata(error.provider) })
})

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

export const subagentUsageFromToolResult = (result: ToolResult): AgentUsage | undefined => {
  if (
    !Schema.is(SubagentStructuredUsage)(result.structuredContent) ||
    result.structuredContent.subagent_run_id !== subagentToolRunId(result.toolCallId)
  ) {
    return undefined
  }

  const usage = result.structuredContent.usage

  return AgentUsage.make({
    input: {
      total: usage.input.total,
      ...(usage.input.uncached === undefined ? {} : { uncached: usage.input.uncached }),
      ...(usage.input.cache_read === undefined ? {} : { cacheRead: usage.input.cache_read }),
      ...(usage.input.cache_write === undefined ? {} : { cacheWrite: usage.input.cache_write })
    },
    output: {
      total: usage.output.total,
      ...(usage.output.text === undefined ? {} : { text: usage.output.text }),
      ...(usage.output.reasoning === undefined ? {} : { reasoning: usage.output.reasoning })
    }
  })
}

export const subagentResultFromEvents = (events: ReadonlyArray<AgentEvent>): SubagentRunResult => {
  const terminal = [...events].reverse().find(isTerminalAgentEvent)

  if (terminal?._tag === 'AgentError') {
    const usageUpdates = events.filter(event => event._tag === 'UsageUpdate')
    const usage = usageUpdates.reduce(
      (total, event) => addAgentUsage(total, event.usage),
      zeroAgentUsage
    )
    const turns = events.reduce(
      (latest, event) => (event._tag === 'TurnStart' ? Math.max(latest, event.turn) : latest),
      0
    )

    return {
      status: 'error',
      text: `Subagent failed: ${terminal.message}`,
      ...(usageUpdates.length === 0 ? {} : { usage }),
      ...(turns === 0 ? {} : { turns }),
      error: {
        code: terminal.code,
        message: terminal.message,
        retryable: terminal.retryable,
        ...(terminal.provider === undefined ? {} : { provider: terminal.provider })
      }
    }
  }

  const messages = terminal?.messages ?? []
  const text = latestAssistantText(messages).trim()

  return {
    status: terminal?._tag === 'AgentAwaitingInput' ? 'awaiting_input' : 'completed',
    text: text.length === 0 ? 'Subagent completed without a final text response.' : text,
    ...(terminal === undefined ? {} : { usage: terminal.usage, turns: terminal.turns }),
    ...(terminal?._tag === 'AgentAwaitingInput' ? { requests: terminal.requests } : {})
  }
}

export const subagentResultText = (events: ReadonlyArray<AgentEvent>) =>
  subagentResultFromEvents(events).text

export const makeSubagentToolResult = (input: SubagentToolResultInput) => {
  const isError = input.isError === true || input.error !== undefined || input.status === 'error'
  const status = isError ? 'error' : (input.status ?? 'completed')

  return ToolResult.make({
    toolCallId: input.callId,
    content: formatSubagentResult(input.output),
    isError: isError ? true : undefined,
    structuredContent: {
      subagent_run_id: input.subagentRunId,
      subagent_type: input.subagentType,
      description: input.description,
      started_at_ms: input.startedAtMs,
      ended_at_ms: input.endedAtMs,
      duration_ms: Math.max(0, input.endedAtMs - input.startedAtMs),
      status,
      model: input.model,
      ...(input.reasoningEffort === undefined ? {} : { reasoning_effort: input.reasoningEffort }),
      ...(input.usage === undefined ? {} : { usage: subagentUsageMetadata(input.usage) }),
      ...(input.turns === undefined ? {} : { turns: input.turns }),
      ...(input.requests === undefined ? {} : { hitl_requests: input.requests }),
      ...(input.error === undefined ? {} : { error: subagentErrorMetadata(input.error) })
    }
  })
}
