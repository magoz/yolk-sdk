import { describe, expect, it } from '@effect/vitest'
import { agentSkillRowsToManifest } from './db-source'

describe('agentSkillRowsToManifest', () => {
  it('converts enabled DB skill rows to portable skillset manifest', () => {
    const manifest = agentSkillRowsToManifest([
      {
        id: 'skill_1',
        name: 'review-code',
        description: 'Review code changes',
        content: 'Review the diff for correctness.'
      }
    ])

    expect(manifest).toEqual({
      version: 1,
      skills: [
        {
          name: 'review-code',
          description: 'Review code changes',
          location: 'db:agentSkill:skill_1',
          content: 'Review the diff for correctness.',
          source: 'db'
        }
      ],
      commands: []
    })
  })
})
