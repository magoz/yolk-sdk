import { Effect, Layer } from 'effect'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import type { McpRemoteServerConfig } from '@yolk-sdk/mcp/client'
import {
  resolveAgentToolSet,
  makeTextToolModules
} from '../../../examples/next/lib/agents/tools/registry.ts'
import { makeCloudflareTextToolModules } from '../src/tool-modules.ts'
import { generatedSkillsetManifest } from '../src/generated/skillset.ts'

const context = {
  surface: 'text' as const,
  route: '/agent/cloudflare',
  userId: 'user_1',
  skillset: {
    skills: generatedSkillsetManifest.skills,
    commands: generatedSkillsetManifest.commands
  }
}

const resolvedToolNames = (modulesEffect: ReturnType<typeof makeTextToolModules>) =>
  Effect.gen(function* () {
    const modules = yield* modulesEffect
    const toolSet = yield* resolveAgentToolSet({ modules, context })

    return toolSet.tools.map(tool => tool.name)
  })

const requestMessage = (request: HttpClientRequest.HttpClientRequest) => {
  const body = request.body
  if (body._tag !== 'Uint8Array') {
    return { id: null, method: 'unknown' }
  }

  const value: unknown = JSON.parse(new TextDecoder().decode(body.body))
  if (typeof value !== 'object' || value === null) {
    return { id: null, method: 'unknown' }
  }

  const id = Reflect.get(value, 'id')
  const method = Reflect.get(value, 'method')
  return {
    id: typeof id === 'string' || typeof id === 'number' ? id : null,
    method: typeof method === 'string' ? method : 'unknown'
  }
}

const fakeRemoteMcpLayer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(request => {
    const message = requestMessage(request)
    const result =
      message.method === 'server/discover'
        ? {
            resultType: 'complete',
            supportedVersions: ['2026-07-28'],
            capabilities: { tools: {} },
            ttlMs: 60_000,
            cacheScope: 'public',
            _meta: {
              'io.modelcontextprotocol/serverInfo': { name: 'remote', version: '0' }
            }
          }
        : {
            resultType: 'complete',
            tools: [
              {
                name: 'search',
                description: 'Search docs',
                inputSchema: { type: 'object' }
              }
            ],
            ttlMs: 60_000,
            cacheScope: 'public'
          }

    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    )
  })
)

const mcpServers: ReadonlyArray<McpRemoteServerConfig> = [
  { name: 'docs', type: 'remote', url: 'https://example.com/mcp' }
]

describe('Cloudflare tool modules', () => {
  it.effect('matches app text toolset without MCP', () =>
    Effect.gen(function* () {
      const nextTools = yield* resolvedToolNames(makeTextToolModules([]))
      const cloudflareTools = yield* resolvedToolNames(makeCloudflareTextToolModules([]))

      expect(cloudflareTools).toEqual(nextTools)
      expect(cloudflareTools).toEqual(['question', 'web_fetch', 'web_search', 'skill', 'just_bash'])
    })
  )

  it.effect('matches app text toolset with remote MCP', () =>
    Effect.gen(function* () {
      const nextTools = yield* resolvedToolNames(
        makeTextToolModules(mcpServers, fakeRemoteMcpLayer)
      )
      const cloudflareTools = yield* resolvedToolNames(
        makeCloudflareTextToolModules(mcpServers, fakeRemoteMcpLayer)
      )

      expect(cloudflareTools).toEqual(nextTools)
      expect(cloudflareTools).toEqual([
        'question',
        'web_fetch',
        'web_search',
        'skill',
        'just_bash',
        'docs_search'
      ])
    })
  )
})
