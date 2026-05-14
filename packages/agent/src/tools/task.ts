import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk/agent/loop'
import { ToolDef, type ToolCall, type ToolResult } from '@yolk/agent/protocol'
import type { ToolModule, ToolRegistration } from './registry.ts'

export const taskToolName = 'task'

const TaskToolParams = Schema.Struct({
  description: Schema.String,
  prompt: Schema.String,
  subagent_type: Schema.String
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

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const taskToolError = (message: string, cause: ToolError['cause']) =>
  new ToolError({
    tool: taskToolName,
    message,
    cause
  })

const decodeTaskParams = (params: unknown) =>
  Schema.decodeUnknownEffect(TaskToolParams)(params).pipe(
    Effect.mapError(error =>
      taskToolError(`Invalid task arguments: ${unknownToMessage(error)}`, 'validation')
    )
  )

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
    'You may call this tool multiple times in one turn to run subagents concurrently.',
    'A fresh subagent only sees the prompt you provide, so include all required context.',
    'Subagents can use their normal tools but cannot launch further task subagents in v1.',
    subagents.length === 0
      ? 'No subagent types are currently available.'
      : `Available subagent types:\n${subagents.map(subagentDescription).join('\n')}`
  ].join('\n\n')

const taskParameters = (subagents: ReadonlyArray<TaskSubagentDefinition>) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    description: {
      type: 'string',
      description: 'A short 3-5 word description of the task.'
    },
    prompt: {
      type: 'string',
      description:
        'The complete task instructions for the subagent, including all context it needs.'
    },
    subagent_type: {
      type: 'string',
      description: 'The specialized subagent type to use for this task.',
      enum: subagents.map(subagent => subagent.name)
    }
  },
  required: ['description', 'prompt', 'subagent_type']
})

export const makeTaskToolDef = (subagents: ReadonlyArray<TaskSubagentDefinition>) =>
  ToolDef.make({
    name: taskToolName,
    description: taskToolDescription(subagents),
    parameters: taskParameters(subagents)
  })

export const makeTaskToolRegistration = <Context>(
  options: TaskToolOptions<Context>
): ToolRegistration<Context> => ({
  def: makeTaskToolDef(options.subagents),
  access: 'read',
  execute: ({ call, context }) =>
    Effect.gen(function* () {
      if (call.name !== taskToolName) {
        return yield* Effect.fail(taskToolError(`Tool is not configured: ${call.name}`, 'not_found'))
      }

      const params = yield* decodeTaskParams(call.params).pipe(Effect.flatMap(validateTaskParams))
      yield* requireKnownSubagent(options.subagents, params.subagent_type)

      return yield* options.execute({ call, context, params })
    })
})

export const makeTaskToolModule = <Context>(options: TaskToolOptions<Context>): ToolModule<Context> => ({
  id: 'task',
  tools: [makeTaskToolRegistration(options)]
})

export const formatTaskResult = (output: string) => ['<task_result>', output, '</task_result>'].join('\n')
