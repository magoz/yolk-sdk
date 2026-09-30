/**
 * OpenAI-compatible Chat Completions emulator core (internal; not a package export).
 *
 * One `POST .../chat/completions` route with request parsing, `chat.completion.chunk` SSE
 * framing (text, reasoning, tool-call argument fragments, a finish event, usage, and
 * `data: [DONE]`), the non-streamed `chat.completion` JSON body, and scripted turns. Faults, the
 * request ledger, the `/_emulate/*` control plane, evidence tagging, and route binding come from
 * the shared kernel (`emulator-kernel.ts`).
 *
 * Each emulator subpath (`gateway`, `openai`) supplies what differs: the path and route evidence
 * manifest, model lists, the error envelope and the unknown-model status and error, the 401
 * error, the completion-token request field, whether reasoning is emulated, its scripted-turn
 * schema, and its wire profile (`ChatWireProfile`: events per network chunk, usage placement, the
 * reasoning field, and extra per-chunk fields). Without a profile the plain OpenAI Chat
 * Completions wire is sent.
 *
 * Runtime-portable Web APIs only (`Request`, `Response`, `ReadableStream`, `TextEncoder`, `URL`);
 * no Node builtins and no SDK imports.
 */
import { Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  approximateTokens,
  EmulatorErrorAfterChunksFault,
  EmulatorFaultMatch,
  EmulatorScriptedError,
  EmulatorStatusFault,
  EmulatorTruncateAfterChunksFault,
  jsonField,
  jsonResponse,
  makeEmulatorKernel,
  parseJson,
  readText,
  splitFragments,
  stringField,
  synthesizeValue,
  type EmulatorApi,
  type EmulatorCoverage,
  type EmulatorFaultState,
  type EmulatorRouteCoverage,
  type KernelLedgerEntry
} from './emulator-kernel.ts'
import {
  emulatorRouteKey,
  type EmulatorEvidence,
  type EmulatorRouteEvidence
} from './route-evidence.ts'

/** Optional fault filter; an omitted field matches every request. `path` ending in `*` is a prefix. */
export const ChatFaultMatch = EmulatorFaultMatch

export type ChatFaultMatch = typeof ChatFaultMatch.Type

/**
 * Wire faults for emulated routes:
 *
 * - `status`: answer with this status, headers, and body instead of a
 *   completion (for example 429 with `retry-after`). The body defaults to the
 *   emulator's error envelope. Statuses that cannot carry a body (1xx, 204,
 *   205, 304) and redirects (3xx) are rejected, as are invalid header names or
 *   values and a `location` header; scripted errors follow the same rules.
 * - `error-after-chunks`: send `chunks` body chunks, then error the body
 *   stream (a dropped connection).
 * - `truncate-after-chunks`: send `chunks` body chunks, then close the body
 *   cleanly (for example without `data: [DONE]`).
 *
 * A whole JSON body counts as one chunk. A chunk fault that cannot take
 * effect (`error-after-chunks` beyond the chunk count, or
 * `truncate-after-chunks` at or beyond it) answers 500 with an emulator error
 * instead of silently doing nothing, and is not consumed.
 */
export const ChatFault = Schema.Union([
  EmulatorStatusFault,
  EmulatorErrorAfterChunksFault,
  EmulatorTruncateAfterChunksFault
])

export type ChatFault = typeof ChatFault.Type

export type ChatFaultKind = ChatFault['kind']

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Usage for a scripted turn (sent as the wire `usage` object). */
export const ChatScriptedUsage = Schema.Struct({
  promptTokens: TokenCount,
  completionTokens: TokenCount,
  reasoningTokens: Schema.optionalKey(TokenCount)
})

export type ChatScriptedUsage = typeof ChatScriptedUsage.Type

/** One scripted tool call; its JSON arguments stream as these fragments. */
export const ChatScriptedToolCall = Schema.Struct({
  name: Schema.NonEmptyString,
  argumentFragments: Schema.Array(Schema.String),
  id: Schema.optionalKey(Schema.NonEmptyString)
})

export type ChatScriptedToolCall = typeof ChatScriptedToolCall.Type

/** Scripted completion fields every Chat Completions emulator accepts. */
export const chatScriptedCompletionFields = {
  text: Schema.optionalKey(Schema.Array(Schema.String)),
  toolCalls: Schema.optionalKey(Schema.Array(ChatScriptedToolCall)),
  usage: Schema.optionalKey(Schema.NullOr(ChatScriptedUsage)),
  finishReason: Schema.optionalKey(Schema.NonEmptyString)
}

/** Scripted completion fields for emulators that emulate streamed reasoning. */
export const chatScriptedReasoningFields = {
  reasoning: Schema.optionalKey(Schema.Array(Schema.String)),
  reasoningField: Schema.optionalKey(Schema.Literals(['reasoning_content', 'reasoning'])),
  order: Schema.optionalKey(Schema.Literals(['reasoning-first', 'text-first']))
}

/**
 * The reasoning variant of a scripted completion (the Gateway's shape; `/openai` uses the
 * reasoning-free `OpenAiScriptedCompletion`). Every field is exact (nothing is
 * filled in) except: `usage` omitted is synthesized when the request asks for
 * usage, and `null` drops it; `finishReason` omitted is `tool_calls` with tool
 * calls, else `stop`. `order` defaults to `reasoning-first`; `reasoningField`
 * defaults to the emulator's wire profile field (`reasoning` for the Gateway,
 * as recorded live; `reasoning_content` is the DeepSeek-native alternative).
 */
export const ChatScriptedReasoningCompletion = Schema.Struct({
  text: chatScriptedCompletionFields.text,
  reasoning: chatScriptedReasoningFields.reasoning,
  reasoningField: chatScriptedReasoningFields.reasoningField,
  order: chatScriptedReasoningFields.order,
  toolCalls: chatScriptedCompletionFields.toolCalls,
  usage: chatScriptedCompletionFields.usage,
  finishReason: chatScriptedCompletionFields.finishReason
})

export type ChatScriptedReasoningCompletion = typeof ChatScriptedReasoningCompletion.Type

/** A scripted error response: status, body (a string is sent as is), and optional headers. */
export const ChatScriptedError = EmulatorScriptedError

export type ChatScriptedError = typeof ChatScriptedError.Type

/**
 * The reasoning variant of a scripted turn, queued for the next chat completion request. It is
 * also the widest turn shape, so it bounds every emulator's turn type.
 */
export const ChatScriptedReasoningTurn = Schema.Union([
  ChatScriptedError,
  ChatScriptedReasoningCompletion
])

export type ChatScriptedReasoningTurn = typeof ChatScriptedReasoningTurn.Type

export type ChatLedgerEntry = {
  /** 1-based arrival order since the last ledger clear or reset. */
  readonly seq: number
  readonly method: string
  readonly path: string
  /** Parsed JSON request body, when it was valid JSON. */
  readonly body?: Schema.Json
  readonly model?: string
  readonly stream?: boolean
  /**
   * The output-token limit from the emulator's completion-token request field (`max_tokens` or
   * `max_completion_tokens`), when it is a number. Recorded as sent; never validated.
   */
  readonly maxCompletionTokens?: number
  readonly reasoningEffort?: string
  readonly thinking?: Schema.Json
  readonly toolNames: ReadonlyArray<string>
  /** Kind of the fault that shaped the response. */
  readonly fault?: ChatFaultKind
  /** Why a matching fault could not take effect (the response was a 500 emulator error). */
  readonly faultError?: string
  /**
   * Set when the emulator could not build the planned response; the request was
   * answered with a 500 emulator error (still evidence-tagged) and no fault was used up.
   */
  readonly responseError?: string
  /** Set when a scripted turn answered the request. */
  readonly scripted?: 'completion' | 'error'
  /** Evidence of the matched route; `unknown-route` for requests that failed closed. */
  readonly evidence: EmulatorEvidence | 'unknown-route'
  readonly status: number
  /** Body chunks handed to the transport so far (each produced when pulled). */
  readonly bodyChunks: number
}

export type ChatFaultState = EmulatorFaultState<ChatFault>

export type ChatRouteCoverage = EmulatorRouteCoverage

export type ChatCoverage = EmulatorCoverage

export type ChatCompletionsEmulator<Turn> = EmulatorApi<Turn, ChatFault, ChatLedgerEntry>

/** One wire error: the emulator's envelope renders it. */
export type ChatWireError = {
  readonly message: string
  readonly type: string
  readonly code: string
}

/** The id and model every chunk of one emulated response repeats. */
export type ChatResponseIdentity = { readonly id: string; readonly model: string }

/** Token counts behind a wire `usage` object. */
export type ChatUsageCounts = {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly reasoningTokens: number | undefined
}

/**
 * Per-service response details on top of the shared framing. Every field is optional; an omitted
 * field keeps the plain OpenAI Chat Completions wire (the `/openai` emulator passes no profile).
 */
export type ChatWireProfile = {
  /**
   * SSE events per network (body) chunk; default 1. Events are packed counting from the end, so
   * the last chunk carries the finish event together with `data: [DONE]` and the first chunk may
   * carry fewer. Chunk faults count these network chunks.
   */
  readonly eventsPerChunk?: number
  /**
   * Where streamed usage goes when `stream_options.include_usage` is set: a trailing chunk with
   * empty `choices` (`usage-chunk`, default) or the finish event itself (`finish-event`).
   */
  readonly streamUsage?: 'usage-chunk' | 'finish-event'
  /** The first streamed delta; default `{ role: 'assistant', content: '' }`. */
  readonly openingDelta?: Schema.JsonObject
  /** Extra fields on every streamed choice, placed before `finish_reason` (for example `logprobs`). */
  readonly choiceFields?: Schema.JsonObject
  /** The default reasoning field for default and scripted output; default `reasoning_content`. */
  readonly reasoningField?: 'reasoning_content' | 'reasoning'
  /** Streamed `reasoning` deltas also carry `reasoning_details` (`reasoning.text` entries). */
  readonly reasoningDetails?: boolean
  /** Extra top-level fields on every streamed chunk (for example `system_fingerprint`). */
  readonly chunkFields?: (identity: ChatResponseIdentity) => Schema.JsonObject
  /** Extra fields on the finish event: top-level (`chunk`) and inside its `delta`. */
  readonly finishFields?: (identity: ChatResponseIdentity) => {
    readonly chunk: Schema.JsonObject
    readonly delta: Schema.JsonObject
  }
  /** Renders token counts as the wire `usage` object (streamed and JSON). */
  readonly usage?: (counts: ChatUsageCounts) => Schema.JsonObject
}

/**
 * What differs between Chat Completions emulators. The core owns everything else (framing,
 * faults, scripting, ledger, control plane, evidence).
 */
export type ChatCompletionsEmulatorConfig<Turn extends ChatScriptedReasoningTurn> = {
  /** The chat completions path, for example `/v1/chat/completions`. */
  readonly path: string
  /** Route evidence manifest; must list exactly the chat completions route. */
  readonly routes: ReadonlyArray<EmulatorRouteEvidence>
  readonly knownModels: ReadonlyArray<string>
  /**
   * Streamed reasoning: `undefined` when the emulator does not emulate reasoning (default plans
   * never reason and `/_emulate/state` omits `reasoningModels`); otherwise the models that stream
   * reasoning when a request asks for it.
   */
  readonly reasoningModels: ReadonlyArray<string> | undefined
  /** Renders a wire error as the service's JSON error envelope. */
  readonly errorEnvelope: (error: ChatWireError) => Schema.Json
  /**
   * Status and answer for an unknown (or missing) model id: an `error` rendered with
   * `errorEnvelope`, or a `body` built from the requested id (for a service whose unknown-model
   * envelope differs from its other errors).
   */
  readonly unknownModel:
    | { readonly status: number; readonly error: ChatWireError }
    | { readonly status: number; readonly body: (model: string | undefined) => Schema.Json }
  /**
   * Requests authenticate with a non-empty `Authorization: Bearer` credential, never checked or
   * stored; anything else answers 401 with `unauthorized`.
   */
  readonly auth: { readonly unauthorized: ChatWireError }
  /** Request field carrying the output-token limit, recorded in the ledger. */
  readonly completionTokenField: 'max_tokens' | 'max_completion_tokens'
  /** Response id prefix; ids are `${prefix}-${seq}`. */
  readonly responseIdPrefix: string
  /** Default answer text deltas. */
  readonly defaultText: ReadonlyArray<string>
  /** The emulator's scripted-turn schema (decoded strictly). */
  readonly turnSchema: Schema.Decoder<Turn>
  /** Builds the error thrown by the JS API (`faults.add`, `script.enqueue`) for invalid input. */
  readonly inputInvalid: (input: 'fault' | 'turn', reason: string) => Error
  /** Per-service wire details; omitted: the plain OpenAI Chat Completions wire. */
  readonly wire?: ChatWireProfile
}

const ChatTool = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  function: Schema.Struct({
    name: Schema.String,
    description: Schema.optionalKey(Schema.String),
    parameters: Schema.optionalKey(Schema.Json)
  })
})

const ChatRequest = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  messages: Schema.Array(Schema.Json),
  stream: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  stream_options: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ include_usage: Schema.optionalKey(Schema.NullOr(Schema.Boolean)) })
    )
  ),
  reasoning_effort: Schema.optionalKey(Schema.NullOr(Schema.String)),
  thinking: Schema.optionalKey(Schema.Json),
  tools: Schema.optionalKey(Schema.NullOr(Schema.Array(ChatTool))),
  tool_choice: Schema.optionalKey(Schema.Json)
})

type ChatRequest = typeof ChatRequest.Type

const decodeChatRequest = Schema.decodeUnknownResult(ChatRequest)

// Synthetic creation time shared by every emulated response (deterministic output).
const syntheticCreated = 1790000000

// A non-empty bearer credential. The value is never checked or stored.
const bearerPattern = /^bearer\s+\S+/i

type CompletionPlan = {
  readonly reasoning: ReadonlyArray<string>
  readonly reasoningField: 'reasoning_content' | 'reasoning'
  readonly order: 'reasoning-first' | 'text-first'
  readonly text: ReadonlyArray<string>
  readonly toolCalls: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly fragments: ReadonlyArray<string>
  }>
  /** `null`: never send usage; `undefined`: synthesize when requested. */
  readonly usage: ChatScriptedUsage | null | undefined
  readonly finishReason: string
}

const defaultReasoning = ['The user wants a short reply.', ' Keep it brief.']

const reasoningRequested = (request: ChatRequest): boolean => {
  const effort = request.reasoning_effort?.trim().toLowerCase()

  return (
    (effort !== undefined && effort.length > 0 && effort !== 'none') ||
    stringField(request.thinking, 'type') === 'enabled'
  )
}

const chosenTool = (request: ChatRequest) => {
  const tools = request.tools ?? []

  if (tools.length === 0 || request.tool_choice === 'none') {
    return undefined
  }

  const forced = stringField(jsonField(request.tool_choice, 'function'), 'name')

  return tools.find(tool => tool.function.name === forced) ?? tools[0]
}

const defaultPlan = (
  request: ChatRequest,
  seq: number,
  reasoningModels: ReadonlyArray<string>,
  defaultText: ReadonlyArray<string>,
  reasoningField: CompletionPlan['reasoningField']
): CompletionPlan => {
  const reasoning =
    request.model !== undefined &&
    reasoningModels.includes(request.model) &&
    reasoningRequested(request)
      ? defaultReasoning
      : []

  const tool = chosenTool(request)

  const base: Pick<CompletionPlan, 'reasoning' | 'reasoningField' | 'order' | 'usage'> = {
    reasoning,
    reasoningField,
    order: 'reasoning-first',
    usage: undefined
  }

  if (tool === undefined) {
    return { ...base, text: defaultText, toolCalls: [], finishReason: 'stop' }
  }

  const argumentsText = JSON.stringify(
    synthesizeValue(tool.function.parameters ?? { type: 'object' }, tool.function.name, 0)
  )

  return {
    ...base,
    text: [],
    toolCalls: [
      {
        id: `call_synthetic_${seq}_0`,
        name: tool.function.name,
        fragments: splitFragments(argumentsText, 3)
      }
    ],
    finishReason: 'tool_calls'
  }
}

const scriptedPlan = (
  turn: ChatScriptedReasoningCompletion,
  seq: number,
  reasoningField: CompletionPlan['reasoningField']
): CompletionPlan => {
  const toolCalls = (turn.toolCalls ?? []).map((call, index) => ({
    id: call.id ?? `call_synthetic_${seq}_${index}`,
    name: call.name,
    fragments: call.argumentFragments
  }))

  return {
    reasoning: turn.reasoning ?? [],
    reasoningField: turn.reasoningField ?? reasoningField,
    order: turn.order ?? 'reasoning-first',
    text: turn.text ?? [],
    toolCalls,
    usage: turn.usage,
    finishReason: turn.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop')
  }
}

// Wire shapes of the OpenAI-compatible Chat Completions responses the emulator sends. Profile
// fields (`ChatWireProfile`) add to them.
type WireToolCallDelta = {
  readonly index: number
  readonly id?: string
  readonly type?: 'function'
  readonly function: { readonly name?: string; readonly arguments: string }
}

type WireReasoningDetail = {
  readonly type: 'reasoning.text'
  readonly text: string
  readonly format: 'unknown'
  readonly index: number
}

type WireDelta = {
  readonly role?: 'assistant'
  readonly content?: string
  readonly reasoning_content?: string
  readonly reasoning?: string
  readonly reasoning_details?: ReadonlyArray<WireReasoningDetail>
  readonly tool_calls?: ReadonlyArray<WireToolCallDelta>
}

type WireStreamChoice = {
  readonly index: number
  readonly delta: WireDelta | Schema.JsonObject
  readonly finish_reason: string | null
}

type WireMessage = {
  role: 'assistant'
  content: string | null
  reasoning_content?: string
  reasoning?: string
  tool_calls?: ReadonlyArray<{
    readonly id: string
    readonly type: 'function'
    readonly function: { readonly name: string; readonly arguments: string }
  }>
}

type WireCompletion = {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: ReadonlyArray<{
    readonly index: number
    readonly message: WireMessage
    readonly finish_reason: string
  }>
  usage?: Schema.JsonObject
}

/** A wire profile with every default filled in. */
type ResolvedWireProfile = {
  readonly eventsPerChunk: number
  readonly streamUsage: 'usage-chunk' | 'finish-event'
  readonly openingDelta: Schema.JsonObject
  readonly choiceFields: Schema.JsonObject
  readonly reasoningField: 'reasoning_content' | 'reasoning'
  readonly reasoningDetails: boolean
  readonly chunkFields: (identity: ChatResponseIdentity) => Schema.JsonObject
  readonly finishFields: (identity: ChatResponseIdentity) => {
    readonly chunk: Schema.JsonObject
    readonly delta: Schema.JsonObject
  }
  readonly usage: (counts: ChatUsageCounts) => Schema.JsonObject
}

/** The plain OpenAI Chat Completions usage object. */
const openAiUsage = (counts: ChatUsageCounts): Schema.JsonObject => {
  const usage = {
    prompt_tokens: counts.promptTokens,
    completion_tokens: counts.completionTokens,
    total_tokens: counts.promptTokens + counts.completionTokens
  }

  return counts.reasoningTokens === undefined
    ? usage
    : { ...usage, completion_tokens_details: { reasoning_tokens: counts.reasoningTokens } }
}

const noFields = (): Schema.JsonObject => ({})

const resolveWireProfile = (profile: ChatWireProfile = {}): ResolvedWireProfile => ({
  eventsPerChunk: profile.eventsPerChunk ?? 1,
  streamUsage: profile.streamUsage ?? 'usage-chunk',
  openingDelta: profile.openingDelta ?? { role: 'assistant', content: '' },
  choiceFields: profile.choiceFields ?? {},
  reasoningField: profile.reasoningField ?? 'reasoning_content',
  reasoningDetails: profile.reasoningDetails ?? false,
  chunkFields: profile.chunkFields ?? noFields,
  finishFields: profile.finishFields ?? (() => ({ chunk: {}, delta: {} })),
  usage: profile.usage ?? openAiUsage
})

const usageCounts = (plan: CompletionPlan, requestText: string): ChatUsageCounts | undefined => {
  if (plan.usage === null) {
    return undefined
  }

  if (plan.usage !== undefined) {
    return {
      promptTokens: plan.usage.promptTokens,
      completionTokens: plan.usage.completionTokens,
      reasoningTokens: plan.usage.reasoningTokens
    }
  }

  const reasoningText = plan.reasoning.join('')

  const outputText = [
    ...plan.text,
    ...plan.reasoning,
    ...plan.toolCalls.flatMap(call => call.fragments)
  ].join('')

  return {
    promptTokens: approximateTokens(requestText),
    completionTokens: approximateTokens(outputText),
    reasoningTokens: reasoningText.length > 0 ? approximateTokens(reasoningText) : undefined
  }
}

/** One SSE event from its `data:` text (a JSON payload, or `[DONE]`). */
const sseEvent = (data: string): string => `data: ${data}\n\n`

/**
 * Pack SSE events into network chunks of `perChunk` events, counting from the end: the last
 * chunk always holds the final events (the finish event and `data: [DONE]` when `perChunk` is at
 * least 2, as the live Gateway sends them), and the first chunk may hold fewer.
 */
const packEvents = (events: ReadonlyArray<string>, perChunk: number): ReadonlyArray<string> => {
  if (perChunk <= 1) {
    return events
  }

  const chunks: Array<string> = []
  const first = events.length % perChunk

  if (first > 0) {
    chunks.push(events.slice(0, first).join(''))
  }

  for (let index = first; index < events.length; index += perChunk) {
    chunks.push(events.slice(index, index + perChunk).join(''))
  }

  return chunks
}

const reasoningDelta = (
  field: CompletionPlan['reasoningField'],
  text: string,
  details: boolean
): WireDelta =>
  field === 'reasoning_content'
    ? { reasoning_content: text }
    : details
      ? {
          reasoning: text,
          reasoning_details: [{ type: 'reasoning.text', text, format: 'unknown', index: 0 }]
        }
      : { reasoning: text }

/** SSE events for a streamed completion, one per array entry (packed into chunks later). */
const streamEvents = (
  plan: CompletionPlan,
  identity: ChatResponseIdentity,
  usage: Schema.JsonObject | undefined,
  wire: ResolvedWireProfile
): ReadonlyArray<string> => {
  const events: Array<string> = []
  const extras = wire.chunkFields(identity)

  const event = (
    choices: ReadonlyArray<WireStreamChoice>,
    fields: Schema.JsonObject = {},
    trailing: Schema.JsonObject = {}
  ) =>
    events.push(
      sseEvent(
        JSON.stringify({
          id: identity.id,
          object: 'chat.completion.chunk',
          created: syntheticCreated,
          model: identity.model,
          choices,
          ...fields,
          ...extras,
          ...trailing
        })
      )
    )

  const choice = (
    delta: WireDelta | Schema.JsonObject,
    finishReason: string | null = null
  ): WireStreamChoice => ({
    index: 0,
    delta,
    ...wire.choiceFields,
    finish_reason: finishReason
  })

  const reasoningEvents = () => {
    for (const text of plan.reasoning) {
      event([choice(reasoningDelta(plan.reasoningField, text, wire.reasoningDetails))])
    }
  }

  const textEvents = () => {
    for (const text of plan.text) {
      event([choice({ content: text })])
    }
  }

  event([choice(wire.openingDelta)])

  if (plan.order === 'reasoning-first') {
    reasoningEvents()
    textEvents()
  } else {
    textEvents()
    reasoningEvents()
  }

  plan.toolCalls.forEach((call, index) => {
    event([
      choice({
        tool_calls: [
          { index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }
        ]
      })
    ])

    for (const fragment of call.fragments) {
      event([choice({ tool_calls: [{ index, function: { arguments: fragment } }] })])
    }
  })

  const finish = wire.finishFields(identity)
  const usageOnFinish = wire.streamUsage === 'finish-event' && usage !== undefined

  const finishFields: Record<string, Schema.Json> = {}

  if (usageOnFinish) {
    finishFields.usage = usage
  }

  event([choice({ ...finish.delta }, plan.finishReason)], finishFields, finish.chunk)

  if (!usageOnFinish && usage !== undefined) {
    event([], { usage })
  }

  events.push(sseEvent('[DONE]'))

  return events
}

/** The non-streamed `chat.completion` JSON body. */
const completionBody = (
  plan: CompletionPlan,
  identity: ChatResponseIdentity,
  usage: Schema.JsonObject | undefined
): WireCompletion => {
  const message: WireMessage = {
    role: 'assistant',
    content: plan.text.length > 0 ? plan.text.join('') : null
  }

  if (plan.reasoning.length > 0 && plan.reasoningField === 'reasoning') {
    message.reasoning = plan.reasoning.join('')
  } else if (plan.reasoning.length > 0) {
    message.reasoning_content = plan.reasoning.join('')
  }

  if (plan.toolCalls.length > 0) {
    message.tool_calls = plan.toolCalls.map(call => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.fragments.join('') }
    }))
  }

  const body: WireCompletion = {
    id: identity.id,
    object: 'chat.completion',
    created: syntheticCreated,
    model: identity.model,
    choices: [{ index: 0, message, finish_reason: plan.finishReason }]
  }

  if (usage !== undefined) {
    body.usage = usage
  }

  return body
}

type MutableLedgerEntry = KernelLedgerEntry<ChatFaultKind> & {
  body?: Schema.Json
  model?: string
  stream?: boolean
  maxCompletionTokens?: number
  reasoningEffort?: string
  thinking?: Schema.Json
  toolNames: ReadonlyArray<string>
  scripted?: 'completion' | 'error'
}

/**
 * Create a Chat Completions emulator from its config. Each call has
 * independent ledger, fault, and script state.
 *
 * Precedence per chat request: authentication and JSON validation, then the
 * first matching fault if it is a `status` fault, then the next scripted
 * turn, then model validation and defaults; a first matching chunk fault then
 * shapes the body. Only the first matching fault (in insertion order)
 * applies. Credential headers are never recorded, and the bearer value is
 * never checked or stored.
 */
export const makeChatCompletionsEmulator = <Turn extends ChatScriptedReasoningTurn>(
  config: ChatCompletionsEmulatorConfig<Turn>
): ChatCompletionsEmulator<Turn> => {
  const knownModels = [...config.knownModels]
  const reasoningModels = config.reasoningModels === undefined ? [] : [...config.reasoningModels]
  const wire = resolveWireProfile(config.wire)

  const unknownModelResponse = (model: string | undefined): Response =>
    'body' in config.unknownModel
      ? jsonResponse(config.unknownModel.status, config.unknownModel.body(model))
      : errorResponse(config.unknownModel.status, config.unknownModel.error)

  const errorResponse = (status: number, error: ChatWireError): Response =>
    jsonResponse(status, config.errorEnvelope(error))

  const defaultFaultBody = (status: number): Schema.Json =>
    status === 429
      ? config.errorEnvelope({
          message: 'Synthetic rate limit: too many requests.',
          type: 'rate_limit_exceeded',
          code: 'rate_limit_exceeded'
        })
      : config.errorEnvelope({
          message: `Synthetic upstream error (${status}).`,
          type: 'api_error',
          code: 'upstream_error'
        })

  const invalidRequest = (message: string, code: string): Response =>
    errorResponse(400, { message, type: 'invalid_request_error', code })

  const kernel = makeEmulatorKernel({
    routes: config.routes,
    faultSchema: ChatFault,
    turnSchema: config.turnSchema,
    newEntry: (base): MutableLedgerEntry => ({ ...base, toolNames: [] }),
    snapshotEntry: (entry): ChatLedgerEntry => ({ ...entry, toolNames: [...entry.toolNames] }),
    unknownRoute: () =>
      errorResponse(404, {
        message: 'Synthetic: no emulated route.',
        type: 'not_found_error',
        code: 'not_found'
      }),
    stateFields: () =>
      config.reasoningModels === undefined ? { knownModels } : { knownModels, reasoningModels },
    inputInvalid: config.inputInvalid
  })

  const authorized = (request: Request): boolean =>
    bearerPattern.test(request.headers.get('authorization') ?? '')

  const chatCompletion = async (
    request: Request,
    entry: MutableLedgerEntry,
    path: string
  ): Promise<Response> => {
    if (!authorized(request)) {
      entry.status = 401

      return errorResponse(401, config.auth.unauthorized)
    }

    const text = await readText(request)
    const json = text === undefined ? undefined : parseJson(text)

    if (text === undefined || json === undefined) {
      entry.status = 400

      return invalidRequest('Synthetic: the request body is not valid JSON.', 'invalid_json')
    }

    entry.body = json

    const decoded = decodeChatRequest(json)

    if (Result.isFailure(decoded)) {
      entry.status = 400

      return invalidRequest(
        'Synthetic: the request body is not a chat completion request.',
        'invalid_request'
      )
    }

    const chat = decoded.success
    const seq = entry.seq

    if (chat.model !== undefined) entry.model = chat.model

    entry.stream = chat.stream === true

    const tokenLimit = jsonField(json, config.completionTokenField)

    if (Predicate.isNumber(tokenLimit)) entry.maxCompletionTokens = tokenLimit

    entry.toolNames = (chat.tools ?? []).map(tool => tool.function.name)

    if (chat.reasoning_effort !== undefined && chat.reasoning_effort !== null) {
      entry.reasoningEffort = chat.reasoning_effort
    }

    if (chat.thinking !== undefined) entry.thinking = chat.thinking

    const fault = kernel.takeFault(path, chat.model)

    if (fault !== undefined && fault.fault.kind === 'status') {
      return kernel.respondWithStatusFault(entry, fault, fault.fault, defaultFaultBody)
    }

    // A scripted turn is used up when its request arrives. Header and status validation at
    // `script.enqueue` time means its response can always be built.
    const turn = kernel.nextTurn()

    if (turn !== undefined && 'error' in turn) {
      entry.scripted = 'error'

      return kernel.respondWithScriptedError(entry, turn.error, fault)
    }

    if (turn === undefined && (chat.model === undefined || !knownModels.includes(chat.model))) {
      entry.status = config.unknownModel.status

      return unknownModelResponse(chat.model)
    }

    if (turn !== undefined) entry.scripted = 'completion'

    const plan =
      turn === undefined
        ? defaultPlan(chat, seq, reasoningModels, config.defaultText, wire.reasoningField)
        : scriptedPlan(turn, seq, wire.reasoningField)

    const identity: ChatResponseIdentity = {
      id: `${config.responseIdPrefix}-${seq}`,
      model: chat.model ?? 'unknown'
    }

    const counts = usageCounts(plan, text)
    const usage = counts === undefined ? undefined : wire.usage(counts)

    if (chat.stream === true) {
      const streamUsage = chat.stream_options?.include_usage === true ? usage : undefined

      // Chunk faults count these network chunks (several events each when packed).
      return kernel.respondWithBody(
        entry,
        200,
        { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        packEvents(streamEvents(plan, identity, streamUsage, wire), wire.eventsPerChunk),
        fault
      )
    }

    return kernel.respondWithBody(
      entry,
      200,
      { 'content-type': 'application/json' },
      [JSON.stringify(completionBody(plan, identity, usage))],
      fault
    )
  }

  // Every manifest route maps to its own handler; construction throws `EmulatorRouteUnmapped`
  // when a manifest route has no handler (or a handler has no manifest route).
  return kernel.serve(new Map([[emulatorRouteKey('POST', config.path), chatCompletion]]))
}
