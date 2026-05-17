import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolError } from '@yolk/agent/loop'
import { ToolResult } from '@yolk/agent/protocol'
import { makeTool, type ToolModule, type ToolRegistration } from '@yolk/agent/tools'
import type { SkillInfo } from '@yolk/skillset'
import type { AgentToolContext } from './tool-context.ts'

const skillToolName = 'skill'

const SkillParams = Schema.Struct({
  name: Schema.String.pipe(
    Schema.annotate({ description: 'The name of the skill from available_skills.' })
  )
})

const skillToolDescription = [
  'Load a specialized skill when the task matches one of the skills listed in the system prompt.',
  'Use this tool to inject skill instructions into the conversation.'
].join(' ')

const makeToolError = (message: string, cause: ToolError['cause']) =>
  new ToolError({
    tool: skillToolName,
    message,
    cause
  })

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

const skillTool: ToolRegistration<AgentToolContext> = makeTool({
  name: skillToolName,
  description: skillToolDescription,
  parameters: SkillParams,
  access: 'read',
  isEnabled: context =>
    Effect.succeed(
      context.surface === 'text' &&
        context.skillset !== undefined &&
        context.skillset.skills.length > 0
    ),
  invalidParamsMessage: error => `Invalid skill arguments: ${error instanceof Error ? error.message : String(error)}`,
  execute: ({ call, context, params }) =>
    Effect.gen(function* () {
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
})

export const skillToolModule: ToolModule<AgentToolContext> = {
  id: 'skillset',
  tools: [skillTool]
}
