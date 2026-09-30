/**
 * Cross-checks: the OpenCode Go emulator must satisfy the same Go conformance cases the replayed
 * fixtures satisfy, through the real public Go provider on each protocol, both in-process and over
 * a loopback socket; the recorded default answers (including the commentary replay's text answer)
 * must satisfy them; the test controls the fixture-only routes allow (shared faults, scripted
 * errors, same-shaped usage bodies) must fail the right case; and wire faults must map correctly
 * through the provider (429 `retry-after`, a stream cut before its terminal event).
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
        headers: { 'anthropic-version': '2023-06-01' },
        body: { max_tokens: 64 }
      })
      // Each request was answered by its own recording, never a not-emulated 400.
      expect(
        [emulator.chat, emulator.messages, emulator.responses, emulator.usage].flatMap(part =>
          part.ledger.entries().map(entry => [entry.status, entry.recording])
        )
      ).toEqual([
        [200, 'opencode.go.chat.stream.plain-text.synthetic'],
        [200, 'opencode.go.messages.stream.plain-text.synthetic'],
        [200, 'opencode.go.responses.stream.plain-text.synthetic'],
        [200, 'opencode.go.responses.stream.commentary-replay.synthetic'],
        [200, 'opencode.go.usage.snapshot.synthetic']
      ])
    }).pipe(Effect.scoped)
  )

  it.effect('answers the commentary replay with its recorded text answer, one Done(stop)', () =>
    Effect.gen(function* () {
      const emulator = makeOpenCodeGoEmulator()

      const result = yield* runConformance([openCodeGoResponsesCommentaryReplayCase], {
        target: { kind: 'in-process' },
        now,
        layer: () => Layer.mergeAll(inProcessLayer(emulator), configLayer)
      }).pipe(Effect.map(report => report.results[0]))

      expect(result?.status).toBe('passed')
      expect(emulator.responses.ledger.entries()).toMatchObject([
        { status: 200, recording: 'opencode.go.responses.stream.commentary-replay.synthetic' }
      ])
    })
  )
})

describe('OpenCode Go conformance disagreement drills (emulator)', () => {
  it.effect('fails each protocol case for a scripted provider error', () =>
    Effect.gen(function* () {
      for (const [testCase, part] of [
        [openCodeGoChatPlainTextCase, 'chat'],
        [openCodeGoMessagesPlainTextCase, 'messages'],
        [openCodeGoResponsesPlainTextCase, 'responses'],
        [openCodeGoResponsesCommentaryReplayCase, 'responses']
      ] as const) {
        const result = yield* drill(testCase, emulator =>
          emulator[part].script.enqueue({
            error: { status: 500, body: { error: { message: 'synthetic' } } }
          })
        )

        expect(result?.status, testCase.id).toBe('failed')
        expect(result?.failure?.tag, testCase.id).toBe('LLMError')
      }
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

  it.effect('fails the usage case for out-of-range windows and for a 401', () =>
    Effect.gen(function* () {
      // Same recorded shape, but no percentage the parser reports.
      const outOfRange = {
        usage: {
          rolling: { percent: 101, resetsAt: '2026-10-01T03:00:00.000Z' },
          weekly: { percent: 102, resetsAt: '2026-10-05T00:00:00.000Z' },
          monthly: { percent: 103, resetsAt: '2026-10-31T00:00:00.000Z' }
        }
      }

      expect(
        (yield* drill(openCodeGoUsageSnapshotCase, emulator =>
          emulator.usage.script.enqueue({ usage: outOfRange })
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

  it.effect(
    'answers 400 not-emulated through the provider for a request shape no fixture records',
    () =>
      Effect.gen(function* () {
        // A host output limit is latitude; a reasoning effort is not recorded, so it is not emulated.
        const events = yield* Effect.gen(function* () {
          const llm = yield* LLMProvider

          return yield* llm
            .stream({
              model: openCodeGoConformanceDefaultModels.responses,
              systemPrompt: 'Reply in one short sentence.',
              messages: [UserMessage.make({ content: 'Say hello.' })],
              tools: [],
              reasoningEffort: 'low'
            })
            .pipe(Stream.runCollect, Effect.flip)
        }).pipe(
          Effect.provide(
            makeOpenCodeGoProviderLayer({
              apiKey,
              protocol: 'responses',
              maxOutputTokens: 4096
            }).pipe(Layer.provide(inProcessLayer(makeOpenCodeGoEmulator())))
          )
        )

        expect(events).toBeInstanceOf(LLMError)
        expect(events).toMatchObject({ provider: { status: 400 } })
      })
  )
})
