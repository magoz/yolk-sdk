import { Effect } from 'effect'
import { SkillsetError } from './errors.ts'

const skillsetNamePattern = /^[a-z0-9]+(-[a-z0-9]+)*$/
const maxSkillsetNameLength = 64

export const isValidSkillsetName = (name: string) =>
  name.length > 0 && name.length <= maxSkillsetNameLength && skillsetNamePattern.test(name)

export const validateSkillsetName = (name: string) =>
  isValidSkillsetName(name)
    ? Effect.succeed(name)
    : Effect.fail(
        new SkillsetError({
          cause: 'invalid_name',
          message: `Invalid skillset entry name: ${name}`
        })
      )

export const validateDirectoryName = (expected: string, actual: string) =>
  expected === actual
    ? Effect.succeed(expected)
    : Effect.fail(
        new SkillsetError({
          cause: 'name_mismatch',
          message: `Skill name must match directory name: expected ${expected}, got ${actual}`
        })
      )
