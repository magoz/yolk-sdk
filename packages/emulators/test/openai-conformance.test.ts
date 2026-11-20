/**
 * Cross-checks: the OpenAI emulator must satisfy the same conformance cases the replayed
 * fixtures satisfy, through the real OpenAI-compatible chat provider, both in-process and over a
 * loopback socket. Tests may import SDK packages; the emulator source never does.
 */
import { Effect, Layer, Predicate, Redacted, Ref, Schema, Stream } from 'effect'
import { FetchHttpClient, type HttpClient } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import { LLMError, LLMProvider, type LLMEvent } from '@yolk-sdk/agent/loop'
import { AgentReasoningEffort, UserMessage } from '@yolk-sdk/agent/protocol'
import {
  OpenAiConformanceConfig,
  openAiChatJsonPlainTextCase,
  openAiChatJsonReasoningUsageCase,
  openAiChatPlainTextCase,
  openAiChatReasoningEffortCase,
  openAiChatToolCallDeltasCase,
  openAiChatUnsupportedParameterCase,
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
  openAiEmulatorDefaultReasoningModels,
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
  reasoningMaxCompletionTokens: 1024,
  reasoningEffort: 'medium',
  models: openAiConformanceDefaultModels
}

const configLayer = Layer.succeed(OpenAiConformanceConfig, settings)

const jsonCaseIds: ReadonlyArray<string> = [
  openAiChatJsonPlainTextCase.id,
  openAiChatJsonReasoningUsageCase.id
]

const reasoningCaseIds: ReadonlyArray<string> = [
  openAiChatReasoningEffortCase.id,
  openAiChatJsonReasoningUsageCase.id
]

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
        passed: 7,
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
        passed: 7,
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
          stream: !jsonCaseIds.includes(testCase.id),
          evidence: 'unverified'
        })
      }

      // The plain cases send the plain limit as `max_completion_tokens`; the reasoning cases send
      // the reasoning limit and the effort to the reasoning model.
      for (const testCase of openAiConformanceCases) {
        if (testCase.id === openAiChatUnsupportedParameterCase.id) continue

        const reasoning = reasoningCaseIds.includes(testCase.id)

        expect(entryOf(testCase.id)?.maxCompletionTokens, testCase.id).toBe(
          reasoning ? settings.reasoningMaxCompletionTokens : settings.maxCompletionTokens
        )
        expect(entryOf(testCase.id)?.reasoningEffort, testCase.id).toBe(
          reasoning ? settings.reasoningEffort : undefined
        )
        expect(entryOf(testCase.id)?.body, testCase.id).not.toHaveProperty('max_tokens')
      }

      for (const id of reasoningCaseIds) {
        expect(entryOf(id), id).toMatchObject({
          model: settings.models.reasoning,
          status: 200
        })
      }

      // The rejected parameter: `max_tokens` on the reasoning model, answered 400 before any body.
      expect(entryOf(openAiChatUnsupportedParameterCase.id)).toMatchObject({
        model: settings.models.reasoning,
        status: 400,
        unsupportedParameter: 'max_tokens',
        body: { max_tokens: settings.maxCompletionTokens }
      })
      expect(entryOf(openAiChatUnsupportedParameterCase.id)?.maxCompletionTokens).toBeUndefined()

      // Streamed cases: several body chunks, one per pull (`node.test.ts` covers progressive
      // delivery over the socket). The JSON case is one chunk.
      for (const id of [
        'openai.chat.stream.plain-text',
        'openai.chat.stream.tool-call-deltas',
        'openai.chat.stream.reasoning-effort'
      ]) {
        expect(entryOf(id)?.status, id).toBe(200)
        expect(entryOf(id)?.bodyChunks, id).toBeGreaterThan(1)
      }

      expect(entryOf('openai.chat.json.plain-text')).toMatchObject({ status: 200, bodyChunks: 1 })
      expect(entryOf('openai.chat.json.reasoning-usage')).toMatchObject({
        status: 200,
        bodyChunks: 1
      })
      expect(entryOf('openai.chat.stream.error-envelope')?.status).toBe(404)
    })
  )
})

const runOn = (testCase: OpenAiConformanceCase, makeEmulator: () => OpenAiEmulator) =>
  runConformance([testCase], {
    target: { kind: 'in-process' },
    now,
    layer: () => Layer.mergeAll(inProcessLayer(makeEmulator()), configLayer)
  }).pipe(Effect.map(report => report.results[0]))

const drill = (testCase: OpenAiConformanceCase, turn: OpenAiScriptedTurn) =>
  runOn(testCase, () => {
    const emulator = makeOpenAiEmulator()

    emulator.script.enqueue(turn)

    return emulator
  })

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

  it.effect('fails both reasoning cases when usage counts no reasoning tokens', () =>
    Effect.gen(function* () {
      for (const testCase of [openAiChatReasoningEffortCase, openAiChatJsonReasoningUsageCase]) {
        const result = yield* drill(testCase, {
          text: ['391'],
          usage: { promptTokens: 20, completionTokens: 2 }
        })

        expect(result?.status, testCase.id).toBe('failed')
        expect(result?.failure?.message, testCase.id).toBe(
          'expected the usage report to count reasoning tokens'
        )
      }
    })
  )

  it.effect('fails both reasoning cases when the model is not a reasoning model', () =>
    Effect.gen(function* () {
      // Without reasoning models the effort is recorded and ignored: usage counts no reasoning.
      for (const testCase of [openAiChatReasoningEffortCase, openAiChatJsonReasoningUsageCase]) {
        const result = yield* runOn(testCase, () => makeOpenAiEmulator({ reasoningModels: [] }))

        expect(result?.status, testCase.id).toBe('failed')
        expect(result?.failure?.message, testCase.id).toBe(
          'expected the usage report to count reasoning tokens'
        )
      }
    })
  )

  it.effect('fails the unsupported-parameter case when max_tokens is accepted', () =>
    Effect.gen(function* () {
      // A scripted turn answers before parameter validation, as a model that accepted it would.
      const scripted = yield* drill(openAiChatUnsupportedParameterCase, { text: ['Hello.'] })

      expect(scripted?.status).toBe('failed')
      expect(scripted?.failure?.message).toBe('expected a rejection, the request succeeded')

      // A model that takes `max_tokens` (not listed as reasoning) accepts the request too.
      const plain = yield* runOn(openAiChatUnsupportedParameterCase, () =>
        makeOpenAiEmulator({ reasoningModels: [] })
      )

      expect(plain?.status).toBe('failed')
      expect(plain?.failure?.message).toBe('expected a rejection, the request succeeded')
    })
  )

  it.effect('fails the unsupported-parameter case for a scripted error in another code', () =>
    Effect.gen(function* () {
      const result = yield* drill(openAiChatUnsupportedParameterCase, {
        error: {
          status: 400,
          body: {
            error: {
              message: 'Synthetic: invalid value.',
              type: 'invalid_request_error',
              param: 'max_tokens',
              code: 'invalid_value'
            }
          }
        }
      })

      expect(result?.status).toBe('failed')
      expect(result?.failure?.message).toBe('expected the provider code `unsupported_parameter`')
    })
  )

  it.effect('the same scripted shapes pass when they agree with the cases', () =>
    Effect.gen(function* () {
      const plain = yield* drill(openAiChatPlainTextCase, { text: ['Hello', ' there.'] })

      const tool = yield* drill(openAiChatToolCallDeltasCase, {
        toolCalls: [{ name: 'lookup_weather', argumentFragments: ['{"ci', 'ty":"Springfield"}'] }]
      })

      const json = yield* drill(openAiChatJsonPlainTextCase, { text: ['Hello', ' there.'] })

      const reasoningUsage = { promptTokens: 20, completionTokens: 66, reasoningTokens: 64 }

      const reasoning = yield* drill(openAiChatReasoningEffortCase, {
        text: ['391'],
        usage: reasoningUsage
      })

      const jsonReasoning = yield* drill(openAiChatJsonReasoningUsageCase, {
        text: ['391'],
        usage: reasoningUsage
      })

      const rejected = yield* drill(openAiChatUnsupportedParameterCase, {
        error: {
          status: 400,
          body: {
            error: {
              message: 'Synthetic: unsupported parameter.',
              type: 'invalid_request_error',
              param: 'max_tokens',
              code: 'unsupported_parameter'
            }
          }
        }
      })

      expect([
        plain?.status,
        tool?.status,
        json?.status,
        reasoning?.status,
        jsonReasoning?.status,
        rejected?.status
      ]).toEqual(['passed', 'passed', 'passed', 'passed', 'passed', 'passed'])
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

describe('reasoning effort through the default OpenAI provider', () => {
  // The emulator's reasoning model; the provider config names no endpoint and no format.
  const reasoningModel = openAiEmulatorDefaultReasoningModels[0] ?? 'gpt-6-luna'

  const streamWithEffort = (emulator: OpenAiEmulator, reasoningEffort: AgentReasoningEffort) =>
    Effect.gen(function* () {
      const provider = yield* LLMProvider

      return yield* provider
        .stream({
          model: reasoningModel,
          systemPrompt: 'Reply in one short sentence.',
          messages: [UserMessage.make({ content: 'Say hello.' })],
          tools: [],
          reasoningEffort
        })
        .pipe(Stream.runCollect)
    }).pipe(
      Effect.provide(
        makeOpenAiProviderLayer({
          apiKey: settings.apiKey,
          maxCompletionTokens: 64,
          streaming: true
        }).pipe(Layer.provide(inProcessLayer(emulator)))
      )
    )

  /** The reasoning tokens the one Usage event reports. */
  const reasoningTokens = (events: Iterable<LLMEvent>) =>
    Array.from(events).flatMap(event =>
      Predicate.isTagged(event, 'Usage') ? [event.usage.output.reasoning] : []
    )

  it.effect('the native endpoint receives the effort, so the reasoning model reasons', () =>
    Effect.gen(function* () {
      const emulator = makeOpenAiEmulator()

      const events = yield* streamWithEffort(emulator, 'high')

      expect(emulator.ledger.entries().map(entry => entry.reasoningEffort)).toEqual(['high'])
      expect(reasoningTokens(events)).toEqual([expect.any(Number)])
      expect(reasoningTokens(events)[0]).toBeGreaterThan(0)
    })
  )

  it.effect('none and max reach the native endpoint unchanged; none turns reasoning off', () =>
    Effect.gen(function* () {
      const emulator = makeOpenAiEmulator()
      const efforts = ['none', 'max']
      const reported: Array<ReadonlyArray<number | undefined>> = []

      for (const value of efforts) {
        // Decoded as a host decodes a stored or submitted effort.
        const effort = yield* Schema.decodeUnknownEffect(AgentReasoningEffort)(value)

        reported.push(reasoningTokens(yield* streamWithEffort(emulator, effort)))
      }

      expect(emulator.ledger.entries().map(entry => entry.reasoningEffort)).toEqual(efforts)
      expect(reported[0]).toEqual([0])
      expect(reported[1]?.[0]).toBeGreaterThan(0)
    })
  )
})
