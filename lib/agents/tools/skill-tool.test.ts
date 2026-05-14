import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall } from '@yolk/agent/protocol'
import { resolveTools } from '@yolk/agent/tools'
import { skillToolModule } from './skill-tool'

const skillset = {
  skills: [
    {
      name: 'review-code',
      description: 'Review code carefully',
      location: '.opencode/skills/review-code/SKILL.md',
      content: 'Check types and tests.'
    }
  ],
  commands: []
}

describe('skill tool', () => {
  it.effect('is enabled for text skillsets and loads skill content', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools([skillToolModule], {
        surface: 'text',
        route: '/agent',
        userId: 'user_1',
        skillset
      })
      const result = yield* toolSet.execute(
        ToolCall.make({ id: 'call_1', name: 'skill', params: { name: 'review-code' } })
      )

      expect(toolSet.tools.map(tool => tool.name)).toEqual(['skill'])
      expect(result.content).toContain('<skill_content name="review-code">')
      expect(result.content).toContain('Check types and tests.')
    })
  )

  it.effect('is disabled for voice', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools([skillToolModule], {
        surface: 'voice',
        route: '/agent',
        userId: 'user_1',
        skillset
      })

      expect(toolSet.tools).toEqual([])
    })
  )

  it.effect('fails missing skills as not found', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveTools([skillToolModule], {
        surface: 'text',
        route: '/agent',
        userId: 'user_1',
        skillset
      })
      const result = yield* toolSet
        .execute(ToolCall.make({ id: 'call_1', name: 'skill', params: { name: 'missing' } }))
        .pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ToolError', cause: 'not_found' }
      })
    })
  )
})
