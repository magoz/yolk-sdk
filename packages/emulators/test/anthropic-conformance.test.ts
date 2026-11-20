/**
 * Cross-checks: the Anthropic emulator must satisfy the same conformance cases the replayed
 * fixtures satisfy, through the real native Messages provider, both in-process and over a
 * loopback socket; and wire faults must map correctly through the real providers, both the
 * native Messages path (`x-api-key`, via OpenCode Go's `messages` protocol) and the Claude
 * subscription provider (`Authorization: Bearer`). Tests may import SDK packages; the emulator
 * source never does.
 */
import { Effect, Layer, Redacted, Ref, Stream } from 'effect'
import { FetchHttpClient, type HttpClient } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import {
  LLMDone,
  LLMError,
  LLMProvider,
  LLMTextDelta,
  makeAgentLoopLayer,
  runModelTurn,
  type LLMEvent
} from '@yolk-sdk/agent/loop'
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import { ToolDef, UserMessage } from '@yolk-sdk/agent/protocol'
import {
  AnthropicConformanceConfig,
  anthropicConformanceCases,
  anthropicConformanceDefaultModels,
  anthropicConformanceMessagesUrl,
  anthropicConformanceTruncatedMaxTokens,
  anthropicMessagesMaxTokensCase,
  anthropicMessagesPlainTextCase,
  anthropicMessagesThinkingBeforeTextCase,
  anthropicMessagesToolUseInputDeltasCase,
  type AnthropicConformanceCase,
  type AnthropicConformanceSettings
} from '@yolk-sdk/agent/providers/anthropic/conformance'
import { makeAnthropicClaudeProviderLayer } from '@yolk-sdk/agent/providers/anthropic/claude-provider'
import { makeOpenCodeGoProviderLayer } from '@yolk-sdk/agent/providers/opencode/go-provider'
import { formatConformanceReport, runConformance } from '@yolk-sdk/conformance/runner'
import {
  makeAnthropicEmulator,
  type AnthropicEmulator,
  type AnthropicFault,
  type AnthropicScriptedTurn
} from '../src/anthropic.ts'
import { serveFetchHandler } from '../src/node.ts'
import { EmulatedHttpClient, EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const anthropicOrigin = new URL(anthropicConformanceMessagesUrl).origin

const now = new Date('2026-09-30T12:00:00.000Z')

const settings: AnthropicConformanceSettings = {
  apiKey: Redacted.make('synthetic-anthropic-key'),
  maxTokens: 64,
  thinkingBudgetTokens: 1024,
  models: anthropicConformanceDefaultModels
}

const configLayer = Layer.succeed(AnthropicConformanceConfig, settings)

const caseCount = anthropicConformanceCases.length

const inProcessLayer = (emulator: AnthropicEmulator) =>
  InProcessHttpClient.layer([EmulatorRoute.handler(anthropicOrigin, emulator.fetch)])

/** Real `FetchHttpClient` underneath, routed to the emulator served on 127.0.0.1:0. */
const emulatedLayer = (emulator: AnthropicEmulator) =>
  Layer.unwrap(
    serveFetchHandler(emulator.fetch).pipe(
      Effect.map(server =>
        EmulatedHttpClient.layer([EmulatorRoute.url(anthropicOrigin, server.url)]).pipe(
          Layer.provide(FetchHttpClient.layer)
        )
      )
    )
  )

describe('cross-check A: in-process Anthropic emulator', () => {
  it.effect('passes every Anthropic Messages conformance case', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(anthropicConformanceCases, {
        target: { kind: 'in-process' },
        now,
        layer: () => Layer.mergeAll(inProcessLayer(makeAnthropicEmulator()), configLayer)
      })

      expect(report.summary, formatConformanceReport(report)).toEqual({
        passed: caseCount,
        failed: 0,
        skipped: 0
      })
      expect(report.target).toEqual({ kind: 'in-process' })
    })
  )
})

describe('cross-check B: Anthropic emulator over a loopback socket', () => {
  it.effect(
    'passes every Anthropic Messages conformance case and records the claimed requests',
    () =>
      Effect.gen(function* () {
        const emulators = yield* Ref.make(new Map<string, AnthropicEmulator>())

        const report = yield* runConformance(anthropicConformanceCases, {
          target: { kind: 'emulated' },
          now,
          layer: testCase => {
            const emulator = makeAnthropicEmulator()

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

        for (const testCase of anthropicConformanceCases) {
          const entry = entryOf(testCase.id)

          expect(entry, testCase.id).toMatchObject({
            path: '/v1/messages',
            stream: true,
            credentialHeader: 'x-api-key',
            anthropicVersion: '2023-06-01',
            evidence: 'unverified'
          })
          expect(entry?.anthropicBeta, testCase.id).toBeUndefined()
        }

        expect(entryOf('anthropic.messages.stream.plain-text')).toMatchObject({
          maxTokens: settings.maxTokens,
          status: 200
        })
        expect(entryOf('anthropic.messages.stream.tool-use-input-deltas')).toMatchObject({
          maxTokens: settings.maxTokens,
          toolChoice: {
            type: 'tool',
            name: 'lookup_weather',
            disable_parallel_tool_use: true
          },
          toolNames: ['lookup_weather'],
          status: 200
        })
        expect(entryOf('anthropic.messages.stream.thinking-before-text')).toMatchObject({
          maxTokens: settings.maxTokens + settings.thinkingBudgetTokens,
          thinking: { type: 'enabled', budget_tokens: settings.thinkingBudgetTokens },
          status: 200
        })
        expect(entryOf('anthropic.messages.stream.error-envelope')?.status).toBe(404)
        expect(entryOf('anthropic.messages.stream.max-tokens')).toMatchObject({
          maxTokens: anthropicConformanceTruncatedMaxTokens,
          status: 200
        })

        // Streamed cases: several body chunks, one per pull (`node.test.ts` covers progressive
        // delivery over the socket).
        for (const id of [
          'anthropic.messages.stream.plain-text',
          'anthropic.messages.stream.tool-use-input-deltas',
          'anthropic.messages.stream.thinking-before-text'
        ]) {
          expect(entryOf(id)?.bodyChunks, id).toBeGreaterThan(1)
        }
      })
  )
})

const drill = (testCase: AnthropicConformanceCase, turn: AnthropicScriptedTurn) =>
  runConformance([testCase], {
    target: { kind: 'in-process' },
    now,
    layer: () => {
      const emulator = makeAnthropicEmulator()

      emulator.script.enqueue(turn)

      return Layer.mergeAll(inProcessLayer(emulator), configLayer)
    }
  }).pipe(Effect.map(report => report.results[0]))

describe('disagreement drill', () => {
  it.effect('fails the plain-text case when the usage is dropped', () =>
    Effect.gen(function* () {
      const result = yield* drill(anthropicMessagesPlainTextCase, {
        text: ['Hello', ' there.'],
        usage: null
      })

      expect(result?.status).toBe('failed')
      expect(result?.failure?.message).toContain('usage report')
    })
  )

  it.effect('fails the tool-use case when the input lacks the claimed key', () =>
    Effect.gen(function* () {
      const result = yield* drill(anthropicMessagesToolUseInputDeltasCase, {
        toolUses: [{ name: 'lookup_weather', inputFragments: ['{"to', 'wn":"Springfield"}'] }]
      })

      expect(result?.status).toBe('failed')
      expect(result?.failure?.message).toContain('non-empty string `city` argument')
    })
  )

  it.effect('fails the thinking case when the thinking block follows the text', () =>
    Effect.gen(function* () {
      const result = yield* drill(anthropicMessagesThinkingBeforeTextCase, {
        thinking: ['Plan.'],
        text: ['Hello.'],
        order: 'text-first'
      })

      expect(result?.status).toBe('failed')
      expect(result?.failure?.message).toBe('expected all reasoning before the answer text')
    })
  )

  it.effect('fails the max-tokens case when the turn ends normally', () =>
    Effect.gen(function* () {
      const result = yield* drill(anthropicMessagesMaxTokensCase, { text: ['1, 2, 3'] })

      expect(result?.status).toBe('failed')
      expect(result?.failure?.message).toBe('expected no Done for a truncated turn')
    })
  )

  it.effect('the same scripted shapes pass when they agree with the cases', () =>
    Effect.gen(function* () {
      const plain = yield* drill(anthropicMessagesPlainTextCase, { text: ['Hello', ' there.'] })

      const tool = yield* drill(anthropicMessagesToolUseInputDeltasCase, {
        toolUses: [{ name: 'lookup_weather', inputFragments: ['', '{"ci', 'ty":"Springfield"}'] }]
      })

      const thinking = yield* drill(anthropicMessagesThinkingBeforeTextCase, {
        thinking: ['Plan.'],
        text: ['Hello.']
      })

      const truncated = yield* drill(anthropicMessagesMaxTokensCase, {
        text: ['1, 2,'],
        stopReason: 'max_tokens'
      })

      expect([plain?.status, tool?.status, thinking?.status, truncated?.status]).toEqual([
        'passed',
        'passed',
        'passed',
        'passed'
      ])
    })
  )
})

const lookupWeatherTool = ToolDef.make({
  name: 'lookup_weather',
  description: 'Look up the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city']
  }
})

/** Native Messages through the public OpenCode Go provider pointed at the Anthropic origin. */
const nativeProvider = makeOpenCodeGoProviderLayer({
  apiKey: settings.apiKey,
  protocol: 'messages',
  maxOutputTokens: 64,
  baseUrl: `${anthropicOrigin}/v1`
})

/** The Claude subscription provider (OAuth bearer, default Messages URL). */
const claudeProvider = makeAnthropicClaudeProviderLayer({
  token: new OAuthAccessToken({
    provider: 'anthropic-claude',
    accessToken: 'synthetic-claude-oauth-token',
    expiresAt: 1_900_000_000_000
  }),
  maxTokens: 64
})

const streamThroughProvider = <E1, E2>(
  provider: Layer.Layer<LLMProvider, E1, HttpClient.HttpClient>,
  emulator: AnthropicEmulator,
  transport: (emulator: AnthropicEmulator) => Layer.Layer<HttpClient.HttpClient, E2>,
  tools: ReadonlyArray<ToolDef> = []
) =>
  Effect.gen(function* () {
    const llm = yield* LLMProvider

    return yield* llm
      .stream({
        model: anthropicConformanceDefaultModels.plainText,
        systemPrompt: 'Reply in one short sentence.',
        messages: [UserMessage.make({ content: 'Say hello.' })],
        tools
      })
      .pipe(Stream.runCollect)
  }).pipe(Effect.provide(provider.pipe(Layer.provide(transport(emulator)))))

const withFaults = (faults: ReadonlyArray<AnthropicFault>) => {
  const emulator = makeAnthropicEmulator()

  for (const fault of faults) emulator.faults.add(fault)

  return emulator
}

const expectLlmError = (error: unknown): LLMError =>
  error instanceof LLMError ? error : expect.fail(`expected an LLMError, got ${String(error)}`)

const rateLimit: AnthropicFault = { kind: 'status', status: 429, headers: { 'retry-after': '2' } }

const expectRateLimit = (error: LLMError, provider: string) => {
  expect(error.retryable).toBe(true)
  expect(error.cause).toBe('rate_limit')
  expect(error.provider).toMatchObject({
    provider,
    kind: 'rate_limit',
    status: 429,
    retryAfterMs: 2000
  })
}

describe('faults through the native Messages provider (x-api-key)', () => {
  it.effect('a 429 with retry-after becomes a retryable rate-limit LLMError (in-process)', () =>
    Effect.gen(function* () {
      const error = yield* streamThroughProvider(
        nativeProvider,
        withFaults([rateLimit]),
        inProcessLayer
      ).pipe(Effect.flip)

      expectRateLimit(expectLlmError(error), 'opencode_go')
    })
  )

  it.effect(
    'a 429 with retry-after becomes a retryable rate-limit LLMError (loopback socket)',
    () =>
      Effect.gen(function* () {
        const error = yield* streamThroughProvider(
          nativeProvider,
          withFaults([rateLimit]),
          emulatedLayer
        ).pipe(Effect.flip, Effect.scoped)

        expectRateLimit(expectLlmError(error), 'opencode_go')
      })
  )

  it.effect('a 529 overloaded_error becomes a retryable overloaded LLMError', () =>
    Effect.gen(function* () {
      const error = expectLlmError(
        yield* streamThroughProvider(
          nativeProvider,
          withFaults([{ kind: 'status', status: 529 }]),
          inProcessLayer
        ).pipe(Effect.flip)
      )

      expect(error.retryable).toBe(true)
      expect(error.cause).toBe('overloaded')
      expect(error.provider).toMatchObject({ kind: 'overloaded', status: 529 })
    })
  )

  it.effect('a mid-stream overloaded_error event becomes a retryable overloaded LLMError', () =>
    Effect.gen(function* () {
      const emulator = withFaults([{ kind: 'error-event-after-chunks', chunks: 4 }])

      const error = expectLlmError(
        yield* streamThroughProvider(nativeProvider, emulator, emulatedLayer).pipe(
          Effect.flip,
          Effect.scoped
        )
      )

      expect(error.retryable).toBe(true)
      expect(error.cause).toBe('overloaded')
      expect(error.provider).toMatchObject({
        kind: 'overloaded',
        providerCode: 'overloaded_error'
      })
      expect(emulator.ledger.entries()[0]).toMatchObject({
        fault: 'error-event-after-chunks',
        bodyChunks: 5
      })
    })
  )

  it.effect('a dropped connection mid-stream becomes a retryable LLMError (loopback socket)', () =>
    Effect.gen(function* () {
      const error = expectLlmError(
        yield* streamThroughProvider(
          nativeProvider,
          withFaults([{ kind: 'error-after-chunks', chunks: 2 }]),
          emulatedLayer
        ).pipe(Effect.flip, Effect.scoped)
      )

      expect(error.retryable).toBe(true)
    })
  )

  it.effect('a stream truncated before message_stop is a non-retryable invalid response', () =>
    Effect.gen(function* () {
      const error = expectLlmError(
        yield* streamThroughProvider(
          nativeProvider,
          withFaults([{ kind: 'truncate-after-chunks', chunks: 8 }]),
          inProcessLayer
        ).pipe(Effect.flip)
      )

      expect(error.retryable).toBe(false)
      expect(error.cause).toBe('invalid_response')
      expect(error.responseIssue).toBe('missing_done')
    })
  )
})

const doneReasons = (events: Iterable<LLMEvent>) =>
  Array.from(events).flatMap(event => (event instanceof LLMDone ? [event.stopReason] : []))

const textOf = (events: Iterable<LLMEvent>) =>
  Array.from(events)
    .flatMap(event => (event instanceof LLMTextDelta ? [event.text] : []))
    .join('')

/** Streams until the provider fails; returns the events it emitted first and the error. */
const failThroughProvider = <E1, E2>(
  provider: Layer.Layer<LLMProvider, E1, HttpClient.HttpClient>,
  emulator: AnthropicEmulator,
  transport: (emulator: AnthropicEmulator) => Layer.Layer<HttpClient.HttpClient, E2>
) =>
  Effect.gen(function* () {
    const llm = yield* LLMProvider
    const seen = yield* Ref.make<ReadonlyArray<LLMEvent>>([])

    const error = yield* llm
      .stream({
        model: anthropicConformanceDefaultModels.plainText,
        systemPrompt: 'Reply in one short sentence.',
        messages: [UserMessage.make({ content: 'Say hello.' })],
        tools: []
      })
      .pipe(
        Stream.runForEach(event => Ref.update(seen, events => [...events, event])),
        Effect.flip
      )

    return { events: yield* Ref.get(seen), error: expectLlmError(error) }
  }).pipe(Effect.provide(provider.pipe(Layer.provide(transport(emulator)))))

/** The loop's incomplete stream: no `Done`, so non-retryable `invalid_response` `missing_done`. */
const expectMissingDone = (error: LLMError) => {
  expect(error.cause).toBe('invalid_response')
  expect(error.retryable).toBe(false)
  expect(error.responseIssue).toBe('missing_done')
}

describe('the Claude subscription provider (bearer) against the emulator', () => {
  it.effect('completes a turn and sends the OAuth wire the emulator records', () =>
    Effect.gen(function* () {
      const emulator = makeAnthropicEmulator()

      const events = yield* streamThroughProvider(claudeProvider, emulator, emulatedLayer, [
        lookupWeatherTool
      ]).pipe(Effect.scoped)

      expect(doneReasons(events)).toEqual(['tool_use'])

      const [entry] = emulator.ledger.entries()

      expect(entry).toMatchObject({
        path: '/v1/messages',
        credentialHeader: 'authorization',
        anthropicVersion: '2023-06-01',
        stream: true,
        maxTokens: 64,
        // Claude subscription compatibility: tool names are rewritten on the wire.
        toolNames: ['mcp_Lookup_weather']
      })
      expect(entry?.anthropicBeta).toContain('oauth-2025-04-20')
      expect(JSON.stringify(entry)).not.toContain('synthetic-claude-oauth-token')
    })
  )

  it.effect('a 429 with retry-after becomes a retryable rate-limit LLMError', () =>
    Effect.gen(function* () {
      const error = yield* streamThroughProvider(
        claudeProvider,
        withFaults([rateLimit]),
        inProcessLayer
      ).pipe(Effect.flip)

      const llmError = expectLlmError(error)

      expectRateLimit(llmError, 'anthropic_claude')
      expect(llmError.provider?.providerCode).toBe('rate_limit_error')
    })
  )

  it.effect(
    'a 529 and a mid-stream overloaded_error event become retryable overloaded errors',
    () =>
      Effect.gen(function* () {
        for (const fault of [
          { kind: 'status', status: 529 },
          { kind: 'error-event-after-chunks', chunks: 4 }
        ] satisfies ReadonlyArray<AnthropicFault>) {
          const error = expectLlmError(
            yield* streamThroughProvider(claudeProvider, withFaults([fault]), inProcessLayer).pipe(
              Effect.flip
            )
          )

          expect(error.retryable, fault.kind).toBe(true)
          expect(error.cause, fault.kind).toBe('overloaded')
          expect(error.provider?.providerCode, fault.kind).toBe('overloaded_error')
        }
      })
  )

  it.effect(
    'a stream cut after message_delta, before message_stop, fails as missing_done without Done',
    () =>
      Effect.gen(function* () {
        // Eight chunks end with `message_delta` (`stop_reason: end_turn`): its stop reason is not
        // terminal, only `message_stop` is.
        const { events, error } = yield* failThroughProvider(
          claudeProvider,
          withFaults([{ kind: 'truncate-after-chunks', chunks: 8 }]),
          inProcessLayer
        )

        expectMissingDone(error)
        expect(textOf(events)).not.toBe('')
        expect(doneReasons(events)).toEqual([])
      })
  )

  it.effect('a stream cut mid-text fails as missing_done after the partial text', () =>
    Effect.gen(function* () {
      // message_start, content_block_start, ping, then one text_delta.
      const { events, error } = yield* failThroughProvider(
        claudeProvider,
        withFaults([{ kind: 'truncate-after-chunks', chunks: 4 }]),
        emulatedLayer
      ).pipe(Effect.scoped)

      expectMissingDone(error)
      expect(textOf(events)).not.toBe('')
      expect(doneReasons(events)).toEqual([])
    })
  )

  it.effect('a truncated stream fails the loop model turn as missing_done', () =>
    Effect.gen(function* () {
      const error = expectLlmError(
        yield* runModelTurn({
          model: anthropicConformanceDefaultModels.plainText,
          systemPrompt: 'Reply in one short sentence.',
          messages: [UserMessage.make({ content: 'Say hello.' })],
          tools: [],
          turn: 1
        }).pipe(
          Stream.runDrain,
          Effect.provide(
            makeAgentLoopLayer({
              provider: claudeProvider.pipe(
                Layer.provide(
                  inProcessLayer(withFaults([{ kind: 'truncate-after-chunks', chunks: 8 }]))
                )
              )
            })
          ),
          Effect.flip
        )
      )

      expectMissingDone(error)
    })
  )
})
