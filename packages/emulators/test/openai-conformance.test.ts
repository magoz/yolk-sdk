/**
 * Cross-checks: the OpenAI emulator must satisfy the same conformance cases the replayed
 * fixtures satisfy, through the real OpenAI-compatible chat provider, both in-process and over a
 * loopback socket. Tests may import SDK packages; the emulator source never does.
 */
import { Effect, Layer, Redacted, Ref, Stream } from 'effect'
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { LLMError, LLMProvider } from '@yolk-sdk/agent/loop'
import { UserMessage } from '@yolk-sdk/agent/protocol'
import {
  OpenAiConformanceConfig,
  openAiChatJsonPlainTextCase,
  openAiChatPlainTextCase,
  openAiChatToolCallDeltasCase,
  openAiConformanceCases,
  openAiConformanceChatCompletionsUrl,
  openAiConformanceDefaultModels,
  type OpenAiConformanceCase,
  type OpenAiConformanceSettings
} from '@yolk-sdk/agent/providers/openai/conformance'
import { makeOpenAiProviderLayer } from '@yolk-sdk/agent/providers/openai/provider'
import { formatConformanceReport, runConformance } from '@yolk-sdk/conformance/runner'
import { serveFetchHandler } from '../src/node.ts'
import {
  makeOpenAiEmulator,
  type OpenAiEmulator,
  type OpenAiFault,
  type OpenAiScriptedTurn
} from '../src/openai.ts'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const openAiOrigin = new URL(openAiConformanceChatCompletionsUrl).origin

const now = new Date('2026-09-30T12:00:00.000Z')

const settings: OpenAiConformanceSettings = {
  apiKey: Redacted.make('synthetic-openai-key'),
  maxCompletionTokens: 64,
  models: openAiConformanceDefaultModels
}

const configLayer = Layer.succeed(OpenAiConformanceConfig, settings)

const inProcessLayer = (emulator: OpenAiEmulator) =>
  InProcessHttpClient.layer([EmulatorRoute.handler(openAiOrigin, emulator.fetch)])

/** Real `FetchHttpClient` underneath, routed to the emulator served on 127.0.0.1:0. */
const emulatedLayer = (emulator: OpenAiEmulator) =>
  Layer.unwrap(
    serveFetchHandler(emulator.fetch).pipe(
      Effect.map(server =>
        EmulatedHttpClient.layer([EmulatorRoute.url(openAiOrigin, server.url)]).pipe(
          Layer.provide(FetchHttpClient.layer)
        )
      )
    )
  )

describe('cross-check A: in-process OpenAI emulator', () => {
  it.effect('passes every OpenAI chat conformance case', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(openAiConformanceCases, {
        target: { kind: 'in-process' },
        now,
        layer: () => Layer.mergeAll(inProcessLayer(makeOpenAiEmulator()), configLayer)
      })

      expect(report.summary, formatConformanceReport(report)).toEqual({
        passed: 4,
        failed: 0,
        skipped: 0
      })
      expect(report.target).toEqual({ kind: 'in-process' })
    })
  )
})

describe('cross-check B: OpenAI emulator over a loopback socket', () => {
  it.effect('passes every OpenAI chat conformance case and records the claimed requests', () =>
    Effect.gen(function* () {
      const emulators = yield* Ref.make(new Map<string, OpenAiEmulator>())

      const report = yield* runConformance(openAiConformanceCases, {
        target: { kind: 'emulated' },
        now,
        layer: testCase => {
          const emulator = makeOpenAiEmulator()

          return Layer.mergeAll(
            emulatedLayer(emulator),
            configLayer,
            Layer.effectDiscard(
              Ref.update(emulators, current => new Map(current).set(testCase.id, emulator))
            )
          )
        }
      })

      expect(report.summary, formatConformanceReport(report)).toEqual({
        passed: 4,
        failed: 0,
        skipped: 0
      })

      const ledgers = yield* Ref.get(emulators)

      const entryOf = (id: string) => {
        const entries = ledgers.get(id)?.ledger.entries() ?? []

        expect(entries, id).toHaveLength(1)

        return entries[0]
      }

      for (const testCase of openAiConformanceCases) {
        expect(entryOf(testCase.id), testCase.id).toMatchObject({
          path: '/v1/chat/completions',
          stream: testCase.id !== openAiChatJsonPlainTextCase.id,
          maxCompletionTokens: settings.maxCompletionTokens,
          evidence: 'unverified'
        })
        expect(entryOf(testCase.id)?.body, testCase.id).not.toHaveProperty('max_tokens')
      }

      // Streamed cases: several body chunks, one per pull (`node.test.ts` covers progressive
      // delivery over the socket). The JSON case is one chunk.
      for (const id of ['openai.chat.stream.plain-text', 'openai.chat.stream.tool-call-deltas']) {
        expect(entryOf(id)?.status, id).toBe(200)
        expect(entryOf(id)?.bodyChunks, id).toBeGreaterThan(1)
      }

      expect(entryOf('openai.chat.json.plain-text')).toMatchObject({ status: 200, bodyChunks: 1 })
      expect(entryOf('openai.chat.stream.error-envelope')?.status).toBe(404)
    })
  )
})

const drill = (testCase: OpenAiConformanceCase, turn: OpenAiScriptedTurn) =>
  runConformance([testCase], {
    target: { kind: 'in-process' },
    now,
    layer: () => {
      const emulator = makeOpenAiEmulator()

      emulator.script.enqueue(turn)

      return Layer.mergeAll(inProcessLayer(emulator), configLayer)
    }
  }).pipe(Effect.map(report => report.results[0]))

describe('disagreement drill', () => {
  it.effect('fails the plain-text case when the usage chunk is dropped', () =>
    Effect.gen(function* () {
      const result = yield* drill(openAiChatPlainTextCase, {
        text: ['Hello', ' there.'],
        usage: null
      })

      expect(result?.status).toBe('failed')
      expect(result?.failure?.message).toContain('usage report')
    })
  )

  it.effect('fails the tool-call case when the arguments lack the claimed key', () =>
    Effect.gen(function* () {
      const result = yield* drill(openAiChatToolCallDeltasCase, {
        toolCalls: [{ name: 'lookup_weather', argumentFragments: ['{"to', 'wn":"Springfield"}'] }]
      })

      expect(result?.status).toBe('failed')
      expect(result?.failure?.message).toContain('non-empty string `city` argument')
    })
  )

  it.effect('fails the JSON case when the completion carries no text', () =>
    Effect.gen(function* () {
      const result = yield* drill(openAiChatJsonPlainTextCase, { text: [] })

      expect(result?.status).toBe('failed')
      expect(result?.failure?.message).toContain('non-empty answer text')
    })
  )

  it.effect('the same scripted shapes pass when they agree with the cases', () =>
    Effect.gen(function* () {
      const plain = yield* drill(openAiChatPlainTextCase, { text: ['Hello', ' there.'] })

      const tool = yield* drill(openAiChatToolCallDeltasCase, {
        toolCalls: [{ name: 'lookup_weather', argumentFragments: ['{"ci', 'ty":"Springfield"}'] }]
      })

      const json = yield* drill(openAiChatJsonPlainTextCase, { text: ['Hello', ' there.'] })

      expect([plain?.status, tool?.status, json?.status]).toEqual(['passed', 'passed', 'passed'])
    })
  )
})

const streamThroughProvider = <E>(
  faults: ReadonlyArray<OpenAiFault>,
  transport: (emulator: OpenAiEmulator) => Layer.Layer<HttpClient.HttpClient, E>
) =>
  Effect.gen(function* () {
    const provider = yield* LLMProvider

    return yield* provider
      .stream({
        model: openAiConformanceDefaultModels.plainText,
        systemPrompt: 'Reply in one short sentence.',
        messages: [UserMessage.make({ content: 'Say hello.' })],
        tools: []
      })
      .pipe(Stream.runCollect)
  }).pipe(
    Effect.provide(
      makeOpenAiProviderLayer({
        apiKey: settings.apiKey,
        maxCompletionTokens: 64,
        streaming: true
      }).pipe(
        Layer.provide(
          transport(
            (() => {
              const emulator = makeOpenAiEmulator()

              for (const fault of faults) emulator.faults.add(fault)

              return emulator
            })()
          )
        )
      )
    )
  )

describe('faults through the OpenAI provider', () => {
  const expectRateLimit = (error: unknown) => {
    expect(error).toBeInstanceOf(LLMError)

    if (error instanceof LLMError) {
      expect(error.retryable).toBe(true)
      expect(error.cause).toBe('rate_limit')
      expect(error.message).toBe('OpenAI returned 429')
      expect(error.provider?.kind).toBe('rate_limit')
      expect(error.provider?.status).toBe(429)
      expect(error.provider?.retryAfterMs).toBe(2000)
    }
  }

  it.effect('a 429 with retry-after becomes a retryable rate-limit LLMError (in-process)', () =>
    Effect.gen(function* () {
      const error = yield* streamThroughProvider(
        [{ kind: 'status', status: 429, headers: { 'retry-after': '2' } }],
        inProcessLayer
      ).pipe(Effect.flip)

      expectRateLimit(error)
    })
  )

  it.effect(
    'a 429 with retry-after becomes a retryable rate-limit LLMError (loopback socket)',
    () =>
      Effect.gen(function* () {
        const error = yield* streamThroughProvider(
          [{ kind: 'status', status: 429, headers: { 'retry-after': '2' } }],
          emulatedLayer
        ).pipe(Effect.flip, Effect.scoped)

        expectRateLimit(error)
      })
  )

  it.effect('a mid-stream error becomes a retryable network LLMError (loopback socket)', () =>
    Effect.gen(function* () {
      const error = yield* streamThroughProvider(
        [{ kind: 'error-after-chunks', chunks: 2 }],
        emulatedLayer
      ).pipe(Effect.flip, Effect.scoped)

      expect(error).toBeInstanceOf(LLMError)

      if (error instanceof LLMError) {
        expect(error.retryable).toBe(true)
        expect(error.provider?.kind).toBe('network')
      }
    })
  )

  it.effect('a truncated stream (no finish, no [DONE]) is not reported as completion', () =>
    Effect.gen(function* () {
      const error = yield* streamThroughProvider(
        [{ kind: 'truncate-after-chunks', chunks: 2 }],
        inProcessLayer
      ).pipe(Effect.flip)

      expect(error).toBeInstanceOf(LLMError)

      if (error instanceof LLMError) {
        expect(error.provider?.providerCode).toBe('incomplete_stream')
      }
    })
  )
})
