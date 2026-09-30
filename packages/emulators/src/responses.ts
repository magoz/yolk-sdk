/**
 * OpenAI Responses emulator core (internal; not a package export).
 *
 * One `POST .../responses` route with request parsing (`model`, `input`, `instructions`, `tools`,
 * `tool_choice`, `reasoning`, `stream`, `store`, `max_output_tokens`), Responses SSE with typed
 * `event:` names in the order the API sends them, the non-streamed `response` JSON body, scripted
 * turns, and a JSON error envelope chosen by each subpath. Faults, the request ledger, the
 * `/_emulate/*` control plane, evidence tagging, and route binding come from the shared kernel
 * (`emulator-kernel.ts`).
 *
 * Streamed responses: `response.created` and `response.in_progress`, then per output item
 * `response.output_item.added`, its parts and deltas, and `response.output_item.done`, then
 * `response.completed` with the full `response` (output items and usage). Output items:
 * `reasoning` (one summary part: `response.reasoning_summary_part.added`,
 * `response.reasoning_summary_text.delta` / `.done`, `response.reasoning_summary_part.done`) when
 * the request asks for a reasoning summary, `message` (`response.content_part.added`,
 * `response.output_text.delta` / `.done`, `response.content_part.done`), and `function_call`
 * (`response.function_call_arguments.delta` / `.done`). Every event carries a `sequence_number`.
 *
 * Each subpath supplies its path and manifest, model list, error envelope and unknown-model
 * status, the 401 error for a missing bearer credential, extra header rules (required headers
 * with their status and error, and which non-credential header values the ledger records),
 * whether `max_output_tokens` is accepted, and its input-invalid error. Bearer values are never
 * checked or stored.
 *
 * Runtime-portable Web APIs only (`Request`, `Response`, `ReadableStream`, `TextEncoder`, `URL`);
 * no Node builtins and no SDK imports.
 */
import { Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import {
  approximateTokens,
  ChunkCount,
  controlError,
  EmulatorErrorAfterChunksFault,
  emulatorFaultFields,
  EmulatorScriptedError,
  EmulatorStatusFault,
  EmulatorTruncateAfterChunksFault,
  isJsonObject,
  jsonField,
  jsonResponse,
  makeEmulatorKernel,
  parseJson,
  readText,
  splitFragments,
  stringField,
  synthesizeValue,
  type EmulatorApi,
  type KernelLedgerEntry
} from './emulator-kernel.ts'
import {
  emulatorRouteKey,
  type EmulatorEvidence,
  type EmulatorRouteEvidence
} from './route-evidence.ts'

/** A mid-stream Responses error: a machine `code` and a message. */
export const ResponsesStreamError = Schema.Struct({
  code: Schema.NonEmptyString,
  message: Schema.String
})

export type ResponsesStreamError = typeof ResponsesStreamError.Type

/**
 * Send `chunks` SSE events, then one error event and close without `response.completed`:
 * `event: 'error'` (the default) sends `{ type: 'error', code, message }`, and
 * `event: 'response.failed'` sends a `response.failed` event whose `response.error` carries the
 * code and message. The error defaults to `server_error`. Streamed responses only; it must come
 * before `response.completed`.
 */
export const ResponsesErrorEventFault = Schema.Struct({
  kind: Schema.Literal('error-event-after-chunks'),
  chunks: ChunkCount,
  event: Schema.optionalKey(Schema.Literals(['error', 'response.failed'])),
  error: Schema.optionalKey(ResponsesStreamError),
  ...emulatorFaultFields
})

/**
 * Wire faults: `status` (the body defaults to the subpath's error envelope for the status),
 * `error-after-chunks` (a dropped connection), `truncate-after-chunks` (a clean close, for example
 * before `response.completed`), and `error-event-after-chunks` (a mid-stream `error` or
 * `response.failed` event).
 */
export const ResponsesFault = Schema.Union([
  EmulatorStatusFault,
  EmulatorErrorAfterChunksFault,
  EmulatorTruncateAfterChunksFault,
  ResponsesErrorEventFault
])

export type ResponsesFault = typeof ResponsesFault.Type

export type ResponsesFaultKind = ResponsesFault['kind']

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Usage for a scripted turn (sent in `response.completed` or the JSON body). */
export const ResponsesScriptedUsage = Schema.Struct({
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  reasoningTokens: Schema.optionalKey(TokenCount)
})

export type ResponsesScriptedUsage = typeof ResponsesScriptedUsage.Type

/** One scripted `function_call` item; its arguments stream as these fragments. */
export const ResponsesScriptedFunctionCall = Schema.Struct({
  name: Schema.NonEmptyString,
  argumentFragments: Schema.Array(Schema.String),
  callId: Schema.optionalKey(Schema.NonEmptyString)
})

export type ResponsesScriptedFunctionCall = typeof ResponsesScriptedFunctionCall.Type

/**
 * A scripted response. Every field is exact (nothing is filled in) except: an item is sent only
 * when its field is present (`reasoning` is one summary part, `text` one message); `usage`
 * omitted is synthesized and `null` drops `usage` from the wire; `order` defaults to
 * `reasoning-first` (`text-first` sends the reasoning item after the message); `format` defaults
 * to the request's `stream` (`sse` streams even for `stream: false`, `json` answers one JSON body
 * even for `stream: true`, as the JSON fallback some endpoints use).
 */
export const ResponsesScriptedResponse = Schema.Struct({
  reasoning: Schema.optionalKey(Schema.Array(Schema.String)),
  text: Schema.optionalKey(Schema.Array(Schema.String)),
  functionCalls: Schema.optionalKey(Schema.Array(ResponsesScriptedFunctionCall)),
  order: Schema.optionalKey(Schema.Literals(['reasoning-first', 'text-first'])),
  usage: Schema.optionalKey(Schema.NullOr(ResponsesScriptedUsage)),
  format: Schema.optionalKey(Schema.Literals(['sse', 'json']))
})

export type ResponsesScriptedResponse = typeof ResponsesScriptedResponse.Type

/** A turn queued for the next Responses request. */
export const ResponsesScriptedTurn = Schema.Union([
  EmulatorScriptedError,
  ResponsesScriptedResponse
])

export type ResponsesScriptedTurn = typeof ResponsesScriptedTurn.Type

export type ResponsesLedgerEntry = {
  /** 1-based arrival order since the last ledger clear or reset. */
  readonly seq: number
  readonly method: string
  readonly path: string
  /** Parsed JSON request body, when it was valid JSON. */
  readonly body?: Schema.Json
  readonly model?: string
  readonly stream?: boolean
  readonly store?: boolean
  /** The request's `max_output_tokens`, when it is a number. */
  readonly maxOutputTokens?: number
  readonly reasoning?: Schema.Json
  readonly toolChoice?: Schema.Json
  /** Names of the offered `function` tools. */
  readonly toolNames: ReadonlyArray<string>
  /** Values of the non-credential headers the subpath records (lower-case names). */
  readonly headers: Readonly<Record<string, string>>
  /** Kind of the fault that shaped the response. */
  readonly fault?: ResponsesFaultKind
  /** Why a matching fault could not take effect (the response was a 500 emulator error). */
  readonly faultError?: string
  /**
   * Set when the emulator could not build the planned response; the request was answered with a
   * 500 emulator error (still evidence-tagged) and no fault was used up.
   */
  readonly responseError?: string
  /** Set when a scripted turn answered the request. */
  readonly scripted?: 'response' | 'error'
  /** Evidence of the matched route; `unknown-route` for requests that failed closed. */
  readonly evidence: EmulatorEvidence | 'unknown-route'
  readonly status: number
  /** Body chunks handed to the transport so far (each produced when pulled). */
  readonly bodyChunks: number
}

export type ResponsesEmulator = EmulatorApi<
  ResponsesScriptedTurn,
  ResponsesFault,
  ResponsesLedgerEntry
>

/** A Responses wire error, rendered by the subpath's `errorEnvelope`. */
export type ResponsesWireError = {
  readonly message: string
  readonly type: string
  readonly code: string
  readonly param?: string
}

/**
 * One request header rule. `record` keeps the header value in the ledger `headers` (never set it
 * for credential headers); `required` answers a request without a non-empty value with that
 * status and error (the value itself is never checked).
 */
export type ResponsesHeaderRule = {
  /** Lower-case header name. */
  readonly name: string
  readonly record: boolean
  readonly required?: { readonly status: number; readonly error: ResponsesWireError }
}

/**
 * What differs between Responses emulators. The core owns everything else (framing, faults,
 * scripting, ledger, control plane, evidence).
 */
export type ResponsesEmulatorConfig = {
  /** The Responses path, for example `/v1/responses`. */
  readonly path: string
  /** Route evidence manifest; must list exactly the Responses route. */
  readonly routes: ReadonlyArray<EmulatorRouteEvidence>
  readonly knownModels: ReadonlyArray<string>
  /** Renders a wire error as the service's JSON error envelope. */
  readonly errorEnvelope: (error: ResponsesWireError) => Schema.Json
  /** Status and error for an unknown model id. */
  readonly unknownModel: { readonly status: number; readonly error: ResponsesWireError }
  /**
   * Requests authenticate with a non-empty `Authorization: Bearer` credential, never checked or
   * stored; anything else answers 401 with `unauthorized`.
   */
  readonly unauthorized: ResponsesWireError
  /** Extra header rules, checked in order after the bearer credential. */
  readonly headers: ReadonlyArray<ResponsesHeaderRule>
  /**
   * `optional`: `max_output_tokens` may be sent (a positive integer, or 400) and is recorded, not
   * enforced; `rejected`: any `max_output_tokens` answers 400 `unsupported_parameter`.
   */
  readonly outputTokenLimit: 'optional' | 'rejected'
  /** Default answer text deltas. */
  readonly defaultText: ReadonlyArray<string>
  /** Builds the error thrown by the JS API (`faults.add`, `script.enqueue`) for invalid input. */
  readonly inputInvalid: (input: 'fault' | 'turn', reason: string) => Error
}

const ResponsesTool = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  parameters: Schema.optionalKey(Schema.Json)
})

const ResponsesRequest = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  input: Schema.Union([Schema.String, Schema.Array(Schema.Json)]),
  instructions: Schema.optionalKey(Schema.NullOr(Schema.String)),
  tools: Schema.optionalKey(Schema.NullOr(Schema.Array(ResponsesTool))),
  tool_choice: Schema.optionalKey(Schema.Json),
  reasoning: Schema.optionalKey(Schema.Json),
  stream: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  store: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  max_output_tokens: Schema.optionalKey(Schema.Json)
})

type ResponsesRequest = typeof ResponsesRequest.Type

const decodeResponsesRequest = Schema.decodeUnknownResult(ResponsesRequest)

// Synthetic creation time shared by every emulated response (deterministic output).
const syntheticCreated = 1790000000

// A non-empty bearer credential. The value is never checked or stored.
const bearerPattern = /^bearer\s+\S+/i

const defaultReasoning = ['The user wants a short reply.', ' Keep it brief.']

const defaultStreamError: ResponsesStreamError = {
  code: 'server_error',
  message: 'Synthetic: the server had an error while processing the request.'
}

type ItemPlan =
  | { readonly type: 'reasoning'; readonly id: string; readonly fragments: ReadonlyArray<string> }
  | { readonly type: 'message'; readonly id: string; readonly fragments: ReadonlyArray<string> }
  | {
      readonly type: 'function_call'
      readonly id: string
      readonly callId: string
      readonly name: string
      readonly fragments: ReadonlyArray<string>
    }

type ResponsePlan = {
  readonly items: ReadonlyArray<ItemPlan>
  /** `null`: never send usage; `undefined`: synthesize. */
  readonly usage: ResponsesScriptedUsage | null | undefined
  /** `undefined`: follow the request's `stream`. */
  readonly format: 'sse' | 'json' | undefined
}

/** A reasoning summary is streamed when the request's `reasoning` asks for one. */
const summaryRequested = (request: ResponsesRequest): boolean => {
  const summary = stringField(request.reasoning, 'summary')

  return summary !== undefined && summary.length > 0
}

const functionTools = (request: ResponsesRequest) =>
  (request.tools ?? []).flatMap(tool =>
    (tool.type === undefined || tool.type === 'function') && tool.name !== undefined
      ? [{ name: tool.name, parameters: tool.parameters }]
      : []
  )

const chosenTool = (request: ResponsesRequest) => {
  const tools = functionTools(request)

  if (tools.length === 0 || request.tool_choice === 'none') {
    return undefined
  }

  const forced =
    stringField(request.tool_choice, 'type') === 'function'
      ? stringField(request.tool_choice, 'name')
      : undefined

  return tools.find(tool => tool.name === forced) ?? tools[0]
}

const defaultPlan = (
  request: ResponsesRequest,
  seq: number,
  defaultText: ReadonlyArray<string>
): ResponsePlan => {
  const reasoning: ReadonlyArray<ItemPlan> = summaryRequested(request)
    ? [{ type: 'reasoning', id: `rs_synthetic_${seq}_0`, fragments: defaultReasoning }]
    : []

  const tool = chosenTool(request)

  if (tool === undefined) {
    return {
      items: [
        ...reasoning,
        { type: 'message', id: `msg_synthetic_${seq}_0`, fragments: defaultText }
      ],
      usage: undefined,
      format: undefined
    }
  }

  const argumentsText = JSON.stringify(
    synthesizeValue(tool.parameters ?? { type: 'object' }, tool.name, 0)
  )

  return {
    items: [
      ...reasoning,
      {
        type: 'function_call',
        id: `fc_synthetic_${seq}_0`,
        callId: `call_synthetic_${seq}_0`,
        name: tool.name,
        fragments: splitFragments(argumentsText, 3)
      }
    ],
    usage: undefined,
    format: undefined
  }
}

const scriptedPlan = (turn: ResponsesScriptedResponse, seq: number): ResponsePlan => {
  const reasoning: ReadonlyArray<ItemPlan> =
    turn.reasoning === undefined
      ? []
      : [{ type: 'reasoning', id: `rs_synthetic_${seq}_0`, fragments: turn.reasoning }]

  const message: ReadonlyArray<ItemPlan> =
    turn.text === undefined
      ? []
      : [{ type: 'message', id: `msg_synthetic_${seq}_0`, fragments: turn.text }]

  const calls = (turn.functionCalls ?? []).map((call, index): ItemPlan => ({
    type: 'function_call',
    id: `fc_synthetic_${seq}_${index}`,
    callId: call.callId ?? `call_synthetic_${seq}_${index}`,
    name: call.name,
    fragments: call.argumentFragments
  }))

  return {
    items:
      turn.order === 'text-first'
        ? [...message, ...reasoning, ...calls]
        : [...reasoning, ...message, ...calls],
    usage: turn.usage,
    format: turn.format
  }
}

type WireUsage = {
  readonly input_tokens: number
  readonly input_tokens_details: { readonly cached_tokens: number }
  readonly output_tokens: number
  readonly output_tokens_details: { readonly reasoning_tokens: number }
  readonly total_tokens: number
}

type WireResponse = {
  readonly id: string
  readonly object: 'response'
  readonly created_at: number
  readonly status: 'in_progress' | 'completed' | 'failed'
  readonly error: Schema.JsonObject | null
  readonly incomplete_details: null
  readonly model: string
  readonly output: ReadonlyArray<Schema.JsonObject>
  usage?: WireUsage | null
}

const planUsage = (plan: ResponsePlan, requestText: string): WireUsage | undefined => {
  if (plan.usage === null) {
    return undefined
  }

  const reasoningText = plan.items
    .flatMap(item => (item.type === 'reasoning' ? item.fragments : []))
    .join('')

  const usage = plan.usage ?? {
    inputTokens: approximateTokens(requestText),
    outputTokens: approximateTokens(plan.items.flatMap(item => item.fragments).join('')),
    reasoningTokens: reasoningText.length > 0 ? approximateTokens(reasoningText) : 0
  }

  return {
    input_tokens: usage.inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
    total_tokens: usage.inputTokens + usage.outputTokens
  }
}

type ResponseIdentity = { readonly id: string; readonly model: string }

const responseObject = (
  identity: ResponseIdentity,
  status: WireResponse['status'],
  output: ReadonlyArray<Schema.JsonObject>
): WireResponse => ({
  id: identity.id,
  object: 'response',
  created_at: syntheticCreated,
  status,
  error: null,
  incomplete_details: null,
  model: identity.model,
  output
})

const outputText = (text: string): Schema.JsonObject => ({
  type: 'output_text',
  text,
  annotations: []
})

const summaryText = (text: string): Schema.JsonObject => ({ type: 'summary_text', text })

/** The complete wire item (as in `response.output_item.done` and the final `output`). */
const completeItem = (item: ItemPlan): Schema.JsonObject => {
  const text = item.fragments.join('')

  switch (item.type) {
    case 'reasoning':
      return {
        id: item.id,
        type: 'reasoning',
        summary: item.fragments.length === 0 ? [] : [summaryText(text)]
      }
    case 'message':
      return {
        id: item.id,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [outputText(text)]
      }
    case 'function_call':
      return {
        id: item.id,
        type: 'function_call',
        status: 'completed',
        call_id: item.callId,
        name: item.name,
        arguments: text
      }
  }
}

/** The item as first announced in `response.output_item.added`. */
const addedItem = (item: ItemPlan): Schema.JsonObject => {
  switch (item.type) {
    case 'reasoning':
      return { id: item.id, type: 'reasoning', summary: [] }
    case 'message':
      return {
        id: item.id,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: []
      }
    case 'function_call':
      return {
        id: item.id,
        type: 'function_call',
        status: 'in_progress',
        call_id: item.callId,
        name: item.name,
        arguments: ''
      }
  }
}

const sseEvent = (type: string, sequence: number, payload: object): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, ...payload })}\n\n`

type EventWriter = {
  readonly events: Array<string>
  readonly push: (type: string, payload: object) => void
}

/** Builds SSE events with increasing `sequence_number`s, one network chunk each. */
const makeEventWriter = (): EventWriter => {
  const events: Array<string> = []

  return {
    events,
    push: (type, payload) => {
      events.push(sseEvent(type, events.length, payload))
    }
  }
}

const itemEvents = (writer: EventWriter, item: ItemPlan, outputIndex: number) => {
  const text = item.fragments.join('')
  const ids = { item_id: item.id, output_index: outputIndex }

  writer.push('response.output_item.added', { output_index: outputIndex, item: addedItem(item) })

  switch (item.type) {
    case 'reasoning': {
      if (item.fragments.length > 0) {
        const part = { ...ids, summary_index: 0 }

        writer.push('response.reasoning_summary_part.added', { ...part, part: summaryText('') })

        for (const fragment of item.fragments) {
          writer.push('response.reasoning_summary_text.delta', { ...part, delta: fragment })
        }

        writer.push('response.reasoning_summary_text.done', { ...part, text })
        writer.push('response.reasoning_summary_part.done', { ...part, part: summaryText(text) })
      }

      break
    }

    case 'message': {
      const part = { ...ids, content_index: 0 }

      writer.push('response.content_part.added', { ...part, part: outputText('') })

      for (const fragment of item.fragments) {
        writer.push('response.output_text.delta', { ...part, delta: fragment })
      }

      writer.push('response.output_text.done', { ...part, text })
      writer.push('response.content_part.done', { ...part, part: outputText(text) })
      break
    }

    case 'function_call': {
      for (const fragment of item.fragments) {
        writer.push('response.function_call_arguments.delta', { ...ids, delta: fragment })
      }

      writer.push('response.function_call_arguments.done', { ...ids, arguments: text })
      break
    }
  }

  writer.push('response.output_item.done', { output_index: outputIndex, item: completeItem(item) })
}

/** The completed `response` object (for `response.completed` and the JSON body). */
const completedResponse = (
  plan: ResponsePlan,
  identity: ResponseIdentity,
  usage: WireUsage | undefined
): WireResponse => {
  const response = responseObject(identity, 'completed', plan.items.map(completeItem))

  if (usage !== undefined) {
    response.usage = usage
  }

  return response
}

/** SSE events for a streamed response, one network chunk each, in the API's order. */
const streamEvents = (
  plan: ResponsePlan,
  identity: ResponseIdentity,
  usage: WireUsage | undefined
): ReadonlyArray<string> => {
  const writer = makeEventWriter()
  const inProgress: WireResponse = { ...responseObject(identity, 'in_progress', []), usage: null }

  writer.push('response.created', { response: inProgress })
  writer.push('response.in_progress', { response: inProgress })

  plan.items.forEach((item, index) => itemEvents(writer, item, index))

  writer.push('response.completed', { response: completedResponse(plan, identity, usage) })

  return writer.events
}

/** The mid-stream error event of an `error-event-after-chunks` fault. */
const errorEvent = (
  fault: typeof ResponsesErrorEventFault.Type,
  identity: ResponseIdentity,
  sequence: number
): string => {
  const error = fault.error ?? defaultStreamError

  if (fault.event === 'response.failed') {
    return sseEvent('response.failed', sequence, {
      response: {
        ...responseObject(identity, 'failed', []),
        error: { code: error.code, message: error.message },
        usage: null
      }
    })
  }

  return sseEvent('error', sequence, { code: error.code, message: error.message, param: null })
}

type MutableLedgerEntry = KernelLedgerEntry<ResponsesFaultKind> & {
  body?: Schema.Json
  model?: string
  stream?: boolean
  store?: boolean
  maxOutputTokens?: number
  reasoning?: Schema.Json
  toolChoice?: Schema.Json
  toolNames: ReadonlyArray<string>
  headers: Record<string, string>
  scripted?: 'response' | 'error'
}

const isPositiveInteger = (value: Schema.Json | undefined): value is number =>
  Predicate.isNumber(value) && Number.isSafeInteger(value) && value > 0

/**
 * Create a Responses emulator from its config. Each call has independent ledger, fault, and
 * script state.
 *
 * Precedence per request: the bearer credential, the header rules in order, JSON and request
 * validation (an `input` string or array, and the `max_output_tokens` policy), then the first
 * matching fault if it is a `status` fault, then the next scripted turn, then model validation and
 * defaults; a first matching body fault then shapes the body. Only the first matching fault (in
 * insertion order) applies. Credential headers are never recorded, and credential values are
 * never checked or stored.
 */
export const makeResponsesEmulator = (config: ResponsesEmulatorConfig): ResponsesEmulator => {
  const knownModels = [...config.knownModels]

  const errorResponse = (status: number, error: ResponsesWireError): Response =>
    jsonResponse(status, config.errorEnvelope(error))

  const invalidRequest = (message: string, code: string, param?: string): Response =>
    errorResponse(
      400,
      param === undefined
        ? { message, type: 'invalid_request_error', code }
        : { message, type: 'invalid_request_error', code, param }
    )

  const defaultFaultBody = (status: number): Schema.Json =>
    status === 429
      ? config.errorEnvelope({
          message: 'Synthetic rate limit: too many requests.',
          type: 'rate_limit_exceeded',
          code: 'rate_limit_exceeded'
        })
      : config.errorEnvelope({
          message: `Synthetic upstream error (${status}).`,
          type: status >= 500 ? 'server_error' : 'api_error',
          code: status >= 500 ? 'server_error' : 'upstream_error'
        })

  const kernel = makeEmulatorKernel({
    routes: config.routes,
    faultSchema: ResponsesFault,
    turnSchema: ResponsesScriptedTurn,
    newEntry: (base): MutableLedgerEntry => ({ ...base, toolNames: [], headers: {} }),
    snapshotEntry: (entry): ResponsesLedgerEntry => ({
      ...entry,
      toolNames: [...entry.toolNames],
      headers: { ...entry.headers }
    }),
    unknownRoute: () =>
      errorResponse(404, {
        message: 'Synthetic: no emulated route.',
        type: 'invalid_request_error',
        code: 'not_found'
      }),
    stateFields: () => ({ knownModels }),
    inputInvalid: config.inputInvalid
  })

  const responses = async (
    request: Request,
    entry: MutableLedgerEntry,
    path: string
  ): Promise<Response> => {
    for (const rule of config.headers) {
      const value = request.headers.get(rule.name)

      if (rule.record && value !== null) entry.headers[rule.name] = value
    }

    if (!bearerPattern.test(request.headers.get('authorization') ?? '')) {
      entry.status = 401

      return errorResponse(401, config.unauthorized)
    }

    for (const rule of config.headers) {
      if (
        rule.required !== undefined &&
        (request.headers.get(rule.name) ?? '').trim().length === 0
      ) {
        entry.status = rule.required.status

        return errorResponse(rule.required.status, rule.required.error)
      }
    }

    const text = await readText(request)
    const json = text === undefined ? undefined : parseJson(text)

    if (text === undefined || json === undefined) {
      entry.status = 400

      return invalidRequest('Synthetic: the request body is not valid JSON.', 'invalid_json')
    }

    entry.body = json

    const decoded = decodeResponsesRequest(json)

    if (Result.isFailure(decoded) || !isJsonObject(json)) {
      entry.status = 400

      return invalidRequest(
        'Synthetic: the request body is not a Responses request (`input` is required).',
        'invalid_request'
      )
    }

    const body = decoded.success
    const seq = entry.seq

    if (body.model !== undefined) entry.model = body.model

    entry.stream = body.stream === true

    if (Predicate.isBoolean(body.store)) entry.store = body.store

    if (body.reasoning !== undefined) entry.reasoning = body.reasoning

    if (body.tool_choice !== undefined) entry.toolChoice = body.tool_choice

    entry.toolNames = functionTools(body).map(tool => tool.name)

    const outputLimit = jsonField(json, 'max_output_tokens')

    if (Predicate.isNumber(outputLimit)) entry.maxOutputTokens = outputLimit

    if (config.outputTokenLimit === 'rejected' && outputLimit !== undefined) {
      entry.status = 400

      return invalidRequest(
        'Synthetic: unsupported parameter: max_output_tokens.',
        'unsupported_parameter',
        'max_output_tokens'
      )
    }

    if (outputLimit !== undefined && outputLimit !== null && !isPositiveInteger(outputLimit)) {
      entry.status = 400

      return invalidRequest(
        'Synthetic: max_output_tokens must be a positive integer.',
        'invalid_value',
        'max_output_tokens'
      )
    }

    const fault = kernel.takeFault(path, body.model)

    if (fault !== undefined && fault.fault.kind === 'status') {
      return kernel.respondWithStatusFault(entry, fault, fault.fault, defaultFaultBody)
    }

    const errorEventFault =
      fault !== undefined && fault.fault.kind === 'error-event-after-chunks'
        ? { state: fault, fault: fault.fault }
        : undefined

    const cannotApply = (problem: string): Response => {
      entry.faultError = problem
      entry.status = 500

      return controlError(500, `emulator fault cannot apply: ${problem}`)
    }

    // A scripted turn is used up when its request arrives. Header and status validation at
    // `script.enqueue` time means its response can always be built.
    const turn = kernel.nextTurn()

    if (turn !== undefined && 'error' in turn) {
      entry.scripted = 'error'

      if (errorEventFault !== undefined) {
        return cannotApply('error-event-after-chunks cannot apply to a scripted error')
      }

      return kernel.respondWithScriptedError(entry, turn.error, fault)
    }

    if (turn === undefined && (body.model === undefined || !knownModels.includes(body.model))) {
      entry.status = config.unknownModel.status

      return errorResponse(config.unknownModel.status, config.unknownModel.error)
    }

    if (turn !== undefined) entry.scripted = 'response'

    const plan =
      turn === undefined ? defaultPlan(body, seq, config.defaultText) : scriptedPlan(turn, seq)

    const identity = { id: `resp_synthetic_${seq}`, model: body.model ?? 'unknown' }
    const usage = planUsage(plan, text)
    const format = plan.format ?? (body.stream === true ? 'sse' : 'json')

    if (format === 'json') {
      if (errorEventFault !== undefined) {
        return cannotApply('error-event-after-chunks cannot apply to a JSON response')
      }

      return kernel.respondWithBody(
        entry,
        200,
        { 'content-type': 'application/json' },
        [JSON.stringify(completedResponse(plan, identity, usage))],
        fault
      )
    }

    const events = streamEvents(plan, identity, usage)
    const headers = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }

    if (errorEventFault === undefined) {
      return kernel.respondWithBody(entry, 200, headers, events, fault)
    }

    const after = errorEventFault.fault.chunks

    // The error must arrive before `response.completed`, or a client rightly ignores it.
    if (after >= events.length) {
      return cannotApply(
        `error-event-after-chunks after ${after} chunk(s) cannot apply to a response with ${events.length} chunk(s)`
      )
    }

    const response = kernel.respondWithBody(
      entry,
      200,
      headers,
      [...events.slice(0, after), errorEvent(errorEventFault.fault, identity, after)],
      undefined
    )

    kernel.consumeFault(errorEventFault.state, entry)

    return response
  }

  // Every manifest route maps to its own handler; construction throws `EmulatorRouteUnmapped`
  // when a manifest route has no handler (or a handler has no manifest route).
  return kernel.serve(new Map([[emulatorRouteKey('POST', config.path), responses]]))
}
