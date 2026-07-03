import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import type { ToolError } from '@yolk-sdk/agent/loop'
import { ToolResult } from '@yolk-sdk/agent/protocol'
import { makeTool, modelVisibleToolError, type ToolModule } from '@yolk-sdk/agent/tools'
import type { AgentToolContext } from './tool-context.ts'

const skillManagerToolName = 'manage_skills'

const SkillManagerParams = Schema.Struct({
  action: Schema.Union([
    Schema.Literal('list'),
    Schema.Literal('create'),
    Schema.Literal('update')
  ]).pipe(Schema.annotate({ description: 'Action to perform.' })),
  id: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.annotate({ description: 'Existing skill id for update.' })
  ),
  name: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.annotate({ description: 'Skill name, or existing skill name for update.' })
  ),
  description: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.annotate({ description: 'Short skill description.' })
  ),
  content: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.annotate({ description: 'Full reusable skill instructions.' })
  ),
  enabled: Schema.optional(Schema.NullOr(Schema.Boolean)).pipe(
    Schema.annotate({ description: 'Whether the skill is enabled after update.' })
  ),
  createCommand: Schema.optional(Schema.NullOr(Schema.Boolean)).pipe(
    Schema.annotate({
      description:
        'Whether to create or update a matching slash command. Defaults true for create/update.'
    })
  ),
  commandName: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.annotate({ description: 'Optional slash command name. Defaults to the skill name.' })
  )
})
type SkillManagerParams = typeof SkillManagerParams.Type

export type SkillManagerAction =
  | { readonly _tag: 'List'; readonly userId: string }
  | {
      readonly _tag: 'Create'
      readonly userId: string
      readonly name: string
      readonly description: string
      readonly content: string
      readonly createCommand: boolean
      readonly commandName?: string
    }
  | {
      readonly _tag: 'Update'
      readonly userId: string
      readonly id?: string
      readonly name?: string
      readonly description: string
      readonly content: string
      readonly enabled?: boolean
      readonly createCommand: boolean
      readonly commandName?: string
    }

export type SkillManagerResult = {
  readonly message: string
  readonly data: unknown
}

export type SkillManagerHandler = (
  action: SkillManagerAction
) => Effect.Effect<SkillManagerResult, ToolError>

const skillManagerToolDescription = [
  'Create, update, or list reusable agent skills for the authenticated user.',
  'Use this when the user asks to save instructions, remember a workflow, create a reusable skill, or update existing behavior.',
  'For create/update, provide concise name, description, and full content. By default create/update also creates or updates a matching slash command.'
].join(' ')

const makeModelVisibleError = (message: string) =>
  modelVisibleToolError({
    tool: skillManagerToolName,
    message,
    reason: 'validation'
  })

const requiredText = (params: SkillManagerParams, key: 'name' | 'description' | 'content') => {
  const value = params[key]?.trim()

  return value === undefined || value.length === 0
    ? Effect.fail(makeModelVisibleError(`${key} is required`))
    : Effect.succeed(value)
}

const optionalText = (value: string | null | undefined) => {
  const trimmed = value?.trim()

  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

const optionalBoolean = (value: boolean | null | undefined) => value ?? undefined

const paramsToAction = (params: SkillManagerParams, userId: string) =>
  Effect.gen(function* () {
    switch (params.action) {
      case 'list':
        return { _tag: 'List', userId } satisfies SkillManagerAction
      case 'create': {
        const name = yield* requiredText(params, 'name')
        const description = yield* requiredText(params, 'description')
        const content = yield* requiredText(params, 'content')

        return {
          _tag: 'Create',
          userId,
          name,
          description,
          content,
          createCommand: params.createCommand ?? true,
          commandName: optionalText(params.commandName)
        } satisfies SkillManagerAction
      }
      case 'update': {
        const description = yield* requiredText(params, 'description')
        const content = yield* requiredText(params, 'content')

        return {
          _tag: 'Update',
          userId,
          id: optionalText(params.id),
          name: optionalText(params.name),
          description,
          content,
          enabled: optionalBoolean(params.enabled),
          createCommand: params.createCommand ?? true,
          commandName: optionalText(params.commandName)
        } satisfies SkillManagerAction
      }
    }
  })

export const makeSkillManagerToolModule = (
  manageSkills: SkillManagerHandler
): ToolModule<AgentToolContext> => ({
  id: 'skill-manager',
  tools: [
    makeTool({
      name: skillManagerToolName,
      description: skillManagerToolDescription,
      parameters: SkillManagerParams,
      access: 'write',
      isEnabled: context => Effect.succeed(context.surface === 'text' && context.subagent !== true),
      invalidParamsMessage: error =>
        `Invalid skill manager arguments: ${error instanceof Error ? error.message : String(error)}`,
      execute: ({ call, context, params }) =>
        Effect.gen(function* () {
          const action = yield* paramsToAction(params, context.userId)
          const result = yield* manageSkills(action)

          return ToolResult.make({
            toolCallId: call.id,
            content: result.message,
            structuredContent: result.data
          })
        })
    })
  ]
})
