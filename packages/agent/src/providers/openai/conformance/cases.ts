/**
 * OpenAI Chat Completions conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * Each case builds the generic OpenAI-compatible chat provider (`makeOpenAiProviderLayer`, default
 * endpoint and `max_completion_tokens`) from `OpenAiConformanceConfig`, sends one request through
 * `LLMProvider`, and asserts one wire claim from the events it sees. Cases need only
 * `HttpClient.HttpClient` and the config service, so the same case runs against replayed fixtures
 * (`ReplayHttpClient`), an emulator, or a host's live `HttpClient`. All four are `read` cases;
 * none is observed live yet (`observed` absent = unverified).
 */
import { Context, Effect, Predicate, Result, Stream, type Redacted } from 'effect'
import type { HttpClient } from 'effect/http'
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
  LLMTextDelta,
  LLMToolCall,
  type LLMEvent,
  type LLMProviderError,
  type LLMRequest
} from '@yolk-sdk/agent/loop'
import { ToolDef, UserMessage } from '@yolk-sdk/agent/protocol'
import { makeOpenAiProviderLayer, type OpenAiProviderConfig } from '../provider.ts'
import { openAiChatErrorEnvelopeFixture } from './error-envelope.ts'
import { openAiChatJsonPlainTextFixture } from './json-plain-text.ts'
import { openAiChatPlainTextFixture } from './plain-text.ts'
import { openAiChatToolCallDeltasFixture } from './tool-call-deltas.ts'

/** The OpenAI Chat Completions endpoint the cases (and the provider's default) call. */
export const openAiConformanceChatCompletionsUrl = 'https://api.openai.com/v1/chat/completions'

/** Model ids per case. `invalid` must NOT exist on the OpenAI API. */
export type OpenAiConformanceModels = {
  readonly plainText: string
  readonly toolCall: string
  readonly invalid: string
}

/** Model ids used by the committed fixtures and the live probe defaults. */
export const openAiConformanceDefaultModels: OpenAiConformanceModels = {
  plainText: 'gpt-4.1-nano',
  toolCall: 'gpt-4.1-nano',
  invalid: 'yolk-conformance-model-does-not-exist'
}

export type OpenAiConformanceSettings = {
  /** OpenAI API key. Any value works under replay or against an emulator. */
  readonly apiKey: Redacted.Redacted<string>
  /** Sent as `max_completion_tokens`. */
  readonly maxCompletionTokens: number
  readonly models: OpenAiConformanceModels
}

/** Host-supplied settings for the OpenAI chat conformance cases. */
export class OpenAiConformanceConfig extends Context.Service<
  OpenAiConformanceConfig,
  OpenAiConformanceSettings
>()('@yolk-sdk/agent/providers/openai/conformance/OpenAiConformanceConfig') {}

/** What every OpenAI chat conformance case requires from the host. */
export type OpenAiConformanceRequirements = HttpClient.HttpClient | OpenAiConformanceConfig

export type OpenAiConformanceCase = ConformanceCase<
  LLMProviderError | ConformanceMismatch,
  OpenAiConformanceRequirements
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

const providerConfig = (
  settings: OpenAiConformanceSettings,
  streaming: boolean
): OpenAiProviderConfig => ({
  apiKey: settings.apiKey,
  maxCompletionTokens: settings.maxCompletionTokens,
  streaming
})

/**
 * Forces the offered tool so the one-call claim rests on the request, not on the model choosing
 * to call it. Sent through the provider's `extraBody`; `parallel_tool_calls` stays as the provider
 * sends it.
 */
const forcedToolChoice = {
  type: 'function',
  function: { name: lookupWeatherTool.name }
} as const

const collectEvents = (
  config: OpenAiProviderConfig,
  request: LLMRequest
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMProviderError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const provider = yield* LLMProvider

    return Array.from(yield* provider.stream(request).pipe(Stream.runCollect))
  }).pipe(Effect.provide(makeOpenAiProviderLayer(config)))

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

/** Shared claim of both plain-text cases: non-empty text, one Done(stop), and a usage report. */
const expectPlainAnswer = (events: ReadonlyArray<LLMEvent>) =>
  Effect.gen(function* () {
    const tags = tagsOf(events)

    yield* expectEqual(doneReasons(events), ['stop'], 'expected exactly one Done(stop)')
    yield* expectConformance(textOf(events).trim().length > 0, 'expected non-empty answer text')
    yield* expectConformance(tags.includes('Usage'), 'expected a usage report', { actual: tags })
  })

export const openAiChatPlainTextCase: OpenAiConformanceCase = defineConformanceCase({
  id: 'openai.chat.stream.plain-text',
  title: 'Streamed plain text ends with one stop and a usage report',
  safety: 'read',
  docs: 'OpenAI Chat Completions with `stream: true` returns `chat.completion.chunk` server-sent events ending in `data: [DONE]`; `stream_options.include_usage` adds a final chunk with empty `choices` and the `usage` object.',
  wire: 'A streamed request succeeds with non-empty answer text, a `stop` finish, and a usage chunk: the provider stream completes without error, its TextDelta events join to non-empty text, and it emits exactly one Done(stop) plus Usage. How many content events carry the text is not part of the claim.',
  fixtures: [openAiChatPlainTextFixture.id],
  run: Effect.gen(function* () {
    const settings = yield* OpenAiConformanceConfig

    const events = yield* collectEvents(
      providerConfig(settings, true),
      userRequest(settings.models.plainText, 'Say hello.')
    )

    yield* expectPlainAnswer(events)
  })
})

export const openAiChatToolCallDeltasCase: OpenAiConformanceCase = defineConformanceCase({
  id: 'openai.chat.stream.tool-call-deltas',
  title: 'Streamed tool-call argument fragments assemble into one call',
  safety: 'read',
  docs: 'Streamed OpenAI tool calls arrive as `delta.tool_calls` entries keyed by `index`; the first carries the call `id` and `function.name`, and the `function.arguments` JSON string is streamed in fragments, finishing with `tool_calls`. A `tool_choice` naming a function forces the model to call it.',
  wire: 'For a single offered tool forced with `tool_choice: { type: "function", function: { name } }`, the streamed argument fragments assemble into exactly one ToolCall named after the tool whose params are a JSON object with a non-empty string `city`, followed by Done(tool_use). Where the fragments split is not asserted.',
  fixtures: [openAiChatToolCallDeltasFixture.id],
  run: Effect.gen(function* () {
    const settings = yield* OpenAiConformanceConfig

    const events = yield* collectEvents(
      { ...providerConfig(settings, true), extraBody: { tool_choice: forcedToolChoice } },
      {
        ...userRequest(
          settings.models.toolCall,
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
      'expected tool arguments to assemble into a JSON object'
    )
    yield* expectConformance(
      Predicate.isString(city) && city.length > 0,
      'expected a non-empty string `city` argument'
    )
    yield* expectEqual(doneReasons(events), ['tool_use'], 'expected exactly one Done(tool_use)')
  })
})

const sanitizedStatusMessage = /^OpenAI returned \d{3}$/

// OpenAI rejects an unknown model with 404 today but has also answered 400 for it, so both count.
// 401/403 (authentication/permission) and every other status are not a model rejection.
const modelRejectionStatuses: ReadonlyArray<number> = [404, 400]

const modelRejectionCode = 'model_not_found'

export const openAiChatErrorEnvelopeCase: OpenAiConformanceCase = defineConformanceCase({
  id: 'openai.chat.stream.error-envelope',
  title: 'Unknown model ids fail with a sanitized non-retryable model_not_found error',
  safety: 'read',
  docs: 'OpenAI errors use the envelope `{ error: { message, type, param, code } }` with a non-2xx status; an unknown model id is rejected with status 404 (400 has also been used) and code `model_not_found`.',
  wire: 'An unknown model id is rejected with a JSON envelope before any stream starts, as a 404 (or 400) with provider code `model_not_found` and never a 401/403 authentication or permission failure: the provider fails with a non-retryable LLMError that is not classified as `auth`, keeps the status and the `model_not_found` provider code, and whose message is status-only (no upstream body text). Any other code, such as an unsupported-parameter rejection, fails the case.',
  fixtures: [openAiChatErrorEnvelopeFixture.id],
  run: Effect.gen(function* () {
    const settings = yield* OpenAiConformanceConfig

    const outcome = yield* collectEvents(
      providerConfig(settings, true),
      userRequest(settings.models.invalid, 'Say hello.')
    ).pipe(Effect.result)

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
    const providerCode = error.provider?.providerCode

    yield* expectEqual(error.retryable, false, 'expected a non-retryable error')
    yield* expectConformance(
      status !== 401 && status !== 403 && error.provider?.kind !== 'auth',
      'expected a model rejection, not an authentication or permission failure',
      { actual: status ?? null }
    )
    yield* expectConformance(
      status !== undefined && modelRejectionStatuses.includes(status),
      'expected a 404 or 400 model-rejection status',
      { expected: [...modelRejectionStatuses], actual: status ?? null }
    )
    yield* expectEqual(
      providerCode ?? null,
      modelRejectionCode,
      'expected the provider code `model_not_found`'
    )
    yield* expectConformance(
      sanitizedStatusMessage.test(error.message),
      'expected a status-only message without upstream body text'
    )
  })
})

export const openAiChatJsonPlainTextCase: OpenAiConformanceCase = defineConformanceCase({
  id: 'openai.chat.json.plain-text',
  title: 'A non-streamed completion yields text, one stop, and usage',
  safety: 'read',
  docs: 'OpenAI Chat Completions with `stream: false` returns one `chat.completion` JSON body whose `choices[0].message.content` holds the answer, with `finish_reason` and a `usage` object.',
  wire: 'A non-streamed request succeeds with one JSON completion: the provider emits TextDelta events that join to non-empty text, exactly one Done(stop), and Usage.',
  fixtures: [openAiChatJsonPlainTextFixture.id],
  run: Effect.gen(function* () {
    const settings = yield* OpenAiConformanceConfig

    const events = yield* collectEvents(
      providerConfig(settings, false),
      userRequest(settings.models.plainText, 'Say hello.')
    )

    yield* expectPlainAnswer(events)
  })
})

/** Every OpenAI chat conformance case, in fixture order. */
export const openAiConformanceCases: ReadonlyArray<OpenAiConformanceCase> = [
  openAiChatPlainTextCase,
  openAiChatToolCallDeltasCase,
  openAiChatErrorEnvelopeCase,
  openAiChatJsonPlainTextCase
]
