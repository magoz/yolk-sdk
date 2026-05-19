import { describe, expect, it } from '@effect/vitest'
import { Schema } from 'effect'
import { SkillsetManifest } from '@yolk-sdk/skillset'
import { generatedSkillsetManifest } from '../src/generated/skillset.ts'

describe('generated skillset manifest', () => {
  it.effect('matches manifest schema', () =>
    Schema.decodeUnknownEffect(SkillsetManifest)(generatedSkillsetManifest)
  )

  it('uses portable locations', () => {
    for (const skill of generatedSkillsetManifest.skills) {
      expect(skill.location?.startsWith('/')).toBe(false)
    }

    for (const command of generatedSkillsetManifest.commands) {
      expect(command.location?.startsWith('/')).toBe(false)
    }
  })
})
