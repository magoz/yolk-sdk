import { Effect, Layer, Predicate, Redacted, Ref } from 'effect'
import { HttpClient } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { defineConformanceCase, type ConformanceCase } from '@yolk-sdk/conformance/case'
import {
  decodeWireFixture,
  isWireStreamResponse,
  scanFixtureForSecrets,
  type WireFixture
} from '@yolk-sdk/conformance/fixture'
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
import {
  OpenAiConformanceConfig,
  openAiChatErrorEnvelopeCase,
  openAiChatErrorEnvelopeFixture,
  openAiChatJsonPlainTextCase,
  openAiChatJsonPlainTextFixture,
  openAiChatPlainTextCase,
  openAiChatPlainTextFixture,
  openAiChatToolCallDeltasCase,
  openAiChatToolCallDeltasFixture,
  openAiConformanceCases,
  openAiConformanceChatCompletionsUrl,
  openAiConformanceDefaultModels,
  openAiConformanceFixtures,
  type OpenAiConformanceCase,
  type OpenAiConformanceSettings
} from '../../../src/providers/openai/conformance/index.ts'

const now = new Date('2026-09-30T12:00:00.000Z')

const settings: OpenAiConformanceSettings = {
  apiKey: Redacted.make('synthetic-openai-key'),
  maxCompletionTokens: 64,
  models: openAiConformanceDefaultModels
}

const configLayer = Layer.succeed(OpenAiConformanceConfig, settings)

const fixturesFor = (
  testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>,
  fixtures: ReadonlyArray<WireFixture> = openAiConformanceFixtures
) => fixtures.filter(fixture => testCase.fixtures.includes(fixture.id))

const replayCaseLayer = (testCase: OpenAiConformanceCase) =>
  Layer.mergeAll(ReplayHttpClient.layer(fixturesFor(testCase)), configLayer)

describe('OpenAI chat conformance cases', () => {
  it('are read-only, unverified, and backed by the OpenAI fixtures', () => {
    expect(openAiConformanceCases.map(testCase => testCase.id)).toEqual(
      openAiConformanceFixtures.map(fixture => fixture.caseId)
    )

    for (const testCase of openAiConformanceCases) {
      expect(testCase.safety).toBe('read')
      expect(testCase.observed).toBeUndefined()
      expect(fixturesFor(testCase).map(fixture => fixture.caseId)).toEqual([testCase.id])
    }

    for (const fixture of openAiConformanceFixtures) {
      expect(fixture).toMatchObject({
        evidence: 'unverified',
        account: 'synthetic',
        endpoint: openAiConformanceChatCompletionsUrl
      })
    }
  })

  it.effect('decode, pass the secret scan, and stay synthetic', () =>
    Effect.gen(function* () {
      for (const fixture of openAiConformanceFixtures) {
        expect((yield* decodeWireFixture(fixture)).id).toBe(fixture.id)
        expect(scanFixtureForSecrets(fixture)).toEqual([])
      }
    })
  )

  it.effect('all pass against the replayed fixtures with unverified warnings', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(openAiConformanceCases, {
        target: { kind: 'replay' },
        now,
        fixtures: openAiConformanceFixtures,
        layer: replayCaseLayer
      })

      expect(report.target).toEqual({ kind: 'replay' })
      expect(report.summary).toEqual({ passed: 4, failed: 0, skipped: 0 })
      expect(conformanceReportFailed(report)).toBe(false)

      // Expected warnings and report lines derive from the fixtures, so a verified live recording
      // keeps this test valid.
      expect(report.results.map(result => result.warnings)).toEqual(
        openAiConformanceFixtures.map(fixture =>
          fixture.evidence === 'unverified'
            ? [{ kind: 'unverified-case' }, { kind: 'unverified-fixture', fixtureId: fixture.id }]
            : [{ kind: 'unverified-case' }]
        )
      )

      expect(formatConformanceReport(report).split('\n')).toEqual([
        ...openAiConformanceFixtures.map(fixture =>
          [
            `PASS  ${fixture.caseId}  [read]  warnings: unverified-case`,
            fixture.evidence === 'unverified' ? `, unverified-fixture:${fixture.id}` : ''
          ].join('')
        ),
        '4 passed, 0 failed, 0 skipped; target replay; started 2026-09-30T12:00:00.000Z'
      ])
    })
  )

  it.effect('run only on read-safe live targets with case-level warnings only', () =>
    Effect.gen(function* () {
      // The host's live HttpClient is replaced by replay here: the exact seam a host swaps.
      const report = yield* runConformance(openAiConformanceCases, {
        target: { kind: 'live', account: 'synthetic' },
        now,
        fixtures: openAiConformanceFixtures,
        layer: replayCaseLayer
      })

      expect(report.summary).toEqual({ passed: 4, failed: 0, skipped: 0 })
      expect(report.results.map(result => result.warnings)).toEqual(
        openAiConformanceCases.map(() => [{ kind: 'unverified-case' }])
      )
    })
  )

  it.effect('send the claimed requests (asserted through the replay ledger)', () =>
    Effect.gen(function* () {
      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance(openAiConformanceCases, {
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

      const entriesOf = (testCase: OpenAiConformanceCase, accept: string) =>
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
            url: openAiConformanceChatCompletionsUrl,
            match: { outcome: 'matched' },
            headers: { authorization: '<redacted>', accept }
          })
          // Replay matches method + URL only; the fixture's request body must still be exactly
          // what the provider sends.
          expect(entries[0]?.bodyJson).toEqual(
            fixturesFor(testCase)[0]?.exchanges[0].request.body ?? expect.fail('no fixture body')
          )

          return entries[0]?.bodyJson
        })

      const plainBody = yield* entriesOf(openAiChatPlainTextCase, 'text/event-stream')

      expect(plainBody).toMatchObject({
        model: settings.models.plainText,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: settings.maxCompletionTokens
      })
      expect(plainBody).not.toHaveProperty('max_tokens')

      expect(yield* entriesOf(openAiChatToolCallDeltasCase, 'text/event-stream')).toMatchObject({
        model: settings.models.toolCall,
        stream: true,
        max_completion_tokens: settings.maxCompletionTokens,
        tools: [{ type: 'function', function: { name: 'lookup_weather' } }]
      })

      expect(yield* entriesOf(openAiChatErrorEnvelopeCase, 'text/event-stream')).toMatchObject({
        model: settings.models.invalid,
        stream: true
      })

      const jsonBody = yield* entriesOf(openAiChatJsonPlainTextCase, 'application/json')

      expect(jsonBody).toMatchObject({
        model: settings.models.plainText,
        stream: false,
        max_completion_tokens: settings.maxCompletionTokens
      })
      expect(jsonBody).not.toHaveProperty('stream_options')
      expect(jsonBody).not.toHaveProperty('max_tokens')
    })
  )

  it('record the request bodies the provider sends in the fixtures', () => {
    // Replay matches on method + URL only, so the committed request bodies are informational;
    // keep them aligned with the claimed request fields.
    const bodies = openAiConformanceFixtures.map(fixture => fixture.exchanges[0].request.body)

    for (const body of bodies) {
      expect(body).toMatchObject({ max_completion_tokens: settings.maxCompletionTokens })
      expect(body).not.toHaveProperty('max_tokens')
    }

    expect(
      bodies.map(body => (Predicate.hasProperty(body, 'stream') ? body.stream : null))
    ).toEqual([true, true, true, false])
  })
})

// Disagreement drills: replay a fixture that contradicts a claim and check the matching case fails
// with a ConformanceMismatch instead of passing. Fixtures are mutated structurally (parsed SSE
// `data:` payloads, parsed JSON bodies, parsed tool arguments, status codes), never by matching
// their text, so the drills keep working when live recordings replace the synthetic placeholders.

type SseEvent = { readonly data: string; readonly json: unknown }

// Mutable JSON, for editing parsed payloads in place.
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
const withEvents = (fixture: WireFixture, events: ReadonlyArray<SseEvent>): WireFixture => {
  const [exchange] = fixture.exchanges

  return {
    ...fixture,
    id: `${fixture.id}.drill`,
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

const hasText = (event: SseEvent): boolean =>
  deltasOf(event.json).some(delta => nonEmptyString(delta.content))

const drill = (testCase: OpenAiConformanceCase, fixture: WireFixture) =>
  Effect.gen(function* () {
    const report = yield* runConformance([testCase], {
      target: { kind: 'replay' },
      now,
      layer: () => Layer.mergeAll(ReplayHttpClient.layer([fixture]), configLayer)
    })

    return report.results[0]
  })

const failedDrill = (testCase: OpenAiConformanceCase, fixture: WireFixture) =>
  drill(testCase, fixture).pipe(
    Effect.map(result => {
      expect(result?.status).toBe('failed')

      return result?.failure
    })
  )

const mismatch = (message: string) => ({ kind: 'failure', tag: 'ConformanceMismatch', message })

const responseBody = (fixture: WireFixture): string => {
  const response = fixture.exchanges[0].response

  return 'body' in response && Predicate.isString(response.body)
    ? response.body
    : expect.fail(`${fixture.id} has no text body`)
}

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

describe('OpenAI chat conformance disagreement drills', () => {
  it.effect('fails the tool-call case when the assembled arguments lack the claimed key', () =>
    Effect.gen(function* () {
      const events = sseEvents(openAiChatToolCallDeltasFixture)

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
          openAiChatToolCallDeltasCase,
          withEvents(openAiChatToolCallDeltasFixture, rewritten)
        )
      ).toEqual(mismatch('expected a non-empty string `city` argument'))
    })
  )

  it.effect('passes the plain-text case when the whole answer is one content event', () =>
    Effect.gen(function* () {
      const events = sseEvents(openAiChatPlainTextFixture)

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
        openAiChatPlainTextCase,
        withEvents(openAiChatPlainTextFixture, single)
      )

      expect(result?.status).toBe('passed')
    })
  )

  it.effect('fails the plain-text case when the stream reports no usage', () =>
    Effect.gen(function* () {
      const withoutUsage = sseEvents(openAiChatPlainTextFixture).map(event => {
        const json = cloneJson(event)

        if (isRecord(json)) {
          delete json.usage
        }

        return { data: event.data, json }
      })

      expect(
        yield* failedDrill(
          openAiChatPlainTextCase,
          withEvents(openAiChatPlainTextFixture, withoutUsage)
        )
      ).toEqual(mismatch('expected a usage report'))
    })
  )

  it.effect('fails the plain-text case when the streamed text is empty', () =>
    Effect.gen(function* () {
      const empty = sseEvents(openAiChatPlainTextFixture).map(event =>
        mapDeltas(event, delta => {
          if (Predicate.isString(delta.content)) {
            delta.content = ''
          }
        })
      )

      expect(
        yield* failedDrill(openAiChatPlainTextCase, withEvents(openAiChatPlainTextFixture, empty))
      ).toEqual(mismatch('expected non-empty answer text'))
    })
  )

  const jsonCompletion = (): JsonRecord => {
    const parsed = parseJson(responseBody(openAiChatJsonPlainTextFixture))

    return isRecord(parsed) && Array.isArray(parsed.choices)
      ? structuredClone(parsed)
      : expect.fail('JSON fixture has no chat.completion body')
  }

  const messagesOf = (completion: JsonRecord): Array<JsonRecord> =>
    (Array.isArray(completion.choices) ? completion.choices : []).flatMap(choice =>
      isRecord(choice) && isRecord(choice.message) ? [choice.message] : []
    )

  const withJsonBody = (suffix: string, completion: JsonRecord): WireFixture => {
    const [exchange] = openAiChatJsonPlainTextFixture.exchanges

    return {
      ...openAiChatJsonPlainTextFixture,
      id: `${openAiChatJsonPlainTextFixture.id}.${suffix}`,
      exchanges: [
        {
          request: exchange.request,
          response: {
            status: exchange.response.status,
            headers: exchange.response.headers,
            body: JSON.stringify(completion)
          }
        }
      ]
    }
  }

  it.effect('fails the JSON case when the completion reports no usage', () =>
    Effect.gen(function* () {
      const completion = jsonCompletion()

      delete completion.usage

      expect(
        yield* failedDrill(openAiChatJsonPlainTextCase, withJsonBody('no-usage', completion))
      ).toEqual(mismatch('expected a usage report'))
    })
  )

  it.effect('fails the JSON case when the message content is empty', () =>
    Effect.gen(function* () {
      const completion = jsonCompletion()
      const messages = messagesOf(completion)

      expect(messages.length).toBeGreaterThan(0)

      for (const message of messages) {
        message.content = ''
      }

      expect(
        yield* failedDrill(openAiChatJsonPlainTextCase, withJsonBody('empty', completion))
      ).toEqual(mismatch('expected non-empty answer text'))
    })
  )

  it.effect('fails the JSON case when the endpoint streams instead', () =>
    Effect.gen(function* () {
      // A streamed plain-text recording answering the non-streamed request: the JSON case must
      // not pass on a server that ignores `stream: false`.
      const streamed: WireFixture = {
        ...openAiChatJsonPlainTextFixture,
        id: `${openAiChatJsonPlainTextFixture.id}.streamed`,
        exchanges: [
          {
            request: openAiChatJsonPlainTextFixture.exchanges[0].request,
            response: streamResponse(openAiChatPlainTextFixture)
          }
        ]
      }

      const result = yield* drill(openAiChatJsonPlainTextCase, streamed)

      expect(result?.status).toBe('failed')
      expect(result?.failure?.tag).toBe('LLMError')
    })
  )

  const errorEnvelope = (): JsonRecord => {
    const parsed = parseJson(responseBody(openAiChatErrorEnvelopeFixture))

    return isRecord(parsed) && isRecord(parsed.error)
      ? structuredClone(parsed)
      : expect.fail('error fixture has no JSON error envelope')
  }

  const errorStatus = (): number => openAiChatErrorEnvelopeFixture.exchanges[0].response.status

  // The provider falls back from `error.code` to `error.type`, so the drill drops both.
  it.effect('fails the error-envelope case when the envelope carries no code or type', () =>
    Effect.gen(function* () {
      const envelope = errorEnvelope()

      if (isRecord(envelope.error)) {
        delete envelope.error.code
        delete envelope.error.type
      }

      expect(
        yield* failedDrill(
          openAiChatErrorEnvelopeCase,
          withResponse(
            openAiChatErrorEnvelopeFixture,
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
            openAiChatErrorEnvelopeCase,
            withResponse(
              openAiChatErrorEnvelopeFixture,
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
          openAiChatErrorEnvelopeCase,
          withResponse(
            openAiChatErrorEnvelopeFixture,
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
          openAiChatErrorEnvelopeCase,
          withResponse(
            openAiChatErrorEnvelopeFixture,
            `status-${status}`,
            status,
            JSON.stringify(errorEnvelope())
          )
        )

        expect(result?.status).toBe('passed')
      }
    })
  )

  it.effect('fails the error-envelope case when the unknown model is accepted', () =>
    Effect.gen(function* () {
      const accepted: WireFixture = {
        ...openAiChatErrorEnvelopeFixture,
        id: `${openAiChatErrorEnvelopeFixture.id}.accepted`,
        exchanges: [
          {
            request: openAiChatErrorEnvelopeFixture.exchanges[0].request,
            response: streamResponse(openAiChatPlainTextFixture)
          }
        ]
      }

      expect(yield* failedDrill(openAiChatErrorEnvelopeCase, accepted)).toEqual(
        mismatch('expected an error envelope, the request succeeded')
      )
    })
  )

  it.effect('reports provider failures (not mismatches) with sanitized messages', () =>
    Effect.gen(function* () {
      const throttled = withResponse(
        openAiChatPlainTextFixture,
        'throttled',
        429,
        '{"error":{"message":"synthetic upstream detail","type":"requests","param":null,"code":"rate_limit_exceeded"}}'
      )

      expect(yield* failedDrill(openAiChatPlainTextCase, throttled)).toEqual({
        kind: 'failure',
        tag: 'LLMError',
        message: 'OpenAI returned 429'
      })
    })
  )

  it('keeps a defined case id aligned with defineConformanceCase validation', () => {
    expect(() => defineConformanceCase({ ...openAiChatPlainTextCase, id: 'OpenAI.Bad' })).toThrow(
      /Invalid conformance case/
    )
  })
})
