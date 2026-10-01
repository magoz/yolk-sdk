import { Effect, Layer } from 'effect'
import { HttpClient } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import type { WireExchange, WireFixture } from '@yolk-sdk/conformance/fixture'
import { makeReplayHttpClient } from '@yolk-sdk/conformance/replay'
import { listRemoteMcpServerTools } from '../../src/client/index.ts'
import {
  makeMcpObservingHttpClient,
  mcpConformanceSyntheticLegacyUrl,
  mcpConformanceSyntheticSessionId,
  mcpConformanceSyntheticTarget,
  mcpLegacySessionCase,
  mcpObservedRequestHeaders,
  mcpObservedResponseHeaders,
  mcpToolsListLegacyFixture
} from '../../src/conformance/index.ts'
import { replayLayer } from './helpers.ts'

/** A live-shaped session id (a UUID, as many servers mint): never kept by the observer. */
const liveSessionId = '4b1d6c2e-8f0a-4c3b-9e2d-7a5f1c0b3e9d'

const withSessionId = (fixture: WireFixture, sessionId: string): WireFixture => {
  const swap = (headers: Readonly<Record<string, string>> | undefined) =>
    headers === undefined || headers['mcp-session-id'] === undefined
      ? headers
      : { ...headers, 'mcp-session-id': sessionId }

  const [first, ...rest] = fixture.exchanges.map((exchange): WireExchange => ({
    request: { ...exchange.request, headers: swap(exchange.request.headers) ?? {} },
    response: { ...exchange.response, headers: swap(exchange.response.headers) ?? {} }
  }))

  if (first === undefined) {
    throw new Error('empty fixture')
  }

  return { ...fixture, exchanges: [first, ...rest] }
}

const observeListing = (fixture: WireFixture, headers: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const { client: replay, ledger } = yield* makeReplayHttpClient([fixture])
    const observer = yield* makeMcpObservingHttpClient(replay)

    yield* listRemoteMcpServerTools(
      { name: 'synthetic', type: 'remote', url: mcpConformanceSyntheticLegacyUrl, headers },
      { timeoutMs: mcpConformanceSyntheticTarget('legacy').timeoutMs }
    ).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, observer.client)))

    return { exchanges: yield* observer.exchanges, entries: yield* ledger.entries }
  })

describe('the observing HttpClient', () => {
  it.effect('forwards every request once and keeps only allowlisted headers', () =>
    Effect.gen(function* () {
      const secret = 'yolk-synthetic-observer-secret-0001'

      const { exchanges, entries } = yield* observeListing(mcpToolsListLegacyFixture, {
        authorization: `Bearer ${secret}`,
        'x-api-key': secret
      })

      expect(exchanges).toHaveLength(entries.length)
      expect(JSON.stringify(exchanges)).not.toContain(secret)

      for (const exchange of exchanges) {
        expect(Object.keys(exchange.requestHeaders)).toEqual(
          Object.keys(exchange.requestHeaders).filter(name =>
            mcpObservedRequestHeaders.includes(name)
          )
        )
        expect(
          Object.keys(exchange.responseHeaders ?? {}).every(name =>
            mcpObservedResponseHeaders.includes(name)
          )
        ).toBe(true)
      }

      expect(exchanges.map(exchange => [exchange.method, exchange.status])).toEqual(
        expect.arrayContaining([
          ['POST', 400],
          ['POST', 200],
          ['POST', 202],
          ['GET', 405]
        ])
      )
      expect(
        exchanges.find(exchange => exchange.mediaType === 'text/event-stream')?.responseBody
      ).toContain('data: ')
    })
  )

  it.effect('never keeps a session id: only its class and whether it is visible ASCII', () =>
    Effect.gen(function* () {
      const fixture = withSessionId(mcpToolsListLegacyFixture, liveSessionId)

      const { exchanges } = yield* observeListing(fixture, {})
      const serialized = JSON.stringify(exchanges)

      expect(serialized).not.toContain(liveSessionId)
      expect(serialized).not.toContain(liveSessionId.slice(0, 8))
      expect(serialized).not.toContain(mcpConformanceSyntheticSessionId)

      const initialize = exchanges.find(exchange => exchange.status === 200)

      expect(initialize?.responseSession).toEqual({ id: 'session#1', visibleAscii: true })
      expect(
        exchanges
          .filter(exchange => exchange.requestSession !== undefined)
          .map(exchange => exchange.requestSession?.id)
      ).toEqual(['session#1', 'session#1', 'session#1'])
    })
  )

  it.effect('the legacy session case still checks the echo with a live-shaped session id', () =>
    mcpLegacySessionCase.run.pipe(
      Effect.provide(
        replayLayer([withSessionId(mcpToolsListLegacyFixture, liveSessionId)], 'legacy', {})
      )
    )
  )

  it.effect('keeps bodies exactly as received (they are sensitive, never redacted)', () =>
    Effect.gen(function* () {
      const fixture = withSessionId(mcpToolsListLegacyFixture, liveSessionId)

      const { exchanges } = yield* observeListing(fixture, {
        authorization: 'Bearer yolk-synthetic-observer-secret-0002',
        'x-client-tag': '2026-07-28'
      })

      const probe = exchanges[0]

      expect(JSON.stringify(probe?.requestBody)).toContain('2026-07-28')
      expect(probe?.requestHeaders['mcp-protocol-version']).toBe('2026-07-28')
      expect(probe?.url).toBe(mcpConformanceSyntheticLegacyUrl)
      expect(
        exchanges.some(exchange => exchange.responseBody?.includes('get_synthetic_note') === true)
      ).toBe(true)
    })
  )
})
