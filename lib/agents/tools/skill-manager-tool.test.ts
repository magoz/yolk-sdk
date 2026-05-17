import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall } from '@yolk/agent/protocol'
import { resolveTools } from '@yolk/agent/tools'
import { makeSkillManagerToolModule, type SkillManagerAction } from './skill-manager-tool'
import type { AgentToolContext } from './tool-context'

const context = {
  surface: 'text',
  route: '/agent',
  userId: 'user_1'
} satisfies AgentToolContext

describe('skill manager tool', () => {
  it.effect('treats nullable optional fields as omitted', () =>
    Effect.gen(function* () {
      let handled: SkillManagerAction | undefined
      const toolSet = yield* resolveTools(
        [
          makeSkillManagerToolModule(action => {
            handled = action

            return Effect.succeed({ message: 'Created skill: Weather', data: { ok: true } })
          })
        ],
        context
      )
      const result = yield* toolSet.execute(
        ToolCall.make({
          id: 'call_1',
          name: 'manage_skills',
          params: {
            action: 'create',
            id: null,
            name: 'Weather',
            description: 'Check weather by web search.',
            content: 'Use web_search for weather requests.',
            enabled: null,
            createCommand: null,
            commandName: null
          }
        })
      )

      expect(result.content).toBe('Created skill: Weather')
      expect(handled).toEqual({
        _tag: 'Create',
        userId: 'user_1',
        name: 'Weather',
        description: 'Check weather by web search.',
        content: 'Use web_search for weather requests.',
        createCommand: true,
        commandName: undefined
      })
    })
  )
})
