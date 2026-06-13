import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolResult } from '@yolk-sdk/agent/protocol'
import {
  makeTool,
  modelVisibleToolError,
  type ToolModule,
  type ToolRegistration
} from '@yolk-sdk/agent/tools'
import type { SkillInfo } from '@yolk-sdk/agent/skillset'
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

const missingSkillContent = (name: string, skills: ReadonlyArray<SkillInfo>) => {
  const availableNames = skills.map(skill => skill.name).toSorted((a, b) => a.localeCompare(b))

  if (availableNames.length === 0) {
    return `Skill not found: ${name}. No skills are available.`
  }

  return `Skill not found: ${name}. Available skills: ${availableNames.join(', ')}.`
}

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
        return yield* Effect.fail(modelVisibleToolError({
          tool: skillToolName,
          message: 'Skills are not configured.',
          reason: 'not_found'
        }))
      }

      const skill = findSkill(skillset.skills, params.name)

      if (skill === undefined) {
        return yield* Effect.fail(modelVisibleToolError({
          tool: skillToolName,
          message: missingSkillContent(params.name, skillset.skills),
          reason: 'not_found'
        }))
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
