import { describe, expect, it } from '@effect/vitest'
import { agentRowsToManifest, agentSkillRowsToManifest } from './db-source'

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

describe('agentRowsToManifest', () => {
  it('converts DB command rows to portable command manifest entries', () => {
    const manifest = agentRowsToManifest([], [
      {
        id: 'command_1',
        name: 'review',
        description: 'Review current work',
        template: 'Review: $ARGUMENTS'
      }
    ])

    expect(manifest).toEqual({
      version: 1,
      skills: [],
      commands: [
        {
          name: 'review',
          description: 'Review current work',
          template: 'Review: $ARGUMENTS',
          hints: ['$ARGUMENTS'],
          location: 'db:agentCommand:command_1',
          source: 'db'
        }
      ]
    })
  })
})
