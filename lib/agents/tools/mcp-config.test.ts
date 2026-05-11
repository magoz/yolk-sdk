import { ConfigProvider, Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { loadMcpSecurityPolicy, loadMcpServerConfigs } from './mcp-config'

const withConfigEnv = <A, E>(effect: Effect.Effect<A, E>, env: Readonly<Record<string, string>>) =>
  Effect.provide(effect, ConfigProvider.layer(ConfigProvider.fromEnv({ env })))

describe('MCP app config', () => {
  it('defaults to no servers and locked-down policy', async () => {
    await expect(Effect.runPromise(withConfigEnv(loadMcpServerConfigs(), {}))).resolves.toEqual([])
    await expect(Effect.runPromise(withConfigEnv(loadMcpSecurityPolicy(), {}))).resolves.toEqual({
      allowLocalServers: false,
      allowDevHttpLocalhost: false
    })
  })

  it('parses remote and local server config from JSON env', async () => {
    const configs = await Effect.runPromise(
      withConfigEnv(loadMcpServerConfigs(), {
        YOLK_MCP_SERVERS: JSON.stringify([
          {
            name: 'docs',
            type: 'remote',
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer token' }
          },
          {
            name: 'local',
            type: 'local',
            command: ['node', 'server.js'],
            environment: { API_KEY: 'secret' }
          }
        ])
      })
    )

    expect(configs).toEqual([
      {
        name: 'docs',
        type: 'remote',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer token' }
      },
      {
        name: 'local',
        type: 'local',
        command: ['node', 'server.js'],
        environment: { API_KEY: 'secret' }
      }
    ])
  })

  it('rejects malformed server config', async () => {
    const result = await Effect.runPromise(
      withConfigEnv(loadMcpServerConfigs().pipe(Effect.result), {
        YOLK_MCP_SERVERS: '[{"name":"bad","type":"remote"}]'
      })
    )
    expect(result._tag).toBe('Failure')
  })

  it('parses explicit security flags', async () => {
    await expect(
      Effect.runPromise(
        withConfigEnv(loadMcpSecurityPolicy(), {
          YOLK_MCP_LOCAL_ENABLED: 'true',
          YOLK_MCP_DEV_HTTP_LOCALHOST: 'true'
        })
      )
    ).resolves.toEqual({
      allowLocalServers: true,
      allowDevHttpLocalhost: true
    })
  })
})
