/**
 * Vercel AI Gateway conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * Each case builds the Gateway provider from `VercelAiGatewayConformanceConfig`, streams one
 * request through `LLMProvider`, and asserts one wire claim from the events it sees. Cases need
 * only `HttpClient.HttpClient` and the config service, so the same case runs against replayed
 * fixtures (`ReplayHttpClient`) or a host's live `HttpClient`. All four are `read` cases, observed
 * live by the owner-approved `pnpm conformance:gateway --live` probe that recorded the committed
 * fixtures.
 */
import { Context, Effect, Predicate, Result, Stream, type Redacted } from 'effect'
import type { HttpClient } from 'effect/unstable/http'
import {
  defineConformanceCase,
  expectConformance,
  expectEqual,
  type ConformanceCase,
  type ConformanceMismatch
} from '@yolk-sdk/conformance/case'
import {
  LLMDone,
  LLMError,
  LLMProvider,
  LLMReasoningDelta,
  LLMTextDelta,
  LLMToolCall,
  type LLMEvent,
  type LLMProviderError,
  type LLMRequest
} from '@yolk-sdk/agent/loop'
import { ToolDef, UserMessage, type AgentReasoningEffort } from '@yolk-sdk/agent/protocol'
import {
  makeVercelAiGatewayProviderLayer,
  type VercelAiGatewayProviderConfig
} from '../ai-gateway-provider.ts'
import { vercelAiGatewayDeepSeekReasoningFixture } from './deepseek-reasoning.ts'
import { vercelAiGatewayErrorEnvelopeFixture } from './error-envelope.ts'
import { vercelAiGatewayPlainTextFixture } from './plain-text.ts'
import { vercelAiGatewayToolCallDeltasFixture } from './tool-call-deltas.ts'

/** Model ids per case. `invalid` must NOT exist on the Gateway. */
export type VercelAiGatewayConformanceModels = {
  readonly plainText: string
  readonly reasoning: string
  readonly toolCall: string
  readonly invalid: string
}

/**
 * Live probe default model ids. They name the model of every committed fixture: the DeepSeek
 * fixture was recorded with `deepseek/deepseek-v4.1-flash`, the default reasoning model.
 */
export const vercelAiGatewayConformanceDefaultModels: VercelAiGatewayConformanceModels = {
  plainText: 'openai/gpt-4.1-nano',
  reasoning: 'deepseek/deepseek-v4.1-flash',
  toolCall: 'openai/gpt-4.1-nano',
  invalid: 'yolk-conformance/model-does-not-exist'
}

export type VercelAiGatewayConformanceSettings = {
  /** Gateway API key (or Vercel OIDC token). Any value works under replay. */
  readonly apiKey: Redacted.Redacted<string>
  readonly maxCompletionTokens: number
  /** Output limit for the reasoning case; reasoning spends tokens before the answer. */
  readonly reasoningMaxCompletionTokens: number
  readonly reasoningEffort: AgentReasoningEffort
  readonly models: VercelAiGatewayConformanceModels
}

/** Host-supplied settings for the Gateway conformance cases. */
export class VercelAiGatewayConformanceConfig extends Context.Service<
  VercelAiGatewayConformanceConfig,
  VercelAiGatewayConformanceSettings
>()('@yolk-sdk/agent/providers/vercel/conformance/VercelAiGatewayConformanceConfig') {}

/** What every Gateway conformance case requires from the host. */
export type VercelAiGatewayConformanceRequirements =
  | HttpClient.HttpClient
  | VercelAiGatewayConformanceConfig

export type VercelAiGatewayConformanceCase = ConformanceCase<
  LLMProviderError | ConformanceMismatch,
  VercelAiGatewayConformanceRequirements
>

const systemPrompt = 'Reply in one short sentence.'

// The owner-approved live probe (`pnpm conformance:gateway --live --account synthetic`) that
// recorded the committed verified fixtures observed every case pass on this date.
const liveObservation = { account: 'synthetic', date: '2026-09-30' } as const

const lookupWeatherTool = ToolDef.make({
  name: 'lookup_weather',
  description: 'Look up the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false
  }
})

const streamingConfig = (
  settings: VercelAiGatewayConformanceSettings,
  overrides: Partial<VercelAiGatewayProviderConfig> = {}
): VercelAiGatewayProviderConfig => ({
  apiKey: settings.apiKey,
  maxCompletionTokens: settings.maxCompletionTokens,
  streaming: true,
  ...overrides
})

const streamRequest = (
  config: VercelAiGatewayProviderConfig,
  request: LLMRequest
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMProviderError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const provider = yield* LLMProvider

    return Array.from(yield* provider.stream(request).pipe(Stream.runCollect))
  }).pipe(Effect.provide(makeVercelAiGatewayProviderLayer(config)))

const userRequest = (model: string, prompt: string): LLMRequest => ({
  model,
  systemPrompt,
  messages: [UserMessage.make({ content: prompt })],
  tools: []
})

const tagsOf = (events: ReadonlyArray<LLMEvent>): Array<string> => events.map(event => event._tag)

const textOf = (events: ReadonlyArray<LLMEvent>): string =>
  events.flatMap(event => (event instanceof LLMTextDelta ? [event.text] : [])).join('')

const doneReasons = (events: ReadonlyArray<LLMEvent>): Array<string> =>
  events.flatMap(event => (event instanceof LLMDone ? [event.stopReason] : []))

export const vercelAiGatewayPlainTextCase: VercelAiGatewayConformanceCase = defineConformanceCase({
  id: 'vercel-ai-gateway.stream.plain-text',
  title: 'Streamed plain text ends with one stop and a usage report',
  safety: 'read',
  docs: 'The Gateway Chat Completions endpoint is OpenAI-compatible: `stream: true` returns `chat.completion.chunk` server-sent events, and `stream_options.include_usage` adds a `usage` report.',
  wire: 'A streamed request succeeds with non-empty answer text, a `stop` finish, and a usage report (the live Gateway sends `usage` on the finish event itself): the provider stream completes without error, its TextDelta events join to non-empty text, and it emits exactly one Done(stop) plus Usage. How many content events carry the text is not part of the claim.',
  observed: liveObservation,
  fixtures: [vercelAiGatewayPlainTextFixture.id],
  run: Effect.gen(function* () {
    const settings = yield* VercelAiGatewayConformanceConfig

    const events = yield* streamRequest(
      streamingConfig(settings),
      userRequest(settings.models.plainText, 'Say hello.')
    )

    const tags = tagsOf(events)

    yield* expectEqual(doneReasons(events), ['stop'], 'expected exactly one Done(stop)')
    yield* expectConformance(textOf(events).trim().length > 0, 'expected non-empty answer text')
    yield* expectConformance(tags.includes('Usage'), 'expected a usage report', { actual: tags })
  })
})

export const vercelAiGatewayDeepSeekReasoningCase: VercelAiGatewayConformanceCase =
  defineConformanceCase({
    id: 'vercel-ai-gateway.stream.deepseek-reasoning',
    title: 'DeepSeek reasoning deltas stream before answer text',
    safety: 'read',
    docs: 'DeepSeek-style models accept `reasoning_effort` and a `thinking` toggle through the OpenAI-compatible endpoint and stream their reasoning as `delta.reasoning_content` (or the Gateway-normalized `delta.reasoning`).',
    wire: 'With reasoning content, the `reasoning_effort` format, and thinking enabled, every reasoning delta arrives before the first answer text delta: the provider emits ReasoningDelta events (from either reasoning field) strictly before TextDelta events, then Done(stop).',
    observed: liveObservation,
    fixtures: [vercelAiGatewayDeepSeekReasoningFixture.id],
    run: Effect.gen(function* () {
      const settings = yield* VercelAiGatewayConformanceConfig

      const events = yield* streamRequest(
        streamingConfig(settings, {
          maxCompletionTokens: settings.reasoningMaxCompletionTokens,
          reasoningContent: true,
          reasoningEffortFormat: 'reasoning-effort',
          thinking: { type: 'enabled' }
        }),
        {
          ...userRequest(settings.models.reasoning, 'Say hello.'),
          reasoningEffort: settings.reasoningEffort
        }
      )

      const tags = tagsOf(events)
      const lastReasoning = tags.lastIndexOf('ReasoningDelta')
      const firstText = tags.indexOf('TextDelta')

      const reasoning = events
        .flatMap(event => (event instanceof LLMReasoningDelta ? [event.text] : []))
        .join('')

      yield* expectConformance(reasoning.trim().length > 0, 'expected reasoning deltas', {
        actual: tags
      })
      yield* expectConformance(firstText !== -1, 'expected answer text deltas', { actual: tags })
      yield* expectConformance(
        lastReasoning < firstText,
        'expected every reasoning delta before the first text delta',
        { expected: 'ReasoningDelta* then TextDelta*', actual: tags }
      )
      yield* expectEqual(doneReasons(events), ['stop'], 'expected exactly one Done(stop)')
    })
  })

export const vercelAiGatewayToolCallDeltasCase: VercelAiGatewayConformanceCase =
  defineConformanceCase({
    id: 'vercel-ai-gateway.stream.tool-call-deltas',
    title: 'Streamed tool-call argument fragments assemble into one call',
    safety: 'read',
    docs: 'Streamed tool calls arrive as `delta.tool_calls` entries whose `function.arguments` JSON string is streamed in fragments.',
    wire: 'For a single offered tool, the streamed argument fragments assemble into exactly one ToolCall named after the tool whose params are a JSON object with a string `city`, followed by Done(tool_use). Where the fragments split is not asserted (a provider/replay concern).',
    observed: liveObservation,
    fixtures: [vercelAiGatewayToolCallDeltasFixture.id],
    run: Effect.gen(function* () {
      const settings = yield* VercelAiGatewayConformanceConfig

      const events = yield* streamRequest(streamingConfig(settings), {
        ...userRequest(
          settings.models.toolCall,
          'What is the weather in Springfield? Use the tool.'
        ),
        tools: [lookupWeatherTool]
      })

      const calls = events.flatMap(event => (event instanceof LLMToolCall ? [event.call] : []))

      yield* expectEqual(calls.length, 1, 'expected exactly one assembled tool call')

      const [call] = calls
      const params: unknown = call?.params
      const city = Predicate.hasProperty(params, 'city') ? params.city : undefined

      yield* expectEqual(call?.name ?? null, lookupWeatherTool.name, 'expected the offered tool')
      yield* expectConformance(
        Predicate.isObject(params) && !Array.isArray(params),
        'expected tool arguments to assemble into a JSON object'
      )
      yield* expectConformance(
        Predicate.isString(city) && city.length > 0,
        'expected a non-empty string `city` argument'
      )
      yield* expectEqual(doneReasons(events), ['tool_use'], 'expected exactly one Done(tool_use)')
    })
  })

const sanitizedStatusMessage = /^Vercel AI Gateway returned \d{3}$/

// Statuses a Gateway may use to reject an unknown model. 401/403 (authentication/permission) and
// every other 4xx are not a model rejection.
const modelRejectionStatuses: ReadonlyArray<number> = [400, 404, 422]

export const vercelAiGatewayErrorEnvelopeCase: VercelAiGatewayConformanceCase =
  defineConformanceCase({
    id: 'vercel-ai-gateway.stream.error-envelope',
    title: 'Unknown model ids fail with a sanitized non-retryable error',
    safety: 'read',
    docs: 'Errors use the OpenAI-compatible envelope `{ error: { message, type, code } }` with a non-2xx status.',
    wire: 'An unknown model id is rejected as a model error (400, 404, or 422; never a 401/403 authentication or permission failure) with a JSON envelope before any stream starts: the provider fails with a non-retryable LLMError that is not classified as `auth`, keeps the status and provider code (`error.code`, else `error.type`), and whose message is status-only (no upstream body text).',
    observed: liveObservation,
    fixtures: [vercelAiGatewayErrorEnvelopeFixture.id],
    run: Effect.gen(function* () {
      const settings = yield* VercelAiGatewayConformanceConfig

      const outcome = yield* streamRequest(
        streamingConfig(settings),
        userRequest(settings.models.invalid, 'Say hello.')
      ).pipe(Effect.result)

      if (Result.isSuccess(outcome)) {
        return yield* expectConformance(
          false,
          'expected an error envelope, the request succeeded',
          {
            actual: tagsOf(outcome.success)
          }
        )
      }

      const error = outcome.failure

      if (!(error instanceof LLMError)) {
        return yield* expectConformance(false, 'expected an LLMError', { actual: error._tag })
      }

      const status = error.provider?.status
      const providerCode = error.provider?.providerCode

      yield* expectEqual(error.retryable, false, 'expected a non-retryable error')
      yield* expectConformance(
        status !== 401 && status !== 403 && error.provider?.kind !== 'auth',
        'expected a model rejection, not an authentication or permission failure',
        { actual: status ?? null }
      )
      yield* expectConformance(
        status !== undefined && modelRejectionStatuses.includes(status),
        'expected a 400, 404, or 422 model-rejection status',
        { expected: [...modelRejectionStatuses], actual: status ?? null }
      )
      yield* expectConformance(
        providerCode !== undefined && providerCode.length > 0,
        'expected the provider error code to be preserved'
      )
      yield* expectConformance(
        sanitizedStatusMessage.test(error.message),
        'expected a status-only message without upstream body text'
      )
    })
  })

/** Every Vercel AI Gateway conformance case, in fixture order. */
export const vercelAiGatewayConformanceCases: ReadonlyArray<VercelAiGatewayConformanceCase> = [
  vercelAiGatewayPlainTextCase,
  vercelAiGatewayDeepSeekReasoningCase,
  vercelAiGatewayToolCallDeltasCase,
  vercelAiGatewayErrorEnvelopeCase
]
