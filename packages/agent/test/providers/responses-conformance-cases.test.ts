/**
 * OpenAI Responses conformance cases for the Codex (`providers/openai/conformance`) and Grok
 * (`providers/xai/conformance`) subscription providers: replay, request claims through the replay
 * ledger, and structural disagreement drills. Both families share one case shape; the drills also
 * pin each provider's documented terminal-event behaviour (Grok requires `response.completed`,
 * Codex keeps EOF-completion compatibility).
 */
import { Effect, Layer, Predicate, Ref, Stream } from 'effect'
import { HttpClient } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import {
  defineConformanceCase,
  type ConformanceCase,
  type ConformanceMismatch
} from '@yolk-sdk/conformance/case'
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
  LLMDone,
  LLMError,
  LLMProvider,
  type LLMEvent,
  type LLMProviderError
} from '@yolk-sdk/agent/loop'
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import { UserMessage } from '@yolk-sdk/agent/protocol'
import { makeOpenAiCodexProviderLayer } from '../../src/providers/openai/codex-provider.ts'
import {
  OpenAiCodexConformanceConfig,
  openAiCodexConformanceCases,
  openAiCodexConformanceDefaultModels,
  openAiCodexConformanceFixtures,
  openAiCodexConformanceResponsesUrl,
  openAiCodexErrorEnvelopeCase,
  openAiCodexErrorEnvelopeFixture,
  openAiCodexFunctionCallArgumentsCase,
  openAiCodexFunctionCallArgumentsFixture,
  openAiCodexPlainTextCase,
  openAiCodexPlainTextFixture,
  openAiCodexTerminalEventCase,
  openAiCodexTerminalEventFixture,
  type OpenAiCodexConformanceSettings
} from '../../src/providers/openai/conformance/index.ts'
import {
  XAiGrokConformanceConfig,
  xAiGrokConformanceCases,
  xAiGrokConformanceDefaultModels,
  xAiGrokConformanceFixtures,
  xAiGrokConformanceResponsesUrl,
  xAiGrokErrorEnvelopeCase,
  xAiGrokErrorEnvelopeFixture,
  xAiGrokFunctionCallArgumentsCase,
  xAiGrokFunctionCallArgumentsFixture,
  xAiGrokPlainTextCase,
  xAiGrokPlainTextFixture,
  xAiGrokTerminalEventCase,
  xAiGrokTerminalEventFixture,
  type XAiGrokConformanceSettings
} from '../../src/providers/xai/conformance/index.ts'
import { makeXAiGrokProviderLayer } from '../../src/providers/xai/grok-provider.ts'

const now = new Date('2026-09-30T12:00:00.000Z')

// Far in the future so the Grok provider's expiry check passes on the real clock.
const expiresAt = 4_000_000_000_000

const codexSettings: OpenAiCodexConformanceSettings = {
  token: new OAuthAccessToken({
    provider: 'openai-codex',
    accessToken: 'synthetic-codex-oauth-token',
    expiresAt
  }),
  models: openAiCodexConformanceDefaultModels
}

const grokSettings: XAiGrokConformanceSettings = {
  token: new OAuthAccessToken({
    provider: 'xai-grok',
    accessToken: 'synthetic-grok-oauth-token',
    expiresAt
  }),
  clientVersion: '0.0.0-synthetic',
  maxOutputTokens: 64,
  models: xAiGrokConformanceDefaultModels
}

type ResponsesCase<Req> = ConformanceCase<
  LLMProviderError | ConformanceMismatch,
  HttpClient.HttpClient | Req
>

type Family<Req> = {
  readonly name: string
  readonly providerName: string
  readonly url: string
  readonly cases: ReadonlyArray<ResponsesCase<Req>>
  readonly fixtures: ReadonlyArray<WireFixture>
  readonly plainText: { readonly testCase: ResponsesCase<Req>; readonly fixture: WireFixture }
  readonly functionCall: { readonly testCase: ResponsesCase<Req>; readonly fixture: WireFixture }
  readonly errorEnvelope: { readonly testCase: ResponsesCase<Req>; readonly fixture: WireFixture }
  readonly terminal: { readonly testCase: ResponsesCase<Req>; readonly fixture: WireFixture }
  readonly configLayer: Layer.Layer<Req>
  readonly providerLayer: Layer.Layer<LLMProvider, never, HttpClient.HttpClient>
  /** Headers the provider sends besides `accept`, `content-type`, and the redacted bearer. */
  readonly headers: (model: string) => Readonly<Record<string, string>>
  /** Request body fields every case sends besides the model, instructions, and input. */
  readonly bodyFields: JsonRecord
  readonly allowsEofCompletion: boolean
}

const codex: Family<OpenAiCodexConformanceConfig> = {
  name: 'Codex',
  providerName: 'OpenAI Codex',
  url: openAiCodexConformanceResponsesUrl,
  cases: openAiCodexConformanceCases,
  fixtures: openAiCodexConformanceFixtures,
  plainText: { testCase: openAiCodexPlainTextCase, fixture: openAiCodexPlainTextFixture },
  functionCall: {
    testCase: openAiCodexFunctionCallArgumentsCase,
    fixture: openAiCodexFunctionCallArgumentsFixture
  },
  errorEnvelope: {
    testCase: openAiCodexErrorEnvelopeCase,
    fixture: openAiCodexErrorEnvelopeFixture
  },
  terminal: { testCase: openAiCodexTerminalEventCase, fixture: openAiCodexTerminalEventFixture },
  configLayer: Layer.succeed(OpenAiCodexConformanceConfig, codexSettings),
  providerLayer: makeOpenAiCodexProviderLayer({ token: codexSettings.token }),
  headers: () => ({ originator: 'opencode' }),
  bodyFields: { store: false, stream: true, reasoning: { effort: 'low', summary: 'auto' } },
  allowsEofCompletion: true
}

const grok: Family<XAiGrokConformanceConfig> = {
  name: 'Grok',
  providerName: 'xAI Grok subscription',
  url: xAiGrokConformanceResponsesUrl,
  cases: xAiGrokConformanceCases,
  fixtures: xAiGrokConformanceFixtures,
  plainText: { testCase: xAiGrokPlainTextCase, fixture: xAiGrokPlainTextFixture },
  functionCall: {
    testCase: xAiGrokFunctionCallArgumentsCase,
    fixture: xAiGrokFunctionCallArgumentsFixture
  },
  errorEnvelope: { testCase: xAiGrokErrorEnvelopeCase, fixture: xAiGrokErrorEnvelopeFixture },
  terminal: { testCase: xAiGrokTerminalEventCase, fixture: xAiGrokTerminalEventFixture },
  configLayer: Layer.succeed(XAiGrokConformanceConfig, grokSettings),
  providerLayer: makeXAiGrokProviderLayer({
    token: grokSettings.token,
    clientVersion: grokSettings.clientVersion,
    maxOutputTokens: grokSettings.maxOutputTokens
  }),
  headers: model => ({
    'x-grok-model-override': model,
    'x-grok-client-version': grokSettings.clientVersion
  }),
  bodyFields: { store: false, stream: true, max_output_tokens: grokSettings.maxOutputTokens },
  allowsEofCompletion: false
}

// Structural SSE editing: fixtures are parsed into events and rewritten, never matched as text, so
// the drills keep working when live recordings replace the synthetic placeholders.

type Json = null | boolean | number | string | Array<Json> | JsonRecord

type JsonRecord = { [key: string]: Json }

type SseEvent = {
  readonly event: string | undefined
  readonly data: string
  readonly json: unknown
}

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

const withEvents = (
  fixture: WireFixture,
  events: ReadonlyArray<SseEvent>,
  suffix = 'drill'
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
              event.json === undefined ? event.data : JSON.stringify(event.json)
            }\n\n`
        )
      }
    }
  ]
})

const withResponse = (
  fixture: WireFixture,
  suffix: string,
  status: number,
  body: string,
  contentType = 'application/json'
): WireFixture => ({
  ...fixture,
  id: `${fixture.id}.${suffix}`,
  exchanges: [
    {
      request: fixture.exchanges[0].request,
      response: { status, headers: { 'content-type': contentType }, body }
    }
  ]
})

const typeOf = (event: SseEvent): unknown => (isRecord(event.json) ? event.json.type : undefined)

/** Deep copy of an event with its parsed JSON edited (never touches the committed fixture). */
const mapJson = (event: SseEvent, update: (json: JsonRecord) => void): SseEvent => {
  const json: unknown = event.json === undefined ? undefined : structuredClone(event.json)

  if (isRecord(json)) update(json)

  return { event: event.event, data: event.data, json }
}

/** Visit every JSON object inside a value (depth first), for structural rewrites. */
const isJsonRecord = (value: Json | undefined): value is JsonRecord =>
  Predicate.isObject(value) && !Array.isArray(value)

const visitRecords = (value: Json | undefined, visit: (record: JsonRecord) => void): void => {
  if (Array.isArray(value)) {
    for (const item of value) visitRecords(item, visit)

    return
  }

  if (!isJsonRecord(value)) return

  visit(value)

  for (const item of Object.values(value)) visitRecords(item, visit)
}

const completedResponseOf = (event: SseEvent): JsonRecord | undefined =>
  typeOf(event) === 'response.completed' && isRecord(event.json) && isRecord(event.json.response)
    ? event.json.response
    : undefined

const doneReasons = (events: Iterable<LLMEvent>) =>
  Array.from(events).flatMap(event => (event instanceof LLMDone ? [event.stopReason] : []))

const mismatch = (message: string) => ({ kind: 'failure', tag: 'ConformanceMismatch', message })

const expectLlmError = (error: unknown): LLMError =>
  error instanceof LLMError ? error : expect.fail(`expected an LLMError, got ${String(error)}`)

const describeFamily = <Req>(family: Family<Req>) => {
  const fixturesFor = (testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>) =>
    family.fixtures.filter(fixture => testCase.fixtures.includes(fixture.id))

  const replayCaseLayer = (testCase: ResponsesCase<Req>) =>
    Layer.mergeAll(ReplayHttpClient.layer(fixturesFor(testCase)), family.configLayer)

  const caseCount = family.cases.length

  const drill = (testCase: ResponsesCase<Req>, fixture: WireFixture) =>
    runConformance([testCase], {
      target: { kind: 'replay' },
      now,
      layer: () => Layer.mergeAll(ReplayHttpClient.layer([fixture]), family.configLayer)
    }).pipe(Effect.map(report => report.results[0]))

  const failedDrill = (testCase: ResponsesCase<Req>, fixture: WireFixture) =>
    drill(testCase, fixture).pipe(
      Effect.map(result => {
        expect(result?.status, fixture.id).toBe('failed')

        return result?.failure
      })
    )

  /** The real provider against one replayed fixture, outside any case. */
  const streamFixture = (fixture: WireFixture) =>
    Effect.gen(function* () {
      const llm = yield* LLMProvider

      return Array.from(
        yield* llm
          .stream({
            model: fixture.model ?? 'unknown',
            systemPrompt: 'Reply in one short sentence.',
            messages: [UserMessage.make({ content: 'Say hello.' })],
            tools: []
          })
          .pipe(Stream.runCollect)
      )
    }).pipe(
      Effect.provide(family.providerLayer.pipe(Layer.provide(ReplayHttpClient.layer([fixture]))))
    )

  describe(`${family.name} Responses conformance cases`, () => {
    it('are read-only, unverified, and backed by one fixture each', () => {
      expect(caseCount).toBe(4)
      expect(family.cases.map(testCase => testCase.id)).toEqual(
        family.fixtures.map(fixture => fixture.caseId)
      )

      for (const testCase of family.cases) {
        expect(testCase.safety).toBe('read')
        expect(testCase.observed).toBeUndefined()
        expect(fixturesFor(testCase).map(fixture => fixture.caseId)).toEqual([testCase.id])
      }

      for (const fixture of family.fixtures) {
        expect(fixture).toMatchObject({
          evidence: 'unverified',
          account: 'synthetic',
          endpoint: family.url
        })
      }
    })

    it.effect('decode, pass the secret scan, and stay synthetic', () =>
      Effect.gen(function* () {
        for (const fixture of family.fixtures) {
          expect((yield* decodeWireFixture(fixture)).id).toBe(fixture.id)
          expect(scanFixtureForSecrets(fixture)).toEqual([])
        }
      })
    )

    it.effect('all pass against the replayed fixtures with unverified warnings', () =>
      Effect.gen(function* () {
        const report = yield* runConformance(family.cases, {
          target: { kind: 'replay' },
          now,
          fixtures: family.fixtures,
          layer: replayCaseLayer
        })

        expect(report.summary, formatConformanceReport(report)).toEqual({
          passed: caseCount,
          failed: 0,
          skipped: 0
        })
        expect(conformanceReportFailed(report)).toBe(false)
        expect(report.results.map(result => result.warnings)).toEqual(
          family.fixtures.map(fixture =>
            fixture.evidence === 'unverified'
              ? [{ kind: 'unverified-case' }, { kind: 'unverified-fixture', fixtureId: fixture.id }]
              : [{ kind: 'unverified-case' }]
          )
        )
      })
    )

    it.effect('run only on read-safe live targets with case-level warnings only', () =>
      Effect.gen(function* () {
        // The host's live HttpClient is replaced by replay here: the exact seam a host swaps.
        const report = yield* runConformance(family.cases, {
          target: { kind: 'live', account: 'synthetic' },
          now,
          fixtures: family.fixtures,
          layer: replayCaseLayer
        })

        expect(report.summary).toEqual({ passed: caseCount, failed: 0, skipped: 0 })
        expect(report.results.map(result => result.warnings)).toEqual(
          family.cases.map(() => [{ kind: 'unverified-case' }])
        )
      })
    )

    it.effect('send the claimed requests (asserted through the replay ledger)', () =>
      Effect.gen(function* () {
        const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

        const report = yield* runConformance(family.cases, {
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
              family.configLayer
            )
        })

        expect(report.summary.passed).toBe(caseCount)

        const byCase = yield* Ref.get(ledgers)

        for (const testCase of family.cases) {
          const ledger = byCase.get(testCase.id) ?? expect.fail(`no ledger for ${testCase.id}`)
          const [fixture] = fixturesFor(testCase)

          expect(yield* ledger.remaining).toEqual([])

          const entries = yield* ledger.entries

          expect(entries, testCase.id).toHaveLength(1)
          expect(entries[0], testCase.id).toMatchObject({
            method: 'POST',
            url: family.url,
            match: { outcome: 'matched' },
            headers: {
              authorization: '<redacted>',
              accept: 'text/event-stream',
              'content-type': 'application/json',
              ...family.headers(fixture?.model ?? 'unknown')
            }
          })
          // Replay matches method + URL only; the fixture's request body must still be exactly
          // what the provider sends.
          expect(entries[0]?.bodyJson, testCase.id).toEqual(
            fixture?.exchanges[0].request.body ?? expect.fail('no fixture body')
          )
          expect(entries[0]?.bodyJson, testCase.id).toMatchObject({
            instructions: 'Reply in one short sentence.',
            ...family.bodyFields
          })

          if (family.allowsEofCompletion) {
            // Codex never sends an output limit: the endpoint rejects `max_output_tokens`.
            expect(entries[0]?.bodyJson, testCase.id).not.toHaveProperty('max_output_tokens')
          } else {
            // Grok sends the token-auth marker (a credential-like header, redacted in the ledger).
            expect(entries[0]?.headers, testCase.id).toHaveProperty('x-xai-token-auth')
            expect(entries[0]?.bodyJson, testCase.id).not.toHaveProperty('reasoning')
          }
        }

        const toolLedger = byCase.get(family.functionCall.testCase.id)
        const [toolEntry] = toolLedger === undefined ? [] : yield* toolLedger.entries

        expect(toolEntry?.bodyJson).toMatchObject({
          parallel_tool_calls: true,
          tools: [{ type: 'function', name: 'lookup_weather', parameters: { required: ['city'] } }]
        })
        expect(toolEntry?.bodyJson).not.toHaveProperty('tool_choice')
      })
    )
  })

  describe(`${family.name} Responses conformance disagreement drills`, () => {
    it.effect('fails the function-call case when the arguments lack the claimed key', () =>
      Effect.gen(function* () {
        const events = sseEvents(family.functionCall.fixture)
        const renamed = JSON.stringify({ town: 'Springfield' })
        let written = false

        const rewritten = events.map(event =>
          mapJson(event, json => {
            if (json.type === 'response.function_call_arguments.delta') {
              json.delta = written ? '' : renamed
              written = true
            }

            if (json.type === 'response.function_call_arguments.done') json.arguments = renamed

            visitRecords(json, record => {
              if (record.type === 'function_call' && Predicate.isString(record.arguments)) {
                record.arguments = record.status === 'in_progress' ? '' : renamed
              }
            })
          })
        )

        expect(
          yield* failedDrill(
            family.functionCall.testCase,
            withEvents(family.functionCall.fixture, rewritten)
          )
        ).toEqual(mismatch('expected a non-empty string `city` argument'))
      })
    )

    it.effect('fails the function-call case when only the argument deltas disagree', () =>
      Effect.gen(function* () {
        const events = sseEvents(family.functionCall.fixture)
        const isDelta = (json: JsonRecord) => json.type === 'response.function_call_arguments.delta'
        const seenItems = new Set<unknown>()
        let changed = 0

        // Only the deltas change: the first fragment of each item carries other arguments, the
        // rest are emptied; `done`, `output_item.done`, and `response.completed` keep theirs.
        const corrupted = events.map(event =>
          mapJson(event, json => {
            if (!isDelta(json)) return

            const first = !seenItems.has(json.item_id)
            const delta = first ? JSON.stringify({ town: 'Shelbyville' }) : ''

            seenItems.add(json.item_id)

            if (json.delta !== delta) changed++

            json.delta = delta
          })
        )

        const withoutDeltas = events.filter(event => !isRecord(event.json) || !isDelta(event.json))

        expect(changed).toBeGreaterThan(0)
        expect(withoutDeltas.length).toBeLessThan(events.length)

        // The provider reads the completed items, so it still assembles the claimed call.
        const result = yield* drill(
          family.functionCall.testCase,
          withEvents(family.functionCall.fixture, corrupted, 'corrupt-deltas')
        )

        expect(result?.failure).toEqual(
          mismatch('expected the argument deltas to assemble into the completed arguments')
        )
        expect(
          yield* failedDrill(
            family.functionCall.testCase,
            withEvents(family.functionCall.fixture, withoutDeltas, 'no-deltas')
          )
        ).toEqual(mismatch('expected the argument deltas to assemble into the completed arguments'))
      })
    )

    it.effect('fails the function-call case when a delta belongs to no completed item', () =>
      Effect.gen(function* () {
        const events = sseEvents(family.functionCall.fixture)

        const delta = events.find(
          event => typeOf(event) === 'response.function_call_arguments.delta'
        )

        expect(delta).toBeDefined()

        const stray =
          delta === undefined
            ? []
            : [
                mapJson(delta, json => {
                  json.item_id = 'fc_unknown_item'
                })
              ]

        const completedIndex = events.findIndex(event => completedResponseOf(event) !== undefined)

        expect(completedIndex).toBeGreaterThan(0)

        expect(
          yield* failedDrill(
            family.functionCall.testCase,
            withEvents(
              family.functionCall.fixture,
              [...events.slice(0, completedIndex), ...stray, ...events.slice(completedIndex)],
              'stray-delta'
            )
          )
        ).toEqual(
          mismatch('expected every argument delta to belong to a completed function_call item')
        )
      })
    )

    it.effect('fails the function-call case when the answer is text only', () =>
      Effect.gen(function* () {
        const textOnly: WireFixture = {
          ...family.functionCall.fixture,
          id: `${family.functionCall.fixture.id}.text-only`,
          exchanges: [
            {
              request: family.functionCall.fixture.exchanges[0].request,
              response: streamResponse(family.plainText.fixture)
            }
          ]
        }

        expect(yield* failedDrill(family.functionCall.testCase, textOnly)).toEqual(
          mismatch('expected at least one assembled tool call')
        )
      })
    )

    it.effect('fails the plain-text case when response.completed carries no usage', () =>
      Effect.gen(function* () {
        const withoutUsage = sseEvents(family.plainText.fixture).map(event =>
          mapJson(event, json => {
            if (isRecord(json.response)) delete json.response.usage
          })
        )

        expect(
          yield* failedDrill(
            family.plainText.testCase,
            withEvents(family.plainText.fixture, withoutUsage)
          )
        ).toEqual(mismatch('expected a usage report'))
      })
    )

    it.effect('fails the plain-text case when the streamed text is empty', () =>
      Effect.gen(function* () {
        const empty = sseEvents(family.plainText.fixture).map(event =>
          mapJson(event, json => {
            if (json.type === 'response.output_text.delta') json.delta = ''

            if (json.type === 'response.output_text.done') json.text = ''

            visitRecords(json, record => {
              if (record.type === 'output_text') record.text = ''
            })
          })
        )

        expect(
          yield* failedDrill(family.plainText.testCase, withEvents(family.plainText.fixture, empty))
        ).toEqual(mismatch('expected non-empty answer text'))
      })
    )

    it.effect('passes the plain-text case for a JSON response body (the JSON fallback)', () =>
      Effect.gen(function* () {
        const completed = sseEvents(family.plainText.fixture).flatMap(event => {
          const response = completedResponseOf(event)

          return response === undefined ? [] : [response]
        })

        expect(completed).toHaveLength(1)

        const result = yield* drill(
          family.plainText.testCase,
          withResponse(family.plainText.fixture, 'json', 200, JSON.stringify(completed[0]))
        )

        expect(result?.status).toBe('passed')
      })
    )

    it.effect('fails the terminal-event case for a JSON response body', () =>
      Effect.gen(function* () {
        const completed = sseEvents(family.terminal.fixture).flatMap(event => {
          const response = completedResponseOf(event)

          return response === undefined ? [] : [response]
        })

        expect(
          yield* failedDrill(
            family.terminal.testCase,
            withResponse(family.terminal.fixture, 'json', 200, JSON.stringify(completed[0]))
          )
        ).toEqual(mismatch('expected a server-sent event stream'))
      })
    )

    it.effect('fails the terminal-event case when an event follows response.completed', () =>
      Effect.gen(function* () {
        const events = sseEvents(family.terminal.fixture)
        const delta = events.find(event => typeOf(event) === 'response.output_text.delta')

        expect(delta).toBeDefined()

        expect(
          yield* failedDrill(
            family.terminal.testCase,
            withEvents(family.terminal.fixture, [
              ...events,
              ...(delta === undefined ? [] : [delta])
            ])
          )
        ).toEqual(mismatch('expected response.completed to be the last event'))
      })
    )

    it.effect('fails the terminal-event case when response.completed is not completed', () =>
      Effect.gen(function* () {
        const events = sseEvents(family.terminal.fixture).map(event =>
          completedResponseOf(event) === undefined
            ? event
            : mapJson(event, json => {
                if (isRecord(json.response)) json.response.status = 'in_progress'
              })
        )

        expect(
          yield* failedDrill(family.terminal.testCase, withEvents(family.terminal.fixture, events))
        ).toEqual(mismatch('expected response.completed to carry status completed'))
      })
    )

    it.effect('fails the terminal-event case when the stream ends with response.failed', () =>
      Effect.gen(function* () {
        const events = sseEvents(family.terminal.fixture).map(event =>
          completedResponseOf(event) === undefined
            ? event
            : mapJson(event, json => {
                json.type = 'response.failed'

                if (isRecord(json.response)) {
                  json.response.status = 'failed'
                  json.response.error = { code: 'server_error', message: 'synthetic' }
                }
              })
        )

        const result = yield* drill(
          family.terminal.testCase,
          withEvents(family.terminal.fixture, events)
        )

        expect(result?.status).toBe('failed')
        expect(result?.failure?.tag).toBe('LLMError')
      })
    )

    const withoutTerminal = () =>
      withEvents(
        family.terminal.fixture,
        sseEvents(family.terminal.fixture).filter(
          event => completedResponseOf(event) === undefined
        ),
        'no-terminal'
      )

    if (family.allowsEofCompletion) {
      it.effect(
        'keeps EOF-completion compatibility: no response.completed still completes, and the case fails',
        () =>
          Effect.gen(function* () {
            const events = yield* streamFixture(withoutTerminal())

            // The provider treats EOF as a normal end (Done without usage).
            expect(doneReasons(events)).toEqual(['stop'])
            expect(events.map(event => event._tag)).not.toContain('Usage')

            // The case reads the body, so a missing terminal event still fails it.
            expect(yield* failedDrill(family.terminal.testCase, withoutTerminal())).toEqual(
              mismatch('expected the stream to carry exactly one response.completed event')
            )
          })
      )
    } else {
      it.effect(
        'requires the terminal event: no response.completed is a non-retryable invalid response',
        () =>
          Effect.gen(function* () {
            const error = expectLlmError(yield* streamFixture(withoutTerminal()).pipe(Effect.flip))

            expect(error.cause).toBe('invalid_response')
            expect(error.retryable).toBe(false)
            expect(error.provider?.providerCode).toBe('incomplete_stream')

            const result = yield* drill(family.terminal.testCase, withoutTerminal())

            expect(result?.status).toBe('failed')
            expect(result?.failure?.tag).toBe('LLMError')
          })
      )
    }

    const errorBody = (): string => {
      const response = family.errorEnvelope.fixture.exchanges[0].response

      return 'body' in response && Predicate.isString(response.body)
        ? response.body
        : expect.fail('error fixture has no text body')
    }

    it('records an accepted model-rejection envelope in the error fixture', () => {
      const fixture = family.errorEnvelope.fixture
      const status = fixture.exchanges[0].response.status
      const body = parseJson(errorBody())

      // The statuses and body shapes the error-envelope case accepts.
      expect([400, 404]).toContain(status)
      expect(
        isRecord(body) &&
          ((isRecord(body.error) && Predicate.isString(body.error.message)) ||
            Predicate.isString(body.error) ||
            Predicate.isString(body.detail))
      ).toBe(true)

      // Only the synthetic placeholder pins the exact OpenAI envelope; a live recording may use
      // any accepted status and shape.
      if (fixture.evidence === 'unverified') {
        expect(status).toBe(400)
        expect(body).toMatchObject({ error: { code: 'model_not_found' } })
      }
    })

    for (const status of [401, 403]) {
      it.effect(`fails the error-envelope case for a ${status} authentication failure`, () =>
        Effect.gen(function* () {
          expect(
            yield* failedDrill(
              family.errorEnvelope.testCase,
              withResponse(family.errorEnvelope.fixture, `status-${status}`, status, errorBody())
            )
          ).toEqual(
            mismatch('expected a model rejection, not an authentication or permission failure')
          )
        })
      )
    }

    it.effect('fails the error-envelope case for a non-400/404 request error', () =>
      Effect.gen(function* () {
        for (const status of [409, 422]) {
          expect(
            yield* failedDrill(
              family.errorEnvelope.testCase,
              withResponse(family.errorEnvelope.fixture, `status-${status}`, status, errorBody())
            )
          ).toEqual(mismatch('expected a 400 or 404 model-rejection status'))
        }
      })
    )

    it.effect('fails the error-envelope case for a body that is not an error envelope', () =>
      Effect.gen(function* () {
        const malformed = [
          withResponse(family.errorEnvelope.fixture, 'empty-object', 400, '{}'),
          withResponse(
            family.errorEnvelope.fixture,
            'html',
            400,
            '<html><body>Bad Request</body></html>',
            'text/html'
          ),
          withResponse(family.errorEnvelope.fixture, 'empty', 400, ''),
          withResponse(
            family.errorEnvelope.fixture,
            'no-message',
            400,
            JSON.stringify({ error: { code: 'model_not_found' } })
          )
        ]

        for (const fixture of malformed) {
          expect(yield* failedDrill(family.errorEnvelope.testCase, fixture), fixture.id).toEqual(
            mismatch('expected the error body to be a JSON error envelope with a message')
          )
        }

        // The other accepted error-body shapes, and a 404, pass: only the body or status differs.
        for (const fixture of [
          withResponse(family.errorEnvelope.fixture, 'detail', 400, '{"detail":"synthetic"}'),
          withResponse(family.errorEnvelope.fixture, 'string', 400, '{"error":"synthetic"}'),
          withResponse(family.errorEnvelope.fixture, 'not-found', 404, errorBody())
        ]) {
          expect((yield* drill(family.errorEnvelope.testCase, fixture))?.status, fixture.id).toBe(
            'passed'
          )
        }
      })
    )

    it.effect('fails the error-envelope case when the unknown model is accepted', () =>
      Effect.gen(function* () {
        const accepted: WireFixture = {
          ...family.errorEnvelope.fixture,
          id: `${family.errorEnvelope.fixture.id}.accepted`,
          exchanges: [
            {
              request: family.errorEnvelope.fixture.exchanges[0].request,
              response: streamResponse(family.plainText.fixture)
            }
          ]
        }

        expect(yield* failedDrill(family.errorEnvelope.testCase, accepted)).toEqual(
          mismatch('expected an error envelope, the request succeeded')
        )
      })
    )

    it.effect('reports provider failures (not mismatches) with sanitized messages', () =>
      Effect.gen(function* () {
        const rateLimited = withResponse(
          family.plainText.fixture,
          'rate-limited',
          429,
          '{"error":{"message":"synthetic upstream detail","type":"rate_limit_exceeded","param":null,"code":"rate_limit_exceeded"}}'
        )

        expect(yield* failedDrill(family.plainText.testCase, rateLimited)).toEqual({
          kind: 'failure',
          tag: 'LLMError',
          message: `${family.providerName} returned 429`
        })
      })
    )

    it('keeps a defined case id aligned with defineConformanceCase validation', () => {
      expect(() =>
        defineConformanceCase({ ...family.plainText.testCase, id: 'Responses.Bad' })
      ).toThrow(/Invalid conformance case/)
    })
  })
}

describeFamily(codex)

describeFamily(grok)
