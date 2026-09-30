/**
 * Cross-checks: the OpenCode Go emulator must satisfy the same Go conformance cases the replayed
 * fixtures satisfy, through the real public Go provider on each protocol, both in-process and over
 * a loopback socket; disagreement drills must fail the right case; and wire faults must map
 * correctly through the provider (429 `retry-after`, a missing terminal event, a mid-stream error).
 * Tests may import SDK packages; the emulator source never does.
 */
import { Effect, Layer, Redacted, Stream } from 'effect'
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http'
import { describe, expect, it } from '@effect/vitest'
import { formatConformanceReport, runConformance } from '@yolk-sdk/conformance/runner'
import { LLMDone, LLMError, LLMProvider, type LLMEvent } from '@yolk-sdk/agent/loop'
import { UserMessage } from '@yolk-sdk/agent/protocol'
import {
  OpenCodeGoConformanceConfig,
  openCodeGoChatPlainTextCase,
  openCodeGoConformanceCases,
  openCodeGoConformanceDefaultModels,
  openCodeGoMessagesPlainTextCase,
  openCodeGoResponsesCommentaryReplayCase,
  openCodeGoResponsesPlainTextCase,
  openCodeGoUsageSnapshotCase,
  type OpenCodeGoConformanceCase
} from '@yolk-sdk/agent/providers/opencode/conformance'
import {
  makeOpenCodeGoProviderLayer,
  type OpenCodeGoProtocol
} from '@yolk-sdk/agent/providers/opencode/go-provider'
import { serveFetchHandler } from '../src/node.ts'
import { makeOpenCodeGoEmulator, type OpenCodeGoEmulator } from '../src/opencode.ts'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const now = new Date('2026-09-30T12:00:00.000Z')

const origin = 'https://opencode.ai'

const apiKey = Redacted.make('synthetic-go-key')

const configLayer = Layer.succeed(OpenCodeGoConformanceConfig, {
  apiKey,
  maxOutputTokens: 64,
  models: openCodeGoConformanceDefaultModels
})

const inProcessLayer = (emulator: OpenCodeGoEmulator) =>
  InProcessHttpClient.layer([EmulatorRoute.handler(origin, emulator.fetch)])

/** Real `FetchHttpClient` underneath, routed to the emulator served on 127.0.0.1:0. */
const emulatedLayer = (emulator: OpenCodeGoEmulator) =>
  Layer.unwrap(
    serveFetchHandler(emulator.fetch).pipe(
      Effect.map(server =>
        EmulatedHttpClient.layer([EmulatorRoute.url(origin, server.url)]).pipe(
          Layer.provide(FetchHttpClient.layer)
        )
      )
    )
  )

const drill = (
  testCase: OpenCodeGoConformanceCase,
  prepare: (emulator: OpenCodeGoEmulator) => void
) =>
  runConformance([testCase], {
    target: { kind: 'in-process' },
    now,
    layer: () => {
      const emulator = makeOpenCodeGoEmulator()

      prepare(emulator)

      return Layer.mergeAll(inProcessLayer(emulator), configLayer)
    }
  }).pipe(Effect.map(report => report.results[0]))

const mismatch = (message: string) => ({ kind: 'failure', tag: 'ConformanceMismatch', message })

const doneReasons = (events: Iterable<LLMEvent>) =>
  Array.from(events).flatMap(event => (event instanceof LLMDone ? [event.stopReason] : []))

const modelFor: Readonly<Record<OpenCodeGoProtocol, string>> = {
  'chat-completions': openCodeGoConformanceDefaultModels.chat,
  messages: openCodeGoConformanceDefaultModels.messages,
  responses: openCodeGoConformanceDefaultModels.responses
}

const streamThroughProvider = <E>(
  protocol: OpenCodeGoProtocol,
  transport: Layer.Layer<HttpClient.HttpClient, E>
) =>
  Effect.gen(function* () {
    const llm = yield* LLMProvider

    return Array.from(
      yield* llm
        .stream({
          model: modelFor[protocol],
          systemPrompt: 'Reply in one short sentence.',
          messages: [UserMessage.make({ content: 'Say hello.' })],
          tools: []
        })
        .pipe(Stream.runCollect)
    )
  }).pipe(
    Effect.provide(
      makeOpenCodeGoProviderLayer({ apiKey, protocol, maxOutputTokens: 64 }).pipe(
        Layer.provide(transport)
      )
    )
  )

describe('OpenCode Go conformance cases against the emulator', () => {
  it.effect('all pass in-process', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(openCodeGoConformanceCases, {
        target: { kind: 'in-process' },
        now,
        layer: () => Layer.mergeAll(inProcessLayer(makeOpenCodeGoEmulator()), configLayer)
      })

      expect(report.summary, formatConformanceReport(report)).toEqual({
        passed: openCodeGoConformanceCases.length,
        failed: 0,
        skipped: 0
      })
    })
  )

  it.effect('all pass over a loopback socket with the real FetchHttpClient', () =>
    Effect.gen(function* () {
      const emulator = makeOpenCodeGoEmulator()

      const report = yield* runConformance(openCodeGoConformanceCases, {
        target: { kind: 'emulated' },
        now,
        layer: () => Layer.mergeAll(emulatedLayer(emulator), configLayer)
      })

      expect(report.summary, formatConformanceReport(report)).toEqual({
        passed: openCodeGoConformanceCases.length,
        failed: 0,
        skipped: 0
      })
      // Every Go route saw its case traffic, and nothing failed closed.
      expect(emulator.coverage().routes.map(route => route.requests)).toEqual([1, 1, 2, 1])
      expect(emulator.coverage().unknownRouteRequests).toBe(0)
      expect(emulator.messages.ledger.entries()[0]).toMatchObject({
        credentialHeader: 'x-api-key',
        anthropicVersion: '2023-06-01',
        maxTokens: 64
      })
      expect(emulator.responses.ledger.entries().map(entry => entry.maxOutputTokens)).toEqual([
        64, 64
      ])
    }).pipe(Effect.scoped)
  )

  it.effect('passes the commentary case when the emulator answers with a tool call', () =>
    Effect.gen(function* () {
      // Without a script the emulator answers a request offering tools with a function call.
      const result = yield* drill(openCodeGoResponsesCommentaryReplayCase, () => undefined)

      expect(result?.status).toBe('passed')
    })
  )
})

describe('OpenCode Go conformance disagreement drills (emulator)', () => {
  it.effect('fails each plain-text case for an empty answer', () =>
    Effect.gen(function* () {
      expect(
        (yield* drill(openCodeGoChatPlainTextCase, emulator =>
          emulator.chat.script.enqueue({ text: [''] })
        ))?.failure
      ).toEqual(mismatch('expected non-empty answer text'))
      expect(
        (yield* drill(openCodeGoMessagesPlainTextCase, emulator =>
          emulator.messages.script.enqueue({ text: [' '] })
        ))?.failure
      ).toEqual(mismatch('expected non-empty answer text'))
      expect(
        (yield* drill(openCodeGoResponsesPlainTextCase, emulator =>
          emulator.responses.script.enqueue({ text: [''] })
        ))?.failure
      ).toEqual(mismatch('expected non-empty answer text'))
    })
  )

  it.effect('fails the plain-text cases without usage', () =>
    Effect.gen(function* () {
      expect(
        (yield* drill(openCodeGoChatPlainTextCase, emulator =>
          emulator.chat.script.enqueue({ text: ['Hi.'], usage: null })
        ))?.failure
      ).toEqual(mismatch('expected a usage report'))
      expect(
        (yield* drill(openCodeGoResponsesPlainTextCase, emulator =>
          emulator.responses.script.enqueue({ text: ['Hi.'], usage: null })
        ))?.failure
      ).toEqual(mismatch('expected a usage report'))
    })
  )

  it.effect(
    'fails the Messages and Responses cases when the stream is cut before its terminal event',
    () =>
      Effect.gen(function* () {
        const messages = yield* drill(openCodeGoMessagesPlainTextCase, emulator =>
          emulator.messages.faults.add({ kind: 'truncate-after-chunks', chunks: 5 })
        )

        expect(messages?.status).toBe('failed')
        expect(messages?.failure?.tag).toBe('LLMError')

        const responses = yield* drill(openCodeGoResponsesPlainTextCase, emulator =>
          emulator.responses.faults.add({ kind: 'truncate-after-chunks', chunks: 5 })
        )

        expect(responses?.status).toBe('failed')
        expect(responses?.failure?.tag).toBe('LLMError')
      })
  )

  it.effect('fails the usage case for a body without windows and for a 401', () =>
    Effect.gen(function* () {
      expect(
        (yield* drill(openCodeGoUsageSnapshotCase, emulator =>
          emulator.usage.script.enqueue({ usage: { usage: { rolling: { percent: null } } } })
        ))?.failure
      ).toEqual(mismatch('expected at least one usage window'))

      const unauthorized = yield* drill(openCodeGoUsageSnapshotCase, emulator =>
        emulator.usage.faults.add({ kind: 'status', status: 401 })
      )

      expect(unauthorized?.failure?.tag).toBe('ProviderSubscriptionUsageAuthError')
    })
  )

  it.effect('fails only the case whose route is faulted', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(openCodeGoConformanceCases, {
        target: { kind: 'in-process' },
        now,
        layer: () => {
          const emulator = makeOpenCodeGoEmulator()

          emulator.messages.faults.add({ kind: 'status', status: 500 })

          return Layer.mergeAll(inProcessLayer(emulator), configLayer)
        }
      })

      expect(
        report.results.filter(result => result.status === 'failed').map(result => result.id)
      ).toEqual([openCodeGoMessagesPlainTextCase.id])
    })
  )
})

describe('OpenCode Go faults through the real provider', () => {
  const faultPart = (emulator: OpenCodeGoEmulator, protocol: OpenCodeGoProtocol) =>
    ({
      'chat-completions': emulator.chat.faults,
      messages: emulator.messages.faults,
      responses: emulator.responses.faults
    })[protocol]

  for (const protocol of ['chat-completions', 'messages', 'responses'] as const) {
    it.effect(`${protocol}: 429 retry-after is a retryable rate limit`, () =>
      Effect.gen(function* () {
        const emulator = makeOpenCodeGoEmulator()

        faultPart(emulator, protocol).add({
          kind: 'status',
          status: 429,
          headers: { 'retry-after': '2' }
        })

        const error = yield* streamThroughProvider(protocol, inProcessLayer(emulator)).pipe(
          Effect.flip
        )

        expect(error).toBeInstanceOf(LLMError)
        expect(error).toMatchObject({
          cause: 'rate_limit',
          retryable: true,
          provider: { status: 429, retryAfterMs: 2000 }
        })
      })
    )

    it.effect(`${protocol}: a plain answer streams one Done(stop)`, () =>
      Effect.gen(function* () {
        const events = yield* streamThroughProvider(
          protocol,
          inProcessLayer(makeOpenCodeGoEmulator())
        )

        expect(doneReasons(events)).toEqual(['stop'])
      })
    )
  }

  it.effect('responses: a mid-stream response.failed event fails the stream', () =>
    Effect.gen(function* () {
      const emulator = makeOpenCodeGoEmulator()

      emulator.responses.faults.add({
        kind: 'error-event-after-chunks',
        chunks: 3,
        event: 'response.failed'
      })

      const error = yield* streamThroughProvider('responses', inProcessLayer(emulator)).pipe(
        Effect.flip
      )

      expect(error).toBeInstanceOf(LLMError)
    })
  )

  it.effect('messages: a mid-stream error event fails the stream', () =>
    Effect.gen(function* () {
      const emulator = makeOpenCodeGoEmulator()

      emulator.messages.faults.add({ kind: 'error-event-after-chunks', chunks: 3 })

      const error = yield* streamThroughProvider('messages', inProcessLayer(emulator)).pipe(
        Effect.flip
      )

      expect(error).toBeInstanceOf(LLMError)
    })
  )
})
