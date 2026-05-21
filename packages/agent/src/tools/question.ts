import { Effect } from 'effect'
import { ToolError } from '@yolk-sdk/agent/loop'
import { QuestionToolParams, ToolResult, type ToolCall } from '@yolk-sdk/agent/protocol'
import { makeTool, type ToolModule, type ToolRegistration } from './registry.ts'

export const questionToolName = 'question'

export type QuestionExecutionInput<Context> = {
  readonly call: ToolCall
  readonly context: Context
  readonly params: QuestionToolParams
}

export type QuestionToolOptions<Context> = {
  readonly execute: (input: QuestionExecutionInput<Context>) => Effect.Effect<ToolResult, ToolError>
}

const questionToolError = (message: string, cause: ToolError['cause']) =>
  new ToolError({
    tool: questionToolName,
    message,
    cause
  })

const questionToolDescription = [
  'Ask the user one or more structured questions and wait for their response.',
  'Use this when you need explicit user input before continuing.',
  'Each question has a stable id, prompt, optional options, and optional custom-answer support.',
  'Yolk returns user answers as structured tool output.'
].join('\n\n')

export const makeQuestionToolRegistration = <Context>(
  options: QuestionToolOptions<Context>
): ToolRegistration<Context> =>
  makeTool({
    name: questionToolName,
    description: questionToolDescription,
    parameters: QuestionToolParams,
    access: 'read',
    invalidParamsMessage: error =>
      `Invalid question arguments: ${error instanceof Error ? error.message : String(error)}`,
    execute: ({ call, context, params }) =>
      call.name === questionToolName
        ? options.execute({ call, context, params })
        : Effect.fail(questionToolError(`Tool is not configured: ${call.name}`, 'not_found'))
  })

export const makeQuestionToolDef = () =>
  makeQuestionToolRegistration({
    execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: '' }))
  }).def

export const makeQuestionToolModule = <Context>(
  options: QuestionToolOptions<Context>
): ToolModule<Context> => ({
  id: 'question',
  tools: [makeQuestionToolRegistration(options)]
})
