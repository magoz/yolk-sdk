/**
 * OpenCode Go conformance cases (`providers/opencode/conformance`): replay, request claims through
 * the replay ledger, and structural disagreement drills over the parsed fixtures (never text
 * matches, so the drills keep working when live recordings replace the synthetic placeholders).
 */
import { Effect, Layer, Predicate, Redacted, Ref } from 'effect'
import { HttpClient } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import type { ConformanceCase } from '@yolk-sdk/conformance/case'
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
  OpenCodeGoConformanceConfig,
  openCodeGoChatPlainTextCase,
  openCodeGoChatPlainTextFixture,
  openCodeGoConformanceBaseUrl,
  openCodeGoConformanceCases,
  openCodeGoConformanceDefaultModels,
  openCodeGoConformanceFixtures,
  openCodeGoConformanceUsageUrl,
  openCodeGoMessagesPlainTextCase,
  openCodeGoMessagesPlainTextFixture,
  openCodeGoResponsesCommentaryReplayCase,
  openCodeGoResponsesCommentaryReplayFixture,
  openCodeGoResponsesPlainTextCase,
  openCodeGoResponsesPlainTextFixture,
  openCodeGoUsageSnapshotCase,
  openCodeGoUsageSnapshotFixture,
  type OpenCodeGoConformanceCase
} from '../../../src/providers/opencode/conformance/index.ts'

const now = new Date('2026-09-30T12:00:00.000Z')

const configLayer = Layer.succeed(OpenCodeGoConformanceConfig, {
  apiKey: Redacted.make('synthetic-go-key'),
  maxOutputTokens: 64,
  models: openCodeGoConformanceDefaultModels
})

const fixturesFor = (testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>) =>
  openCodeGoConformanceFixtures.filter(fixture => testCase.fixtures.includes(fixture.id))

const replayCaseLayer = (testCase: OpenCodeGoConformanceCase) =>
  Layer.mergeAll(ReplayHttpClient.layer(fixturesFor(testCase)), configLayer)

const drill = (testCase: OpenCodeGoConformanceCase, fixture: WireFixture) =>
  runConformance([testCase], {
    target: { kind: 'replay' },
    now,
    layer: () => Layer.mergeAll(ReplayHttpClient.layer([fixture]), configLayer)
  }).pipe(Effect.map(report => report.results[0]))

const failedDrill = (testCase: OpenCodeGoConformanceCase, fixture: WireFixture) =>
  drill(testCase, fixture).pipe(
    Effect.map(result => {
      expect(result?.status, fixture.id).toBe('failed')

      return result?.failure
    })
  )

const mismatch = (message: string) => ({ kind: 'failure', tag: 'ConformanceMismatch', message })

// Structural SSE editing over parsed events.

type Json = null | boolean | number | string | Array<Json> | JsonRecord

type JsonRecord = { [key: string]: Json }

type SseEvent = { readonly event: string | undefined; readonly json: unknown; readonly raw: string }

const isRecord = (value: unknown): value is JsonRecord =>
  Predicate.isObject(value) && !Array.isArray(value)

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const streamResponse = (fixture: WireFixture) => {
  const response = fixture.exchanges[0].response

  return isWireStreamResponse(response) ? response : expect.fail(`${fixture.id} is not a stream`)
}

const sseEvents = (fixture: WireFixture): Array<SseEvent> =>
  streamResponse(fixture)
    .chunks.map(chunk => (Predicate.isString(chunk) ? chunk : expect.fail('text chunks only')))
    .join('')
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

      return data.length === 0 ? [] : [{ event, json: parseJson(data), raw: data }]
    })

const withEvents = (
  fixture: WireFixture,
  events: ReadonlyArray<SseEvent>,
  suffix: string
): WireFixture => ({
  ...fixture,
  id: `${fixture.id}.${suffix}`,
  exchanges: [
    {
      request: fixture.exchanges[0].request,
      response: {
        ...streamResponse(fixture),
        chunks: events.map(
          event =>
            `${event.event === undefined ? '' : `event: ${event.event}\n`}data: ${
              event.json === undefined ? event.raw : JSON.stringify(event.json)
            }\n\n`
        )
      }
    }
  ]
})

const mapJson = (event: SseEvent, update: (json: JsonRecord) => void): SseEvent => {
  const json: unknown = event.json === undefined ? undefined : structuredClone(event.json)

  if (isRecord(json)) update(json)

  return { ...event, json }
}

const typeOf = (event: SseEvent): unknown => (isRecord(event.json) ? event.json.type : undefined)

const visitRecords = (value: unknown, visit: (record: JsonRecord) => void): void => {
  if (Array.isArray(value)) {
    for (const item of value) visitRecords(item, visit)

    return
  }

  if (!isRecord(value)) return

  visit(value)

  for (const item of Object.values(value)) visitRecords(item, visit)
}

describe('OpenCode Go conformance cases', () => {
  it('are read-only, unverified, and backed by one fixture each', () => {
    expect(openCodeGoConformanceCases.map(testCase => testCase.id)).toEqual([
      'opencode.go.chat.stream.plain-text',
      'opencode.go.messages.stream.plain-text',
      'opencode.go.responses.stream.plain-text',
      'opencode.go.responses.stream.commentary-replay',
      'opencode.go.usage.snapshot'
    ])
    expect(openCodeGoConformanceCases.map(testCase => testCase.id)).toEqual(
      openCodeGoConformanceFixtures.map(fixture => fixture.caseId)
    )

    for (const testCase of openCodeGoConformanceCases) {
      expect(testCase.safety).toBe('read')
      expect(testCase.observed).toBeUndefined()
      expect(fixturesFor(testCase).map(fixture => fixture.caseId)).toEqual([testCase.id])
    }

    for (const fixture of openCodeGoConformanceFixtures) {
      expect(fixture).toMatchObject({ evidence: 'unverified', account: 'synthetic' })
      expect(fixture.exchanges[0].request.url.startsWith(openCodeGoConformanceBaseUrl)).toBe(true)
    }

    expect(openCodeGoUsageSnapshotFixture.exchanges[0].request.url).toBe(
      openCodeGoConformanceUsageUrl
    )
  })

  it.effect('decode and pass the secret scan', () =>
    Effect.gen(function* () {
      for (const fixture of openCodeGoConformanceFixtures) {
        expect((yield* decodeWireFixture(fixture)).id).toBe(fixture.id)
        expect(scanFixtureForSecrets(fixture)).toEqual([])
      }
    })
  )

  it.effect('all pass against the replayed fixtures with unverified warnings', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(openCodeGoConformanceCases, {
        target: { kind: 'replay' },
        now,
        fixtures: openCodeGoConformanceFixtures,
        layer: replayCaseLayer
      })

      expect(report.summary, formatConformanceReport(report)).toEqual({
        passed: 5,
        failed: 0,
        skipped: 0
      })
      expect(conformanceReportFailed(report)).toBe(false)
      expect(report.results.map(result => result.warnings)).toEqual(
        openCodeGoConformanceFixtures.map(fixture => [
          { kind: 'unverified-case' },
          { kind: 'unverified-fixture', fixtureId: fixture.id }
        ])
      )
    })
  )

  it.effect('run on read-safe live targets with case-level warnings only', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(openCodeGoConformanceCases, {
        target: { kind: 'live', account: 'synthetic' },
        now,
        fixtures: openCodeGoConformanceFixtures,
        layer: replayCaseLayer
      })

      expect(report.summary).toEqual({ passed: 5, failed: 0, skipped: 0 })
      expect(report.results.map(result => result.warnings)).toEqual(
        openCodeGoConformanceCases.map(() => [{ kind: 'unverified-case' }])
      )
    })
  )

  it.effect('send the claimed requests (asserted through the replay ledger)', () =>
    Effect.gen(function* () {
      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance(openCodeGoConformanceCases, {
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

      expect(report.summary.passed).toBe(5)

      const byCase = yield* Ref.get(ledgers)

      const entryOf = (testCase: OpenCodeGoConformanceCase) =>
        Effect.gen(function* () {
          const ledger = byCase.get(testCase.id) ?? expect.fail(`no ledger for ${testCase.id}`)
          const entries = yield* ledger.entries

          expect(yield* ledger.remaining).toEqual([])
          expect(entries, testCase.id).toHaveLength(1)

          const [fixture] = fixturesFor(testCase)

          // Replay matches method + URL only; the fixture body must be exactly what is sent.
          if (fixture?.exchanges[0].request.body !== undefined) {
            expect(entries[0]?.bodyJson, testCase.id).toEqual(fixture.exchanges[0].request.body)
          }

          return entries[0] ?? expect.fail('no entry')
        })

      const chat = yield* entryOf(openCodeGoChatPlainTextCase)

      expect(chat).toMatchObject({
        method: 'POST',
        url: `${openCodeGoConformanceBaseUrl}/chat/completions`,
        headers: { authorization: '<redacted>', accept: 'text/event-stream' },
        bodyJson: {
          model: openCodeGoConformanceDefaultModels.chat,
          max_tokens: 64,
          stream: true,
          stream_options: { include_usage: true }
        }
      })
      expect(chat.headers).not.toHaveProperty('x-api-key')
      expect(chat.bodyJson).not.toHaveProperty('max_completion_tokens')

      const messages = yield* entryOf(openCodeGoMessagesPlainTextCase)

      expect(messages).toMatchObject({
        method: 'POST',
        url: `${openCodeGoConformanceBaseUrl}/messages`,
        headers: {
          'x-api-key': '<redacted>',
          'anthropic-version': '2023-06-01',
          accept: 'text/event-stream'
        },
        bodyJson: {
          model: openCodeGoConformanceDefaultModels.messages,
          max_tokens: 64,
          stream: true,
          system: [{ type: 'text', text: 'Reply in one short sentence.' }]
        }
      })
      // Native Messages: no Claude OAuth fingerprint.
      expect(messages.headers).not.toHaveProperty('authorization')
      expect(messages.headers).not.toHaveProperty('anthropic-beta')

      for (const testCase of [
        openCodeGoResponsesPlainTextCase,
        openCodeGoResponsesCommentaryReplayCase
      ]) {
        expect(yield* entryOf(testCase)).toMatchObject({
          method: 'POST',
          url: `${openCodeGoConformanceBaseUrl}/responses`,
          headers: { authorization: '<redacted>', accept: 'text/event-stream' },
          bodyJson: {
            model: openCodeGoConformanceDefaultModels.responses,
            max_output_tokens: 64,
            store: false,
            stream: true
          }
        })
      }

      const replay = yield* entryOf(openCodeGoResponsesCommentaryReplayCase)

      expect(replay.bodyJson).toMatchObject({
        input: [
          { role: 'user' },
          { role: 'assistant', phase: 'commentary' },
          { type: 'function_call', call_id: 'call_synthetic_weather' },
          { type: 'function_call_output', call_id: 'call_synthetic_weather' }
        ]
      })

      expect(yield* entryOf(openCodeGoUsageSnapshotCase)).toMatchObject({
        method: 'GET',
        url: openCodeGoConformanceUsageUrl,
        headers: { authorization: '<redacted>', accept: 'application/json' }
      })
    })
  )
})

describe('OpenCode Go conformance disagreement drills', () => {
  it.effect('fails each plain-text case when the streamed text is empty', () =>
    Effect.gen(function* () {
      const blank = (fixture: WireFixture) =>
        withEvents(
          fixture,
          sseEvents(fixture).map(event =>
            mapJson(event, json => {
              visitRecords(json, record => {
                if (Predicate.isString(record.content)) record.content = ''

                if (record.type === 'text_delta' || record.type === 'output_text') record.text = ''

                if (
                  record.type === 'response.output_text.delta' ||
                  record.type === 'response.output_text.done'
                ) {
                  record.delta = ''
                  record.text = ''
                }
              })
            })
          ),
          'blank'
        )

      for (const [testCase, fixture] of [
        [openCodeGoChatPlainTextCase, openCodeGoChatPlainTextFixture],
        [openCodeGoMessagesPlainTextCase, openCodeGoMessagesPlainTextFixture],
        [openCodeGoResponsesPlainTextCase, openCodeGoResponsesPlainTextFixture]
      ] as const) {
        expect(yield* failedDrill(testCase, blank(fixture)), testCase.id).toEqual(
          mismatch('expected non-empty answer text')
        )
      }
    })
  )

  it.effect('fails the chat case without the usage chunk', () =>
    Effect.gen(function* () {
      const events = sseEvents(openCodeGoChatPlainTextFixture).filter(
        event => !(isRecord(event.json) && 'usage' in event.json)
      )

      expect(
        yield* failedDrill(
          openCodeGoChatPlainTextCase,
          withEvents(openCodeGoChatPlainTextFixture, events, 'no-usage')
        )
      ).toEqual(mismatch('expected a usage report'))
    })
  )

  it.effect('fails the chat case for a length finish', () =>
    Effect.gen(function* () {
      const events = sseEvents(openCodeGoChatPlainTextFixture).map(event =>
        mapJson(event, json => {
          visitRecords(json, record => {
            if (record.finish_reason === 'stop') record.finish_reason = 'length'
          })
        })
      )

      const result = yield* drill(
        openCodeGoChatPlainTextCase,
        withEvents(openCodeGoChatPlainTextFixture, events, 'length')
      )

      expect(result?.status).toBe('failed')
      expect(result?.failure?.tag).toBe('LLMError')
    })
  )

  it.effect('fails the Messages and Responses cases without their terminal event', () =>
    Effect.gen(function* () {
      for (const [testCase, fixture, terminal] of [
        [openCodeGoMessagesPlainTextCase, openCodeGoMessagesPlainTextFixture, 'message_stop'],
        [
          openCodeGoResponsesPlainTextCase,
          openCodeGoResponsesPlainTextFixture,
          'response.completed'
        ],
        [
          openCodeGoResponsesCommentaryReplayCase,
          openCodeGoResponsesCommentaryReplayFixture,
          'response.completed'
        ]
      ] as const) {
        const events = sseEvents(fixture)

        expect(events.some(event => typeOf(event) === terminal)).toBe(true)

        const result = yield* drill(
          testCase,
          withEvents(
            fixture,
            events.filter(event => typeOf(event) !== terminal),
            'no-terminal'
          )
        )

        expect(result?.status, testCase.id).toBe('failed')
        expect(result?.failure?.tag, testCase.id).toBe('LLMError')
      }
    })
  )

  it.effect('fails the commentary case when the endpoint rejects the replayed input', () =>
    Effect.gen(function* () {
      const fixture = openCodeGoResponsesCommentaryReplayFixture

      const rejected: WireFixture = {
        ...fixture,
        id: `${fixture.id}.rejected`,
        exchanges: [
          {
            request: fixture.exchanges[0].request,
            response: {
              status: 400,
              headers: { 'content-type': 'application/json' },
              body: '{"error":{"message":"synthetic: unknown input field phase","type":"invalid_request_error","param":"input","code":"unknown_parameter"}}'
            }
          }
        ]
      }

      const result = yield* drill(openCodeGoResponsesCommentaryReplayCase, rejected)

      expect(result?.status).toBe('failed')
      expect(result?.failure).toEqual({
        kind: 'failure',
        tag: 'LLMError',
        message: 'OpenCode Go provider_error'
      })
    })
  )

  it.effect('fails the usage case for an empty body and an auth rejection', () =>
    Effect.gen(function* () {
      const withBody = (suffix: string, status: number, body: string): WireFixture => ({
        ...openCodeGoUsageSnapshotFixture,
        id: `${openCodeGoUsageSnapshotFixture.id}.${suffix}`,
        exchanges: [
          {
            request: openCodeGoUsageSnapshotFixture.exchanges[0].request,
            response: { status, headers: { 'content-type': 'application/json' }, body }
          }
        ]
      })

      expect(
        yield* failedDrill(openCodeGoUsageSnapshotCase, withBody('empty', 200, '{"usage":{}}'))
      ).toEqual(mismatch('expected at least one usage window'))

      const unauthorized = yield* failedDrill(
        openCodeGoUsageSnapshotCase,
        withBody('unauthorized', 401, '{"error":{"message":"synthetic"}}')
      )

      expect(unauthorized?.tag).toBe('ProviderSubscriptionUsageAuthError')
    })
  )
})
