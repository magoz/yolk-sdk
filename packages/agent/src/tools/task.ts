import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk-sdk/agent/loop'
import {
  assistantContent,
  contentText,
  makeSubagentRunId,
  ToolResult,
  type AgentEvent,
  type AgentMessage,
  type ToolCall
} from '@yolk-sdk/agent/protocol'
import {
  makeTool,
  modelVisibleToolError,
  type ModelVisibleToolError,
  type ToolModule,
  type ToolRegistration,
  type ToolRegistryError
} from './registry.ts'

export const taskToolName = 'task'

const TaskToolParams = Schema.Struct({
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
})

export type TaskToolParams = typeof TaskToolParams.Type

export type TaskSubagentDefinition = {
  readonly name: string
  readonly description: string
}

export type TaskSubagentContext = {
  readonly subagent?: boolean
}

export type TaskExecutionInput<Context> = {
  readonly call: ToolCall
  readonly context: Context
  readonly params: TaskToolParams
}

export type TaskToolOptions<Context> = {
  readonly subagents: ReadonlyArray<TaskSubagentDefinition>
  readonly isEnabled?: (context: Context) => Effect.Effect<boolean, ToolRegistryError>
  readonly execute: (input: TaskExecutionInput<Context>) => Effect.Effect<ToolResult, ToolError>
}

export type TaskToolResultInput = {
  readonly callId: string
  readonly output: string
  readonly subagentType: string
  readonly description: string
  readonly subagentRunId: string
  readonly startedAtMs: number
  readonly endedAtMs: number
  readonly model: string
  readonly isError?: boolean
}

const taskToolError = (message: string, cause: ToolError['cause']) =>
  new ToolError({
    tool: taskToolName,
    message,
    cause
  })

const taskModelVisibleError = (message: string) =>
  modelVisibleToolError({
    tool: taskToolName,
    message,
    reason: 'validation'
  })

const trimmedTaskParams = (params: TaskToolParams) => ({
  description: params.description.trim(),
  prompt: params.prompt.trim(),
  subagent_type: params.subagent_type.trim()
})

const validateTaskParams = (
  params: TaskToolParams
): Effect.Effect<
  {
    readonly description: string
    readonly prompt: string
    readonly subagent_type: string
  },
  ModelVisibleToolError
> => {
  const trimmed = trimmedTaskParams(params)

  if (trimmed.description.length === 0) {
    return Effect.fail(taskModelVisibleError('description must not be empty'))
  }

  if (trimmed.prompt.length === 0) {
    return Effect.fail(taskModelVisibleError('prompt must not be empty'))
  }

  if (trimmed.subagent_type.length === 0) {
    return Effect.fail(taskModelVisibleError('subagent_type must not be empty'))
  }

  return Effect.succeed(trimmed)
}

const findSubagent = (subagents: ReadonlyArray<TaskSubagentDefinition>, name: string) =>
  subagents.find(subagent => subagent.name === name)

const requireKnownSubagent = (
  subagents: ReadonlyArray<TaskSubagentDefinition>,
  name: string
): Effect.Effect<TaskSubagentDefinition, ModelVisibleToolError> => {
  const subagent = findSubagent(subagents, name)

  return subagent === undefined
    ? Effect.fail(taskModelVisibleError(`Unknown subagent type: ${name}`))
    : Effect.succeed(subagent)
}

const subagentDescription = (subagent: TaskSubagentDefinition) =>
  `- ${subagent.name}: ${subagent.description}`

const taskToolDescription = (subagents: ReadonlyArray<TaskSubagentDefinition>) =>
  [
    'Launch a new agent to handle complex, multistep tasks autonomously.',
    'Use this when delegating focused work to a specialized subagent would save context or allow parallel exploration.',
    'To run subagents in parallel, call this task tool multiple times in the same assistant response.',
    'Yolk runs same-turn task calls concurrently automatically.',
    'A fresh subagent only sees the prompt you provide, so include all required context.',
    'Subagents can use their normal tools but cannot launch further task subagents in v1.',
    subagents.length === 0
      ? 'No subagent types are currently available.'
      : `Available subagent types:\n${subagents.map(subagentDescription).join('\n')}`
  ].join('\n\n')

export const makeTaskToolRegistration = <Context>(
  options: TaskToolOptions<Context>
): ToolRegistration<Context> =>
  makeTool({
    name: taskToolName,
    description: taskToolDescription(options.subagents),
    parameters: TaskToolParams,
    access: 'read',
    isEnabled: options.isEnabled,
    invalidParamsMessage: error =>
      `Invalid task arguments: ${error instanceof Error ? error.message : String(error)}`,
    execute: ({ call, context, params }) =>
      Effect.gen(function* () {
        if (call.name !== taskToolName) {
          return yield* Effect.fail(
            taskToolError(`Tool is not configured: ${call.name}`, 'not_found')
          )
        }

        const normalizedParams = yield* validateTaskParams(params)
        yield* requireKnownSubagent(options.subagents, normalizedParams.subagent_type)

        return yield* options.execute({ call, context, params: normalizedParams })
      })
  })

export const makeTaskToolDef = (subagents: ReadonlyArray<TaskSubagentDefinition>) =>
  makeTaskToolRegistration({
    subagents,
    execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: '' }))
  }).def

export const makeTaskToolModule = <Context>(
  options: TaskToolOptions<Context>
): ToolModule<Context> => ({
  id: 'task',
  tools: [makeTaskToolRegistration(options)]
})

export const makeNonRecursiveTaskToolModule = <Context extends TaskSubagentContext>(
  options: TaskToolOptions<Context>
): ToolModule<Context> =>
  makeTaskToolModule({
    ...options,
    isEnabled: context =>
      context.subagent === true
        ? Effect.succeed(false)
        : options.isEnabled === undefined
          ? Effect.succeed(true)
          : options.isEnabled(context)
  })

export const formatTaskResult = (output: string) =>
  ['<task_result>', output, '</task_result>'].join('\n')

export const taskSubagentRunId = makeSubagentRunId

const latestAssistantText = (messages: ReadonlyArray<AgentMessage>) => {
  const assistant = [...messages].reverse().find(message => message._tag === 'Assistant')

  return assistant === undefined ? '' : contentText(assistantContent(assistant))
}

export const subagentResultText = (events: ReadonlyArray<AgentEvent>) => {
  const messages = [...events].reverse().find(event => event._tag === 'AgentEnd')?.messages ?? []
  const text = latestAssistantText(messages).trim()

  return text.length === 0 ? 'Subagent completed without a final text response.' : text
}

export const makeTaskToolResult = (input: TaskToolResultInput) =>
  ToolResult.make({
    toolCallId: input.callId,
    content: formatTaskResult(input.output),
    isError: input.isError,
    structuredContent: {
      subagent_run_id: input.subagentRunId,
      subagent_type: input.subagentType,
      description: input.description,
      started_at_ms: input.startedAtMs,
      ended_at_ms: input.endedAtMs,
      duration_ms: Math.max(0, input.endedAtMs - input.startedAtMs),
      status: input.isError === true ? 'error' : 'completed',
      model: input.model
    }
  })
