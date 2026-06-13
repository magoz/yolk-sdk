import * as Schema from 'effect/Schema'
import { CommandInfo } from './command.ts'
import { SkillInfo } from './skill.ts'

export const SkillsetManifest = Schema.Struct({
  version: Schema.Literal(1),
  skills: Schema.Array(SkillInfo),
  commands: Schema.Array(CommandInfo)
})
export type SkillsetManifest = typeof SkillsetManifest.Type

export const emptySkillsetManifest: SkillsetManifest = {
  version: 1,
  skills: [],
  commands: []
}
