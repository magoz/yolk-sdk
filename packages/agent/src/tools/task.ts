import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk/agent/loop'
import { ToolResult, type ToolCall } from '@yolk/agent/protocol'
import { makeTool, type ToolModule, type ToolRegistration } from './registry.ts'

export const taskToolName = 'task'

const TaskToolParams = Schema.Struct({
  description: Schema.String.pipe(Schema.annotate({ description: 'A short 3-5 word description of the task.' })),
  prompt: Schema.String.pipe(
    Schema.annotate({
      description: 'The complete task instructions for the subagent, including all context it needs.'
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

export type TaskExecutionInput<Context> = {
  readonly call: ToolCall
  readonly context: Context
  readonly params: TaskToolParams
}

export type TaskToolOptions<Context> = {
  readonly subagents: ReadonlyArray<TaskSubagentDefinition>
  readonly execute: (input: TaskExecutionInput<Context>) => Effect.Effect<ToolResult, ToolError>
}

const taskToolError = (message: string, cause: ToolError['cause']) =>
  new ToolError({
    tool: taskToolName,
    message,
    cause
  })

const trimmedTaskParams = (params: TaskToolParams) => ({
  description: params.description.trim(),
  prompt: params.prompt.trim(),
  subagent_type: params.subagent_type.trim()
})

const validateTaskParams = (params: TaskToolParams) => {
  const trimmed = trimmedTaskParams(params)

  if (trimmed.description.length === 0) {
    return Effect.fail(taskToolError('description must not be empty', 'validation'))
  }

  if (trimmed.prompt.length === 0) {
    return Effect.fail(taskToolError('prompt must not be empty', 'validation'))
  }

  if (trimmed.subagent_type.length === 0) {
    return Effect.fail(taskToolError('subagent_type must not be empty', 'validation'))
  }

  return Effect.succeed(trimmed)
}

const findSubagent = (subagents: ReadonlyArray<TaskSubagentDefinition>, name: string) =>
  subagents.find(subagent => subagent.name === name)

const requireKnownSubagent = (
  subagents: ReadonlyArray<TaskSubagentDefinition>,
  name: string
) => {
  const subagent = findSubagent(subagents, name)

  return subagent === undefined
    ? Effect.fail(taskToolError(`Unknown subagent type: ${name}`, 'validation'))
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
): ToolRegistration<Context> => makeTool({
  name: taskToolName,
  description: taskToolDescription(options.subagents),
  parameters: TaskToolParams,
  access: 'read',
  invalidParamsMessage: error => `Invalid task arguments: ${error instanceof Error ? error.message : String(error)}`,
  execute: ({ call, context, params }) =>
    Effect.gen(function* () {
      if (call.name !== taskToolName) {
        return yield* Effect.fail(taskToolError(`Tool is not configured: ${call.name}`, 'not_found'))
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

export const makeTaskToolModule = <Context>(options: TaskToolOptions<Context>): ToolModule<Context> => ({
  id: 'task',
  tools: [makeTaskToolRegistration(options)]
})

export const formatTaskResult = (output: string) => ['<task_result>', output, '</task_result>'].join('\n')
