import { ConfigProvider, Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall } from '@yolk/protocol'
import { join } from 'node:path'
import { resolveAgentTools } from './registry'

const stdioFixturePath = join(process.cwd(), 'packages/mcp/test/fixtures/fake-stdio-mcp-server.mjs')

const withMcpConfig = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.provide(
    effect,
    ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: {
          YOLK_MCP_LOCAL_ENABLED: 'true',
          YOLK_MCP_SERVERS: JSON.stringify([
            {
              name: 'local',
              type: 'local',
              command: [process.execPath, stdioFixturePath]
            }
          ])
        }
      })
    )
  )

describe('MCP tool module', () => {
  it.effect('adds configured MCP tools to text agents only', () =>
    withMcpConfig(
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

        expect(textTools.tools.map(tool => tool.name)).toContain('local_echo')
        expect(voiceTools.tools.map(tool => tool.name)).not.toContain('local_echo')
      })
    )
  )

  it.effect('executes configured MCP tools through the registry', () =>
    withMcpConfig(
      Effect.gen(function* () {
        const textTools = yield* resolveAgentTools({
          surface: 'text',
          route: '/agent',
          userId: 'user_1'
        })

        const result = yield* textTools.execute(
          ToolCall.make({ id: 'call_1', name: 'local_echo', params: { text: 'hello' } })
        )

        expect(result.toolCallId).toBe('call_1')
        expect(result.content).toBe('local result')
      })
    )
  )
})
