/**
 * Anthropic Messages conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * Each case builds the native Messages provider (the same internal Messages layer OpenCode Go
 * uses for `protocol: 'messages'`: `x-api-key` and `anthropic-version` headers, native `system`
 * and tool names, and `message_stop` required) against the Anthropic Messages endpoint from
 * `AnthropicConformanceConfig`, sends one request through `LLMProvider`, and asserts one wire
 * claim from the events it sees. The Claude subscription provider is not used: it only takes a
 * Claude OAuth token and adds the subscription compatibility layer (billing system block,
 * relocated system prompt, `mcp_` tool names), and neither public provider can send `tool_choice`
 * or `thinking`, which these cases set through the internal layer's extra request fields.
 *
 * Cases need only `HttpClient.HttpClient` and the config service, so the same case runs against
 * replayed fixtures (`ReplayHttpClient`), an emulator, or a host's live `HttpClient`. All five are
 * `read` cases; none is observed live yet (`observed` absent = unverified).
 */
import { Context, Effect, Option, Predicate, Redacted, Ref, Result, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
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
import { ToolDef, UserMessage } from '@yolk-sdk/agent/protocol'
import { makeAnthropicMessagesProviderLayer } from '../../anthropic-messages-provider-internal.ts'
import { anthropicMessagesErrorEnvelopeFixture } from './error-envelope.ts'
import { anthropicMessagesMaxTokensFixture } from './max-tokens.ts'
import { anthropicMessagesPlainTextFixture } from './plain-text.ts'
import { anthropicMessagesThinkingBeforeTextFixture } from './thinking-before-text.ts'
import { anthropicMessagesToolUseInputDeltasFixture } from './tool-use-input-deltas.ts'

/** The Anthropic Messages endpoint the cases call. */
export const anthropicConformanceMessagesUrl = 'https://api.anthropic.com/v1/messages'

/** The `anthropic-version` header every case sends. */
export const anthropicConformanceVersion = '2023-06-01'

/**
 * `max_tokens` of the max-tokens case: small enough that the counting prompt cannot finish, so
 * the real API stops with `stop_reason: max_tokens`.
 */
export const anthropicConformanceTruncatedMaxTokens = 8

/** Model ids per case. `invalid` must NOT exist on the Anthropic API. */
export type AnthropicConformanceModels = {
  readonly plainText: string
  readonly toolUse: string
  /** Must support extended thinking (`thinking: { type: 'enabled', budget_tokens }`). */
  readonly thinking: string
  readonly invalid: string
}

/** Model ids used by the committed fixtures and the live probe defaults. */
export const anthropicConformanceDefaultModels: AnthropicConformanceModels = {
  plainText: 'claude-haiku-4-5',
  toolUse: 'claude-haiku-4-5',
  thinking: 'claude-haiku-4-5',
  invalid: 'yolk-conformance-model-does-not-exist'
}

export type AnthropicConformanceSettings = {
  /** Anthropic API key, sent as `x-api-key`. Any value works under replay or an emulator. */
  readonly apiKey: Redacted.Redacted<string>
  /** `max_tokens` of the plain-text, tool-use, and error cases. */
  readonly maxTokens: number
  /**
   * `thinking.budget_tokens` of the thinking case (the API minimum is 1024). That case sends
   * `max_tokens` = `maxTokens + thinkingBudgetTokens`, so the answer keeps its own budget.
   */
  readonly thinkingBudgetTokens: number
  readonly models: AnthropicConformanceModels
}

/** Host-supplied settings for the Anthropic Messages conformance cases. */
export class AnthropicConformanceConfig extends Context.Service<
  AnthropicConformanceConfig,
  AnthropicConformanceSettings
>()('@yolk-sdk/agent/providers/anthropic/conformance/AnthropicConformanceConfig') {}

/** What every Anthropic Messages conformance case requires from the host. */
export type AnthropicConformanceRequirements = HttpClient.HttpClient | AnthropicConformanceConfig

export type AnthropicConformanceCase = ConformanceCase<
  LLMProviderError | ConformanceMismatch,
  AnthropicConformanceRequirements
>

const systemPrompt = 'Reply in one short sentence.'

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

type ProviderOptions = {
  readonly maxTokens: number
  readonly extraBody?: Readonly<Record<string, Schema.Json>> | undefined
}

const providerLayer = (settings: AnthropicConformanceSettings, options: ProviderOptions) =>
  makeAnthropicMessagesProviderLayer({
    providerId: 'anthropic_messages',
    providerName: 'Anthropic Messages',
    messagesUrl: anthropicConformanceMessagesUrl,
    maxTokens: options.maxTokens,
    headers: {
      'x-api-key': Redacted.value(settings.apiKey),
      'anthropic-version': anthropicConformanceVersion,
      accept: 'text/event-stream',
      'content-type': 'application/json'
    },
    extraBody: options.extraBody
  })

/**
 * Run one request and keep every event seen, including those before a failure: the terminal
 * `max_tokens` claim needs to see that no Done was emitted before the stream failed.
 */
const collectOutcome = (
  settings: AnthropicConformanceSettings,
  options: ProviderOptions,
  request: LLMRequest
): Effect.Effect<
  {
    readonly events: ReadonlyArray<LLMEvent>
    readonly result: Result.Result<void, LLMProviderError>
  },
  never,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const provider = yield* LLMProvider
    const seen = yield* Ref.make<ReadonlyArray<LLMEvent>>([])

    const result = yield* provider.stream(request).pipe(
      Stream.runForEach(event => Ref.update(seen, events => [...events, event])),
      Effect.result
    )

    return { events: yield* Ref.get(seen), result }
  }).pipe(Effect.provide(providerLayer(settings, options)))

const collectEvents = (
  settings: AnthropicConformanceSettings,
  options: ProviderOptions,
  request: LLMRequest
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMProviderError, HttpClient.HttpClient> =>
  collectOutcome(settings, options, request).pipe(
    Effect.flatMap(({ events, result }) =>
      Result.isFailure(result) ? Effect.fail(result.failure) : Effect.succeed(events)
    )
  )

const userRequest = (model: string, prompt: string): LLMRequest => ({
  model,
  systemPrompt,
  messages: [UserMessage.make({ content: prompt })],
  tools: []
})

const tagsOf = (events: ReadonlyArray<LLMEvent>): Array<string> => events.map(event => event._tag)

const textOf = (events: ReadonlyArray<LLMEvent>): string =>
  events.flatMap(event => (event instanceof LLMTextDelta ? [event.text] : [])).join('')

const reasoningOf = (events: ReadonlyArray<LLMEvent>): string =>
  events.flatMap(event => (event instanceof LLMReasoningDelta ? [event.text] : [])).join('')

const doneReasons = (events: ReadonlyArray<LLMEvent>): Array<string> =>
  events.flatMap(event => (event instanceof LLMDone ? [event.stopReason] : []))

export const anthropicMessagesPlainTextCase: AnthropicConformanceCase = defineConformanceCase({
  id: 'anthropic.messages.stream.plain-text',
  title: 'Streamed plain text ends with one stop, usage, and no thinking',
  safety: 'read',
  docs: 'Anthropic Messages with `stream: true` sends `message_start` (with input usage), content blocks as `content_block_start` / `content_block_delta` (`text_delta`) / `content_block_stop`, `ping` events, `message_delta` with the `stop_reason` and output usage, and `message_stop`. Without a `thinking` request field the response has no thinking blocks.',
  wire: 'A streamed request without `thinking` succeeds with non-empty answer text and ends normally: the provider stream completes without error, its TextDelta events join to non-empty text, it emits no ReasoningDelta, exactly one Done(stop), and at least one Usage. How many text deltas carry the text is not part of the claim.',
  fixtures: [anthropicMessagesPlainTextFixture.id],
  run: Effect.gen(function* () {
    const settings = yield* AnthropicConformanceConfig

    const events = yield* collectEvents(
      settings,
      { maxTokens: settings.maxTokens },
      userRequest(settings.models.plainText, 'Say hello.')
    )

    const tags = tagsOf(events)

    yield* expectEqual(doneReasons(events), ['stop'], 'expected exactly one Done(stop)')
    yield* expectConformance(textOf(events).trim().length > 0, 'expected non-empty answer text')
    yield* expectConformance(
      !tags.includes('ReasoningDelta'),
      'expected no reasoning without a thinking request',
      { actual: tags }
    )
    yield* expectConformance(tags.includes('Usage'), 'expected a usage report', { actual: tags })
  })
})

/**
 * Forces the offered tool and disables parallel tool use, so the exactly-one-call claim rests on
 * the request (`tool_choice: { type: 'tool', name }` alone still allows several calls of that
 * tool), not on the model choosing to call it once.
 */
const forcedToolChoice = {
  type: 'tool',
  name: lookupWeatherTool.name,
  disable_parallel_tool_use: true
} as const

export const anthropicMessagesToolUseInputDeltasCase: AnthropicConformanceCase =
  defineConformanceCase({
    id: 'anthropic.messages.stream.tool-use-input-deltas',
    title: 'Streamed tool_use input fragments assemble into one call',
    safety: 'read',
    docs: 'A streamed Anthropic `tool_use` block starts with `content_block_start` carrying the block `id`, `name`, and an empty `input`; the input JSON arrives as `input_json_delta` `partial_json` fragments and is complete at `content_block_stop`; `message_delta` then carries `stop_reason: tool_use`. `tool_choice: { type: "tool", name }` forces that tool, and `disable_parallel_tool_use: true` limits the answer to at most one tool use.',
    wire: 'For a single offered tool forced with `tool_choice: { type: "tool", name, disable_parallel_tool_use: true }`, the streamed input fragments assemble into exactly one ToolCall named after the tool (native name, no rewriting) whose params are a JSON object with a non-empty string `city`, followed by Done(tool_use). Where the fragments split is not asserted.',
    fixtures: [anthropicMessagesToolUseInputDeltasFixture.id],
    run: Effect.gen(function* () {
      const settings = yield* AnthropicConformanceConfig

      const events = yield* collectEvents(
        settings,
        { maxTokens: settings.maxTokens, extraBody: { tool_choice: forcedToolChoice } },
        {
          ...userRequest(
            settings.models.toolUse,
            'What is the weather in Springfield? Use the tool.'
          ),
          tools: [lookupWeatherTool]
        }
      )

      const calls = events.flatMap(event => (event instanceof LLMToolCall ? [event.call] : []))

      yield* expectEqual(calls.length, 1, 'expected exactly one assembled tool call')

      const [call] = calls
      const params: unknown = call?.params
      const city = Predicate.hasProperty(params, 'city') ? params.city : undefined

      yield* expectEqual(call?.name ?? null, lookupWeatherTool.name, 'expected the offered tool')
      yield* expectConformance(
        Predicate.isObject(params) && !Array.isArray(params),
        'expected tool input to assemble into a JSON object'
      )
      yield* expectConformance(
        Predicate.isString(city) && city.length > 0,
        'expected a non-empty string `city` argument'
      )
      yield* expectEqual(doneReasons(events), ['tool_use'], 'expected exactly one Done(tool_use)')
    })
  })

export const anthropicMessagesThinkingBeforeTextCase: AnthropicConformanceCase =
  defineConformanceCase({
    id: 'anthropic.messages.stream.thinking-before-text',
    title: 'With thinking enabled, the thinking block streams before the answer text',
    safety: 'read',
    docs: 'With `thinking: { type: "enabled", budget_tokens }` (and `max_tokens` above the budget), Anthropic Messages streams a `thinking` content block (`thinking_delta` events, then a `signature_delta`) before the `text` block that holds the answer.',
    wire: 'A streamed request with thinking enabled succeeds with non-empty reasoning and non-empty answer text, and every ReasoningDelta arrives before the first TextDelta, followed by exactly one Done(stop). How many deltas carry either is not asserted, and the signature is not surfaced.',
    fixtures: [anthropicMessagesThinkingBeforeTextFixture.id],
    run: Effect.gen(function* () {
      const settings = yield* AnthropicConformanceConfig

      const events = yield* collectEvents(
        settings,
        {
          maxTokens: settings.maxTokens + settings.thinkingBudgetTokens,
          extraBody: {
            thinking: { type: 'enabled', budget_tokens: settings.thinkingBudgetTokens }
          }
        },
        userRequest(settings.models.thinking, 'Say hello.')
      )

      const tags = tagsOf(events)
      const firstText = tags.indexOf('TextDelta')
      const lastReasoning = tags.lastIndexOf('ReasoningDelta')

      yield* expectConformance(
        reasoningOf(events).trim().length > 0,
        'expected non-empty reasoning',
        { actual: tags }
      )
      yield* expectConformance(textOf(events).trim().length > 0, 'expected non-empty answer text')
      yield* expectConformance(
        lastReasoning < firstText,
        'expected all reasoning before the answer text',
        { actual: tags }
      )
      yield* expectEqual(doneReasons(events), ['stop'], 'expected exactly one Done(stop)')
    })
  })

/** The Anthropic error envelope the error case requires in the 404 body (extra keys allowed). */
const NotFoundErrorEnvelope = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal('error'),
    error: Schema.Struct({
      type: Schema.Literal('not_found_error'),
      message: Schema.String
    })
  })
)

const isNotFoundErrorEnvelope = (body: string): boolean =>
  Option.isSome(Schema.decodeUnknownOption(NotFoundErrorEnvelope)(body))

/**
 * The error case's own HttpClient boundary: wraps the host client so the body of every error
 * response (status 400 or above) is read, kept in `bodies`, and handed on to the provider as the
 * same status, headers, and bytes. Success responses pass through untouched, and the provider's
 * behaviour does not change; the case only gains the envelope the provider does not surface.
 */
const capturingErrorBodies = (
  client: HttpClient.HttpClient,
  bodies: Ref.Ref<ReadonlyArray<string>>
): HttpClient.HttpClient =>
  HttpClient.transform(client, (effect, request) =>
    Effect.flatMap(effect, response =>
      response.status < 400
        ? Effect.succeed(response)
        : response.arrayBuffer.pipe(
            Effect.tap(bytes =>
              Ref.update(bodies, current => [...current, new TextDecoder().decode(bytes)])
            ),
            Effect.map(bytes =>
              HttpClientResponse.fromWeb(
                request,
                new Response(bytes, { status: response.status, headers: response.headers })
              )
            )
          )
    )
  )

export const anthropicMessagesErrorEnvelopeCase: AnthropicConformanceCase = defineConformanceCase({
  id: 'anthropic.messages.stream.error-envelope',
  title: 'Unknown model ids fail with a sanitized non-retryable 404',
  safety: 'read',
  docs: 'Anthropic errors use the envelope `{ type: "error", error: { type, message } }` with a non-2xx status; an unknown model id is rejected with status 404 and error type `not_found_error`, while a missing or invalid credential is a 401 `authentication_error`.',
  wire: 'An unknown model id is rejected with a JSON envelope before any stream starts, as a 404 and never a 401/403 authentication or permission failure: the provider fails with a non-retryable LLMError that is not classified as `auth`, keeps the 404 status, and whose message is sanitized to the provider name and error cause (no upstream body text). The native Messages layer does not surface the envelope, so the case also reads the 404 body at its own HttpClient boundary (handing the same bytes on to the provider) and requires `{ type: "error", error: { type: "not_found_error", message } }`; an empty, non-JSON, or differently shaped body fails the case.',
  fixtures: [anthropicMessagesErrorEnvelopeFixture.id],
  run: Effect.gen(function* () {
    const settings = yield* AnthropicConformanceConfig
    const client = yield* HttpClient.HttpClient
    const errorBodies = yield* Ref.make<ReadonlyArray<string>>([])

    const outcome = yield* collectEvents(
      settings,
      { maxTokens: settings.maxTokens },
      userRequest(settings.models.invalid, 'Say hello.')
    ).pipe(
      Effect.provideService(HttpClient.HttpClient, capturingErrorBodies(client, errorBodies)),
      Effect.result
    )

    if (Result.isSuccess(outcome)) {
      return yield* expectConformance(false, 'expected an error envelope, the request succeeded', {
        actual: tagsOf(outcome.success)
      })
    }

    const error = outcome.failure

    if (!(error instanceof LLMError)) {
      return yield* expectConformance(false, 'expected an LLMError', { actual: error._tag })
    }

    const status = error.provider?.status

    yield* expectEqual(error.retryable, false, 'expected a non-retryable error')
    yield* expectConformance(
      status !== 401 && status !== 403 && error.provider?.kind !== 'auth',
      'expected a model rejection, not an authentication or permission failure',
      { actual: status ?? null }
    )
    yield* expectEqual(status ?? null, 404, 'expected a 404 model-rejection status')
    // The Messages layer keeps only classified metadata: the message names the cause, never
    // upstream body text.
    yield* expectEqual(
      error.message,
      `Anthropic Messages ${error.cause}`,
      'expected a sanitized message without upstream body text'
    )

    const bodies = yield* Ref.get(errorBodies)

    // Only the shape is reported, never the upstream body text.
    yield* expectConformance(
      bodies.length === 1 && bodies.every(isNotFoundErrorEnvelope),
      'expected the 404 body to be a `not_found_error` Anthropic error envelope',
      { actual: bodies.map(isNotFoundErrorEnvelope) }
    )
  })
})

export const anthropicMessagesMaxTokensCase: AnthropicConformanceCase = defineConformanceCase({
  id: 'anthropic.messages.stream.max-tokens',
  title: 'A stream stopped by max_tokens fails as a non-retryable invalid response',
  safety: 'read',
  docs: 'When the output reaches `max_tokens`, Anthropic Messages ends the stream normally (`message_delta` with `stop_reason: max_tokens`, then `message_stop`) after the partial content.',
  wire: `A streamed request whose answer cannot fit \`max_tokens: ${anthropicConformanceTruncatedMaxTokens}\` is never reported as a normal completion: the provider emits no Done and fails with a non-retryable \`invalid_response\` LLMError that names \`max_tokens\`.`,
  fixtures: [anthropicMessagesMaxTokensFixture.id],
  run: Effect.gen(function* () {
    const settings = yield* AnthropicConformanceConfig

    const { events, result } = yield* collectOutcome(
      settings,
      { maxTokens: anthropicConformanceTruncatedMaxTokens },
      userRequest(settings.models.plainText, 'Count from 1 to 100, separated by commas.')
    )

    yield* expectEqual(doneReasons(events), [], 'expected no Done for a truncated turn')

    if (Result.isSuccess(result)) {
      return yield* expectConformance(false, 'expected a max_tokens failure, the turn completed', {
        actual: tagsOf(events)
      })
    }

    const error = result.failure

    if (!(error instanceof LLMError)) {
      return yield* expectConformance(false, 'expected an LLMError', { actual: error._tag })
    }

    yield* expectEqual(error.cause, 'invalid_response', 'expected an invalid_response failure')
    yield* expectEqual(error.retryable, false, 'expected a non-retryable error')
    yield* expectConformance(
      error.message.includes('max_tokens'),
      'expected the failure to name max_tokens',
      { actual: error.message }
    )
  })
})

/** Every Anthropic Messages conformance case, in fixture order. */
export const anthropicConformanceCases: ReadonlyArray<AnthropicConformanceCase> = [
  anthropicMessagesPlainTextCase,
  anthropicMessagesToolUseInputDeltasCase,
  anthropicMessagesThinkingBeforeTextCase,
  anthropicMessagesErrorEnvelopeCase,
  anthropicMessagesMaxTokensCase
]
