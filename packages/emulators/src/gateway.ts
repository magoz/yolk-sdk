/**
 * Vercel AI Gateway emulator: a plain fetch handler for the OpenAI-compatible
 * `POST /v1/chat/completions` endpoint, with scripted turns, wire faults, a
 * request ledger, and an `/_emulate/*` control plane.
 *
 * It never imports SDK code: its wire shapes follow the synthetic Gateway
 * conformance fixtures (`chat.completion.chunk` SSE, usage chunk,
 * `data: [DONE]`, and the `{ error: { message, type, code } }` envelope) and
 * are linked to those conformance case ids in `gatewayEmulatorRoutes`.
 *
 * Runtime-portable Web APIs only (`Request`, `Response`, `ReadableStream`,
 * `TextEncoder`, `URL`); no Effect runtime is required to use it.
 *
 * @experimental
 */
import { Data, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  bindRouteHandlers,
  emulatorEvidenceHeader,
  emulatorRouteKey,
  type EmulatorEvidence,
  type EmulatorRouteEvidence
} from './route-evidence.ts'

export type { EmulatorEvidence, EmulatorRouteEvidence } from './route-evidence.ts'

export { emulatorEvidenceHeader } from './route-evidence.ts'

export const gatewayChatCompletionsPath = '/v1/chat/completions'

/** Synthetic-safe default model ids, including the Gateway conformance defaults. */
export const gatewayEmulatorDefaultModels: ReadonlyArray<string> = [
  'openai/gpt-4.1-nano',
  'openai/gpt-4.1-mini',
  'deepseek/deepseek-v3.2'
]

/** Models that stream reasoning deltas when reasoning is requested. */
export const gatewayEmulatorDefaultReasoningModels: ReadonlyArray<string> = [
  'deepseek/deepseek-v3.2'
]

/**
 * Route evidence manifest: every emulated Gateway route and the conformance
 * cases whose (currently synthetic, unverified) wire shapes it follows.
 */
export const gatewayEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> = [
  {
    method: 'POST',
    path: gatewayChatCompletionsPath,
    kind: 'provider',
    write: false,
    caseIds: [
      'vercel-ai-gateway.stream.plain-text',
      'vercel-ai-gateway.stream.deepseek-reasoning',
      'vercel-ai-gateway.stream.tool-call-deltas',
      'vercel-ai-gateway.stream.error-envelope'
    ],
    evidence: 'unverified',
    observedAt: undefined
  }
]

/**
 * Statuses a fault or scripted error may answer with. Every emulated response
 * carries a body and emulators never redirect, so 1xx, 204, 205, and every
 * 3xx (including 304) are rejected when the fault or turn is added.
 */
const Status = Schema.Int.check(
  Schema.isBetween({ minimum: 200, maximum: 599 }),
  Schema.makeFilter((status: number) =>
    status >= 300 && status <= 399
      ? 'emulators never redirect: 3xx statuses are not allowed'
      : status === 204 || status === 205
        ? 'a 204 or 205 response cannot carry a body'
        : undefined
  )
)

const ChunkCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const FaultCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

// RFC 9110 token characters for header names.
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

// Visible ASCII, space, tab, and obs-text: what both web `Headers` and Node's HTTP server accept.
const headerValuePattern = /^[\t\x20-\x7e\x80-\xff]*$/

const framingHeaders: ReadonlySet<string> = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade'
])

const headerRecordProblem = (headers: Readonly<Record<string, string>>): string | undefined => {
  for (const [name, value] of Object.entries(headers)) {
    if (!headerNamePattern.test(name)) {
      return `header name ${JSON.stringify(name)} is not a valid HTTP token`
    }

    if (name.toLowerCase() === 'location') {
      return 'emulators never redirect: a location header is not allowed'
    }

    // The server frames the body itself; a hand-set framing header would corrupt the response.
    if (framingHeaders.has(name.toLowerCase())) {
      return `header ${name} is set by the server and cannot be scripted`
    }

    if (!headerValuePattern.test(value)) {
      return `header ${name} has a value with control or non-Latin-1 characters`
    }
  }

  return undefined
}

/** Response headers for a fault or scripted error: valid names and values, and no `location`. */
const HeaderRecord = Schema.Record(Schema.String, Schema.String).check(
  Schema.makeFilter(headerRecordProblem)
)

/** Optional fault filter; an omitted field matches every request. `path` ending in `*` is a prefix. */
export const GatewayFaultMatch = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String)
})

export type GatewayFaultMatch = typeof GatewayFaultMatch.Type

const faultFields = {
  match: Schema.optionalKey(GatewayFaultMatch),
  /** How many matching requests the fault answers. Omitted: every matching request. */
  count: Schema.optionalKey(FaultCount)
}

/**
 * Wire faults for emulated routes:
 *
 * - `status`: answer with this status, headers, and body instead of a
 *   completion (for example 429 with `retry-after`). The body defaults to a
 *   Gateway error envelope. Statuses that cannot carry a body (1xx, 204, 205,
 *   304) and redirects (3xx) are rejected, as are invalid header names or
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
export const GatewayFault = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('status'),
    status: Status,
    headers: Schema.optionalKey(HeaderRecord),
    body: Schema.optionalKey(Schema.Json),
    ...faultFields
  }),
  Schema.Struct({
    kind: Schema.Literal('error-after-chunks'),
    chunks: ChunkCount,
    ...faultFields
  }),
  Schema.Struct({
    kind: Schema.Literal('truncate-after-chunks'),
    chunks: ChunkCount,
    ...faultFields
  })
])

export type GatewayFault = typeof GatewayFault.Type

export type GatewayFaultKind = GatewayFault['kind']

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Usage for a scripted turn (sent as the wire `usage` object). */
export const GatewayScriptedUsage = Schema.Struct({
  promptTokens: TokenCount,
  completionTokens: TokenCount,
  reasoningTokens: Schema.optionalKey(TokenCount)
})

export type GatewayScriptedUsage = typeof GatewayScriptedUsage.Type

/** One scripted tool call; its JSON arguments stream as these fragments. */
export const GatewayScriptedToolCall = Schema.Struct({
  name: Schema.NonEmptyString,
  argumentFragments: Schema.Array(Schema.String),
  id: Schema.optionalKey(Schema.NonEmptyString)
})

export type GatewayScriptedToolCall = typeof GatewayScriptedToolCall.Type

/**
 * A scripted completion. Every field is exact (nothing is filled in) except:
 * `usage` omitted is synthesized when the request asks for usage, and `null`
 * drops it; `finishReason` omitted is `tool_calls` with tool calls, else
 * `stop`. `order` defaults to `reasoning-first`; `reasoningField` defaults to
 * `reasoning_content` (the Gateway-normalized alternative is `reasoning`).
 */
export const GatewayScriptedCompletion = Schema.Struct({
  text: Schema.optionalKey(Schema.Array(Schema.String)),
  reasoning: Schema.optionalKey(Schema.Array(Schema.String)),
  reasoningField: Schema.optionalKey(Schema.Literals(['reasoning_content', 'reasoning'])),
  order: Schema.optionalKey(Schema.Literals(['reasoning-first', 'text-first'])),
  toolCalls: Schema.optionalKey(Schema.Array(GatewayScriptedToolCall)),
  usage: Schema.optionalKey(Schema.NullOr(GatewayScriptedUsage)),
  finishReason: Schema.optionalKey(Schema.NonEmptyString)
})

export type GatewayScriptedCompletion = typeof GatewayScriptedCompletion.Type

/** A scripted error response: status, body (a string is sent as is), and optional headers. */
export const GatewayScriptedError = Schema.Struct({
  error: Schema.Struct({
    status: Status,
    body: Schema.Json,
    headers: Schema.optionalKey(HeaderRecord)
  })
})

export type GatewayScriptedError = typeof GatewayScriptedError.Type

/** A turn queued for the next chat completion request. */
export const GatewayScriptedTurn = Schema.Union([GatewayScriptedError, GatewayScriptedCompletion])

export type GatewayScriptedTurn = typeof GatewayScriptedTurn.Type

/** Thrown by the JS API (`faults.add`, `script.enqueue`) for invalid input; a programmer error. */
export class GatewayEmulatorInputInvalid extends Data.TaggedError('GatewayEmulatorInputInvalid')<{
  readonly input: 'fault' | 'turn'
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid Gateway emulator ${this.input}: ${this.reason}`
  }
}

export type GatewayLedgerEntry = {
  /** 1-based arrival order since the last ledger clear or reset. */
  readonly seq: number
  readonly method: string
  readonly path: string
  /** Parsed JSON request body, when it was valid JSON. */
  readonly body?: Schema.Json
  readonly model?: string
  readonly stream?: boolean
  readonly reasoningEffort?: string
  readonly thinking?: Schema.Json
  readonly toolNames: ReadonlyArray<string>
  /** Kind of the fault that shaped the response. */
  readonly fault?: GatewayFaultKind
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

export type GatewayFaultState = {
  readonly id: number
  readonly fault: GatewayFault
  /** Remaining matching requests; `undefined` for an unlimited fault. */
  readonly remaining: number | undefined
  readonly applied: number
}

export type GatewayRouteCoverage = EmulatorRouteEvidence & {
  /** Ledger requests answered by this route since the last ledger clear or reset. */
  readonly requests: number
}

export type GatewayCoverage = {
  readonly routes: ReadonlyArray<GatewayRouteCoverage>
  /** Ledger requests to unknown routes (failed closed). */
  readonly unknownRouteRequests: number
}

export type GatewayEmulatorOptions = {
  /** Model ids that exist. Defaults to `gatewayEmulatorDefaultModels`. */
  readonly knownModels?: ReadonlyArray<string>
  /** Model ids that stream reasoning. Defaults to `gatewayEmulatorDefaultReasoningModels`. */
  readonly reasoningModels?: ReadonlyArray<string>
}

export type GatewayEmulator = {
  /** The fetch handler (emulated API plus the `/_emulate/*` control plane). Never rejects. */
  readonly fetch: (request: Request) => Promise<Response>
  readonly ledger: {
    readonly entries: () => ReadonlyArray<GatewayLedgerEntry>
    readonly clear: () => void
  }
  /** Clear the ledger, faults, and scripted turns. */
  readonly reset: () => void
  readonly faults: {
    /** Add a fault; throws `GatewayEmulatorInputInvalid` for an invalid fault. */
    readonly add: (fault: GatewayFault) => GatewayFaultState
    readonly list: () => ReadonlyArray<GatewayFaultState>
    readonly clear: () => void
  }
  readonly script: {
    /** Queue a turn for the next chat completion request; throws `GatewayEmulatorInputInvalid`. */
    readonly enqueue: (turn: GatewayScriptedTurn) => void
    readonly pending: () => number
    readonly clear: () => void
  }
  readonly coverage: () => GatewayCoverage
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

const decodeJsonText = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))

const decodeChatRequest = Schema.decodeUnknownResult(ChatRequest)

// Control inputs are strict: an unknown key (a typo, or an `error` turn with a bad field) is
// rejected instead of silently decoding as a different, all-optional shape.
const strict = { onExcessProperty: 'error' } as const

const decodeFault = Schema.decodeUnknownResult(GatewayFault, strict)

const decodeTurn = Schema.decodeUnknownResult(GatewayScriptedTurn, strict)

const decodeFaultList = Schema.decodeUnknownResult(
  Schema.Union([GatewayFault, Schema.Struct({ faults: Schema.Array(GatewayFault) })]),
  strict
)

const decodeTurnList = Schema.decodeUnknownResult(
  Schema.Union([Schema.Struct({ turns: Schema.Array(GatewayScriptedTurn) }), GatewayScriptedTurn]),
  strict
)

const issueMessage = (issue: Schema.SchemaError['issue']): string =>
  new Schema.SchemaError(issue).message

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  value !== null && value !== undefined && Predicate.isObject(value) && !Array.isArray(value)

const jsonField = (value: Schema.Json | undefined, key: string): Schema.Json | undefined =>
  isJsonObject(value) ? value[key] : undefined

const stringField = (value: Schema.Json | undefined, key: string): string | undefined => {
  const field = jsonField(value, key)

  return Predicate.isString(field) ? field : undefined
}

// Synthetic creation time shared by every emulated response (deterministic output).
const syntheticCreated = 1790000000

const textEncoder = new TextEncoder()

// `body` is any JSON-serializable value (ledger snapshots, fault states, envelopes).
const jsonResponse = (status: number, body: unknown, headers: HeadersInit = {}): Response => {
  const responseHeaders = new Headers(headers)

  responseHeaders.set('content-type', 'application/json')

  return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

const errorEnvelope = (message: string, type: string, code: string): Schema.Json => ({
  error: { message, type, code }
})

const defaultFaultBody = (status: number): Schema.Json =>
  status === 429
    ? errorEnvelope(
        'Synthetic rate limit: too many requests.',
        'rate_limit_exceeded',
        'rate_limit_exceeded'
      )
    : errorEnvelope(`Synthetic upstream error (${status}).`, 'api_error', 'upstream_error')

// Copied data shape of the synthetic Gateway error-envelope fixture (unknown model id).
const modelNotFound = (): Response =>
  jsonResponse(
    400,
    errorEnvelope(
      'Synthetic placeholder: the requested model is not available.',
      'invalid_request_error',
      'model_not_found'
    )
  )

const unauthorized = (): Response =>
  jsonResponse(
    401,
    errorEnvelope(
      'Synthetic: missing or invalid authorization.',
      'authentication_error',
      'unauthorized'
    )
  )

const invalidRequest = (message: string, code: string): Response =>
  jsonResponse(400, errorEnvelope(message, 'invalid_request_error', code))

const unknownRoute = (): Response =>
  jsonResponse(404, errorEnvelope('Synthetic: no emulated route.', 'not_found_error', 'not_found'))

const controlError = (status: number, message: string, headers: HeadersInit = {}): Response =>
  jsonResponse(status, { error: { message, type: 'emulator_error' } }, headers)

const bodyText = (body: Schema.Json): string =>
  Predicate.isString(body) ? body : JSON.stringify(body)

// A non-empty bearer credential. The value is never checked or stored.
const bearerPattern = /^bearer\s+\S+/i

const pathMatches = (pattern: string, path: string): boolean =>
  pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path

const faultMatches = (fault: GatewayFault, path: string, model: string | undefined): boolean =>
  (fault.match?.path === undefined || pathMatches(fault.match.path, path)) &&
  (fault.match?.model === undefined || fault.match.model === model)

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
  readonly usage: GatewayScriptedUsage | null | undefined
  readonly finishReason: string
}

const defaultText = ['Hello', ' from the', ' synthetic gateway.']

const defaultReasoning = ['The user wants a short reply.', ' Keep it brief.']

const maxSchemaDepth = 8

/**
 * A synthetic value for a JSON Schema: required object properties only,
 * non-empty strings (or the first `enum` / `const` value), the minimum for
 * numbers, `true` for booleans, and `minItems` synthetic items for arrays.
 */
const synthesizeValue = (
  schema: Schema.Json | undefined,
  name: string,
  depth: number
): Schema.Json => {
  const constant = jsonField(schema, 'const')

  if (constant !== undefined) {
    return constant
  }

  const choices = jsonField(schema, 'enum')

  if (Array.isArray(choices) && choices.length > 0) {
    return choices[0] ?? null
  }

  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const options = jsonField(schema, key)

    if (Array.isArray(options) && options.length > 0) {
      const preferred = options.find(option => stringField(option, 'type') !== 'null')

      return synthesizeValue(preferred ?? options[0], name, depth + 1)
    }
  }

  const declared = jsonField(schema, 'type')

  const type = Array.isArray(declared)
    ? declared.find(entry => Predicate.isString(entry) && entry !== 'null')
    : declared

  if (depth > maxSchemaDepth) {
    return null
  }

  switch (type) {
    case 'object': {
      const properties = jsonField(schema, 'properties')
      const required = jsonField(schema, 'required')
      const value: Record<string, Schema.Json> = {}

      for (const key of Array.isArray(required) ? required : []) {
        if (Predicate.isString(key)) {
          value[key] = synthesizeValue(jsonField(properties, key), key, depth + 1)
        }
      }

      return value
    }

    case 'array': {
      const minItems = jsonField(schema, 'minItems')
      const count = Predicate.isNumber(minItems) && minItems > 0 ? Math.min(minItems, 3) : 0

      return Array.from({ length: count }, () =>
        synthesizeValue(jsonField(schema, 'items'), name, depth + 1)
      )
    }

    case 'integer':
    case 'number': {
      const minimum = jsonField(schema, 'minimum')

      return Predicate.isNumber(minimum) ? minimum : 1
    }

    case 'boolean':
      return true
    case 'null':
      return null
    default:
      return `synthetic ${name}`
  }
}

/** Split text into up to `parts` non-empty fragments (at least one). */
const splitFragments = (text: string, parts: number): ReadonlyArray<string> => {
  if (text.length <= 1) {
    return [text]
  }

  const size = Math.ceil(text.length / Math.min(parts, text.length))
  const fragments: Array<string> = []

  for (let index = 0; index < text.length; index += size) {
    fragments.push(text.slice(index, index + size))
  }

  return fragments
}

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
  reasoningModels: ReadonlyArray<string>
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
    reasoningField: 'reasoning_content',
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

const scriptedPlan = (turn: GatewayScriptedCompletion, seq: number): CompletionPlan => {
  const toolCalls = (turn.toolCalls ?? []).map((call, index) => ({
    id: call.id ?? `call_synthetic_${seq}_${index}`,
    name: call.name,
    fragments: call.argumentFragments
  }))

  return {
    reasoning: turn.reasoning ?? [],
    reasoningField: turn.reasoningField ?? 'reasoning_content',
    order: turn.order ?? 'reasoning-first',
    text: turn.text ?? [],
    toolCalls,
    usage: turn.usage,
    finishReason: turn.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop')
  }
}

const approximateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4))

// Wire shapes of the OpenAI-compatible Chat Completions responses the emulator sends.
type WireUsage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  completion_tokens_details?: { readonly reasoning_tokens: number }
}

type WireToolCallDelta = {
  readonly index: number
  readonly id?: string
  readonly type?: 'function'
  readonly function: { readonly name?: string; readonly arguments: string }
}

type WireDelta = {
  readonly role?: 'assistant'
  readonly content?: string
  readonly reasoning_content?: string
  readonly reasoning?: string
  readonly tool_calls?: ReadonlyArray<WireToolCallDelta>
}

type WireStreamChoice = {
  readonly index: number
  readonly delta: WireDelta
  readonly finish_reason: string | null
}

type WireChunk = {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: ReadonlyArray<WireStreamChoice>
  usage?: WireUsage
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
  usage?: WireUsage
}

const wireUsage = (plan: CompletionPlan, requestText: string): WireUsage | undefined => {
  if (plan.usage === null) {
    return undefined
  }

  const reasoningText = plan.reasoning.join('')

  const outputText = [
    ...plan.text,
    ...plan.reasoning,
    ...plan.toolCalls.flatMap(call => call.fragments)
  ].join('')

  const usage = plan.usage ?? {
    promptTokens: approximateTokens(requestText),
    completionTokens: approximateTokens(outputText),
    reasoningTokens: reasoningText.length > 0 ? approximateTokens(reasoningText) : undefined
  }

  const wire: WireUsage = {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.promptTokens + usage.completionTokens
  }

  if (usage.reasoningTokens !== undefined) {
    wire.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens }
  }

  return wire
}

type ResponseIdentity = { readonly id: string; readonly model: string }

const sseEvent = (payload: WireChunk | '[DONE]'): string =>
  `data: ${payload === '[DONE]' ? payload : JSON.stringify(payload)}\n\n`

const chunkPayload = (
  identity: ResponseIdentity,
  choices: ReadonlyArray<WireStreamChoice>,
  usage: WireUsage | undefined
): WireChunk => {
  const payload: WireChunk = {
    id: identity.id,
    object: 'chat.completion.chunk',
    created: syntheticCreated,
    model: identity.model,
    choices
  }

  if (usage !== undefined) {
    payload.usage = usage
  }

  return payload
}

const deltaChoice = (delta: WireDelta, finishReason: string | null = null): WireStreamChoice => ({
  index: 0,
  delta,
  finish_reason: finishReason
})

const reasoningDelta = (field: CompletionPlan['reasoningField'], text: string): WireDelta =>
  field === 'reasoning' ? { reasoning: text } : { reasoning_content: text }

/** SSE events for a streamed completion, one network chunk each. */
const streamEvents = (
  plan: CompletionPlan,
  identity: ResponseIdentity,
  usage: WireUsage | undefined
): ReadonlyArray<string> => {
  const events: Array<string> = []

  const event = (choices: ReadonlyArray<WireStreamChoice>, eventUsage?: WireUsage) =>
    events.push(sseEvent(chunkPayload(identity, choices, eventUsage)))

  const reasoningEvents = () => {
    for (const text of plan.reasoning) {
      event([deltaChoice(reasoningDelta(plan.reasoningField, text))])
    }
  }

  const textEvents = () => {
    for (const text of plan.text) {
      event([deltaChoice({ content: text })])
    }
  }

  event([deltaChoice({ role: 'assistant', content: '' })])

  if (plan.order === 'reasoning-first') {
    reasoningEvents()
    textEvents()
  } else {
    textEvents()
    reasoningEvents()
  }

  plan.toolCalls.forEach((call, index) => {
    event([
      deltaChoice({
        tool_calls: [
          { index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }
        ]
      })
    ])

    for (const fragment of call.fragments) {
      event([deltaChoice({ tool_calls: [{ index, function: { arguments: fragment } }] })])
    }
  })

  event([deltaChoice({}, plan.finishReason)])

  if (usage !== undefined) {
    event([], usage)
  }

  events.push(sseEvent('[DONE]'))

  return events
}

/** The non-streamed `chat.completion` JSON body. */
const completionBody = (
  plan: CompletionPlan,
  identity: ResponseIdentity,
  usage: WireUsage | undefined
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

type MutableLedgerEntry = {
  seq: number
  method: string
  path: string
  body?: Schema.Json
  model?: string
  stream?: boolean
  reasoningEffort?: string
  thinking?: Schema.Json
  toolNames: ReadonlyArray<string>
  fault?: GatewayFaultKind
  faultError?: string
  responseError?: string
  scripted?: 'completion' | 'error'
  evidence: EmulatorEvidence | 'unknown-route'
  status: number
  bodyChunks: number
}

type MutableFaultState = {
  readonly id: number
  readonly fault: GatewayFault
  remaining: number | undefined
  applied: number
}

type ChunkFault = Exclude<GatewayFault, { readonly kind: 'status' }>

const chunkFaultProblem = (fault: ChunkFault, chunks: number): string | undefined => {
  const applies =
    fault.kind === 'error-after-chunks' ? fault.chunks <= chunks : fault.chunks < chunks

  return applies
    ? undefined
    : `${fault.kind} after ${fault.chunks} chunk(s) cannot apply to a response with ${chunks} chunk(s)`
}

/**
 * Strictly pull-driven body: chunk `k` is produced only when the consumer
 * pulls it, and `entry.bodyChunks` counts the chunks handed over. The fault
 * (already validated against the chunk count) applies when the consumer pulls
 * past `fault.chunks` chunks.
 */
const chunkedBody = (
  chunks: ReadonlyArray<string>,
  fault: ChunkFault | undefined,
  entry: MutableLedgerEntry
): ReadableStream<Uint8Array> => {
  let next = 0

  return new ReadableStream<Uint8Array>(
    {
      pull: controller => {
        if (fault !== undefined && next === fault.chunks) {
          if (fault.kind === 'error-after-chunks') {
            controller.error(new Error(`synthetic mid-stream failure after ${next} chunk(s)`))
          } else {
            controller.close()
          }

          return
        }

        const chunk = chunks[next]

        if (chunk === undefined) {
          controller.close()

          return
        }

        next += 1
        entry.bodyChunks += 1
        controller.enqueue(textEncoder.encode(chunk))
      }
    },
    { highWaterMark: 0 }
  )
}

const withEvidence = (response: Response, evidence: EmulatorEvidence): Response => {
  if (evidence === 'unverified') {
    response.headers.set(emulatorEvidenceHeader, 'unverified')
  }

  return response
}

const readText = (request: Request): Promise<string | undefined> =>
  request.text().then(
    text => text,
    () => undefined
  )

const parseJson = (text: string): Schema.Json | undefined => {
  const result = decodeJsonText(text)

  return Result.isSuccess(result) ? result.success : undefined
}

/**
 * Create a Vercel AI Gateway emulator. Each call has independent ledger,
 * fault, and script state.
 *
 * Without a script, `POST /v1/chat/completions` answers a known model with
 * synthetic text deltas (`stream: true`: `chat.completion.chunk` SSE, a finish
 * chunk, a usage chunk when `stream_options.include_usage` is set, and
 * `data: [DONE]`; `stream: false`: one `chat.completion` JSON body). Reasoning
 * models asked for reasoning (`reasoning_effort`, or `thinking.type:
 * 'enabled'`) stream `delta.reasoning_content` before the text. A request with
 * `tools` gets one tool call whose arguments are synthesized from the tool's
 * JSON Schema and streamed in fragments, finishing with `tool_calls`. Unknown
 * models get the Gateway error envelope (400, `model_not_found`); a missing
 * bearer credential gets a 401 envelope; unknown routes get a 404 JSON error.
 *
 * Precedence per chat request: authentication and JSON validation, then the
 * first matching fault if it is a `status` fault, then the next scripted
 * turn, then model validation and defaults; a first matching chunk fault then
 * shapes the body. Only the first matching fault (in insertion order) applies. Credential headers are never
 * recorded, and the bearer value is never checked or stored.
 */
export const makeGatewayEmulator = (options: GatewayEmulatorOptions = {}): GatewayEmulator => {
  const knownModels = [...(options.knownModels ?? gatewayEmulatorDefaultModels)]
  const reasoningModels = [...(options.reasoningModels ?? gatewayEmulatorDefaultReasoningModels)]

  let entries: Array<MutableLedgerEntry> = []
  let faultStates: Array<MutableFaultState> = []
  let turns: Array<GatewayScriptedTurn> = []
  let nextSeq = 1
  let nextFaultId = 1

  const snapshotEntry = (entry: MutableLedgerEntry): GatewayLedgerEntry => ({
    ...entry,
    toolNames: [...entry.toolNames]
  })

  const snapshotFault = (state: MutableFaultState): GatewayFaultState => ({ ...state })

  const clearLedger = () => {
    entries = []
    nextSeq = 1
  }

  const addFault = (input: unknown): GatewayFaultState | string => {
    const decoded = decodeFault(input)

    if (Result.isFailure(decoded)) {
      return issueMessage(decoded.failure.issue)
    }

    const state: MutableFaultState = {
      id: nextFaultId++,
      fault: decoded.success,
      remaining: decoded.success.count,
      applied: 0
    }

    faultStates.push(state)

    return snapshotFault(state)
  }

  const enqueueTurn = (input: unknown): string | undefined => {
    const decoded = decodeTurn(input)

    if (Result.isFailure(decoded)) {
      return issueMessage(decoded.failure.issue)
    }

    turns.push(decoded.success)

    return undefined
  }

  const takeFault = (path: string, model: string | undefined): MutableFaultState | undefined =>
    faultStates.find(
      state =>
        (state.remaining === undefined || state.remaining > 0) &&
        faultMatches(state.fault, path, model)
    )

  const consumeFault = (state: MutableFaultState) => {
    state.applied += 1

    if (state.remaining !== undefined) {
      state.remaining -= 1
    }
  }

  const coverage = (): GatewayCoverage => ({
    routes: gatewayEmulatorRoutes.map(route => ({
      ...route,
      requests: entries.filter(
        entry =>
          entry.evidence !== 'unknown-route' &&
          entry.method === route.method &&
          entry.path === route.path
      ).length
    })),
    unknownRouteRequests: entries.filter(entry => entry.evidence === 'unknown-route').length
  })

  const respondWithBody = (
    entry: MutableLedgerEntry,
    status: number,
    headers: HeadersInit,
    chunks: ReadonlyArray<string>,
    fault: MutableFaultState | undefined
  ): Response => {
    const chunkFault =
      fault === undefined || fault.fault.kind === 'status' ? undefined : fault.fault

    if (chunkFault !== undefined) {
      const problem = chunkFaultProblem(chunkFault, chunks.length)

      if (problem !== undefined) {
        entry.faultError = problem
        entry.status = 500

        return controlError(500, `emulator fault cannot apply: ${problem}`)
      }
    }

    // Build the response before using up the fault: a response that cannot be built must not
    // consume it.
    const response = new Response(chunkedBody(chunks, chunkFault, entry), { status, headers })

    if (chunkFault !== undefined && fault !== undefined) {
      consumeFault(fault)
      entry.fault = chunkFault.kind
    }

    entry.status = response.status

    return response
  }

  const chatCompletion = async (
    request: Request,
    entry: MutableLedgerEntry,
    path: string
  ): Promise<Response> => {
    if (!bearerPattern.test(request.headers.get('authorization') ?? '')) {
      entry.status = 401

      return unauthorized()
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
    entry.toolNames = (chat.tools ?? []).map(tool => tool.function.name)

    if (chat.reasoning_effort !== undefined && chat.reasoning_effort !== null) {
      entry.reasoningEffort = chat.reasoning_effort
    }

    if (chat.thinking !== undefined) entry.thinking = chat.thinking

    const fault = takeFault(path, chat.model)

    if (fault !== undefined && fault.fault.kind === 'status') {
      const headers = new Headers(fault.fault.headers ?? {})
      const faultBody = fault.fault.body ?? defaultFaultBody(fault.fault.status)

      if (!headers.has('content-type')) {
        headers.set(
          'content-type',
          Predicate.isString(faultBody) ? 'text/plain' : 'application/json'
        )
      }

      // Built first: a status fault whose response cannot be built is not used up.
      const response = new Response(bodyText(faultBody), { status: fault.fault.status, headers })

      consumeFault(fault)
      entry.fault = 'status'
      entry.status = response.status

      return response
    }

    // A scripted turn is used up when its request arrives. Header and status validation at
    // `script.enqueue` time means its response can always be built.
    const turn = turns.shift()

    if (turn !== undefined && 'error' in turn) {
      entry.scripted = 'error'

      const headers = new Headers(turn.error.headers ?? {})

      if (!headers.has('content-type')) {
        headers.set(
          'content-type',
          Predicate.isString(turn.error.body) ? 'text/plain' : 'application/json'
        )
      }

      return respondWithBody(entry, turn.error.status, headers, [bodyText(turn.error.body)], fault)
    }

    if (turn === undefined && (chat.model === undefined || !knownModels.includes(chat.model))) {
      entry.status = 400

      return modelNotFound()
    }

    if (turn !== undefined) entry.scripted = 'completion'

    const plan =
      turn === undefined ? defaultPlan(chat, seq, reasoningModels) : scriptedPlan(turn, seq)

    const identity = { id: `gen-synthetic-${seq}`, model: chat.model ?? 'unknown' }

    if (chat.stream === true) {
      const usage = chat.stream_options?.include_usage === true ? wireUsage(plan, text) : undefined

      return respondWithBody(
        entry,
        200,
        { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        streamEvents(plan, identity, usage),
        fault
      )
    }

    return respondWithBody(
      entry,
      200,
      { 'content-type': 'application/json' },
      [JSON.stringify(completionBody(plan, identity, wireUsage(plan, text)))],
      fault
    )
  }

  // Every manifest route maps to its own handler; construction throws `EmulatorRouteUnmapped`
  // when a manifest route has no handler (or a handler has no manifest route).
  const routes = bindRouteHandlers(
    gatewayEmulatorRoutes,
    new Map([[emulatorRouteKey('POST', gatewayChatCompletionsPath), chatCompletion]])
  )

  const emulatedApi = async (request: Request, path: string): Promise<Response> => {
    const bound = routes.find(
      candidate => candidate.route.method === request.method && candidate.route.path === path
    )

    const entry: MutableLedgerEntry = {
      seq: nextSeq++,
      method: request.method,
      path,
      toolNames: [],
      evidence: bound?.route.evidence ?? 'unknown-route',
      status: 0,
      bodyChunks: 0
    }

    entries.push(entry)

    if (bound === undefined) {
      entry.status = 404

      return unknownRoute()
    }

    // Error recovery still answers through the route: the fallback 500 is evidence-tagged and
    // the ledger records the status actually sent.
    const response = await bound.handler(request, entry, path).catch(() => {
      entry.status = 500
      entry.responseError = 'the emulator could not build the planned response'

      return controlError(500, 'emulator could not build the response')
    })

    return withEvidence(response, bound.route.evidence)
  }

  const controlPlane = async (request: Request, path: string): Promise<Response> => {
    const method = request.method
    const allow = (methods: string) => controlError(405, 'method not allowed', { allow: methods })

    const jsonBody = async (): Promise<Schema.Json | undefined> => {
      const text = await readText(request)

      return text === undefined ? undefined : parseJson(text)
    }

    switch (path) {
      case '/_emulate/ledger':
        if (method === 'GET') {
          return jsonResponse(200, { entries: entries.map(snapshotEntry) })
        }

        if (method === 'DELETE') {
          const cleared = entries.length

          clearLedger()

          return jsonResponse(200, { cleared })
        }

        return allow('GET, DELETE')

      case '/_emulate/faults': {
        if (method === 'GET') {
          return jsonResponse(200, { faults: faultStates.map(snapshotFault) })
        }

        if (method === 'DELETE') {
          const cleared = faultStates.length

          faultStates = []

          return jsonResponse(200, { cleared })
        }

        if (method !== 'POST') {
          return allow('GET, POST, DELETE')
        }

        const decoded = decodeFaultList(await jsonBody())

        if (Result.isFailure(decoded)) {
          return controlError(400, `invalid fault: ${issueMessage(decoded.failure.issue)}`)
        }

        const added = (
          'faults' in decoded.success ? decoded.success.faults : [decoded.success]
        ).map(fault => addFault(fault))

        return jsonResponse(201, { faults: added })
      }

      case '/_emulate/script': {
        if (method !== 'POST') {
          return allow('POST')
        }

        const decoded = decodeTurnList(await jsonBody())

        if (Result.isFailure(decoded)) {
          return controlError(400, `invalid turn: ${issueMessage(decoded.failure.issue)}`)
        }

        const queued = 'turns' in decoded.success ? decoded.success.turns : [decoded.success]

        for (const turn of queued) {
          enqueueTurn(turn)
        }

        return jsonResponse(201, { pending: turns.length })
      }

      case '/_emulate/reset':
        if (method !== 'POST') {
          return allow('POST')
        }

        reset()

        return jsonResponse(200, { reset: true })

      case '/_emulate/state':
        if (method !== 'GET') {
          return allow('GET')
        }

        return jsonResponse(200, {
          knownModels,
          reasoningModels,
          pendingTurns: turns.length,
          faults: faultStates.map(snapshotFault),
          ledgerEntries: entries.length
        })

      case '/_emulate/coverage':
        if (method !== 'GET') {
          return allow('GET')
        }

        return jsonResponse(200, coverage())

      default:
        return controlError(404, 'unknown control-plane route')
    }
  }

  const reset = () => {
    clearLedger()
    faultStates = []
    turns = []
  }

  const handle = (request: Request): Promise<Response> => {
    const path = URL.canParse(request.url) ? new URL(request.url).pathname : '/'

    return path === '/_emulate' || path.startsWith('/_emulate/')
      ? controlPlane(request, path)
      : emulatedApi(request, path)
  }

  return {
    fetch: request =>
      handle(request).catch(() => controlError(500, 'emulator failed to handle the request')),
    ledger: {
      entries: () => entries.map(snapshotEntry),
      clear: clearLedger
    },
    reset,
    faults: {
      add: fault => {
        const added = addFault(fault)

        if (Predicate.isString(added)) {
          throw new GatewayEmulatorInputInvalid({ input: 'fault', reason: added })
        }

        return added
      },
      list: () => faultStates.map(snapshotFault),
      clear: () => {
        faultStates = []
      }
    },
    script: {
      enqueue: turn => {
        const problem = enqueueTurn(turn)

        if (problem !== undefined) {
          throw new GatewayEmulatorInputInvalid({ input: 'turn', reason: problem })
        }
      },
      pending: () => turns.length,
      clear: () => {
        turns = []
      }
    },
    coverage
  }
}
