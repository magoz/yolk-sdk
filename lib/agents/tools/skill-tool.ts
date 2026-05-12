import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk/agent-loop'
import { ToolDef, ToolResult } from '@yolk/protocol'
import type { ToolModule, ToolRegistration } from '@yolk/tool-registry'
import type { SkillInfo } from '@yolk/skillset'
import type { AgentToolContext } from './tool-context'

const skillToolName = 'skill'

const SkillParams = Schema.Struct({
  name: Schema.String
})

const skillParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: {
      type: 'string',
      description: 'The name of the skill from available_skills.'
    }
  },
  required: ['name']
}

const skillToolDef = ToolDef.make({
  name: skillToolName,
  description: [
    'Load a specialized skill when the task matches one of the skills listed in the system prompt.',
    'Use this tool to inject skill instructions into the conversation.'
  ].join(' '),
  parameters: skillParameters
})

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const makeToolError = (message: string, cause: ToolError['cause']) =>
  new ToolError({
    tool: skillToolName,
    message,
    cause
  })

const decodeSkillParams = (params: unknown) =>
  Schema.decodeUnknownEffect(SkillParams)(params).pipe(
    Effect.mapError(error => makeToolError(`Invalid skill arguments: ${unknownToMessage(error)}`, 'validation'))
  )

const findSkill = (skills: ReadonlyArray<SkillInfo>, name: string) =>
  skills.find(skill => skill.name === name)

const formatSkillContent = (skill: SkillInfo) =>
  [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    '',
    skill.content.trim(),
    '',
    `<skill_location>${skill.location}</skill_location>`,
    '</skill_content>'
  ].join('\n')

const skillTool: ToolRegistration<AgentToolContext> = {
  def: skillToolDef,
  access: 'read',
  isEnabled: context =>
    Effect.succeed(
      context.surface === 'text' &&
        context.skillset !== undefined &&
        context.skillset.skills.length > 0
    ),
  execute: ({ call, context }) =>
    Effect.gen(function* () {
      const params = yield* decodeSkillParams(call.params)
      const skillset = context.skillset

      if (skillset === undefined) {
        return yield* Effect.fail(makeToolError('Skills are not configured.', 'not_found'))
      }

      const skill = findSkill(skillset.skills, params.name)

      if (skill === undefined) {
        return yield* Effect.fail(makeToolError(`Skill not found: ${params.name}`, 'not_found'))
      }

      return ToolResult.make({
        toolCallId: call.id,
        content: formatSkillContent(skill)
      })
    })
}

export const skillToolModule: ToolModule<AgentToolContext> = {
  id: 'skillset',
  tools: [skillTool]
}
