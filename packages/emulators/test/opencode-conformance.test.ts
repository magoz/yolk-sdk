/**
 * Cross-checks: the OpenCode Go emulator must satisfy the same Go conformance cases the replayed
 * fixtures satisfy, through the real public Go provider on each protocol, both in-process and over
 * a loopback socket; the recorded default answers (including the commentary replay's text answer)
 * must satisfy them; the test controls the fixture-only routes allow (shared faults, scripted
 * errors, same-shaped usage bodies) must fail the right case; and wire faults must map correctly
 * through the provider (429 `retry-after`, a stream cut before its terminal event).
 * Tests may import SDK packages; the emulator source never does.
 */
import { Effect, Layer, Predicate, Redacted, Ref, Stream } from 'effect'
import { FetchHttpClient, type HttpClient } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import { formatConformanceReport, runConformance } from '@yolk-sdk/conformance/runner'
import {
  LLMDone,
  LLMError,
  LLMProvider,
  LLMTextDelta,
  LLMUsage,
  type LLMEvent
} from '@yolk-sdk/agent/loop'
import { UserMessage } from '@yolk-sdk/agent/protocol'
import { isWireStreamResponse } from '@yolk-sdk/conformance/fixture'
import {
  OpenCodeGoConformanceConfig,
  openCodeGoChatPlainTextCase,
  openCodeGoChatPlainTextFixture,
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

/** Each Done's stop reason and whether it says the requested usage never arrived. */
const doneSignals = (events: Iterable<LLMEvent>) =>
  Array.from(events).flatMap(event =>
    event instanceof LLMDone ? [[event.stopReason, event.usageUnavailable]] : []
  )

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

  // The recorded chat stream sends its usage in a chunk after the finish chunk. A cut between
  // them still completes (the answer is whole), and Done says the requested usage never arrived.
  it.effect('chat-completions: a stream cut after the finish marks its usage unavailable', () =>
    Effect.gen(function* () {
      const response = openCodeGoChatPlainTextFixture.exchanges[0].response
      const chunks = isWireStreamResponse(response) ? response.chunks : expect.fail('no stream')

      // The whole JSON events in the first `count` chunks.
      const events = (count: number): ReadonlyArray<unknown> =>
        chunks
          .slice(0, count)
          .map(chunk => (Predicate.isString(chunk) ? chunk : expect.fail('text chunks only')))
          .join('')
          .split('\n\n')
          .slice(0, -1)
          .map(event => event.replace(/^data: ?/, ''))
          .filter(payload => payload !== '[DONE]')
          .map(payload => JSON.parse(payload))

      const isFinish = (event: unknown) =>
        Predicate.hasProperty(event, 'choices') &&
        Array.isArray(event.choices) &&
        event.choices.some(
          (choice: unknown) =>
            Predicate.hasProperty(choice, 'finish_reason') &&
            Predicate.isString(choice.finish_reason)
        )

      const hasUsage = (event: unknown) =>
        Predicate.hasProperty(event, 'usage') && Predicate.isObject(event.usage)

      // The fewest chunks carrying the whole finish event: the usage chunk is not among them.
      const kept = chunks.findIndex((_, index) => events(index + 1).some(isFinish)) + 1

      expect(kept).toBeGreaterThan(0)
      expect(events(kept).some(hasUsage)).toBe(false)
      expect(events(chunks.length).some(hasUsage)).toBe(true)

      const emulator = makeOpenCodeGoEmulator()

      emulator.chat.faults.add({ kind: 'truncate-after-chunks', chunks: kept })

      const streamed = yield* streamThroughProvider('chat-completions', inProcessLayer(emulator))

      expect(doneSignals(streamed)).toEqual([['stop', true]])
      expect(streamed.some(event => event instanceof LLMUsage)).toBe(false)
      expect(emulator.chat.ledger.entries()[0]?.fault).toBe('truncate-after-chunks')
    })
  )

  // Issue #363: a Responses stream cut before `response.completed` emits no Done, the loop's
  // incomplete stream, as `messages` reports a missing `message_stop`. The provider code stays
  // `incomplete_stream`, so Go still re-routes a cut that came before any event.
  describe('responses: a stream cut before response.completed', () => {
    const failThroughProvider = (emulator: OpenCodeGoEmulator) =>
      Effect.gen(function* () {
        const llm = yield* LLMProvider
        const seen = yield* Ref.make<ReadonlyArray<LLMEvent>>([])

        const error = yield* llm
          .stream({
            model: modelFor.responses,
            systemPrompt: 'Reply in one short sentence.',
            messages: [UserMessage.make({ content: 'Say hello.' })],
            tools: []
          })
          .pipe(
            Stream.runForEach(event => Ref.update(seen, events => [...events, event])),
            Effect.flip
          )

        return { events: yield* Ref.get(seen), error }
      }).pipe(
        Effect.provide(
          makeOpenCodeGoProviderLayer({ apiKey, protocol: 'responses', maxOutputTokens: 64 }).pipe(
            Layer.provide(inProcessLayer(emulator))
          )
        )
      )

    const expectMissingDone = (error: unknown) =>
      expect(error).toMatchObject({
        cause: 'invalid_response',
        retryable: false,
        responseIssue: 'missing_done',
        message: 'OpenCode Go invalid_response',
        provider: { provider: 'opencode_go', providerCode: 'incomplete_stream' }
      })

    it.effect('after the text began fails as missing_done, without a re-route', () =>
      Effect.gen(function* () {
        const emulator = makeOpenCodeGoEmulator()

        // Four events, then the first text delta: output started.
        emulator.responses.faults.add({ kind: 'truncate-after-chunks', chunks: 5, count: 1 })

        const { events, error } = yield* failThroughProvider(emulator)

        expectMissingDone(error)
        expect(events.some(event => event instanceof LLMTextDelta)).toBe(true)
        expect(doneReasons(events)).toEqual([])
        expect(emulator.responses.ledger.entries()).toHaveLength(1)
      })
    )

    it.effect('before any event is re-routed once, then fails as missing_done', () =>
      Effect.gen(function* () {
        const emulator = makeOpenCodeGoEmulator()

        // Every request: the first and its re-route.
        emulator.responses.faults.add({ kind: 'truncate-after-chunks', chunks: 4 })

        const { events, error } = yield* failThroughProvider(emulator)

        expectMissingDone(error)
        expect(events).toEqual([])
        expect(emulator.responses.ledger.entries().map(entry => entry.fault)).toEqual([
          'truncate-after-chunks',
          'truncate-after-chunks'
        ])
      })
    )

    it.effect('before any event, once, is answered by the re-routed request', () =>
      Effect.gen(function* () {
        const emulator = makeOpenCodeGoEmulator()

        emulator.responses.faults.add({ kind: 'truncate-after-chunks', chunks: 4, count: 1 })

        const events = yield* streamThroughProvider('responses', inProcessLayer(emulator))

        expect(doneReasons(events)).toEqual(['stop'])
        expect(emulator.responses.ledger.entries()).toHaveLength(2)
      })
    )
  })

  it.effect('chat-completions: Done stays unmarked when the usage chunk arrives', () =>
    Effect.gen(function* () {
      const events = yield* streamThroughProvider(
        'chat-completions',
        inProcessLayer(makeOpenCodeGoEmulator())
      )

      expect(doneSignals(events)).toEqual([['stop', undefined]])
      expect(events.some(event => event instanceof LLMUsage)).toBe(true)
    })
  )

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
