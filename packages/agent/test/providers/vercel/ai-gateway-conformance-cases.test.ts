import { Effect, Layer, Predicate, Redacted, Ref } from 'effect'
import { HttpClient } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { defineConformanceCase, type ConformanceCase } from '@yolk-sdk/conformance/case'
import { isWireStreamResponse, type WireFixture } from '@yolk-sdk/conformance/fixture'
import {
  makeReplayHttpClient,
  ReplayHttpClient,
  type ReplayLedgerApi
} from '@yolk-sdk/conformance/replay'
import {
  conformanceReportFailed,
  formatConformanceReport,
  runConformance
} from '@yolk-sdk/conformance/runner'
import { vercelAiGatewayChatCompletionsUrl } from '../../../src/providers/vercel/ai-gateway-provider.ts'
import {
  VercelAiGatewayConformanceConfig,
  vercelAiGatewayConformanceCases,
  vercelAiGatewayConformanceDefaultModels,
  vercelAiGatewayConformanceFixtures,
  vercelAiGatewayDeepSeekReasoningCase,
  vercelAiGatewayDeepSeekReasoningFixture,
  vercelAiGatewayErrorEnvelopeCase,
  vercelAiGatewayErrorEnvelopeFixture,
  vercelAiGatewayPlainTextCase,
  vercelAiGatewayPlainTextFixture,
  vercelAiGatewayToolCallDeltasCase,
  vercelAiGatewayToolCallDeltasFixture,
  type VercelAiGatewayConformanceCase,
  type VercelAiGatewayConformanceSettings
} from '../../../src/providers/vercel/conformance/index.ts'

const now = new Date('2026-09-29T12:00:00.000Z')

const settings: VercelAiGatewayConformanceSettings = {
  apiKey: Redacted.make('synthetic-gateway-key'),
  maxCompletionTokens: 64,
  reasoningMaxCompletionTokens: 512,
  reasoningEffort: 'high',
  models: vercelAiGatewayConformanceDefaultModels
}

const configLayer = Layer.succeed(VercelAiGatewayConformanceConfig, settings)

const fixturesFor = (
  testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>,
  fixtures: ReadonlyArray<WireFixture> = vercelAiGatewayConformanceFixtures
) => fixtures.filter(fixture => testCase.fixtures.includes(fixture.id))

const replayCaseLayer = (testCase: VercelAiGatewayConformanceCase) =>
  Layer.mergeAll(ReplayHttpClient.layer(fixturesFor(testCase)), configLayer)

describe('Vercel AI Gateway conformance cases', () => {
  it('are read-only, unverified, and backed by the Gateway fixtures', () => {
    expect(vercelAiGatewayConformanceCases.map(testCase => testCase.id)).toEqual(
      vercelAiGatewayConformanceFixtures.map(fixture => fixture.caseId)
    )

    for (const testCase of vercelAiGatewayConformanceCases) {
      expect(testCase.safety).toBe('read')
      expect(testCase.observed).toBeUndefined()
      expect(fixturesFor(testCase).map(fixture => fixture.caseId)).toEqual([testCase.id])
    }
  })

  it.effect('all pass against the replayed fixtures with unverified warnings', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(vercelAiGatewayConformanceCases, {
        target: { kind: 'replay' },
        now,
        fixtures: vercelAiGatewayConformanceFixtures,
        layer: replayCaseLayer
      })

      expect(report.target).toEqual({ kind: 'replay' })
      expect(report.summary).toEqual({ passed: 4, failed: 0, skipped: 0 })
      expect(conformanceReportFailed(report)).toBe(false)

      for (const [index, result] of report.results.entries()) {
        const fixture = vercelAiGatewayConformanceFixtures[index]

        expect(result.status).toBe('passed')
        expect(result.warnings).toEqual([
          { kind: 'unverified-case' },
          { kind: 'unverified-fixture', fixtureId: fixture?.id }
        ])
      }

      expect(formatConformanceReport(report).split('\n')).toEqual([
        'PASS  vercel-ai-gateway.stream.plain-text  [read]  warnings: unverified-case, unverified-fixture:vercel-ai-gateway.stream.plain-text.synthetic',
        'PASS  vercel-ai-gateway.stream.deepseek-reasoning  [read]  warnings: unverified-case, unverified-fixture:vercel-ai-gateway.stream.deepseek-reasoning.synthetic',
        'PASS  vercel-ai-gateway.stream.tool-call-deltas  [read]  warnings: unverified-case, unverified-fixture:vercel-ai-gateway.stream.tool-call-deltas.synthetic',
        'PASS  vercel-ai-gateway.stream.error-envelope  [read]  warnings: unverified-case, unverified-fixture:vercel-ai-gateway.stream.error-envelope.synthetic',
        '4 passed, 0 failed, 0 skipped; target replay; started 2026-09-29T12:00:00.000Z'
      ])
    })
  )

  it.effect('run only on read-safe live targets with case-level warnings only', () =>
    Effect.gen(function* () {
      // Live selection is proven without any network: the host's live HttpClient is replaced by
      // replay here, which is exactly the seam a host swaps.
      const report = yield* runConformance(vercelAiGatewayConformanceCases, {
        target: { kind: 'live', account: 'synthetic' },
        now,
        fixtures: vercelAiGatewayConformanceFixtures,
        layer: replayCaseLayer
      })

      expect(report.summary).toEqual({ passed: 4, failed: 0, skipped: 0 })
      expect(report.results.map(result => result.warnings)).toEqual([
        [{ kind: 'unverified-case' }],
        [{ kind: 'unverified-case' }],
        [{ kind: 'unverified-case' }],
        [{ kind: 'unverified-case' }]
      ])
    })
  )

  it.effect('send the claimed requests (asserted through the replay ledger)', () =>
    Effect.gen(function* () {
      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance(vercelAiGatewayConformanceCases, {
        target: { kind: 'replay' },
        now,
        layer: testCase =>
          Layer.mergeAll(
            Layer.unwrap(
              makeReplayHttpClient(fixturesFor(testCase)).pipe(
                Effect.tap(({ ledger }) =>
                  Ref.update(ledgers, current => new Map(current).set(testCase.id, ledger))
                ),
                Effect.map(({ client }) => Layer.succeed(HttpClient.HttpClient, client))
              )
            ),
            configLayer
          )
      })

      expect(report.summary.passed).toBe(4)

      const byCase = yield* Ref.get(ledgers)

      const entriesOf = (testCase: VercelAiGatewayConformanceCase) =>
        Effect.gen(function* () {
          const ledger = byCase.get(testCase.id)

          if (ledger === undefined) {
            return expect.fail(`no ledger for ${testCase.id}`)
          }

          expect(yield* ledger.remaining).toEqual([])

          const entries = yield* ledger.entries

          expect(entries).toHaveLength(1)
          expect(entries[0]).toMatchObject({
            method: 'POST',
            url: vercelAiGatewayChatCompletionsUrl,
            match: { outcome: 'matched' },
            headers: { authorization: '<redacted>', accept: 'text/event-stream' }
          })

          return entries[0]?.bodyJson
        })

      expect(yield* entriesOf(vercelAiGatewayPlainTextCase)).toMatchObject({
        model: settings.models.plainText,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: settings.maxCompletionTokens
      })

      const reasoningBody = yield* entriesOf(vercelAiGatewayDeepSeekReasoningCase)

      expect(reasoningBody).toMatchObject({
        model: settings.models.reasoning,
        stream: true,
        reasoning_effort: settings.reasoningEffort,
        thinking: { type: 'enabled' },
        max_tokens: settings.reasoningMaxCompletionTokens
      })
      expect(reasoningBody).not.toHaveProperty('reasoning')

      expect(yield* entriesOf(vercelAiGatewayToolCallDeltasCase)).toMatchObject({
        model: settings.models.toolCall,
        stream: true,
        tools: [{ type: 'function', function: { name: 'lookup_weather' } }]
      })

      expect(yield* entriesOf(vercelAiGatewayErrorEnvelopeCase)).toMatchObject({
        model: settings.models.invalid,
        stream: true
      })
    })
  )
})

// Disagreement drills: replay a fixture that contradicts a claim and check the matching case fails
// with a ConformanceMismatch instead of passing.

const streamChunks = (fixture: WireFixture): ReadonlyArray<string> => {
  const response = fixture.exchanges[0].response

  if (!isWireStreamResponse(response)) {
    return expect.fail(`${fixture.id} is not a stream`)
  }

  return response.chunks.map(chunk => (Predicate.isString(chunk) ? chunk : expect.fail('text')))
}

const withChunks = (fixture: WireFixture, chunks: ReadonlyArray<string>): WireFixture => {
  const [exchange] = fixture.exchanges
  const response = exchange.response

  if (!isWireStreamResponse(response)) {
    return expect.fail(`${fixture.id} is not a stream`)
  }

  return {
    ...fixture,
    id: `${fixture.id}.drill`,
    exchanges: [{ request: exchange.request, response: { ...response, chunks: [...chunks] } }]
  }
}

const drill = (testCase: VercelAiGatewayConformanceCase, fixture: WireFixture) =>
  Effect.gen(function* () {
    const report = yield* runConformance([testCase], {
      target: { kind: 'replay' },
      now,
      layer: () => Layer.mergeAll(ReplayHttpClient.layer([fixture]), configLayer)
    })

    expect(conformanceReportFailed(report)).toBe(true)

    return report.results[0]?.failure
  })

describe('Vercel AI Gateway conformance disagreement drills', () => {
  it.effect('fails the reasoning case when reasoning deltas are stripped', () =>
    Effect.gen(function* () {
      const stripped = withChunks(
        vercelAiGatewayDeepSeekReasoningFixture,
        streamChunks(vercelAiGatewayDeepSeekReasoningFixture).map(chunk =>
          chunk.replace(/"reasoning_content":"[^"]*"/, '"reasoning_content":null')
        )
      )

      expect(yield* drill(vercelAiGatewayDeepSeekReasoningCase, stripped)).toEqual({
        kind: 'failure',
        tag: 'ConformanceMismatch',
        message: 'expected reasoning deltas'
      })
    })
  )

  it.effect('fails the reasoning case when reasoning arrives after answer text', () =>
    Effect.gen(function* () {
      const chunks = streamChunks(vercelAiGatewayDeepSeekReasoningFixture)
      const firstText = chunks.findIndex(chunk => chunk.includes('"content":"Hello"'))
      const lastReasoning = chunks.findIndex(chunk => chunk.includes('" Keep it short."'))

      expect(lastReasoning).toBeLessThan(firstText)

      const reordered = chunks.filter((_, index) => index !== lastReasoning)
      reordered.splice(firstText, 0, chunks[lastReasoning] ?? expect.fail('chunk'))

      expect(
        yield* drill(
          vercelAiGatewayDeepSeekReasoningCase,
          withChunks(vercelAiGatewayDeepSeekReasoningFixture, reordered)
        )
      ).toEqual({
        kind: 'failure',
        tag: 'ConformanceMismatch',
        message: 'expected every reasoning delta before the first text delta'
      })
    })
  )

  it.effect('fails the tool-call case when argument fragments do not assemble the claim', () =>
    Effect.gen(function* () {
      const renamed = withChunks(
        vercelAiGatewayToolCallDeltasFixture,
        streamChunks(vercelAiGatewayToolCallDeltasFixture).map(chunk =>
          chunk.replace('{\\"ci', '{\\"to').replace('ty\\":\\"Spri', 'wn\\":\\"Spri')
        )
      )

      expect(yield* drill(vercelAiGatewayToolCallDeltasCase, renamed)).toEqual({
        kind: 'failure',
        tag: 'ConformanceMismatch',
        message: 'expected a non-empty string `city` argument'
      })
    })
  )

  it.effect('fails the plain-text case when the answer arrives as a single delta', () =>
    Effect.gen(function* () {
      const chunks = streamChunks(vercelAiGatewayPlainTextFixture)

      const oneDelta = chunks
        .join('')
        .split('\n\n')
        .filter(event => event.length > 0)
        .filter(event => !event.includes('" from the') && !event.includes('" synthetic gateway."'))
        .map(event => `${event}\n\n`)

      expect(
        yield* drill(
          vercelAiGatewayPlainTextCase,
          withChunks(vercelAiGatewayPlainTextFixture, oneDelta)
        )
      ).toEqual({
        kind: 'failure',
        tag: 'ConformanceMismatch',
        message: 'expected at least two text deltas before Done (a streamed answer)'
      })
    })
  )

  // The provider falls back from `error.code` to `error.type`, so the drill drops both.
  it.effect('fails the error-envelope case when the envelope carries no code or type', () =>
    Effect.gen(function* () {
      const [exchange] = vercelAiGatewayErrorEnvelopeFixture.exchanges

      const codeless: WireFixture = {
        ...vercelAiGatewayErrorEnvelopeFixture,
        id: `${vercelAiGatewayErrorEnvelopeFixture.id}.drill`,
        exchanges: [
          {
            request: exchange.request,
            response: {
              status: 400,
              headers: { 'content-type': 'application/json' },
              body: '{"error":{"message":"Synthetic placeholder."}}'
            }
          }
        ]
      }

      expect(yield* drill(vercelAiGatewayErrorEnvelopeCase, codeless)).toEqual({
        kind: 'failure',
        tag: 'ConformanceMismatch',
        message: 'expected the provider error code to be preserved'
      })
    })
  )

  it.effect('reports provider failures (not mismatches) with sanitized messages', () =>
    Effect.gen(function* () {
      const throttled: WireFixture = {
        ...vercelAiGatewayPlainTextFixture,
        id: `${vercelAiGatewayPlainTextFixture.id}.throttled`,
        exchanges: [
          {
            request: vercelAiGatewayPlainTextFixture.exchanges[0].request,
            response: {
              status: 429,
              headers: { 'content-type': 'application/json', 'retry-after': '2' },
              body: '{"error":{"message":"synthetic upstream detail","type":"rate_limit_exceeded"}}'
            }
          }
        ]
      }

      const failure = yield* drill(vercelAiGatewayPlainTextCase, throttled)

      expect(failure).toEqual({
        kind: 'failure',
        tag: 'LLMError',
        message: 'Vercel AI Gateway returned 429'
      })
    })
  )

  it('keeps a defined case id aligned with defineConformanceCase validation', () => {
    expect(() =>
      defineConformanceCase({ ...vercelAiGatewayPlainTextCase, id: 'Vercel.Bad' })
    ).toThrow(/Invalid conformance case/)
  })
})
