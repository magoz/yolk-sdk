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
  AnthropicConformanceConfig,
  anthropicConformanceCases,
  anthropicConformanceDefaultModels,
  anthropicConformanceFixtures,
  anthropicConformanceMessagesUrl,
  anthropicConformanceTruncatedMaxTokens,
  anthropicConformanceVersion,
  anthropicMessagesErrorEnvelopeCase,
  anthropicMessagesErrorEnvelopeFixture,
  anthropicMessagesMaxTokensCase,
  anthropicMessagesMaxTokensFixture,
  anthropicMessagesPlainTextCase,
  anthropicMessagesPlainTextFixture,
  anthropicMessagesThinkingBeforeTextCase,
  anthropicMessagesThinkingBeforeTextFixture,
  anthropicMessagesToolUseInputDeltasCase,
  anthropicMessagesToolUseInputDeltasFixture,
  type AnthropicConformanceCase,
  type AnthropicConformanceSettings
} from '../../../src/providers/anthropic/conformance/index.ts'

const now = new Date('2026-09-30T12:00:00.000Z')

const settings: AnthropicConformanceSettings = {
  apiKey: Redacted.make('synthetic-anthropic-key'),
  maxTokens: 64,
  thinkingBudgetTokens: 1024,
  models: anthropicConformanceDefaultModels
}

const configLayer = Layer.succeed(AnthropicConformanceConfig, settings)

const fixturesFor = (
  testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>,
  fixtures: ReadonlyArray<WireFixture> = anthropicConformanceFixtures
) => fixtures.filter(fixture => testCase.fixtures.includes(fixture.id))

const replayCaseLayer = (testCase: AnthropicConformanceCase) =>
  Layer.mergeAll(ReplayHttpClient.layer(fixturesFor(testCase)), configLayer)

const caseCount = anthropicConformanceCases.length

describe('Anthropic Messages conformance cases', () => {
  it('are read-only, unverified, and backed by the Anthropic fixtures', () => {
    expect(caseCount).toBe(5)
    expect(anthropicConformanceCases.map(testCase => testCase.id)).toEqual(
      anthropicConformanceFixtures.map(fixture => fixture.caseId)
    )

    for (const testCase of anthropicConformanceCases) {
      expect(testCase.safety).toBe('read')
      expect(testCase.observed).toBeUndefined()
      expect(fixturesFor(testCase).map(fixture => fixture.caseId)).toEqual([testCase.id])
    }

    for (const fixture of anthropicConformanceFixtures) {
      expect(fixture).toMatchObject({
        evidence: 'unverified',
        account: 'synthetic',
        endpoint: anthropicConformanceMessagesUrl
      })
    }
  })

  it.effect('decode, pass the secret scan, and stay synthetic', () =>
    Effect.gen(function* () {
      for (const fixture of anthropicConformanceFixtures) {
        expect((yield* decodeWireFixture(fixture)).id).toBe(fixture.id)
        expect(scanFixtureForSecrets(fixture)).toEqual([])
      }
    })
  )

  it.effect('all pass against the replayed fixtures with unverified warnings', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(anthropicConformanceCases, {
        target: { kind: 'replay' },
        now,
        fixtures: anthropicConformanceFixtures,
        layer: replayCaseLayer
      })

      expect(report.target).toEqual({ kind: 'replay' })
      expect(report.summary, formatConformanceReport(report)).toEqual({
        passed: caseCount,
        failed: 0,
        skipped: 0
      })
      expect(conformanceReportFailed(report)).toBe(false)

      // Expected warnings and report lines derive from the fixtures, so a verified live recording
      // keeps this test valid.
      expect(report.results.map(result => result.warnings)).toEqual(
        anthropicConformanceFixtures.map(fixture =>
          fixture.evidence === 'unverified'
            ? [{ kind: 'unverified-case' }, { kind: 'unverified-fixture', fixtureId: fixture.id }]
            : [{ kind: 'unverified-case' }]
        )
      )

      expect(formatConformanceReport(report).split('\n')).toEqual([
        ...anthropicConformanceFixtures.map(fixture =>
          [
            `PASS  ${fixture.caseId}  [read]  warnings: unverified-case`,
            fixture.evidence === 'unverified' ? `, unverified-fixture:${fixture.id}` : ''
          ].join('')
        ),
        `${caseCount} passed, 0 failed, 0 skipped; target replay; started 2026-09-30T12:00:00.000Z`
      ])
    })
  )

  it.effect('run only on read-safe live targets with case-level warnings only', () =>
    Effect.gen(function* () {
      // The host's live HttpClient is replaced by replay here: the exact seam a host swaps.
      const report = yield* runConformance(anthropicConformanceCases, {
        target: { kind: 'live', account: 'synthetic' },
        now,
        fixtures: anthropicConformanceFixtures,
        layer: replayCaseLayer
      })

      expect(report.summary).toEqual({ passed: caseCount, failed: 0, skipped: 0 })
      expect(report.results.map(result => result.warnings)).toEqual(
        anthropicConformanceCases.map(() => [{ kind: 'unverified-case' }])
      )
    })
  )

  it.effect('send the claimed requests (asserted through the replay ledger)', () =>
    Effect.gen(function* () {
      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance(anthropicConformanceCases, {
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

      expect(report.summary.passed).toBe(caseCount)

      const byCase = yield* Ref.get(ledgers)

      const bodyOf = (testCase: AnthropicConformanceCase) =>
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
            url: anthropicConformanceMessagesUrl,
            match: { outcome: 'matched' },
            headers: {
              'x-api-key': '<redacted>',
              'anthropic-version': anthropicConformanceVersion,
              accept: 'text/event-stream'
            }
          })
          // Native Messages: an API key, never a bearer credential or Claude OAuth betas.
          expect(entries[0]?.headers).not.toHaveProperty('authorization')
          expect(entries[0]?.headers).not.toHaveProperty('anthropic-beta')
          // Replay matches method + URL only; the fixture's request body must still be exactly
          // what the provider sends.
          expect(entries[0]?.bodyJson).toEqual(
            fixturesFor(testCase)[0]?.exchanges[0].request.body ?? expect.fail('no fixture body')
          )

          return entries[0]?.bodyJson
        })

      const system = [{ type: 'text', text: 'Reply in one short sentence.' }]

      const plainBody = yield* bodyOf(anthropicMessagesPlainTextCase)

      expect(plainBody).toEqual({
        model: settings.models.plainText,
        system,
        messages: [{ role: 'user', content: 'Say hello.' }],
        max_tokens: settings.maxTokens,
        stream: true
      })

      // Native tool names (no `mcp_` rewriting) and a forced tool choice.
      expect(yield* bodyOf(anthropicMessagesToolUseInputDeltasCase)).toMatchObject({
        tool_choice: { type: 'tool', name: 'lookup_weather' },
        model: settings.models.toolUse,
        system,
        max_tokens: settings.maxTokens,
        stream: true,
        tools: [{ name: 'lookup_weather', input_schema: { required: ['city'] } }]
      })

      const thinkingBody = yield* bodyOf(anthropicMessagesThinkingBeforeTextCase)

      expect(thinkingBody).toMatchObject({
        thinking: { type: 'enabled', budget_tokens: settings.thinkingBudgetTokens },
        model: settings.models.thinking,
        max_tokens: settings.maxTokens + settings.thinkingBudgetTokens,
        stream: true
      })
      expect(thinkingBody).not.toHaveProperty('tool_choice')

      const errorBody = yield* bodyOf(anthropicMessagesErrorEnvelopeCase)

      expect(errorBody).toMatchObject({ model: settings.models.invalid, stream: true })
      expect(errorBody).not.toHaveProperty('thinking')

      expect(yield* bodyOf(anthropicMessagesMaxTokensCase)).toMatchObject({
        model: settings.models.plainText,
        max_tokens: anthropicConformanceTruncatedMaxTokens,
        stream: true
      })

      expect(plainBody).not.toHaveProperty('tool_choice')
      expect(plainBody).not.toHaveProperty('thinking')
    })
  )
})

// Disagreement drills: replay a fixture that contradicts a claim and check the matching case fails
// with a ConformanceMismatch instead of passing. Fixtures are mutated structurally (parsed SSE
// events, parsed JSON bodies, parsed tool input, status codes), never by matching their text, so
// the drills keep working when live recordings replace the synthetic placeholders.

type SseEvent = {
  readonly event: string | undefined
  readonly data: string
  readonly json: unknown
}

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
    .flatMap(block => {
      const lines = block.split('\n')

      const event = lines
        .find(line => line.startsWith('event:'))
        ?.slice('event:'.length)
        .trim()

      const data = lines
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice('data:'.length).trim())
        .join('\n')

      return data.length === 0 ? [] : [{ event, data, json: parseJson(data) }]
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
          chunks: events.map(
            event =>
              `${event.event === undefined ? '' : `event: ${event.event}\n`}data: ${
                event.json === undefined ? event.data : JSON.stringify(event.json)
              }\n\n`
          )
        }
      }
    ]
  }
}

const typeOf = (event: SseEvent): unknown => (isRecord(event.json) ? event.json.type : undefined)

// Deep copy of an event with its parsed JSON edited, so edits never touch the committed fixture.
const mapJson = (event: SseEvent, update: (json: JsonRecord) => void): SseEvent => {
  const json: unknown = event.json === undefined ? undefined : structuredClone(event.json)

  if (isRecord(json)) update(json)

  return { event: event.event, data: event.data, json }
}

const deltaOf = (json: unknown): JsonRecord | undefined =>
  isRecord(json) && isRecord(json.delta) ? json.delta : undefined

const blockIndexOf = (event: SseEvent): unknown =>
  isRecord(event.json) ? event.json.index : undefined

const blockTypeAt = (events: ReadonlyArray<SseEvent>, index: unknown): unknown => {
  const start = events.find(
    event => typeOf(event) === 'content_block_start' && blockIndexOf(event) === index
  )

  return isRecord(start?.json) && isRecord(start.json.content_block)
    ? start.json.content_block.type
    : undefined
}

const blockEvents = (events: ReadonlyArray<SseEvent>, type: string) =>
  events.filter(
    event =>
      Predicate.isString(typeOf(event)) &&
      String(typeOf(event)).startsWith('content_block_') &&
      blockTypeAt(events, blockIndexOf(event)) === type
  )

const drill = (testCase: AnthropicConformanceCase, fixture: WireFixture) =>
  Effect.gen(function* () {
    const report = yield* runConformance([testCase], {
      target: { kind: 'replay' },
      now,
      layer: () => Layer.mergeAll(ReplayHttpClient.layer([fixture]), configLayer)
    })

    return report.results[0]
  })

const failedDrill = (testCase: AnthropicConformanceCase, fixture: WireFixture) =>
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

const withStopReason = (events: ReadonlyArray<SseEvent>, stopReason: string) =>
  events.map(event =>
    typeOf(event) === 'message_delta'
      ? mapJson(event, json => {
          if (isRecord(json.delta)) json.delta.stop_reason = stopReason
        })
      : event
  )

describe('Anthropic Messages conformance disagreement drills', () => {
  it.effect('fails the tool-use case when the assembled input lacks the claimed key', () =>
    Effect.gen(function* () {
      const events = sseEvents(anthropicMessagesToolUseInputDeltasFixture)

      const isInputDelta = (event: SseEvent) => deltaOf(event.json)?.type === 'input_json_delta'

      const assembled = events
        .filter(isInputDelta)
        .map(event => deltaOf(event.json)?.partial_json)
        .filter(Predicate.isString)
        .join('')

      const params = parseJson(assembled)

      if (!isRecord(params) || !('city' in params)) {
        return expect.fail('recorded tool input carries no `city`')
      }

      const { city, ...rest } = params
      const renamed = JSON.stringify({ ...rest, town: city })
      let written = false

      // The whole renamed input goes into the first fragment; later fragments are empty.
      const rewritten = events.map(event =>
        isInputDelta(event)
          ? mapJson(event, json => {
              if (isRecord(json.delta)) json.delta.partial_json = written ? '' : renamed
              written = true
            })
          : event
      )

      expect(
        yield* failedDrill(
          anthropicMessagesToolUseInputDeltasCase,
          withEvents(anthropicMessagesToolUseInputDeltasFixture, rewritten)
        )
      ).toEqual(mismatch('expected a non-empty string `city` argument'))
    })
  )

  it.effect('passes the plain-text case when the whole answer is one text delta', () =>
    Effect.gen(function* () {
      const events = sseEvents(anthropicMessagesPlainTextFixture)
      const isText = (event: SseEvent) => deltaOf(event.json)?.type === 'text_delta'

      const text = events
        .filter(isText)
        .map(event => deltaOf(event.json)?.text)
        .filter(Predicate.isString)
        .join('')

      expect(text.trim().length).toBeGreaterThan(0)

      const firstText = events.findIndex(isText)

      const single = events.flatMap((event, index) => {
        if (index === firstText) {
          return [
            mapJson(event, json => {
              if (isRecord(json.delta)) json.delta.text = text
            })
          ]
        }

        return isText(event) ? [] : [event]
      })

      expect(single.filter(isText)).toHaveLength(1)

      const result = yield* drill(
        anthropicMessagesPlainTextCase,
        withEvents(anthropicMessagesPlainTextFixture, single)
      )

      expect(result?.status).toBe('passed')
    })
  )

  it.effect('fails the plain-text case when the stream reports no usage', () =>
    Effect.gen(function* () {
      const withoutUsage = sseEvents(anthropicMessagesPlainTextFixture).map(event =>
        mapJson(event, json => {
          delete json.usage

          if (isRecord(json.message)) delete json.message.usage
        })
      )

      expect(
        yield* failedDrill(
          anthropicMessagesPlainTextCase,
          withEvents(anthropicMessagesPlainTextFixture, withoutUsage)
        )
      ).toEqual(mismatch('expected a usage report'))
    })
  )

  it.effect('fails the plain-text case when the streamed text is empty', () =>
    Effect.gen(function* () {
      const empty = sseEvents(anthropicMessagesPlainTextFixture).map(event =>
        deltaOf(event.json)?.type === 'text_delta'
          ? mapJson(event, json => {
              if (isRecord(json.delta)) json.delta.text = ''
            })
          : event
      )

      expect(
        yield* failedDrill(
          anthropicMessagesPlainTextCase,
          withEvents(anthropicMessagesPlainTextFixture, empty)
        )
      ).toEqual(mismatch('expected non-empty answer text'))
    })
  )

  it.effect('fails the plain-text case when a thinking block streams without a request', () =>
    Effect.gen(function* () {
      // The recorded thinking block, spliced in before the plain-text answer at a free index.
      const thinking = blockEvents(
        sseEvents(anthropicMessagesThinkingBeforeTextFixture),
        'thinking'
      ).map(event =>
        mapJson(event, json => {
          json.index = 99
        })
      )

      const events = sseEvents(anthropicMessagesPlainTextFixture)
      const firstBlock = events.findIndex(event => typeOf(event) === 'content_block_start')

      expect(
        yield* failedDrill(
          anthropicMessagesPlainTextCase,
          withEvents(anthropicMessagesPlainTextFixture, [
            ...events.slice(0, firstBlock),
            ...thinking,
            ...events.slice(firstBlock)
          ])
        )
      ).toEqual(mismatch('expected no reasoning without a thinking request'))
    })
  )

  it.effect('fails the plain-text case when the stream stops with max_tokens', () =>
    Effect.gen(function* () {
      const result = yield* drill(
        anthropicMessagesPlainTextCase,
        withEvents(
          anthropicMessagesPlainTextFixture,
          withStopReason(sseEvents(anthropicMessagesPlainTextFixture), 'max_tokens')
        )
      )

      expect(result?.status).toBe('failed')
      expect(result?.failure?.tag).toBe('LLMError')
    })
  )

  it.effect('fails the plain-text case when the stream ends without message_stop', () =>
    Effect.gen(function* () {
      const truncated = sseEvents(anthropicMessagesPlainTextFixture).filter(
        event => typeOf(event) !== 'message_stop'
      )

      const result = yield* drill(
        anthropicMessagesPlainTextCase,
        withEvents(anthropicMessagesPlainTextFixture, truncated)
      )

      expect(result?.status).toBe('failed')
      expect(result?.failure?.tag).toBe('LLMError')
    })
  )

  it.effect('fails the thinking case when the thinking block follows the text', () =>
    Effect.gen(function* () {
      const events = sseEvents(anthropicMessagesThinkingBeforeTextFixture)
      const thinking = blockEvents(events, 'thinking')
      const text = blockEvents(events, 'text')

      expect(thinking.length).toBeGreaterThan(0)
      expect(text.length).toBeGreaterThan(0)

      const blocks = new Set([...thinking, ...text])
      const firstBlock = events.findIndex(event => blocks.has(event))
      const rest = events.filter((event, index) => index >= firstBlock && !blocks.has(event))

      expect(
        yield* failedDrill(
          anthropicMessagesThinkingBeforeTextCase,
          withEvents(anthropicMessagesThinkingBeforeTextFixture, [
            ...events.slice(0, firstBlock),
            ...text,
            ...thinking,
            ...rest
          ])
        )
      ).toEqual(mismatch('expected all reasoning before the answer text'))
    })
  )

  it.effect('fails the thinking case when the response has no thinking block', () =>
    Effect.gen(function* () {
      const events = sseEvents(anthropicMessagesThinkingBeforeTextFixture)
      const thinking = new Set(blockEvents(events, 'thinking'))

      expect(
        yield* failedDrill(
          anthropicMessagesThinkingBeforeTextCase,
          withEvents(
            anthropicMessagesThinkingBeforeTextFixture,
            events.filter(event => !thinking.has(event))
          )
        )
      ).toEqual(mismatch('expected non-empty reasoning'))
    })
  )

  it.effect('fails the max-tokens case when the turn ends normally', () =>
    Effect.gen(function* () {
      expect(
        yield* failedDrill(
          anthropicMessagesMaxTokensCase,
          withEvents(
            anthropicMessagesMaxTokensFixture,
            withStopReason(sseEvents(anthropicMessagesMaxTokensFixture), 'end_turn')
          )
        )
      ).toEqual(mismatch('expected no Done for a truncated turn'))
    })
  )

  it.effect('fails the max-tokens case for a different invalid response', () =>
    Effect.gen(function* () {
      // No `message_stop` after an `end_turn`: invalid, but not a max_tokens stop.
      const events = withStopReason(sseEvents(anthropicMessagesMaxTokensFixture), 'end_turn')

      expect(
        yield* failedDrill(
          anthropicMessagesMaxTokensCase,
          withEvents(
            anthropicMessagesMaxTokensFixture,
            events.filter(event => typeOf(event) !== 'message_stop')
          )
        )
      ).toMatchObject({
        tag: 'ConformanceMismatch',
        message: 'expected the failure to name max_tokens'
      })
    })
  )

  const errorBody = (): string => {
    const response = anthropicMessagesErrorEnvelopeFixture.exchanges[0].response

    return 'body' in response && Predicate.isString(response.body)
      ? response.body
      : expect.fail('error fixture has no text body')
  }

  it('records the not_found_error envelope in the error fixture', () => {
    expect(anthropicMessagesErrorEnvelopeFixture.exchanges[0].response.status).toBe(404)
    expect(parseJson(errorBody())).toMatchObject({
      type: 'error',
      error: { type: 'not_found_error' }
    })
  })

  for (const status of [401, 403]) {
    it.effect(`fails the error-envelope case for a ${status} authentication failure`, () =>
      Effect.gen(function* () {
        expect(
          yield* failedDrill(
            anthropicMessagesErrorEnvelopeCase,
            withResponse(
              anthropicMessagesErrorEnvelopeFixture,
              `status-${status}`,
              status,
              JSON.stringify({
                type: 'error',
                error: { type: 'authentication_error', message: 'synthetic' }
              })
            )
          )
        ).toEqual(
          mismatch('expected a model rejection, not an authentication or permission failure')
        )
      })
    )
  }

  it.effect('fails the error-envelope case for a non-404 request error', () =>
    Effect.gen(function* () {
      for (const status of [400, 422]) {
        expect(
          yield* failedDrill(
            anthropicMessagesErrorEnvelopeCase,
            withResponse(
              anthropicMessagesErrorEnvelopeFixture,
              `status-${status}`,
              status,
              errorBody()
            )
          )
        ).toEqual(mismatch('expected a 404 model-rejection status'))
      }
    })
  )

  it.effect('fails the error-envelope case when the unknown model is accepted', () =>
    Effect.gen(function* () {
      const accepted: WireFixture = {
        ...anthropicMessagesErrorEnvelopeFixture,
        id: `${anthropicMessagesErrorEnvelopeFixture.id}.accepted`,
        exchanges: [
          {
            request: anthropicMessagesErrorEnvelopeFixture.exchanges[0].request,
            response: streamResponse(anthropicMessagesPlainTextFixture)
          }
        ]
      }

      expect(yield* failedDrill(anthropicMessagesErrorEnvelopeCase, accepted)).toEqual(
        mismatch('expected an error envelope, the request succeeded')
      )
    })
  )

  it.effect('reports provider failures (not mismatches) with sanitized messages', () =>
    Effect.gen(function* () {
      const overloaded = withResponse(
        anthropicMessagesPlainTextFixture,
        'overloaded',
        529,
        '{"type":"error","error":{"type":"overloaded_error","message":"synthetic upstream detail"}}'
      )

      expect(yield* failedDrill(anthropicMessagesPlainTextCase, overloaded)).toEqual({
        kind: 'failure',
        tag: 'LLMError',
        message: 'Anthropic Messages overloaded'
      })
    })
  )

  it('keeps a defined case id aligned with defineConformanceCase validation', () => {
    expect(() =>
      defineConformanceCase({ ...anthropicMessagesPlainTextCase, id: 'Anthropic.Bad' })
    ).toThrow(/Invalid conformance case/)
  })
})
