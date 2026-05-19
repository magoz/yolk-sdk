import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall } from '@yolk-sdk/agent/protocol'
import { resolveAgentTools } from './registry'
import { executeJustBashTool } from './just-bash-tool'

describe('just_bash tool', () => {
  it.effect('runs a data-processing script', () =>
    Effect.gen(function* () {
      const result = yield* executeJustBashTool(
        ToolCall.make({
          id: 'call_1',
          name: 'just_bash',
          params: {
            script: `printf '%s' '[{"name":"Ada"},{"name":"Grace"}]' | jq 'length'`
          }
        })
      )

      expect(result.content).toContain('exit_code: 0')
      expect(result.content).toContain('2')
    })
  )

  it.effect('exposes curl for network access', () =>
    Effect.gen(function* () {
      const result = yield* executeJustBashTool(
        ToolCall.make({
          id: 'call_1',
          name: 'just_bash',
          params: { script: 'curl --help | head -1' }
        })
      )

      expect(result.content).toContain('exit_code: 0')
      expect(result.content).toContain('curl')
      expect(result.content).not.toContain('command not found')
    })
  )

  it.effect('enables just_bash for text agents only', () =>
    Effect.gen(function* () {
      const textTools = yield* resolveAgentTools({
        surface: 'text',
        route: '/agent',
        userId: 'user_1'
      })
      const voiceTools = yield* resolveAgentTools({
        surface: 'voice',
        route: '/agent',
        userId: 'user_1'
      })

      expect(textTools.tools.map(tool => tool.name)).toEqual([
        'web_fetch',
        'web_search',
        'just_bash'
      ])
      expect(voiceTools.tools.map(tool => tool.name)).toEqual(['web_fetch', 'web_search'])
    })
  )
})
