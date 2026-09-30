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
import {
  pickRecordedRequestFields,
  recordedNumber,
  recordedReasoningEffort,
  recordedRequestBody,
  recordedString
} from './recorded-gateway-request.ts'

const now = new Date('2026-09-30T12:00:00.000Z')

// Replay-only settings: every model, limit, and effort comes from the recorded request bodies,
// so each case sends the request its fixture recorded (the DeepSeek fixture, for example, was
// recorded with a reasoning-model override rather than the public default models).
const settings: VercelAiGatewayConformanceSettings = {
  apiKey: Redacted.make('synthetic-gateway-key'),
  maxCompletionTokens: recordedNumber(vercelAiGatewayPlainTextFixture, 'max_tokens'),
  reasoningMaxCompletionTokens: recordedNumber(
    vercelAiGatewayDeepSeekReasoningFixture,
    'max_tokens'
  ),
  reasoningEffort: recordedReasoningEffort(vercelAiGatewayDeepSeekReasoningFixture),
  models: {
    plainText: recordedString(vercelAiGatewayPlainTextFixture, 'model'),
    reasoning: recordedString(vercelAiGatewayDeepSeekReasoningFixture, 'model'),
    toolCall: recordedString(vercelAiGatewayToolCallDeltasFixture, 'model'),
    invalid: recordedString(vercelAiGatewayErrorEnvelopeFixture, 'model')
  }
}

const configLayer = Layer.succeed(VercelAiGatewayConformanceConfig, settings)

const fixturesFor = (
  testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>,
  fixtures: ReadonlyArray<WireFixture> = vercelAiGatewayConformanceFixtures
) => fixtures.filter(fixture => testCase.fixtures.includes(fixture.id))

const replayCaseLayer = (testCase: VercelAiGatewayConformanceCase) =>
  Layer.mergeAll(ReplayHttpClient.layer(fixturesFor(testCase)), configLayer)

type ExpectedWarning = { readonly kind: string; readonly fixtureId?: string }

// Case-level warnings, derived from the case data: `unverified-case` without a live observation.
// (No observation here is stale: `now` is within 30 days of every observation date.)
const expectedCaseWarnings = (
  testCase: Pick<VercelAiGatewayConformanceCase, 'id' | 'observed'>
): Array<ExpectedWarning> => (testCase.observed === undefined ? [{ kind: 'unverified-case' }] : [])

// Fixture-level warnings (non-live targets only), derived from each backing fixture's evidence.
const expectedFixtureWarnings = (
  testCase: Pick<VercelAiGatewayConformanceCase, 'fixtures'>,
  fixtures: ReadonlyArray<WireFixture>
): Array<ExpectedWarning> =>
  fixturesFor(testCase, fixtures).flatMap(fixture =>
    fixture.evidence === 'unverified' ? [{ kind: 'unverified-fixture', fixtureId: fixture.id }] : []
  )

const formatExpectedWarnings = (warnings: ReadonlyArray<ExpectedWarning>): string =>
  warnings.length === 0
    ? ''
    : `  warnings: ${warnings
        .map(warning =>
          warning.fixtureId === undefined ? warning.kind : `${warning.kind}:${warning.fixtureId}`
        )
        .join(', ')}`

describe('Vercel AI Gateway conformance cases', () => {
  it('are read-only and backed by the Gateway fixtures, observed when a verified recording exists', () => {
    expect(vercelAiGatewayConformanceCases.map(testCase => testCase.id)).toEqual(
      vercelAiGatewayConformanceFixtures.map(fixture => fixture.caseId)
    )

    for (const testCase of vercelAiGatewayConformanceCases) {
      const fixtures = fixturesFor(testCase)

      expect(testCase.safety).toBe('read')
      expect(fixtures.map(fixture => fixture.caseId)).toEqual([testCase.id])

      // A verified recording is a live observation of the case: the case records the same
      // account label and date as the recording it is backed by.
      for (const fixture of fixtures.filter(candidate => candidate.evidence === 'verified')) {
        expect(testCase.observed).toEqual({ account: fixture.account, date: fixture.recordedAt })
      }
    }
  })

  it.effect(
    'all pass against the replayed fixtures with warnings derived from their evidence',
    () =>
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

        // Expected warnings and report lines derive from the case observations and fixture
        // evidence, so re-recording or re-observing keeps this test valid.
        const expectedWarnings = vercelAiGatewayConformanceCases.map(testCase => [
          ...expectedCaseWarnings(testCase),
          ...expectedFixtureWarnings(testCase, vercelAiGatewayConformanceFixtures)
        ])

        expect(report.results.map(result => result.status)).toEqual([
          'passed',
          'passed',
          'passed',
          'passed'
        ])
        expect(report.results.map(result => result.warnings)).toEqual(expectedWarnings)

        expect(formatConformanceReport(report).split('\n')).toEqual([
          ...vercelAiGatewayConformanceCases.map(
            (testCase, index) =>
              `PASS  ${testCase.id}  [read]${formatExpectedWarnings(expectedWarnings[index] ?? [])}`
          ),
          `4 passed, 0 failed, 0 skipped; target replay; started ${now.toISOString()}`
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
      expect(report.results.map(result => result.warnings)).toEqual(
        vercelAiGatewayConformanceCases.map(expectedCaseWarnings)
      )
    })
  )

  // The shipped cases are observed and their fixtures verified, so the unverified paths are
  // exercised with a test-local copy: an unobserved case backed by an unverified fixture.
  it.effect('warn unverified-case and unverified-fixture for an unobserved, unverified copy', () =>
    Effect.gen(function* () {
      const { observed: _observed, ...unobservedCase } = vercelAiGatewayPlainTextCase

      const unverifiedFixture: WireFixture = {
        ...vercelAiGatewayPlainTextFixture,
        evidence: 'unverified'
      }

      const replay = yield* runConformance([unobservedCase], {
        target: { kind: 'replay' },
        now,
        fixtures: [unverifiedFixture],
        layer: () => Layer.mergeAll(ReplayHttpClient.layer([unverifiedFixture]), configLayer)
      })

      expect(replay.summary).toEqual({ passed: 1, failed: 0, skipped: 0 })
      expect(replay.results[0]?.warnings).toEqual([
        ...expectedCaseWarnings(unobservedCase),
        ...expectedFixtureWarnings(unobservedCase, [unverifiedFixture])
      ])
      expect(replay.results[0]?.warnings).toEqual([
        { kind: 'unverified-case' },
        { kind: 'unverified-fixture', fixtureId: unverifiedFixture.id }
      ])
    })
  )

  it.effect('send the recorded requests (asserted through the replay ledger)', () =>
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

      // Every case sends its fixture's recorded model, effort, thinking toggle, token limit,
      // streaming flag, and tools.
      for (const testCase of vercelAiGatewayConformanceCases) {
        const [fixture] = fixturesFor(testCase)

        if (fixture === undefined) {
          return expect.fail(`no fixture for ${testCase.id}`)
        }

        expect(pickRecordedRequestFields(yield* entriesOf(testCase))).toEqual(
          pickRecordedRequestFields(recordedRequestBody(fixture))
        )
      }

      expect(yield* entriesOf(vercelAiGatewayPlainTextCase)).toMatchObject({
        stream: true,
        stream_options: { include_usage: true }
      })

      const reasoningBody = yield* entriesOf(vercelAiGatewayDeepSeekReasoningCase)

      expect(reasoningBody).toMatchObject({
        reasoning_effort: settings.reasoningEffort,
        thinking: { type: 'enabled' },
        max_tokens: settings.reasoningMaxCompletionTokens
      })
      expect(reasoningBody).not.toHaveProperty('reasoning')

      expect(yield* entriesOf(vercelAiGatewayToolCallDeltasCase)).toMatchObject({
        tools: [{ type: 'function', function: { name: 'lookup_weather' } }]
      })
    })
  )
})

// Disagreement drills: replay a fixture that contradicts a claim and check the matching case fails
// with a ConformanceMismatch instead of passing. Fixtures are mutated structurally (parsed SSE
// `data:` payloads, parsed tool arguments, status codes), never by matching their text, so the
// drills keep working when the live recordings are re-recorded.

type SseEvent = { readonly data: string; readonly json: unknown }

// Mutable JSON, for editing parsed SSE payloads in place.
type Json = null | boolean | number | string | Array<Json> | JsonRecord

type JsonRecord = { [key: string]: Json }

const isRecord = (value: unknown): value is JsonRecord =>
  Predicate.isObject(value) && !Array.isArray(value)

const streamResponse = (fixture: WireFixture) => {
  const response = fixture.exchanges[0].response

  return isWireStreamResponse(response) ? response : expect.fail(`${fixture.id} is not a stream`)
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// Every server-sent event of the recorded stream (chunks reassembled first, so events split
// across network chunks parse whole), with its `data:` payload parsed when it is JSON.
const sseEvents = (fixture: WireFixture): Array<SseEvent> =>
  streamResponse(fixture)
    .chunks.map(chunk => (Predicate.isString(chunk) ? chunk : expect.fail('text chunks only')))
    .join('')
    .replace(/\r\n?/g, '\n')
    .split('\n\n')
    .flatMap(event => {
      const data = event
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice('data:'.length).trim())
        .join('\n')

      return data.length === 0 ? [] : [{ data, json: parseJson(data) }]
    })

// Rewrite the stream as one network chunk per event.
const withEvents = (
  fixture: WireFixture,
  events: ReadonlyArray<SseEvent>,
  suffix = 'drill'
): WireFixture => {
  const [exchange] = fixture.exchanges

  return {
    ...fixture,
    id: `${fixture.id}.${suffix}`,
    exchanges: [
      {
        request: exchange.request,
        response: {
          ...streamResponse(fixture),
          chunks: events.map(event =>
            event.json === undefined
              ? `data: ${event.data}\n\n`
              : `data: ${JSON.stringify(event.json)}\n\n`
          )
        }
      }
    ]
  }
}

// Deep copy of an event's parsed JSON, so edits never touch the committed fixture.
const cloneJson = (event: SseEvent): unknown =>
  event.json === undefined ? undefined : structuredClone(event.json)

const deltasOf = (json: unknown): Array<JsonRecord> => {
  const choices = isRecord(json) && Array.isArray(json.choices) ? json.choices : []

  return choices.flatMap(choice =>
    isRecord(choice) && isRecord(choice.delta) ? [choice.delta] : []
  )
}

const mapDeltas = (event: SseEvent, update: (delta: JsonRecord) => void): SseEvent => {
  const json = cloneJson(event)

  deltasOf(json).forEach(update)

  return { data: event.data, json }
}

const nonEmptyString = (value: unknown): boolean => Predicate.isString(value) && value.length > 0

const hasReasoning = (event: SseEvent): boolean =>
  deltasOf(event.json).some(
    delta => nonEmptyString(delta.reasoning_content) || nonEmptyString(delta.reasoning)
  )

const hasText = (event: SseEvent): boolean =>
  deltasOf(event.json).some(delta => nonEmptyString(delta.content))

const drill = (testCase: VercelAiGatewayConformanceCase, fixture: WireFixture) =>
  Effect.gen(function* () {
    const report = yield* runConformance([testCase], {
      target: { kind: 'replay' },
      now,
      layer: () => Layer.mergeAll(ReplayHttpClient.layer([fixture]), configLayer)
    })

    return report.results[0]
  })

const failedDrill = (testCase: VercelAiGatewayConformanceCase, fixture: WireFixture) =>
  drill(testCase, fixture).pipe(
    Effect.map(result => {
      expect(result?.status).toBe('failed')

      return result?.failure
    })
  )

const mismatch = (message: string) => ({ kind: 'failure', tag: 'ConformanceMismatch', message })

const withResponse = (
  fixture: WireFixture,
  suffix: string,
  status: number,
  body: string
): WireFixture => ({
  ...fixture,
  id: `${fixture.id}.${suffix}`,
  exchanges: [
    {
      request: fixture.exchanges[0].request,
      response: { status, headers: { 'content-type': 'application/json' }, body }
    }
  ]
})

describe('Vercel AI Gateway conformance disagreement drills', () => {
  it.effect('fails the reasoning case when reasoning deltas are stripped', () =>
    Effect.gen(function* () {
      const events = sseEvents(vercelAiGatewayDeepSeekReasoningFixture)

      expect(events.some(hasReasoning)).toBe(true)

      const stripped = events.map(event =>
        mapDeltas(event, delta => {
          delete delta.reasoning_content
          delete delta.reasoning
        })
      )

      expect(
        yield* failedDrill(
          vercelAiGatewayDeepSeekReasoningCase,
          withEvents(vercelAiGatewayDeepSeekReasoningFixture, stripped)
        )
      ).toEqual(mismatch('expected reasoning deltas'))
    })
  )

  it.effect('fails the reasoning case when reasoning arrives after answer text', () =>
    Effect.gen(function* () {
      const events = sseEvents(vercelAiGatewayDeepSeekReasoningFixture)
      const firstText = events.findIndex(hasText)
      const lastReasoning = events.findLastIndex(hasReasoning)

      expect(lastReasoning).not.toBe(-1)
      expect(lastReasoning).toBeLessThan(firstText)

      const reasoningEvent = events[lastReasoning] ?? expect.fail('reasoning event')
      const reordered = events.filter((_, index) => index !== lastReasoning)

      // After removal the first text event sits at `firstText - 1`; insert right after it.
      reordered.splice(firstText, 0, reasoningEvent)

      expect(
        yield* failedDrill(
          vercelAiGatewayDeepSeekReasoningCase,
          withEvents(vercelAiGatewayDeepSeekReasoningFixture, reordered)
        )
      ).toEqual(mismatch('expected every reasoning delta before the first text delta'))
    })
  )

  it.effect('fails the tool-call case when the assembled arguments lack the claimed key', () =>
    Effect.gen(function* () {
      const events = sseEvents(vercelAiGatewayToolCallDeltasFixture)

      const argumentsOf = (delta: JsonRecord): Array<JsonRecord> =>
        (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).flatMap(call =>
          isRecord(call) && isRecord(call.function) && Predicate.isString(call.function.arguments)
            ? [call.function]
            : []
        )

      const assembled = events
        .flatMap(event => deltasOf(event.json).flatMap(argumentsOf))
        .map(fn => fn.arguments)
        .join('')

      const params = parseJson(assembled)

      if (!isRecord(params) || !('city' in params)) {
        return expect.fail('recorded tool arguments carry no `city`')
      }

      const { city, ...rest } = params
      const renamed = JSON.stringify({ ...rest, town: city })
      let written = false

      // The whole renamed argument string goes into the first fragment; later fragments empty.
      const rewritten = events.map(event =>
        mapDeltas(event, delta => {
          for (const fn of argumentsOf(delta)) {
            fn.arguments = written ? '' : renamed
            written = true
          }
        })
      )

      expect(
        yield* failedDrill(
          vercelAiGatewayToolCallDeltasCase,
          withEvents(vercelAiGatewayToolCallDeltasFixture, rewritten)
        )
      ).toEqual(mismatch('expected a non-empty string `city` argument'))
    })
  )

  it.effect('passes the plain-text case when the whole answer is one content event', () =>
    Effect.gen(function* () {
      const events = sseEvents(vercelAiGatewayPlainTextFixture)

      const text = events
        .flatMap(event => deltasOf(event.json).map(delta => delta.content))
        .filter(Predicate.isString)
        .join('')

      expect(text.trim().length).toBeGreaterThan(0)

      const firstText = events.findIndex(hasText)

      const single = events.flatMap((event, index) => {
        if (index === firstText) {
          return [
            mapDeltas(event, delta => {
              delta.content = text
            })
          ]
        }

        return hasText(event) ? [] : [event]
      })

      expect(single.filter(hasText)).toHaveLength(1)

      const result = yield* drill(
        vercelAiGatewayPlainTextCase,
        withEvents(vercelAiGatewayPlainTextFixture, single)
      )

      expect(result?.status).toBe('passed')
    })
  )

  it.effect('fails the plain-text case when the stream reports no usage', () =>
    Effect.gen(function* () {
      const events = sseEvents(vercelAiGatewayPlainTextFixture)

      const withoutUsage = events.map(event => {
        const json = cloneJson(event)

        if (isRecord(json)) {
          delete json.usage
        }

        return { data: event.data, json }
      })

      expect(
        yield* failedDrill(
          vercelAiGatewayPlainTextCase,
          withEvents(vercelAiGatewayPlainTextFixture, withoutUsage)
        )
      ).toEqual(mismatch('expected a usage report'))
    })
  )

  it.effect('fails the plain-text case when the streamed text is empty', () =>
    Effect.gen(function* () {
      const empty = sseEvents(vercelAiGatewayPlainTextFixture).map(event =>
        mapDeltas(event, delta => {
          if (Predicate.isString(delta.content)) {
            delta.content = ''
          }
        })
      )

      expect(
        yield* failedDrill(
          vercelAiGatewayPlainTextCase,
          withEvents(vercelAiGatewayPlainTextFixture, empty)
        )
      ).toEqual(mismatch('expected non-empty answer text'))
    })
  )

  const errorEnvelope = (): JsonRecord => {
    const response = vercelAiGatewayErrorEnvelopeFixture.exchanges[0].response
    const body = 'body' in response && Predicate.isString(response.body) ? response.body : ''
    const parsed = parseJson(body)

    return isRecord(parsed) && isRecord(parsed.error)
      ? structuredClone(parsed)
      : expect.fail('error fixture has no JSON error envelope')
  }

  const errorStatus = (): number => vercelAiGatewayErrorEnvelopeFixture.exchanges[0].response.status

  // The provider falls back from `error.code` to `error.type`, so the drill drops both (the
  // recorded envelope has only `error.type`). The recorded status is kept.
  it.effect('fails the error-envelope case when the envelope carries no code or type', () =>
    Effect.gen(function* () {
      const envelope = errorEnvelope()

      if (isRecord(envelope.error)) {
        delete envelope.error.code
        delete envelope.error.type
      }

      expect(
        yield* failedDrill(
          vercelAiGatewayErrorEnvelopeCase,
          withResponse(
            vercelAiGatewayErrorEnvelopeFixture,
            'codeless',
            errorStatus(),
            JSON.stringify(envelope)
          )
        )
      ).toEqual(mismatch('expected the provider error code to be preserved'))
    })
  )

  for (const status of [401, 403]) {
    it.effect(`fails the error-envelope case for a ${status} authentication failure`, () =>
      Effect.gen(function* () {
        expect(
          yield* failedDrill(
            vercelAiGatewayErrorEnvelopeCase,
            withResponse(
              vercelAiGatewayErrorEnvelopeFixture,
              `status-${status}`,
              status,
              JSON.stringify(errorEnvelope())
            )
          )
        ).toEqual(
          mismatch('expected a model rejection, not an authentication or permission failure')
        )
      })
    )
  }

  it.effect('fails the error-envelope case for a non-model-rejection 4xx status', () =>
    Effect.gen(function* () {
      expect(
        yield* failedDrill(
          vercelAiGatewayErrorEnvelopeCase,
          withResponse(
            vercelAiGatewayErrorEnvelopeFixture,
            'status-402',
            402,
            JSON.stringify(errorEnvelope())
          )
        )
      ).toEqual(mismatch('expected a 400, 404, or 422 model-rejection status'))
    })
  )

  it.effect('accepts 400, 404, and 422 model rejections', () =>
    Effect.gen(function* () {
      for (const status of [400, 404, 422]) {
        const result = yield* drill(
          vercelAiGatewayErrorEnvelopeCase,
          withResponse(
            vercelAiGatewayErrorEnvelopeFixture,
            `status-${status}`,
            status,
            JSON.stringify(errorEnvelope())
          )
        )

        expect(result?.status).toBe('passed')
      }
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

      const failure = yield* failedDrill(vercelAiGatewayPlainTextCase, throttled)

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
