/**
 * Cross-checks: the Gateway emulator must satisfy the same conformance cases the replayed
 * fixtures satisfy, through the real Gateway provider, both in-process and over a loopback
 * socket. Tests may import SDK packages; the emulator source never does.
 */
import { Effect, Layer, Redacted, Ref, Stream } from 'effect'
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { LLMError, LLMProvider } from '@yolk-sdk/agent/loop'
import { UserMessage } from '@yolk-sdk/agent/protocol'
import {
  makeVercelAiGatewayProviderLayer,
  vercelAiGatewayChatCompletionsUrl
} from '@yolk-sdk/agent/providers/vercel/ai-gateway-provider'
import {
  VercelAiGatewayConformanceConfig,
  vercelAiGatewayConformanceCases,
  vercelAiGatewayConformanceDefaultModels,
  vercelAiGatewayDeepSeekReasoningCase,
  vercelAiGatewayPlainTextCase,
  type VercelAiGatewayConformanceCase,
  type VercelAiGatewayConformanceSettings
} from '@yolk-sdk/agent/providers/vercel/conformance'
import { formatConformanceReport, runConformance } from '@yolk-sdk/conformance/runner'
import {
  makeGatewayEmulator,
  type GatewayEmulator,
  type GatewayFault,
  type GatewayScriptedTurn
} from '../src/gateway.ts'
import { serveFetchHandler } from '../src/node.ts'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const gatewayOrigin = new URL(vercelAiGatewayChatCompletionsUrl).origin

const now = new Date('2026-09-30T12:00:00.000Z')

const settings: VercelAiGatewayConformanceSettings = {
  apiKey: Redacted.make('synthetic-gateway-key'),
  maxCompletionTokens: 64,
  reasoningMaxCompletionTokens: 512,
  reasoningEffort: 'high',
  models: vercelAiGatewayConformanceDefaultModels
}

const configLayer = Layer.succeed(VercelAiGatewayConformanceConfig, settings)

const inProcessLayer = (emulator: GatewayEmulator) =>
  InProcessHttpClient.layer([EmulatorRoute.handler(gatewayOrigin, emulator.fetch)])

/** Real `FetchHttpClient` underneath, routed to the emulator served on 127.0.0.1:0. */
const emulatedLayer = (emulator: GatewayEmulator) =>
  Layer.unwrap(
    serveFetchHandler(emulator.fetch).pipe(
      Effect.map(server =>
        EmulatedHttpClient.layer([EmulatorRoute.url(gatewayOrigin, server.url)]).pipe(
          Layer.provide(FetchHttpClient.layer)
        )
      )
    )
  )

describe('cross-check A: in-process emulator', () => {
  it.effect('passes every Gateway conformance case', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(vercelAiGatewayConformanceCases, {
        target: { kind: 'in-process' },
        now,
        layer: () => Layer.mergeAll(inProcessLayer(makeGatewayEmulator()), configLayer)
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

describe('cross-check B: emulated over a loopback socket', () => {
  it.effect(
    'passes every Gateway conformance case, with streamed bodies sent as several chunks',
    () =>
      Effect.gen(function* () {
        const emulators = yield* Ref.make(new Map<string, GatewayEmulator>())

        const report = yield* runConformance(vercelAiGatewayConformanceCases, {
          target: { kind: 'emulated' },
          now,
          layer: testCase => {
            const emulator = makeGatewayEmulator()

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

        for (const testCase of vercelAiGatewayConformanceCases) {
          const entries = ledgers.get(testCase.id)?.ledger.entries() ?? []

          expect(entries, testCase.id).toHaveLength(1)
          expect(entries[0]?.path).toBe('/v1/chat/completions')
          expect(entries[0]?.stream).toBe(true)
          expect(entries[0]?.evidence).toBe('unverified')
        }

        // Streamed cases: the emulator produced several body chunks, one per pull. This does not
        // prove client-side timing; `node.test.ts` covers progressive delivery over the socket.
        for (const id of [
          'vercel-ai-gateway.stream.plain-text',
          'vercel-ai-gateway.stream.deepseek-reasoning',
          'vercel-ai-gateway.stream.tool-call-deltas'
        ]) {
          const [entry] = ledgers.get(id)?.ledger.entries() ?? []

          expect(entry?.status, id).toBe(200)
          expect(entry?.bodyChunks, id).toBeGreaterThan(1)
        }

        const [errorEntry] =
          ledgers.get('vercel-ai-gateway.stream.error-envelope')?.ledger.entries() ?? []

        expect(errorEntry?.status).toBe(400)
      })
  )
})

const drill = (testCase: VercelAiGatewayConformanceCase, turn: GatewayScriptedTurn) =>
  runConformance([testCase], {
    target: { kind: 'in-process' },
    now,
    layer: () => {
      const emulator = makeGatewayEmulator()

      emulator.script.enqueue(turn)

      return Layer.mergeAll(inProcessLayer(emulator), configLayer)
    }
  }).pipe(Effect.map(report => report.results[0]))

describe('disagreement drill', () => {
  it.effect('fails the reasoning case when reasoning arrives after the text', () =>
    Effect.gen(function* () {
      const result = yield* drill(vercelAiGatewayDeepSeekReasoningCase, {
        reasoning: ['Thinking about it.'],
        text: ['Hello', ' there.'],
        order: 'text-first'
      })

      expect(result?.status).toBe('failed')
      expect(result?.failure?.message).toContain(
        'every reasoning delta before the first text delta'
      )
    })
  )

  it.effect('fails the plain-text case when the usage chunk is dropped', () =>
    Effect.gen(function* () {
      const result = yield* drill(vercelAiGatewayPlainTextCase, {
        text: ['Hello', ' there.'],
        usage: null
      })

      expect(result?.status).toBe('failed')
      expect(result?.failure?.message).toContain('usage report')
    })
  )

  it.effect('the same scripted shapes pass when they agree with the cases', () =>
    Effect.gen(function* () {
      const reasoning = yield* drill(vercelAiGatewayDeepSeekReasoningCase, {
        reasoning: ['Thinking about it.'],
        text: ['Hello', ' there.']
      })

      const plain = yield* drill(vercelAiGatewayPlainTextCase, { text: ['Hello', ' there.'] })

      expect([reasoning?.status, plain?.status]).toEqual(['passed', 'passed'])
    })
  )
})

const streamThroughProvider = <E>(
  faults: ReadonlyArray<GatewayFault>,
  transport: (emulator: GatewayEmulator) => Layer.Layer<HttpClient.HttpClient, E>
) =>
  Effect.gen(function* () {
    const provider = yield* LLMProvider

    return yield* provider
      .stream({
        model: vercelAiGatewayConformanceDefaultModels.plainText,
        systemPrompt: 'Reply in one short sentence.',
        messages: [UserMessage.make({ content: 'Say hello.' })],
        tools: []
      })
      .pipe(Stream.runCollect)
  }).pipe(
    Effect.provide(
      makeVercelAiGatewayProviderLayer({
        apiKey: settings.apiKey,
        maxCompletionTokens: 64,
        streaming: true
      }).pipe(
        Layer.provide(
          transport(
            (() => {
              const emulator = makeGatewayEmulator()

              for (const fault of faults) emulator.faults.add(fault)

              return emulator
            })()
          )
        )
      )
    )
  )

describe('faults through the Gateway provider', () => {
  const expectRateLimit = (error: unknown) => {
    expect(error).toBeInstanceOf(LLMError)

    if (error instanceof LLMError) {
      expect(error.retryable).toBe(true)
      expect(error.cause).toBe('rate_limit')
      expect(error.provider?.kind).toBe('rate_limit')
      expect(error.provider?.status).toBe(429)
      expect(error.provider?.retryAfterMs).toBe(2000)
    }
  }

  it.effect(
    'a 429 with retry-after becomes a retryable rate-limit LLMError with retryAfterMs (in-process)',
    () =>
      Effect.gen(function* () {
        const error = yield* streamThroughProvider(
          [{ kind: 'status', status: 429, headers: { 'retry-after': '2' } }],
          inProcessLayer
        ).pipe(Effect.flip)

        expectRateLimit(error)
      })
  )

  it.effect(
    'a 429 with retry-after becomes a retryable rate-limit LLMError with retryAfterMs (loopback socket)',
    () =>
      Effect.gen(function* () {
        const error = yield* streamThroughProvider(
          [{ kind: 'status', status: 429, headers: { 'retry-after': '2' } }],
          emulatedLayer
        ).pipe(Effect.flip, Effect.scoped)

        expectRateLimit(error)
      })
  )

  it.effect('a mid-stream error becomes a retryable network LLMError (in-process)', () =>
    Effect.gen(function* () {
      const error = yield* streamThroughProvider(
        [{ kind: 'error-after-chunks', chunks: 2 }],
        inProcessLayer
      ).pipe(Effect.flip)

      expect(error).toBeInstanceOf(LLMError)

      if (error instanceof LLMError) {
        expect(error.retryable).toBe(true)
        expect(error.provider?.kind).toBe('network')
      }
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
})
