import { Effect, Layer } from 'effect'
import { HttpClient, HttpClientError } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { makeMcpToolModule } from './mcp-tool-module'

describe('MCP tool module', () => {
  it.effect('does not read MCP config from env', () =>
    Effect.gen(function* () {
      const toolModule = yield* makeMcpToolModule([])

      expect(toolModule.tools).toEqual([])
    })
  )

  it.effect('omits tools when a remote MCP server is unavailable', () =>
    Effect.gen(function* () {
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(request =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                description: 'connection refused'
              })
            })
          )
        )
      )

      const toolModule = yield* makeMcpToolModule(
        [{ name: 'docs', type: 'remote', url: 'https://example.com/mcp' }],
        httpClientLayer
      )

      expect(toolModule.tools).toEqual([])
    })
  )
})
