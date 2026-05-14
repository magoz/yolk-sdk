import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolCall } from '@yolk/agent/protocol'
import { skillToolModule } from './skill-tool'
import { resolveAgentTools } from './registry'
import { resolveAgentToolSet } from './resolve-toolset'
import { webSearchToolModule } from './web-search-tool'
import { webFetchWorkerToolModule } from './web-fetch-worker-tool'
import {
  ensurePublicUrlWithoutDns,
  executeWebFetchTool,
  type WebFetchHttpResponse,
  type WebFetchToolDependencies
} from './web-fetch-tool'

const makeResponse = (input: {
  readonly status: number
  readonly body: string
  readonly headers?: Readonly<Record<string, string | undefined>>
}): WebFetchHttpResponse => ({
  status: input.status,
  headers: input.headers ?? {},
  body: Effect.promise(() => new Response(input.body).arrayBuffer())
})

const makeDependencies = (responses: ReadonlyArray<WebFetchHttpResponse>) => {
  const requested: Array<string> = []
  let index = 0
  const fallback = makeResponse({ status: 500, body: 'unexpected request' })
  const deps: WebFetchToolDependencies = {
    ensurePublicUrl: ensurePublicUrlWithoutDns,
    request: url => {
      requested.push(url.toString())
      const response = responses[index] ?? fallback
      index += 1

      return Effect.succeed(response)
    }
  }

  return { deps, requested }
}

describe('web_fetch tool', () => {
  it.effect('fetches public HTML and returns markdown by default', () =>
    Effect.gen(function* () {
      const { deps } = makeDependencies([
        makeResponse({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: '<html><body><h1>Hello &amp; goodbye</h1><p>Read <a href="https://example.com/docs">docs</a>.</p><script>ignored()</script></body></html>'
        })
      ])
      const result = yield* executeWebFetchTool(
        ToolCall.make({
          id: 'call_1',
          name: 'web_fetch',
          params: { url: 'https://example.com/' }
        }),
        deps
      )

      expect(result.content).toContain('URL: https://example.com/')
      expect(result.content).toContain('Format: markdown')
      expect(result.content).toContain('# Hello & goodbye')
      expect(result.content).toContain('docs (https://example.com/docs)')
      expect(result.content).not.toContain('ignored')
    })
  )

  it.effect('follows safe redirects manually', () =>
    Effect.gen(function* () {
      const { deps, requested } = makeDependencies([
        makeResponse({ status: 302, body: '', headers: { location: '/final' } }),
        makeResponse({ status: 200, body: 'done', headers: { 'content-type': 'text/plain' } })
      ])
      const result = yield* executeWebFetchTool(
        ToolCall.make({
          id: 'call_1',
          name: 'web_fetch',
          params: { url: 'https://example.com/start', format: 'text' }
        }),
        deps
      )

      expect(requested).toEqual(['https://example.com/start', 'https://example.com/final'])
      expect(result.content).toContain('URL: https://example.com/final')
      expect(result.content).toContain('done')
    })
  )

  it.effect('blocks private hosts before requesting', () =>
    Effect.gen(function* () {
      const { deps, requested } = makeDependencies([])
      const result = yield* executeWebFetchTool(
        ToolCall.make({
          id: 'call_1',
          name: 'web_fetch',
          params: { url: 'http://127.0.0.1:3000/' }
        }),
        deps
      ).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ToolError', cause: 'permission' }
      })
      expect(requested).toEqual([])
    })
  )

  it.effect('blocks unsafe redirects before requesting target', () =>
    Effect.gen(function* () {
      const { deps, requested } = makeDependencies([
        makeResponse({ status: 302, body: '', headers: { location: 'http://127.0.0.1:3000/' } })
      ])
      const result = yield* executeWebFetchTool(
        ToolCall.make({
          id: 'call_1',
          name: 'web_fetch',
          params: { url: 'https://example.com/start' }
        }),
        deps
      ).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ToolError', cause: 'permission' }
      })
      expect(requested).toEqual(['https://example.com/start'])
    })
  )

  it.effect('limits redirect chains', () =>
    Effect.gen(function* () {
      const redirects = Array.from({ length: 6 }, (_value, index) =>
        makeResponse({ status: 302, body: '', headers: { location: `/step-${index}` } })
      )
      const { deps } = makeDependencies(redirects)
      const result = yield* executeWebFetchTool(
        ToolCall.make({
          id: 'call_1',
          name: 'web_fetch',
          params: { url: 'https://example.com/start' }
        }),
        deps
      ).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ToolError', cause: 'execution' }
      })
    })
  )

  it.effect('enables web_fetch for text and voice agents', () =>
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

      expect(textTools.tools.map(tool => tool.name)).toEqual(['web_fetch', 'web_search'])
      expect(voiceTools.tools.map(tool => tool.name)).toEqual(['web_fetch', 'web_search'])
    })
  )

  it.effect('resolves Cloudflare-safe text tools', () =>
    Effect.gen(function* () {
      const toolSet = yield* resolveAgentToolSet({
        modules: [webFetchWorkerToolModule, webSearchToolModule, skillToolModule],
        context: {
          surface: 'text',
          route: '/agent/cloudflare',
          userId: 'user_1',
          skillset: {
            skills: [
              {
                name: 'react-best-practices',
                description: 'React guidance',
                location: 'file:///skills/react-best-practices/SKILL.md',
                content: 'Use server components carefully.'
              }
            ],
            commands: []
          }
        }
      })

      expect(toolSet.tools.map(tool => tool.name)).toEqual(['web_fetch', 'web_search', 'skill'])
    })
  )
})
