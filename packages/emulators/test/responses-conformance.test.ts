/**
 * Cross-checks: the Codex and Grok Responses emulators must satisfy the same conformance cases the
 * replayed fixtures satisfy, through the real public providers, both in-process and over a
 * loopback socket; and wire faults must map correctly through those providers (429 `retry-after`,
 * a mid-stream `error` / `response.failed` event, a dropped connection, and truncation before
 * `response.completed`, which Grok rejects and Codex completes for EOF compatibility). Tests may
 * import SDK packages; the emulator source never does.
 */
import { Effect, Layer, Ref, Stream } from 'effect'
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import type { ConformanceCase, ConformanceMismatch } from '@yolk-sdk/conformance/case'
import { formatConformanceReport, runConformance } from '@yolk-sdk/conformance/runner'
import {
  LLMDone,
  LLMError,
  LLMProvider,
  LLMToolCall,
  type LLMEvent,
  type LLMProviderError
} from '@yolk-sdk/agent/loop'
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import { ToolDef, UserMessage } from '@yolk-sdk/agent/protocol'
import { makeOpenAiCodexProviderLayer } from '@yolk-sdk/agent/providers/openai/codex-provider'
import {
  OpenAiCodexConformanceConfig,
  openAiCodexConformanceCases,
  openAiCodexConformanceDefaultModels,
  openAiCodexConformanceResponsesUrl,
  openAiCodexErrorEnvelopeCase,
  openAiCodexFunctionCallArgumentsCase,
  openAiCodexPlainTextCase,
  openAiCodexTerminalEventCase
} from '@yolk-sdk/agent/providers/openai/conformance'
import {
  XAiGrokConformanceConfig,
  xAiGrokConformanceCases,
  xAiGrokConformanceDefaultModels,
  xAiGrokConformanceResponsesUrl,
  xAiGrokErrorEnvelopeCase,
  xAiGrokFunctionCallArgumentsCase,
  xAiGrokPlainTextCase,
  xAiGrokTerminalEventCase
} from '@yolk-sdk/agent/providers/xai/conformance'
import { makeXAiGrokProviderLayer } from '@yolk-sdk/agent/providers/xai/grok-provider'
import { codexResponsesPath, makeCodexEmulator } from '../src/codex.ts'
import { serveFetchHandler } from '../src/node.ts'
import type { ResponsesEmulator, ResponsesFault, ResponsesScriptedTurn } from '../src/responses.ts'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '../src/router.ts'
import { makeXAiGrokEmulator, xAiGrokResponsesPath } from '../src/xai.ts'

const now = new Date('2026-09-30T12:00:00.000Z')

// Far in the future so the Grok provider's expiry check passes on the real clock.
const expiresAt = 4_000_000_000_000

const codexToken = new OAuthAccessToken({
  provider: 'openai-codex',
  accessToken: 'synthetic-codex-oauth-token',
  expiresAt
})

const grokToken = new OAuthAccessToken({
  provider: 'xai-grok',
  accessToken: 'synthetic-grok-oauth-token',
  expiresAt
})

const grokClientVersion = '0.0.0-synthetic'

type ResponsesCase<Req> = ConformanceCase<
  LLMProviderError | ConformanceMismatch,
  HttpClient.HttpClient | Req
>

type Family<Req> = {
  readonly name: string
  /** The model the provider-level fault tests send. */
  readonly model: string
  readonly origin: string
  readonly path: string
  readonly makeEmulator: () => ResponsesEmulator
  readonly cases: ReadonlyArray<ResponsesCase<Req>>
  readonly plainText: ResponsesCase<Req>
  readonly functionCall: ResponsesCase<Req>
  readonly errorEnvelope: ResponsesCase<Req>
  readonly terminal: ResponsesCase<Req>
  readonly configLayer: Layer.Layer<Req>
  readonly providerLayer: (
    clientVersion?: string
  ) => Layer.Layer<LLMProvider, never, HttpClient.HttpClient>
  readonly providerId: string
  readonly allowsEofCompletion: boolean
}

const codex: Family<OpenAiCodexConformanceConfig> = {
  name: 'Codex',
  model: openAiCodexConformanceDefaultModels.plainText,
  origin: new URL(openAiCodexConformanceResponsesUrl).origin,
  path: codexResponsesPath,
  makeEmulator: makeCodexEmulator,
  cases: openAiCodexConformanceCases,
  plainText: openAiCodexPlainTextCase,
  functionCall: openAiCodexFunctionCallArgumentsCase,
  errorEnvelope: openAiCodexErrorEnvelopeCase,
  terminal: openAiCodexTerminalEventCase,
  configLayer: Layer.succeed(OpenAiCodexConformanceConfig, {
    token: codexToken,
    models: openAiCodexConformanceDefaultModels
  }),
  providerLayer: () => makeOpenAiCodexProviderLayer({ token: codexToken }),
  providerId: 'openai_codex',
  allowsEofCompletion: true
}

const grok: Family<XAiGrokConformanceConfig> = {
  name: 'Grok',
  model: xAiGrokConformanceDefaultModels.plainText,
  origin: new URL(xAiGrokConformanceResponsesUrl).origin,
  path: xAiGrokResponsesPath,
  makeEmulator: makeXAiGrokEmulator,
  cases: xAiGrokConformanceCases,
  plainText: xAiGrokPlainTextCase,
  functionCall: xAiGrokFunctionCallArgumentsCase,
  errorEnvelope: xAiGrokErrorEnvelopeCase,
  terminal: xAiGrokTerminalEventCase,
  configLayer: Layer.succeed(XAiGrokConformanceConfig, {
    token: grokToken,
    clientVersion: grokClientVersion,
    maxOutputTokens: 64,
    models: xAiGrokConformanceDefaultModels
  }),
  providerLayer: (clientVersion = grokClientVersion) =>
    makeXAiGrokProviderLayer({ token: grokToken, clientVersion, maxOutputTokens: 64 }),
  providerId: 'xai_grok',
  allowsEofCompletion: false
}

const lookupWeatherTool = ToolDef.make({
  name: 'lookup_weather',
  description: 'Look up the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city']
  }
})

const doneReasons = (events: Iterable<LLMEvent>) =>
  Array.from(events).flatMap(event => (event instanceof LLMDone ? [event.stopReason] : []))

const expectLlmError = (error: unknown): LLMError =>
  error instanceof LLMError ? error : expect.fail(`expected an LLMError, got ${String(error)}`)

const describeFamily = <Req>(family: Family<Req>) => {
  const caseCount = family.cases.length

  const inProcessLayer = (emulator: ResponsesEmulator) =>
    InProcessHttpClient.layer([EmulatorRoute.handler(family.origin, emulator.fetch)])

  /** Real `FetchHttpClient` underneath, routed to the emulator served on 127.0.0.1:0. */
  const emulatedLayer = (emulator: ResponsesEmulator) =>
    Layer.unwrap(
      serveFetchHandler(emulator.fetch).pipe(
        Effect.map(server =>
          EmulatedHttpClient.layer([EmulatorRoute.url(family.origin, server.url)]).pipe(
            Layer.provide(FetchHttpClient.layer)
          )
        )
      )
    )

  const drill = (testCase: ResponsesCase<Req>, turn: ResponsesScriptedTurn) =>
    runConformance([testCase], {
      target: { kind: 'in-process' },
      now,
      layer: () => {
        const emulator = family.makeEmulator()

        emulator.script.enqueue(turn)

        return Layer.mergeAll(inProcessLayer(emulator), family.configLayer)
      }
    }).pipe(Effect.map(report => report.results[0]))

  const streamThroughProvider = <E>(
    emulator: ResponsesEmulator,
    transport: (emulator: ResponsesEmulator) => Layer.Layer<HttpClient.HttpClient, E>,
    options: { readonly tools?: ReadonlyArray<ToolDef>; readonly clientVersion?: string } = {}
  ) =>
    Effect.gen(function* () {
      const llm = yield* LLMProvider

      return Array.from(
        yield* llm
          .stream({
            model: family.model,
            systemPrompt: 'Reply in one short sentence.',
            messages: [UserMessage.make({ content: 'Say hello.' })],
            tools: options.tools ?? []
          })
          .pipe(Stream.runCollect)
      )
    }).pipe(
      Effect.provide(
        family.providerLayer(options.clientVersion).pipe(Layer.provide(transport(emulator)))
      )
    )

  const withFaults = (faults: ReadonlyArray<ResponsesFault>) => {
    const emulator = family.makeEmulator()

    for (const fault of faults) emulator.faults.add(fault)

    return emulator
  }

  describe(`${family.name} cross-check A: in-process emulator`, () => {
    it.effect('passes every Responses conformance case', () =>
      Effect.gen(function* () {
        const report = yield* runConformance(family.cases, {
          target: { kind: 'in-process' },
          now,
          layer: () => Layer.mergeAll(inProcessLayer(family.makeEmulator()), family.configLayer)
        })

        expect(report.summary, formatConformanceReport(report)).toEqual({
          passed: caseCount,
          failed: 0,
          skipped: 0
        })
      })
    )
  })

  describe(`${family.name} cross-check B: emulator over a loopback socket`, () => {
    it.effect('passes every Responses conformance case and records the claimed requests', () =>
      Effect.gen(function* () {
        const emulators = yield* Ref.make(new Map<string, ResponsesEmulator>())

        const report = yield* runConformance(family.cases, {
          target: { kind: 'emulated' },
          now,
          layer: testCase => {
            const emulator = family.makeEmulator()

            return Layer.mergeAll(
              emulatedLayer(emulator),
              family.configLayer,
              Layer.effectDiscard(
                Ref.update(emulators, current => new Map(current).set(testCase.id, emulator))
              )
            )
          }
        })

        expect(report.summary, formatConformanceReport(report)).toEqual({
          passed: caseCount,
          failed: 0,
          skipped: 0
        })

        const ledgers = yield* Ref.get(emulators)

        const entryOf = (id: string) => {
          const entries = ledgers.get(id)?.ledger.entries() ?? []

          expect(entries, id).toHaveLength(1)

          return entries[0]
        }

        for (const testCase of family.cases) {
          const entry = entryOf(testCase.id)

          expect(entry, testCase.id).toMatchObject({
            path: family.path,
            stream: true,
            store: false,
            evidence: 'unverified'
          })

          if (family.allowsEofCompletion) {
            expect(entry, testCase.id).toMatchObject({
              reasoning: { effort: 'low', summary: 'auto' },
              headers: { originator: 'opencode' }
            })
            expect(entry?.maxOutputTokens, testCase.id).toBeUndefined()
          } else {
            expect(entry, testCase.id).toMatchObject({
              maxOutputTokens: 64,
              headers: {
                'x-grok-client-version': grokClientVersion,
                'x-grok-model-override': entry?.model ?? 'missing'
              }
            })
            expect(entry?.reasoning, testCase.id).toBeUndefined()
          }
        }

        expect(entryOf(family.functionCall.id)).toMatchObject({
          toolNames: ['lookup_weather'],
          status: 200
        })
        expect(entryOf(family.functionCall.id)?.toolChoice).toBeUndefined()
        expect(entryOf(family.errorEnvelope.id)?.status).toBe(400)

        // Streamed cases: several body chunks, one per pull.
        for (const testCase of [family.plainText, family.functionCall, family.terminal]) {
          expect(entryOf(testCase.id)?.bodyChunks, testCase.id).toBeGreaterThan(1)
        }
      })
    )
  })

  describe(`${family.name} disagreement drills`, () => {
    it.effect('fails the plain-text case when response.completed drops the usage', () =>
      Effect.gen(function* () {
        const result = yield* drill(family.plainText, { text: ['Hello', ' there.'], usage: null })

        expect(result?.status).toBe('failed')
        expect(result?.failure?.message).toBe('expected a usage report')
      })
    )

    it.effect('fails the function-call case when the arguments lack the claimed key', () =>
      Effect.gen(function* () {
        const result = yield* drill(family.functionCall, {
          functionCalls: [{ name: 'lookup_weather', argumentFragments: ['{"to', 'wn":"X"}'] }]
        })

        expect(result?.status).toBe('failed')
        expect(result?.failure?.message).toBe('expected a non-empty string `city` argument')
      })
    )

    it.effect('fails the terminal-event case for a JSON body instead of a stream', () =>
      Effect.gen(function* () {
        const result = yield* drill(family.terminal, { text: ['Hello.'], format: 'json' })

        expect(result?.status).toBe('failed')
        expect(result?.failure?.message).toBe('expected a server-sent event stream')
      })
    )

    it.effect('the same scripted shapes pass when they agree with the cases', () =>
      Effect.gen(function* () {
        const plain = yield* drill(family.plainText, { reasoning: ['Plan.'], text: ['Hello.'] })

        const tool = yield* drill(family.functionCall, {
          functionCalls: [
            { name: 'lookup_weather', argumentFragments: ['{"ci', 'ty":"Springfield"}'] },
            { name: 'lookup_weather', argumentFragments: ['{"city":"Shelbyville"}'] }
          ]
        })

        const terminal = yield* drill(family.terminal, { text: ['Hello.'] })

        expect([plain?.status, tool?.status, terminal?.status]).toEqual([
          'passed',
          'passed',
          'passed'
        ])
      })
    )
  })

  describe(`${family.name} faults through the real provider`, () => {
    const rateLimit: ResponsesFault = {
      kind: 'status',
      status: 429,
      headers: { 'retry-after': '2' }
    }

    const expectRateLimit = (error: LLMError) => {
      expect(error.retryable).toBe(true)
      expect(error.cause).toBe('rate_limit')
      expect(error.provider).toMatchObject({
        provider: family.providerId,
        kind: 'rate_limit',
        status: 429,
        retryAfterMs: 2000
      })
    }

    it.effect('a 429 with retry-after becomes a retryable rate-limit LLMError (in-process)', () =>
      Effect.gen(function* () {
        expectRateLimit(
          expectLlmError(
            yield* streamThroughProvider(withFaults([rateLimit]), inProcessLayer).pipe(Effect.flip)
          )
        )
      })
    )

    it.effect(
      'a 429 with retry-after becomes a retryable rate-limit LLMError (loopback socket)',
      () =>
        Effect.gen(function* () {
          expectRateLimit(
            expectLlmError(
              yield* streamThroughProvider(withFaults([rateLimit]), emulatedLayer).pipe(
                Effect.flip,
                Effect.scoped
              )
            )
          )
        })
    )

    it.effect('a mid-stream error event becomes a stream-error LLMError with its code', () =>
      Effect.gen(function* () {
        const emulator = withFaults([{ kind: 'error-event-after-chunks', chunks: 3 }])

        const error = expectLlmError(
          yield* streamThroughProvider(emulator, emulatedLayer).pipe(Effect.flip, Effect.scoped)
        )

        // `server_error` carries no retry signal the shared classifier recognizes.
        expect(error.retryable).toBe(false)
        expect(error.cause).toBe('provider_error')
        expect(error.message).toContain('stream error')
        expect(error.provider).toMatchObject({ kind: 'unknown', providerCode: 'server_error' })
        expect(emulator.ledger.entries()[0]).toMatchObject({
          fault: 'error-event-after-chunks',
          bodyChunks: 4
        })
      })
    )

    it.effect('a mid-stream response.failed rate limit becomes a retryable rate-limit error', () =>
      Effect.gen(function* () {
        const error = expectLlmError(
          yield* streamThroughProvider(
            withFaults([
              {
                kind: 'error-event-after-chunks',
                chunks: 6,
                event: 'response.failed',
                error: { code: 'rate_limit_exceeded', message: 'Synthetic rate limit.' }
              }
            ]),
            inProcessLayer
          ).pipe(Effect.flip)
        )

        expect(error.retryable).toBe(true)
        expect(error.cause).toBe('rate_limit')
        expect(error.provider?.providerCode).toBe('rate_limit_exceeded')
      })
    )

    it.effect(
      'a dropped connection mid-stream becomes a retryable LLMError (loopback socket)',
      () =>
        Effect.gen(function* () {
          const error = expectLlmError(
            yield* streamThroughProvider(
              withFaults([{ kind: 'error-after-chunks', chunks: 2 }]),
              emulatedLayer
            ).pipe(Effect.flip, Effect.scoped)
          )

          expect(error.retryable).toBe(true)
        })
    )

    if (family.allowsEofCompletion) {
      it.effect(
        'keeps EOF-completion compatibility for a stream cut before response.completed',
        () =>
          Effect.gen(function* () {
            const events = yield* streamThroughProvider(
              withFaults([{ kind: 'truncate-after-chunks', chunks: 12 }]),
              inProcessLayer
            )

            // Existing Codex compatibility behaviour, recorded here, not endorsed.
            expect(doneReasons(events)).toEqual(['stop'])
            expect(events.map(event => event._tag)).not.toContain('Usage')
          })
      )

      it.effect('never sends an output limit, which the emulated endpoint would reject', () =>
        Effect.gen(function* () {
          const emulator = family.makeEmulator()
          const events = yield* streamThroughProvider(emulator, inProcessLayer)

          expect(doneReasons(events)).toEqual(['stop'])
          expect(emulator.ledger.entries()[0]?.maxOutputTokens).toBeUndefined()
        })
      )
    } else {
      it.effect('rejects a stream cut before response.completed as an invalid response', () =>
        Effect.gen(function* () {
          const error = expectLlmError(
            yield* streamThroughProvider(
              withFaults([{ kind: 'truncate-after-chunks', chunks: 8 }]),
              inProcessLayer
            ).pipe(Effect.flip)
          )

          expect(error.retryable).toBe(false)
          expect(error.cause).toBe('invalid_response')
          expect(error.provider?.providerCode).toBe('incomplete_stream')
        })
      )

      it.effect('a missing client version gets 426 through the provider (non-retryable)', () =>
        Effect.gen(function* () {
          const emulator = family.makeEmulator()

          const error = expectLlmError(
            yield* streamThroughProvider(emulator, inProcessLayer, { clientVersion: '' }).pipe(
              Effect.flip
            )
          )

          expect(error.retryable).toBe(false)
          expect(error.provider?.status).toBe(426)
          expect(error.message).toBe('xAI Grok subscription returned 426')
          expect(emulator.ledger.entries()[0]?.status).toBe(426)
        })
      )
    }

    it.effect('a scripted JSON body completes through the JSON fallback', () =>
      Effect.gen(function* () {
        const emulator = family.makeEmulator()

        emulator.script.enqueue({ text: ['Hello.'], format: 'json' })

        const events = yield* streamThroughProvider(emulator, inProcessLayer)

        expect(doneReasons(events)).toEqual(['stop'])
        expect(events.map(event => event._tag)).toContain('Usage')
      })
    )

    it.effect('completes a default tool turn with the synthesized arguments', () =>
      Effect.gen(function* () {
        const events = yield* streamThroughProvider(family.makeEmulator(), emulatedLayer, {
          tools: [lookupWeatherTool]
        }).pipe(Effect.scoped)

        expect(doneReasons(events)).toEqual(['tool_use'])
        expect(
          events.flatMap(event => (event instanceof LLMToolCall ? [event.call.params] : []))
        ).toEqual([{ city: 'synthetic city' }])
      })
    )
  })
}

describeFamily(codex)

describeFamily(grok)
