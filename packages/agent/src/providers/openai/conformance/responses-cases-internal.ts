/**
 * Shared OpenAI Responses conformance case builder (internal; not a public export).
 *
 * The Responses-based subscription providers (OpenAI Codex, xAI Grok) share one wire and one
 * private parser (`openai-responses-provider-internal.ts`), so their conformance cases share one
 * shape: streamed plain text, `function_call` argument assembly, the unknown-model error
 * envelope, and the terminal `response.completed` event. Each vendor's `conformance/cases.ts`
 * builds its cases here with its own id prefix, config service, public provider layer, fixtures,
 * and terminal-event wording (Grok requires the terminal event; Codex keeps EOF-completion
 * compatibility).
 *
 * Two cases read the raw HTTP body at their own `HttpClient` boundary (a conformance-local
 * wrapper; the providers are unchanged): the error case reads the error body, and the
 * terminal-event case tees the streamed body while the provider consumes it, chunk for chunk.
 * Only shapes are reported, never upstream body text.
 */
import { Effect, Option, Predicate, Ref, Result, Stream, type Layer } from 'effect'
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
  LLMTextDelta,
  LLMToolCall,
  type LLMEvent,
  type LLMProviderError,
  type LLMRequest
} from '@yolk-sdk/agent/loop'
import { ToolDef, UserMessage } from '@yolk-sdk/agent/protocol'

/** Model ids per Responses case. `invalid` must NOT exist on the service. */
export type ResponsesConformanceModels = {
  readonly plainText: string
  readonly toolCall: string
  readonly invalid: string
}

/** The instructions every Responses case sends. */
export const responsesConformanceInstructions = 'Reply in one short sentence.'

export const responsesConformanceLookupWeatherTool = ToolDef.make({
  name: 'lookup_weather',
  description: 'Look up the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false
  }
})

type ResponsesConformanceCase<R> = ConformanceCase<
  LLMProviderError | ConformanceMismatch,
  HttpClient.HttpClient | R
>

export type ResponsesConformanceCases<R> = {
  readonly plainText: ResponsesConformanceCase<R>
  readonly functionCallArguments: ResponsesConformanceCase<R>
  readonly errorEnvelope: ResponsesConformanceCase<R>
  readonly terminalEvent: ResponsesConformanceCase<R>
}

export type ResponsesConformanceSpec<Settings, R> = {
  /** Dotted case id prefix, for example `openai.codex`. */
  readonly idPrefix: string
  /** The provider's display name, as in its sanitized `<name> returned <status>` messages. */
  readonly providerName: string
  /** How the docs name the endpoint, for example `The ChatGPT Codex Responses endpoint`. */
  readonly endpointLabel: string
  readonly settings: Effect.Effect<Settings, never, R>
  readonly models: (settings: Settings) => ResponsesConformanceModels
  /** The public provider layer the cases run through. */
  readonly providerLayer: (
    settings: Settings
  ) => Layer.Layer<LLMProvider, never, HttpClient.HttpClient>
  readonly fixtures: {
    readonly plainText: string
    readonly functionCallArguments: string
    readonly errorEnvelope: string
    readonly terminalEvent: string
  }
  /** Extra plain-text request docs, for example the reasoning summary Codex always requests. */
  readonly requestDocs: string
  /** Provider-specific terminal-event wording appended to the shared claim. */
  readonly terminalDocs: string
}

const userRequest = (model: string, prompt: string): LLMRequest => ({
  model,
  systemPrompt: responsesConformanceInstructions,
  messages: [UserMessage.make({ content: prompt })],
  tools: []
})

const tagsOf = (events: ReadonlyArray<LLMEvent>): Array<string> => events.map(event => event._tag)

const textOf = (events: ReadonlyArray<LLMEvent>): string =>
  events.flatMap(event => (event instanceof LLMTextDelta ? [event.text] : [])).join('')

const doneReasons = (events: ReadonlyArray<LLMEvent>): Array<string> =>
  events.flatMap(event => (event instanceof LLMDone ? [event.stopReason] : []))

type Outcome = {
  readonly events: ReadonlyArray<LLMEvent>
  readonly result: Result.Result<void, LLMProviderError>
}

/** Run one request and keep every event seen, including those before a failure. */
const collectOutcome = (
  layer: Layer.Layer<LLMProvider, never, HttpClient.HttpClient>,
  request: LLMRequest
): Effect.Effect<Outcome, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const provider = yield* LLMProvider
    const seen = yield* Ref.make<ReadonlyArray<LLMEvent>>([])

    const result = yield* provider.stream(request).pipe(
      Stream.runForEach(event => Ref.update(seen, events => [...events, event])),
      Effect.result
    )

    return { events: yield* Ref.get(seen), result }
  }).pipe(Effect.provide(layer))

const collectEvents = (
  layer: Layer.Layer<LLMProvider, never, HttpClient.HttpClient>,
  request: LLMRequest
): Effect.Effect<ReadonlyArray<LLMEvent>, LLMProviderError, HttpClient.HttpClient> =>
  collectOutcome(layer, request).pipe(
    Effect.flatMap(({ events, result }) =>
      Result.isFailure(result) ? Effect.fail(result.failure) : Effect.succeed(events)
    )
  )

/** One HTTP body read at the case's own boundary. */
type CapturedBody = {
  readonly status: number
  readonly chunks: Array<Uint8Array>
}

/**
 * The case's own HttpClient boundary: wraps the host client and keeps every response body while
 * handing the provider the same status, headers, and bytes. An error body (status 400 or above)
 * is read whole; a success body is teed chunk for chunk as the provider pulls it, so streaming,
 * chunk boundaries, and stream failures reach the provider unchanged.
 */
const capturingBodies = (
  client: HttpClient.HttpClient,
  bodies: Ref.Ref<ReadonlyArray<CapturedBody>>
): HttpClient.HttpClient =>
  HttpClient.transform(client, (effect, request) =>
    Effect.flatMap(effect, response => {
      const captured: CapturedBody = { status: response.status, chunks: [] }

      const record = Ref.update(bodies, current => [...current, captured])

      if (response.status >= 400) {
        return record.pipe(
          Effect.andThen(response.arrayBuffer),
          Effect.map(bytes => {
            captured.chunks.push(new Uint8Array(bytes))

            return HttpClientResponse.fromWeb(
              request,
              new Response(bytes, { status: response.status, headers: response.headers })
            )
          })
        )
      }

      return record.pipe(
        Effect.andThen(
          Stream.toReadableStreamEffect(
            response.stream.pipe(
              Stream.tap(chunk => Effect.sync(() => captured.chunks.push(chunk)))
            )
          )
        ),
        Effect.map(readable =>
          HttpClientResponse.fromWeb(
            request,
            new Response(readable, { status: response.status, headers: response.headers })
          )
        )
      )
    })
  )

const bodyText = (body: CapturedBody): string => {
  const joined = new Uint8Array(body.chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0

  for (const chunk of body.chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }

  return new TextDecoder().decode(joined)
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** The `data:` payload of every server-sent event in a body, parsed when it is JSON. */
export const responsesSseData = (text: string): ReadonlyArray<Schema.Json | undefined> =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n\n')
    .map(block =>
      block
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice('data:'.length).trim())
        .join('\n')
        .trim()
    )
    .filter(data => data.length > 0 && data !== '[DONE]')
    .map(data => Option.getOrUndefined(decodeJson(data)))

const isRecord = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

const eventType = (data: Schema.Json | undefined): unknown =>
  isRecord(data) ? data.type : undefined

/**
 * A JSON error body carrying a message: the OpenAI envelope `{ error: { message } }`, or the
 * `{ detail }` / `{ error: "<message>" }` shapes some Responses endpoints use (extra keys
 * allowed).
 */
const ErrorBody = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
    Schema.Struct({ error: Schema.String }),
    Schema.Struct({ detail: Schema.String })
  ])
)

const isErrorBody = (text: string): boolean =>
  Option.isSome(Schema.decodeUnknownOption(ErrorBody)(text))

// Unknown model ids are request rejections: 400 or 404, never 401/403 or a 429/5xx.
const modelRejectionStatuses: ReadonlyArray<number> = [400, 404]

const functionCallPrompt = 'What is the weather in Springfield? Use the tool.'

/** Build the four Responses conformance cases for one provider. */
export const makeResponsesConformanceCases = <Settings, R>(
  spec: ResponsesConformanceSpec<Settings, R>
): ResponsesConformanceCases<R> => {
  const id = (suffix: string) => `${spec.idPrefix}.stream.${suffix}`

  const plainText = defineConformanceCase({
    id: id('plain-text'),
    title: 'Streamed plain text ends with one stop and a usage report',
    safety: 'read',
    docs: `${spec.endpointLabel} streams Responses server-sent events with typed \`event:\` names: \`response.created\`, per output item \`response.output_item.added\` / deltas / \`response.output_item.done\` (a \`message\` item streams \`response.output_text.delta\`), and a final \`response.completed\` carrying the whole \`response\` with its \`usage\`. ${spec.requestDocs}`,
    wire: 'A streamed request succeeds with non-empty answer text and ends normally: the provider stream completes without error, its TextDelta events join to non-empty text, it emits exactly one Done(stop), and at least one Usage (read from `response.completed`). How many deltas carry the text, and whether a reasoning summary precedes it, are not part of the claim.',
    fixtures: [spec.fixtures.plainText],
    run: Effect.gen(function* () {
      const settings = yield* spec.settings

      const events = yield* collectEvents(
        spec.providerLayer(settings),
        userRequest(spec.models(settings).plainText, 'Say hello.')
      )

      const tags = tagsOf(events)

      yield* expectEqual(doneReasons(events), ['stop'], 'expected exactly one Done(stop)')
      yield* expectConformance(textOf(events).trim().length > 0, 'expected non-empty answer text')
      yield* expectConformance(tags.includes('Usage'), 'expected a usage report', {
        actual: tags
      })
    })
  })

  const functionCallArguments = defineConformanceCase({
    id: id('function-call-arguments'),
    title: 'Streamed function_call arguments assemble into tool calls',
    safety: 'read',
    docs: `A streamed Responses \`function_call\` output item is announced by \`response.output_item.added\` (with its \`call_id\`, \`name\`, and empty \`arguments\`), its JSON arguments stream as \`response.function_call_arguments.delta\` fragments, and \`response.function_call_arguments.done\` and \`response.output_item.done\` carry the complete arguments; \`response.completed\` repeats the item in \`output\`. The provider offers the tool without forcing it (it sends no \`tool_choice\`) and allows parallel calls.`,
    wire: 'For a single offered tool and a prompt that asks for it, the stream yields at least one ToolCall and every ToolCall is named after the tool (native name), has a distinct call id (a call replayed in `response.completed` is not emitted twice), and has params that are a JSON object with a non-empty string `city`; the stream ends with exactly one Done(tool_use). How the arguments are split into deltas is not asserted.',
    fixtures: [spec.fixtures.functionCallArguments],
    run: Effect.gen(function* () {
      const settings = yield* spec.settings

      const events = yield* collectEvents(spec.providerLayer(settings), {
        ...userRequest(spec.models(settings).toolCall, functionCallPrompt),
        tools: [responsesConformanceLookupWeatherTool]
      })

      const calls = events.flatMap(event => (event instanceof LLMToolCall ? [event.call] : []))

      yield* expectConformance(calls.length > 0, 'expected at least one assembled tool call', {
        actual: tagsOf(events)
      })
      yield* expectEqual(
        new Set(calls.map(call => call.id)).size,
        calls.length,
        'expected distinct tool call ids'
      )

      for (const call of calls) {
        const params: unknown = call.params
        const city = Predicate.hasProperty(params, 'city') ? params.city : undefined

        yield* expectEqual(
          call.name,
          responsesConformanceLookupWeatherTool.name,
          'expected the offered tool'
        )
        yield* expectConformance(
          Predicate.isObject(params) && !Array.isArray(params),
          'expected tool arguments to assemble into a JSON object'
        )
        yield* expectConformance(
          Predicate.isString(city) && city.length > 0,
          'expected a non-empty string `city` argument'
        )
      }

      yield* expectEqual(doneReasons(events), ['tool_use'], 'expected exactly one Done(tool_use)')
    })
  })

  const errorEnvelope = defineConformanceCase({
    id: id('error-envelope'),
    title: 'Unknown model ids fail with a sanitized non-retryable request rejection',
    safety: 'read',
    docs: `${spec.endpointLabel} rejects an unknown model id before any stream starts with a non-2xx JSON error body; OpenAI-style endpoints use the envelope \`{ error: { message, type, param, code } }\` (code \`model_not_found\`), while a missing or invalid credential is a 401.`,
    wire: `An unknown model id is rejected as a 400 or 404, never a 401/403 authentication or permission failure: the provider fails with a non-retryable LLMError that is not classified as \`auth\`, keeps the status, and whose message is status-only (\`${spec.providerName} returned <status>\`, no upstream body text). The provider does not surface the body, so the case also reads it at its own HttpClient boundary (handing the same bytes on to the provider) and requires a JSON error body with a string message (\`{ error: { message } }\`, \`{ error }\`, or \`{ detail }\`); an empty, non-JSON, or differently shaped body fails the case.`,
    fixtures: [spec.fixtures.errorEnvelope],
    run: Effect.gen(function* () {
      const settings = yield* spec.settings
      const client = yield* HttpClient.HttpClient
      const bodies = yield* Ref.make<ReadonlyArray<CapturedBody>>([])

      const outcome = yield* collectEvents(
        spec.providerLayer(settings),
        userRequest(spec.models(settings).invalid, 'Say hello.')
      ).pipe(
        Effect.provideService(HttpClient.HttpClient, capturingBodies(client, bodies)),
        Effect.result
      )

      if (Result.isSuccess(outcome)) {
        return yield* expectConformance(
          false,
          'expected an error envelope, the request succeeded',
          { actual: tagsOf(outcome.success) }
        )
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
      yield* expectConformance(
        status !== undefined && modelRejectionStatuses.includes(status),
        'expected a 400 or 404 model-rejection status',
        { expected: [...modelRejectionStatuses], actual: status ?? null }
      )
      yield* expectEqual(
        error.message,
        `${spec.providerName} returned ${status ?? 'unknown'}`,
        'expected a status-only message without upstream body text'
      )

      const errorBodies = (yield* Ref.get(bodies)).filter(body => body.status >= 400)

      // Only the shape is reported, never the upstream body text.
      yield* expectConformance(
        errorBodies.length === 1 && errorBodies.every(body => isErrorBody(bodyText(body))),
        'expected the error body to be a JSON error envelope with a message',
        { actual: errorBodies.map(body => isErrorBody(bodyText(body))) }
      )
    })
  })

  const terminalEvent = defineConformanceCase({
    id: id('terminal-event'),
    title: 'The stream ends with one response.completed event',
    safety: 'read',
    docs: `A Responses stream that finishes normally ends with one \`response.completed\` event whose \`response.status\` is \`completed\`; nothing follows it. Failures end with \`response.failed\` or an \`error\` event instead, and a stream cut before the terminal event never reaches it. ${spec.terminalDocs}`,
    wire: 'A streamed plain-text request succeeds with exactly one Done, and its body (read at the case\'s own HttpClient boundary while the provider consumes it, chunk for chunk) is server-sent events whose JSON `data:` payloads include exactly one `response.completed`, as the last event, with `response.status: "completed"`, and no `response.failed`, `response.incomplete`, or `error` event.',
    fixtures: [spec.fixtures.terminalEvent],
    run: Effect.gen(function* () {
      const settings = yield* spec.settings
      const client = yield* HttpClient.HttpClient
      const bodies = yield* Ref.make<ReadonlyArray<CapturedBody>>([])

      const events = yield* collectEvents(
        spec.providerLayer(settings),
        userRequest(spec.models(settings).plainText, 'Say hello.')
      ).pipe(Effect.provideService(HttpClient.HttpClient, capturingBodies(client, bodies)))

      yield* expectEqual(doneReasons(events).length, 1, 'expected exactly one Done')

      const [body, ...rest] = yield* Ref.get(bodies)

      yield* expectConformance(
        body !== undefined && rest.length === 0,
        'expected exactly one response body'
      )

      const data = body === undefined ? [] : responsesSseData(bodyText(body))
      const types = data.map(eventType)
      const completed = data.filter(item => eventType(item) === 'response.completed')
      const failures = ['response.failed', 'response.incomplete', 'error']

      yield* expectConformance(data.length > 0, 'expected a server-sent event stream')
      yield* expectConformance(
        !types.some(type => Predicate.isString(type) && failures.includes(type)),
        'expected no failure event'
      )
      yield* expectEqual(
        completed.length,
        1,
        'expected the stream to carry exactly one response.completed event'
      )
      yield* expectConformance(
        types.at(-1) === 'response.completed',
        'expected response.completed to be the last event'
      )

      const [terminal] = completed
      const response = isRecord(terminal) ? terminal.response : undefined

      yield* expectConformance(
        isRecord(response) && response.status === 'completed',
        'expected response.completed to carry status completed'
      )
    })
  })

  return { plainText, functionCallArguments, errorEnvelope, terminalEvent }
}
