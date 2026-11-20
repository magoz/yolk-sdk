import { Effect, Layer, Predicate, Redacted, Ref, Stream } from 'effect'
import { HttpClient } from 'effect/http'
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
  ReplayLedger,
  WireFault,
  type ReplayLedgerApi
} from '@yolk-sdk/conformance/replay'
import { LLMDone, LLMProvider, LLMUsage, type LLMEvent } from '@yolk-sdk/agent/loop'
import { UserMessage } from '@yolk-sdk/agent/protocol'
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
  openAiChatJsonReasoningUsageCase,
  openAiChatJsonReasoningUsageFixture,
  openAiChatPlainTextCase,
  openAiChatPlainTextFixture,
  openAiChatReasoningEffortCase,
  openAiChatReasoningEffortFixture,
  openAiChatToolCallDeltasCase,
  openAiChatToolCallDeltasFixture,
  openAiChatUnsupportedParameterCase,
  openAiChatUnsupportedParameterFixture,
  openAiConformanceCases,
  openAiConformanceChatCompletionsUrl,
  openAiConformanceDefaultModels,
  openAiConformanceFixtures,
  type OpenAiConformanceCase,
  type OpenAiConformanceSettings
} from '../../../src/providers/openai/conformance/index.ts'
import { makeOpenAiProviderLayer } from '../../../src/providers/openai/provider.ts'

const now = new Date('2026-09-30T12:00:00.000Z')

const settings: OpenAiConformanceSettings = {
  apiKey: Redacted.make('synthetic-openai-key'),
  maxCompletionTokens: 64,
  reasoningMaxCompletionTokens: 1024,
  reasoningEffort: 'medium',
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
      expect(report.summary).toEqual({ passed: 7, failed: 0, skipped: 0 })
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
        '7 passed, 0 failed, 0 skipped; target replay; started 2026-09-30T12:00:00.000Z'
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

      expect(report.summary).toEqual({ passed: 7, failed: 0, skipped: 0 })
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

      expect(report.summary.passed).toBe(7)

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
        tools: [{ type: 'function', function: { name: 'lookup_weather' } }],
        tool_choice: { type: 'function', function: { name: 'lookup_weather' } },
        parallel_tool_calls: true
      })

      const errorBody = yield* entriesOf(openAiChatErrorEnvelopeCase, 'text/event-stream')

      expect(errorBody).toMatchObject({
        model: settings.models.invalid,
        stream: true
      })
      expect(errorBody).not.toHaveProperty('tool_choice')

      expect(plainBody).not.toHaveProperty('tool_choice')

      const jsonBody = yield* entriesOf(openAiChatJsonPlainTextCase, 'application/json')

      expect(jsonBody).toMatchObject({
        model: settings.models.plainText,
        stream: false,
        max_completion_tokens: settings.maxCompletionTokens
      })
      expect(jsonBody).not.toHaveProperty('stream_options')
      expect(jsonBody).not.toHaveProperty('max_tokens')

      const reasoningBody = yield* entriesOf(openAiChatReasoningEffortCase, 'text/event-stream')

      expect(reasoningBody).toMatchObject({
        model: settings.models.reasoning,
        reasoning_effort: settings.reasoningEffort,
        max_completion_tokens: settings.reasoningMaxCompletionTokens,
        stream: true,
        stream_options: { include_usage: true }
      })
      expect(reasoningBody).not.toHaveProperty('max_tokens')

      const jsonReasoningBody = yield* entriesOf(
        openAiChatJsonReasoningUsageCase,
        'application/json'
      )

      expect(jsonReasoningBody).toMatchObject({
        model: settings.models.reasoning,
        reasoning_effort: settings.reasoningEffort,
        max_completion_tokens: settings.reasoningMaxCompletionTokens,
        stream: false
      })
      expect(jsonReasoningBody).not.toHaveProperty('max_tokens')

      const unsupportedBody = yield* entriesOf(
        openAiChatUnsupportedParameterCase,
        'text/event-stream'
      )

      expect(unsupportedBody).toMatchObject({
        model: settings.models.reasoning,
        max_tokens: settings.maxCompletionTokens,
        stream: true
      })
      expect(unsupportedBody).not.toHaveProperty('max_completion_tokens')
      expect(unsupportedBody).not.toHaveProperty('reasoning_effort')
    })
  )

  it('record the request bodies the provider sends in the fixtures', () => {
    // Replay matches on method + URL only, so the committed request bodies are informational;
    // keep them aligned with the claimed request fields.
    const bodyOf = (fixture: WireFixture) => fixture.exchanges[0].request.body

    const limitFields = openAiConformanceFixtures.map(fixture => {
      const body = bodyOf(fixture)

      return [
        fixture.caseId,
        Predicate.hasProperty(body, 'max_completion_tokens') ? body.max_completion_tokens : null,
        Predicate.hasProperty(body, 'max_tokens') ? body.max_tokens : null,
        Predicate.hasProperty(body, 'reasoning_effort') ? body.reasoning_effort : null,
        Predicate.hasProperty(body, 'stream') ? body.stream : null
      ]
    })

    const plainLimit = settings.maxCompletionTokens
    const reasoningLimit = settings.reasoningMaxCompletionTokens
    const effort = settings.reasoningEffort

    // Only the unsupported-parameter case sends `max_tokens`; only the reasoning cases an effort.
    expect(limitFields).toEqual([
      ['openai.chat.stream.plain-text', plainLimit, null, null, true],
      ['openai.chat.stream.tool-call-deltas', plainLimit, null, null, true],
      ['openai.chat.stream.error-envelope', plainLimit, null, null, true],
      ['openai.chat.json.plain-text', plainLimit, null, null, false],
      ['openai.chat.stream.reasoning-effort', reasoningLimit, null, effort, true],
      ['openai.chat.json.reasoning-usage', reasoningLimit, null, effort, false],
      ['openai.chat.stream.unsupported-parameter', null, plainLimit, null, true]
    ])
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
      ).toEqual(mismatch('expected the provider code `model_not_found`'))
    })
  )

  it.effect('fails the error-envelope case for an unrelated request error code', () =>
    Effect.gen(function* () {
      const envelope = errorEnvelope()

      if (!isRecord(envelope.error)) {
        return expect.fail('error fixture has no error object')
      }

      envelope.error.code = 'unsupported_parameter'

      // Checked at both accepted statuses, so only the code can fail the case.
      for (const status of [400, 404]) {
        expect(
          yield* failedDrill(
            openAiChatErrorEnvelopeCase,
            withResponse(
              openAiChatErrorEnvelopeFixture,
              `unsupported-parameter-${status}`,
              status,
              JSON.stringify(envelope)
            )
          )
        ).toEqual(mismatch('expected the provider code `model_not_found`'))
      }
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
      for (const status of [402, 422]) {
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
        ).toEqual(mismatch('expected a 404 or 400 model-rejection status'))
      }
    })
  )

  it.effect('accepts 404 and 400 model_not_found rejections', () =>
    Effect.gen(function* () {
      for (const status of [404, 400]) {
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

  // Edits the usage object of every recorded event that carries one.
  const withStreamedUsage = (suffix: string, update: (usage: JsonRecord) => void): WireFixture => {
    const events = sseEvents(openAiChatReasoningEffortFixture).map(event => {
      const json = cloneJson(event)

      if (isRecord(json) && isRecord(json.usage)) {
        update(json.usage)
      }

      return { data: event.data, json }
    })

    return {
      ...withEvents(openAiChatReasoningEffortFixture, events),
      id: `${openAiChatReasoningEffortFixture.id}.${suffix}`
    }
  }

  it.effect('passes the reasoning-effort case against an unchanged rewrite of its recording', () =>
    Effect.gen(function* () {
      const unchanged = withStreamedUsage('unchanged', () => {})

      expect((yield* drill(openAiChatReasoningEffortCase, unchanged))?.status).toBe('passed')
    })
  )

  it.effect('fails the reasoning-effort case when usage counts no reasoning tokens', () =>
    Effect.gen(function* () {
      expect(
        yield* failedDrill(
          openAiChatReasoningEffortCase,
          withStreamedUsage('no-details', usage => {
            delete usage.completion_tokens_details
          })
        )
      ).toEqual(mismatch('expected the usage report to count reasoning tokens'))

      expect(
        yield* failedDrill(
          openAiChatReasoningEffortCase,
          withStreamedUsage('zero', usage => {
            usage.completion_tokens_details = { reasoning_tokens: 0 }
          })
        )
      ).toEqual(mismatch('expected the usage report to count reasoning tokens'))
    })
  )

  it.effect('fails the reasoning-effort case when reasoning exceeds the output total', () =>
    Effect.gen(function* () {
      expect(
        yield* failedDrill(
          openAiChatReasoningEffortCase,
          withStreamedUsage('over', usage => {
            const completion = usage.completion_tokens

            usage.completion_tokens_details = {
              reasoning_tokens: Predicate.isNumber(completion) ? completion + 1 : 1
            }
          })
        )
      ).toEqual(mismatch('expected reasoning tokens counted within the output total'))
    })
  )

  it.effect('fails the reasoning-effort case when the stream carries reasoning text', () =>
    Effect.gen(function* () {
      const events = sseEvents(openAiChatReasoningEffortFixture)
      const firstText = events.findIndex(hasText)

      const withReasoning = events.map((event, index) =>
        index === firstText
          ? mapDeltas(event, delta => {
              delta.reasoning_content = 'Synthetic reasoning.'
            })
          : event
      )

      expect(
        yield* failedDrill(
          openAiChatReasoningEffortCase,
          withEvents(openAiChatReasoningEffortFixture, withReasoning)
        )
      ).toEqual(mismatch('expected no reasoning text (OpenAI Chat Completions returns none)'))
    })
  )

  const jsonReasoningCompletion = (): JsonRecord => {
    const parsed = parseJson(responseBody(openAiChatJsonReasoningUsageFixture))

    return isRecord(parsed) && isRecord(parsed.usage)
      ? structuredClone(parsed)
      : expect.fail('JSON reasoning fixture has no usage')
  }

  const withJsonReasoningBody = (suffix: string, completion: JsonRecord): WireFixture =>
    withResponse(openAiChatJsonReasoningUsageFixture, suffix, 200, JSON.stringify(completion))

  it.effect('fails the JSON reasoning case when usage counts no reasoning tokens', () =>
    Effect.gen(function* () {
      const completion = jsonReasoningCompletion()

      if (isRecord(completion.usage)) {
        delete completion.usage.completion_tokens_details
      }

      expect(
        yield* failedDrill(
          openAiChatJsonReasoningUsageCase,
          withJsonReasoningBody('no-details', completion)
        )
      ).toEqual(mismatch('expected the usage report to count reasoning tokens'))
    })
  )

  it.effect('fails the JSON reasoning case when the message carries reasoning text', () =>
    Effect.gen(function* () {
      const completion = jsonReasoningCompletion()

      for (const message of messagesOf(completion)) {
        message.reasoning_content = 'Synthetic reasoning.'
      }

      expect(
        yield* failedDrill(
          openAiChatJsonReasoningUsageCase,
          withJsonReasoningBody('reasoning-text', completion)
        )
      ).toEqual(mismatch('expected no reasoning text (OpenAI Chat Completions returns none)'))
    })
  )

  const unsupportedEnvelope = (): JsonRecord => {
    const parsed = parseJson(responseBody(openAiChatUnsupportedParameterFixture))

    return isRecord(parsed) && isRecord(parsed.error)
      ? structuredClone(parsed)
      : expect.fail('unsupported-parameter fixture has no JSON error envelope')
  }

  it.effect('fails the unsupported-parameter case when max_tokens is accepted', () =>
    Effect.gen(function* () {
      const accepted: WireFixture = {
        ...openAiChatUnsupportedParameterFixture,
        id: `${openAiChatUnsupportedParameterFixture.id}.accepted`,
        exchanges: [
          {
            request: openAiChatUnsupportedParameterFixture.exchanges[0].request,
            response: streamResponse(openAiChatPlainTextFixture)
          }
        ]
      }

      expect(yield* failedDrill(openAiChatUnsupportedParameterCase, accepted)).toEqual(
        mismatch('expected a rejection, the request succeeded')
      )
    })
  )

  it.effect('fails the unsupported-parameter case for another code or status', () =>
    Effect.gen(function* () {
      const otherCode = unsupportedEnvelope()

      if (isRecord(otherCode.error)) {
        otherCode.error.code = 'invalid_value'
      }

      expect(
        yield* failedDrill(
          openAiChatUnsupportedParameterCase,
          withResponse(
            openAiChatUnsupportedParameterFixture,
            'invalid-value',
            400,
            JSON.stringify(otherCode)
          )
        )
      ).toEqual(mismatch('expected the provider code `unsupported_parameter`'))

      expect(
        yield* failedDrill(
          openAiChatUnsupportedParameterCase,
          withResponse(
            openAiChatUnsupportedParameterFixture,
            'status-422',
            422,
            JSON.stringify(unsupportedEnvelope())
          )
        )
      ).toEqual(mismatch('expected status 400'))

      expect(
        yield* failedDrill(
          openAiChatUnsupportedParameterCase,
          withResponse(
            openAiChatUnsupportedParameterFixture,
            'status-401',
            401,
            JSON.stringify(unsupportedEnvelope())
          )
        )
      ).toEqual(mismatch('expected a request rejection, not an authentication failure'))
    })
  )

  it('keeps a defined case id aligned with defineConformanceCase validation', () => {
    expect(() => defineConformanceCase({ ...openAiChatPlainTextCase, id: 'OpenAI.Bad' })).toThrow(
      /Invalid conformance case/
    )
  })
})

/** Each Done's stop reason and whether it says the requested usage never arrived. */
const doneSignals = (events: Iterable<LLMEvent>) =>
  Array.from(events).flatMap(event =>
    event instanceof LLMDone ? [[event.stopReason, event.usageUnavailable]] : []
  )

// The generic chat provider with the plain-text case's request, over the recorded stream.
const streamPlainText = (faults: ReadonlyArray<WireFault> = []) =>
  Effect.gen(function* () {
    const provider = yield* LLMProvider

    const events = yield* provider
      .stream({
        model: settings.models.plainText,
        systemPrompt: 'Reply in one short sentence.',
        messages: [UserMessage.make({ content: 'Say hello.' })],
        tools: []
      })
      .pipe(Stream.runCollect)

    const entries = yield* (yield* ReplayLedger).entries

    return { events: Array.from(events), entries }
  }).pipe(
    Effect.provide(
      makeOpenAiProviderLayer({
        apiKey: settings.apiKey,
        maxCompletionTokens: settings.maxCompletionTokens,
        streaming: true
      }).pipe(Layer.provideMerge(ReplayHttpClient.layer([openAiChatPlainTextFixture], { faults })))
    )
  )

const hasFinish = (event: SseEvent): boolean => {
  const choices =
    isRecord(event.json) && Array.isArray(event.json.choices) ? event.json.choices : []

  return choices.some(choice => isRecord(choice) && Predicate.isString(choice.finish_reason))
}

const hasUsage = (event: SseEvent): boolean => isRecord(event.json) && isRecord(event.json.usage)

// The fixture's first `count` network chunks, as a truncating wire would deliver them.
const firstChunks = (fixture: WireFixture, count: number): WireFixture => ({
  ...fixture,
  exchanges: [
    {
      request: fixture.exchanges[0].request,
      response: {
        ...streamResponse(fixture),
        chunks: streamResponse(fixture).chunks.slice(0, count)
      }
    }
  ]
})

// The fewest network chunks that carry the whole finish event.
const chunksThroughFinish = (fixture: WireFixture): number => {
  const index = streamResponse(fixture).chunks.findIndex((_, chunk) =>
    sseEvents(firstChunks(fixture, chunk + 1)).some(hasFinish)
  )

  return index === -1 ? expect.fail(`${fixture.id} records no finish event`) : index + 1
}

describe('OpenAI chat streaming under wire faults', () => {
  it.effect('completes a stream cut after the finish chunk, marking usage unavailable', () =>
    Effect.gen(function* () {
      const fixture = openAiChatPlainTextFixture
      const kept = chunksThroughFinish(fixture)
      const keptEvents = sseEvents(firstChunks(fixture, kept))

      // The cut keeps the finish and drops the separate usage chunk.
      expect(keptEvents.some(hasFinish)).toBe(true)
      expect(keptEvents.some(hasUsage)).toBe(false)
      expect(sseEvents(fixture).some(hasUsage)).toBe(true)

      const { events, entries } = yield* streamPlainText([
        WireFault.TruncateAfterChunks({ chunks: kept })
      ])

      expect(doneSignals(events)).toEqual([['stop', true]])
      expect(events.some(event => event instanceof LLMUsage)).toBe(false)
      expect(entries.map(entry => [entry.match.outcome, entry.fault])).toEqual([
        ['matched', 'TruncateAfterChunks']
      ])
    })
  )

  it.effect('leaves Done unmarked when the usage chunk arrives', () =>
    Effect.gen(function* () {
      const { events } = yield* streamPlainText()

      expect(doneSignals(events)).toEqual([['stop', undefined]])
      expect(events.some(event => event instanceof LLMUsage)).toBe(true)
    })
  )
})
