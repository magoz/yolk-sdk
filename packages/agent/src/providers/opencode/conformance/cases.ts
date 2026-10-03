/**
 * OpenCode Go conformance cases for `@yolk-sdk/conformance/runner`.
 *
 * Each protocol case builds the public Go provider (`makeOpenCodeGoProviderLayer` with an explicit
 * `protocol`, the redacted API key, the host output limit, and the default
 * `https://opencode.ai/zen/go/v1` base) from `OpenCodeGoConformanceConfig`, sends one request
 * through `LLMProvider`, and asserts one wire claim from the events it sees (the commentary-replay
 * case also reads the request it sends at its own `HttpClient` boundary). The usage case calls the
 * public `fetchOpenCodeGoSubscriptionUsage` (default `https://opencode.ai/zen/go/v1/usage`, Bearer
 * API key) and shares its shape with the Claude, Codex, and Grok usage cases. Cases need only
 * `HttpClient.HttpClient` and the config service, so the same case runs against replayed fixtures
 * (`ReplayHttpClient`), the `@yolk-sdk/emulators/opencode` emulator, or a host's live
 * `HttpClient`. All five are `read` cases; none is observed live yet (`observed` absent =
 * unverified).
 */
import {
  Context,
  Effect,
  Match,
  Option,
  Predicate,
  Ref,
  Result,
  Stream,
  type Redacted
} from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient, type HttpClientRequest } from 'effect/http'
import {
  defineConformanceCase,
  expectConformance,
  expectEqual,
  type ConformanceCase,
  type ConformanceMismatch
} from '@yolk-sdk/conformance/case'
import {
  LLMDone,
  LLMProvider,
  LLMTextDelta,
  type LLMEvent,
  type LLMProviderError,
  type LLMRequest
} from '@yolk-sdk/agent/loop'
import {
  AssistantAgentMessage,
  AssistantTextPart,
  HostToolCallPart,
  ToolCall,
  ToolDef,
  ToolResultMessage,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import {
  isWireRecord,
  makeSubscriptionUsageConformanceCase,
  wireField,
  wireInstant,
  wirePercent,
  type SubscriptionUsageExpectedWindow
} from '../../openai/conformance/subscription-usage-cases-internal.ts'
import type { ProviderSubscriptionUsageError } from '../../subscription-usage.ts'
import {
  makeOpenCodeGoProviderLayer,
  openCodeGoBaseUrl,
  openCodeGoProviderId,
  type OpenCodeGoProtocol
} from '../go-provider.ts'
import { fetchOpenCodeGoSubscriptionUsage, openCodeGoSubscriptionUsageUrl } from '../usage.ts'
import { openCodeGoChatPlainTextFixture } from './chat-plain-text.ts'
import { openCodeGoMessagesPlainTextFixture } from './messages-plain-text.ts'
import { openCodeGoResponsesCommentaryReplayFixture } from './responses-commentary-replay.ts'
import { openCodeGoResponsesPlainTextFixture } from './responses-plain-text.ts'
import { openCodeGoUsageSnapshotFixture } from './usage-snapshot.ts'

/** The Go base URL the protocol cases (and the provider's default) call. */
export const openCodeGoConformanceBaseUrl = openCodeGoBaseUrl

/** The Go subscription-usage endpoint the usage case (and the fetcher's default) calls. */
export const openCodeGoConformanceUsageUrl = openCodeGoSubscriptionUsageUrl

/** Model ids per protocol: each must be advertised by OpenCode Go for that protocol. */
export type OpenCodeGoConformanceModels = {
  readonly chat: string
  readonly messages: string
  readonly responses: string
}

/**
 * Model ids used by the committed synthetic fixtures. They are placeholders: a live probe takes
 * real Go model ids per protocol from the owner (`pnpm conformance:opencode --chat-model ...`).
 */
export const openCodeGoConformanceDefaultModels: OpenCodeGoConformanceModels = {
  chat: 'synthetic-go-chat',
  messages: 'synthetic-go-messages',
  responses: 'synthetic-go-responses'
}

export type OpenCodeGoConformanceSettings = {
  /**
   * OpenCode Go API key: Bearer for chat, Responses, and usage; `x-api-key` for Messages. Any
   * value works under replay or an emulator.
   */
  readonly apiKey: Redacted.Redacted<string>
  /** Host output limit (`max_tokens`, `max_tokens`, or `max_output_tokens` per protocol). */
  readonly maxOutputTokens: number
  readonly models: OpenCodeGoConformanceModels
}

/** Host-supplied settings for the OpenCode Go conformance cases. */
export class OpenCodeGoConformanceConfig extends Context.Service<
  OpenCodeGoConformanceConfig,
  OpenCodeGoConformanceSettings
>()('@yolk-sdk/agent/providers/opencode/conformance/OpenCodeGoConformanceConfig') {}

/** What every OpenCode Go conformance case requires from the host. */
export type OpenCodeGoConformanceRequirements = HttpClient.HttpClient | OpenCodeGoConformanceConfig

export type OpenCodeGoConformanceCase = ConformanceCase<
  LLMProviderError | ProviderSubscriptionUsageError | ConformanceMismatch,
  OpenCodeGoConformanceRequirements
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

const providerLayer = (settings: OpenCodeGoConformanceSettings, protocol: OpenCodeGoProtocol) =>
  makeOpenCodeGoProviderLayer({
    apiKey: settings.apiKey,
    protocol,
    maxOutputTokens: settings.maxOutputTokens
  })

const modelFor = (settings: OpenCodeGoConformanceSettings, protocol: OpenCodeGoProtocol) =>
  Match.value(protocol).pipe(
    Match.when('chat-completions', () => settings.models.chat),
    Match.when('messages', () => settings.models.messages),
    Match.when('responses', () => settings.models.responses),
    Match.exhaustive
  )

/** Run one request through the Go provider and keep every event (fails on a provider error). */
const collectEvents = (
  settings: OpenCodeGoConformanceSettings,
  protocol: OpenCodeGoProtocol,
  request: LLMRequest
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMProviderError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const provider = yield* LLMProvider
    const seen = yield* Ref.make<ReadonlyArray<LLMEvent>>([])

    const result = yield* provider.stream(request).pipe(
      Stream.runForEach(event => Ref.update(seen, events => [...events, event])),
      Effect.result
    )

    if (Result.isFailure(result)) return yield* Effect.fail(result.failure)

    return yield* Ref.get(seen)
  }).pipe(Effect.provide(providerLayer(settings, protocol)))

const tagsOf = (events: ReadonlyArray<LLMEvent>): Array<string> => events.map(event => event._tag)

const textOf = (events: ReadonlyArray<LLMEvent>): string =>
  events.flatMap(event => (event instanceof LLMTextDelta ? [event.text] : [])).join('')

const doneReasons = (events: ReadonlyArray<LLMEvent>): Array<string> =>
  events.flatMap(event => (event instanceof LLMDone ? [event.stopReason] : []))

const protocolWire: Readonly<Record<OpenCodeGoProtocol, string>> = {
  'chat-completions':
    '`POST /zen/go/v1/chat/completions` with Bearer auth, `max_tokens`, `stream: true`, and `stream_options.include_usage` streams OpenAI-compatible `chat.completion.chunk` server-sent events (text in `delta.content`, a `finish_reason: stop` chunk, a usage chunk) ending with `data: [DONE]`.',
  messages:
    '`POST /zen/go/v1/messages` with `x-api-key`, `anthropic-version: 2023-06-01`, `max_tokens`, and `stream: true` streams Anthropic Messages events (`message_start`, a text block of `text_delta` events, `message_delta` with `stop_reason: end_turn` and usage, and the required `message_stop`).',
  responses:
    '`POST /zen/go/v1/responses` with Bearer auth, `max_output_tokens`, `store: false`, and `stream: true` streams OpenAI Responses events (`response.created`, a `message` item of `response.output_text.delta` events, and the required `response.completed` with the output and usage).'
}

const plainTextCase = (
  protocol: OpenCodeGoProtocol,
  id: string,
  fixture: string
): OpenCodeGoConformanceCase =>
  defineConformanceCase({
    id,
    title: `Go ${protocol} streamed plain text ends with one stop and a usage report`,
    safety: 'read',
    docs: protocolWire[protocol],
    wire: `A streamed \`${protocol}\` request succeeds with non-empty answer text and ends normally: the Go provider stream completes without error, its TextDelta events join to non-empty text, it emits exactly one Done(stop) and at least one Usage. How many deltas carry the text, and any reasoning before it, are not part of the claim.`,
    fixtures: [fixture],
    run: Effect.gen(function* () {
      const settings = yield* OpenCodeGoConformanceConfig

      const events = yield* collectEvents(settings, protocol, {
        model: modelFor(settings, protocol),
        systemPrompt,
        messages: [UserMessage.make({ content: 'Say hello.' })],
        tools: []
      })

      const tags = tagsOf(events)

      yield* expectEqual(doneReasons(events), ['stop'], 'expected exactly one Done(stop)')
      yield* expectConformance(textOf(events).trim().length > 0, 'expected non-empty answer text')
      yield* expectConformance(tags.includes('Usage'), 'expected a usage report', {
        actual: tags
      })
    })
  })

export const openCodeGoChatPlainTextCase: OpenCodeGoConformanceCase = plainTextCase(
  'chat-completions',
  'opencode.go.chat.stream.plain-text',
  openCodeGoChatPlainTextFixture.id
)

export const openCodeGoMessagesPlainTextCase: OpenCodeGoConformanceCase = plainTextCase(
  'messages',
  'opencode.go.messages.stream.plain-text',
  openCodeGoMessagesPlainTextFixture.id
)

export const openCodeGoResponsesPlainTextCase: OpenCodeGoConformanceCase = plainTextCase(
  'responses',
  'opencode.go.responses.stream.plain-text',
  openCodeGoResponsesPlainTextFixture.id
)

/** The earlier tool turn the commentary-replay case sends back (synthetic ids and text). */
const replayCall = ToolCall.make({
  id: 'call_synthetic_weather',
  name: lookupWeatherTool.name,
  params: { city: 'Springfield' }
})

const replayCommentary = 'I will look up the weather first.'

const replayRequest = (model: string): LLMRequest => ({
  model,
  systemPrompt,
  messages: [
    UserMessage.make({ content: 'What is the weather in Springfield?' }),
    AssistantAgentMessage.make({
      parts: [
        AssistantTextPart.make({ content: replayCommentary }),
        HostToolCallPart.make({ call: replayCall })
      ]
    }),
    ToolResultMessage.make({
      toolCallId: replayCall.id,
      content: 'Sunny and mild.',
      isError: false
    })
  ],
  tools: [lookupWeatherTool]
})

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** The JSON body of a request, when it is a byte body that parses. */
const requestJson = (request: HttpClientRequest.HttpClientRequest): Schema.Json | undefined =>
  Predicate.isTagged(request.body, 'Uint8Array')
    ? Option.getOrUndefined(decodeJson(new TextDecoder().decode(request.body.body)))
    : undefined

/** A compact, text-free view of the Responses `input` items, for ordering claims. */
const replayedItemKinds = (input: Schema.Json | undefined): ReadonlyArray<string> =>
  Array.isArray(input)
    ? input.map(item => {
        const type = wireField(item, 'type')
        const role = wireField(item, 'role')
        const phase = wireField(item, 'phase')

        if (Predicate.isString(type)) return type

        return `${Predicate.isString(role) ? role : 'unknown'}${Predicate.isString(phase) ? `:${phase}` : ''}`
      })
    : []

export const openCodeGoResponsesCommentaryReplayCase: OpenCodeGoConformanceCase =
  defineConformanceCase({
    id: 'opencode.go.responses.stream.commentary-replay',
    title: 'Go Responses replay tags text before a tool call as commentary and is accepted',
    safety: 'read',
    docs: 'OpenCode Go Responses keeps an assistant turn in order when it is sent back: text, then its `function_call`, then the host `function_call_output`. Assistant text that precedes a later host `function_call` is sent as `{ role: "assistant", content, phase: "commentary" }`; trailing and final-answer text carries no `phase`. The endpoint accepts that input and streams a normal response.',
    wire: 'A streamed Responses request replaying one earlier tool turn (user prompt; assistant text then a `lookup_weather` call; its result) sends, as read at the case\'s own HttpClient boundary, exactly one request whose `input` is, in order, the user message, the assistant text with `phase: "commentary"`, the `function_call` (its `call_id`), and the `function_call_output` with the same `call_id`, with no other `phase`; the endpoint accepts it: the stream completes without error and emits exactly one Done (a stop or another tool call).',
    fixtures: [openCodeGoResponsesCommentaryReplayFixture.id],
    run: Effect.gen(function* () {
      const settings = yield* OpenCodeGoConformanceConfig
      const client = yield* HttpClient.HttpClient
      const requests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([])

      const recording = HttpClient.transform(client, (effect, request) =>
        Ref.update(requests, current => [...current, request]).pipe(Effect.andThen(effect))
      )

      const events = yield* collectEvents(
        settings,
        'responses',
        replayRequest(settings.models.responses)
      ).pipe(Effect.provideService(HttpClient.HttpClient, recording))

      const sent = yield* Ref.get(requests)
      const [request] = sent
      const input = request === undefined ? undefined : wireField(requestJson(request), 'input')
      const items = Array.isArray(input) ? input : []

      yield* expectConformance(sent.length === 1, 'expected exactly one request', {
        actual: sent.length
      })
      yield* expectEqual(
        [...replayedItemKinds(input)],
        ['user', 'assistant:commentary', 'function_call', 'function_call_output'],
        'expected the replayed turn in order with the text tagged as commentary'
      )
      yield* expectConformance(
        wireField(items[1], 'content') === replayCommentary &&
          wireField(items[2], 'call_id') === replayCall.id &&
          wireField(items[2], 'name') === replayCall.name &&
          wireField(items[3], 'call_id') === replayCall.id &&
          items.every(item => !isWireRecord(item) || item === items[1] || !('phase' in item)),
        'expected the commentary text, the call id, and its output to be replayed unchanged'
      )
      yield* expectEqual(doneReasons(events).length, 1, 'expected exactly one Done')
    })
  })

const goWindows = [
  { key: 'rolling', id: 'five-hour' },
  { key: 'weekly', id: 'seven-day' },
  { key: 'monthly', id: 'monthly' }
] as const

export const openCodeGoUsageSnapshotCase: OpenCodeGoConformanceCase =
  makeSubscriptionUsageConformanceCase({
    id: 'opencode.go.usage.snapshot',
    title: 'Go subscription usage normalizes the reported windows only',
    docs: 'The Go usage endpoint (`GET /zen/go/v1/usage`, Bearer API key, not console cookies or OAuth) answers JSON whose `usage` carries `rolling`, `weekly`, and `monthly` windows as `{ percent, resetsAt }` (any may be `null` or absent); the fetcher maps them to `five-hour`, `seven-day`, and `monthly`, trusting the provider reset instants.',
    wire: 'A wire window is reported when its `percent` is a number from 0 to 100; its reset instant is `resetsAt` when readable (never an inferred calendar boundary).',
    providerId: openCodeGoProviderId,
    windowIds: goWindows.map(window => window.id),
    settings: Effect.service(OpenCodeGoConformanceConfig),
    fetch: settings => fetchOpenCodeGoSubscriptionUsage(settings.apiKey),
    expectedWindows: body =>
      goWindows.flatMap((window): Array<SubscriptionUsageExpectedWindow> => {
        const wire = wireField(wireField(body, 'usage'), window.key)
        const usedPercent = wirePercent(wireField(wire, 'percent'))

        return usedPercent === undefined
          ? []
          : [{ id: window.id, usedPercent, resetsAt: wireInstant(wireField(wire, 'resetsAt')) }]
      }),
    fixture: openCodeGoUsageSnapshotFixture.id
  })

/** Every OpenCode Go conformance case, in fixture order. */
export const openCodeGoConformanceCases: ReadonlyArray<OpenCodeGoConformanceCase> = [
  openCodeGoChatPlainTextCase,
  openCodeGoMessagesPlainTextCase,
  openCodeGoResponsesPlainTextCase,
  openCodeGoResponsesCommentaryReplayCase,
  openCodeGoUsageSnapshotCase
]
