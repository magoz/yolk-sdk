import { Effect, Layer } from 'effect'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import type { McpRemoteServerConfig } from '@yolk/mcp/client'
import { resolveAgentToolSet, makeTextToolModules } from '../../../lib/agents/tools/registry'
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

const requestMethod = (request: HttpClientRequest.HttpClientRequest) => {
  const body = request.body
  if (body._tag !== 'Uint8Array') {
    return 'notifications/initialized'
  }

  const text = new TextDecoder().decode(body.body)
  if (text.includes('"method":"initialize"')) {
    return 'initialize'
  }
  if (text.includes('"method":"tools/list"')) {
    return 'tools/list'
  }
  return 'notifications/initialized'
}

const fakeRemoteMcpLayer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(request =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(responseBodyFor(requestMethod(request)), {
          status: responseStatusFor(requestMethod(request)),
          headers: { 'content-type': 'application/json' }
        })
      )
    )
  )
)

const responseStatusFor = (method: string) => (method === 'notifications/initialized' ? 204 : 200)

const responseBodyFor = (method: string) => {
  if (method === 'notifications/initialized') {
    return undefined
  }

  return JSON.stringify({
    jsonrpc: '2.0',
    id: method === 'initialize' ? 1 : 2,
    result:
      method === 'initialize'
        ? {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'remote', version: '0' }
          }
        : {
            tools: [
              {
                name: 'search',
                description: 'Search docs',
                inputSchema: { type: 'object' }
              }
            ]
          }
  })
}

const mcpServers: ReadonlyArray<McpRemoteServerConfig> = [
  { name: 'docs', type: 'remote', url: 'https://example.com/mcp' }
]

describe('Cloudflare tool modules', () => {
  it.effect('matches app text toolset without MCP', () =>
    Effect.gen(function* () {
      const nextTools = yield* resolvedToolNames(makeTextToolModules([]))
      const cloudflareTools = yield* resolvedToolNames(makeCloudflareTextToolModules([]))

      expect(cloudflareTools).toEqual(nextTools)
      expect(cloudflareTools).toEqual(['web_fetch', 'web_search', 'skill'])
    })
  )

  it.effect('matches app text toolset with remote MCP', () =>
    Effect.gen(function* () {
      const nextTools = yield* resolvedToolNames(makeTextToolModules(mcpServers, fakeRemoteMcpLayer))
      const cloudflareTools = yield* resolvedToolNames(
        makeCloudflareTextToolModules(mcpServers, fakeRemoteMcpLayer)
      )

      expect(cloudflareTools).toEqual(nextTools)
      expect(cloudflareTools).toEqual(['web_fetch', 'web_search', 'skill', 'docs_search'])
    })
  )
})
