/**
 * Anthropic Messages emulator core (internal; not a package export).
 *
 * One `POST /v1/messages` route with request parsing (`model`, `max_tokens`, `system`,
 * `messages`, `tools`, `tool_choice`, `thinking`, `stream`), Messages SSE framing in the order
 * the real API sends it (`message_start`, then per content block `content_block_start`, its
 * deltas, and `content_block_stop`, a `ping` after the first block starts, then `message_delta`
 * with the stop reason and usage, and `message_stop`), the non-streamed `message` JSON body,
 * scripted turns, and the `{ type: 'error', error: { type, message } }` envelope. Faults, the
 * request ledger, the `/_emulate/*` control plane, evidence tagging, and route binding come from
 * the shared kernel (`emulator-kernel.ts`).
 *
 * Content blocks: `thinking` (`thinking_delta` fragments, then one `signature_delta`) when the
 * request enables thinking, `text` (`text_delta`), and `tool_use` (`input_json_delta` fragments
 * of the tool input). Stop reasons: `end_turn`, `tool_use`, and `max_tokens` (the default answer
 * is cut when it would exceed the request's `max_tokens`; scripted turns name any reason).
 *
 * Requests authenticate with a non-empty `x-api-key` (native API) or `Authorization: Bearer`
 * (OAuth) credential; neither value is ever checked or stored.
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

/** An Anthropic wire error: `type` (for example `overloaded_error`) and a message. */
export const MessagesWireError = Schema.Struct({
  type: Schema.NonEmptyString,
  message: Schema.String
})

export type MessagesWireError = typeof MessagesWireError.Type

/**
 * Send `chunks` SSE events, then one `event: error` event (default `overloaded_error`) and close
 * without `message_stop`. Streamed responses only; it must come before `message_stop`.
 */
export const MessagesErrorEventFault = Schema.Struct({
  kind: Schema.Literal('error-event-after-chunks'),
  chunks: ChunkCount,
  error: Schema.optionalKey(MessagesWireError),
  ...emulatorFaultFields
})

/**
 * Wire faults: `status` (the body defaults to an Anthropic error envelope matching the status,
 * for example `rate_limit_error` for 429 and `overloaded_error` for 529), `error-after-chunks`
 * (a dropped connection), `truncate-after-chunks` (a clean close, for example before
 * `message_stop`), and `error-event-after-chunks` (a mid-stream `error` event).
 */
export const MessagesFault = Schema.Union([
  EmulatorStatusFault,
  EmulatorErrorAfterChunksFault,
  EmulatorTruncateAfterChunksFault,
  MessagesErrorEventFault
])

export type MessagesFault = typeof MessagesFault.Type

export type MessagesFaultKind = MessagesFault['kind']

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Usage for a scripted turn (sent in `message_start` and `message_delta`). */
export const MessagesScriptedUsage = Schema.Struct({
  inputTokens: TokenCount,
  outputTokens: TokenCount
})

export type MessagesScriptedUsage = typeof MessagesScriptedUsage.Type

/** One scripted `tool_use` block; its JSON input streams as these `input_json_delta` fragments. */
export const MessagesScriptedToolUse = Schema.Struct({
  name: Schema.NonEmptyString,
  inputFragments: Schema.Array(Schema.String),
  id: Schema.optionalKey(Schema.NonEmptyString)
})

export type MessagesScriptedToolUse = typeof MessagesScriptedToolUse.Type

/**
 * A scripted message. Every field is exact (nothing is filled in) except: a block is sent only
 * when its field is present; `usage` omitted is synthesized and `null` drops `usage` from the
 * wire; `stopReason` omitted is `tool_use` with tool uses, else `end_turn`; `order` defaults to
 * `thinking-first` (`text-first` sends the thinking block after the text).
 */
export const MessagesScriptedMessage = Schema.Struct({
  thinking: Schema.optionalKey(Schema.Array(Schema.String)),
  text: Schema.optionalKey(Schema.Array(Schema.String)),
  toolUses: Schema.optionalKey(Schema.Array(MessagesScriptedToolUse)),
  order: Schema.optionalKey(Schema.Literals(['thinking-first', 'text-first'])),
  usage: Schema.optionalKey(Schema.NullOr(MessagesScriptedUsage)),
  stopReason: Schema.optionalKey(Schema.NonEmptyString)
})

export type MessagesScriptedMessage = typeof MessagesScriptedMessage.Type

/** A turn queued for the next Messages request. */
export const MessagesScriptedTurn = Schema.Union([EmulatorScriptedError, MessagesScriptedMessage])

export type MessagesScriptedTurn = typeof MessagesScriptedTurn.Type

export type MessagesLedgerEntry = {
  /** 1-based arrival order since the last ledger clear or reset. */
  readonly seq: number
  readonly method: string
  readonly path: string
  /** Parsed JSON request body, when it was valid JSON. */
  readonly body?: Schema.Json
  readonly model?: string
  readonly stream?: boolean
  /** The request's `max_tokens`, when it is a number (non-positive or fractional answers 400). */
  readonly maxTokens?: number
  readonly thinking?: Schema.Json
  readonly toolChoice?: Schema.Json
  readonly toolNames: ReadonlyArray<string>
  /** Which header carried the credential (the value is never recorded). */
  readonly credentialHeader?: 'x-api-key' | 'authorization'
  readonly anthropicVersion?: string
  readonly anthropicBeta?: string
  /** Kind of the fault that shaped the response. */
  readonly fault?: MessagesFaultKind
  /** Why a matching fault could not take effect (the response was a 500 emulator error). */
  readonly faultError?: string
  /**
   * Set when the emulator could not build the planned response; the request was answered with a
   * 500 emulator error (still evidence-tagged) and no fault was used up.
   */
  readonly responseError?: string
  /** Set when a scripted turn answered the request. */
  readonly scripted?: 'message' | 'error'
  /** Evidence of the matched route; `unknown-route` for requests that failed closed. */
  readonly evidence: EmulatorEvidence | 'unknown-route'
  readonly status: number
  /** Body chunks handed to the transport so far (each produced when pulled). */
  readonly bodyChunks: number
}

export type MessagesEmulator = EmulatorApi<MessagesScriptedTurn, MessagesFault, MessagesLedgerEntry>

export type MessagesEmulatorConfig = {
  /** The Messages path, for example `/v1/messages`. */
  readonly path: string
  /** Route evidence manifest; must list exactly the Messages route. */
  readonly routes: ReadonlyArray<EmulatorRouteEvidence>
  readonly knownModels: ReadonlyArray<string>
  /** Builds the error thrown by the JS API (`faults.add`, `script.enqueue`) for invalid input. */
  readonly inputInvalid: (input: 'fault' | 'turn', reason: string) => Error
}

const MessagesTool = Schema.Struct({
  name: Schema.String,
  type: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  input_schema: Schema.optionalKey(Schema.Json)
})

const MessagesRequest = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  max_tokens: Schema.optionalKey(Schema.Json),
  system: Schema.optionalKey(Schema.Json),
  messages: Schema.Array(Schema.Json),
  tools: Schema.optionalKey(Schema.NullOr(Schema.Array(MessagesTool))),
  tool_choice: Schema.optionalKey(Schema.Json),
  thinking: Schema.optionalKey(Schema.Json),
  stream: Schema.optionalKey(Schema.NullOr(Schema.Boolean))
})

type MessagesRequest = typeof MessagesRequest.Type

const decodeMessagesRequest = Schema.decodeUnknownResult(MessagesRequest)

// A non-empty bearer credential. The value is never checked or stored.
const bearerPattern = /^bearer\s+\S+/i

const defaultText = ['Hello', ' from the', ' synthetic Anthropic emulator.']

const defaultThinking = ['The user wants a short greeting.', ' Reply briefly.']

// Opaque placeholder for the thinking-block signature the real API sends.
const syntheticSignature = 'synthetic-thinking-signature'

type BlockPlan =
  | { readonly type: 'thinking'; readonly fragments: ReadonlyArray<string> }
  | { readonly type: 'text'; readonly fragments: ReadonlyArray<string> }
  | {
      readonly type: 'tool_use'
      readonly id: string
      readonly name: string
      readonly fragments: ReadonlyArray<string>
    }

type MessagePlan = {
  readonly blocks: ReadonlyArray<BlockPlan>
  /** `null`: never send usage; `undefined`: synthesize. */
  readonly usage: MessagesScriptedUsage | null | undefined
  readonly stopReason: string
}

const thinkingRequested = (request: MessagesRequest): boolean => {
  const type = stringField(request.thinking, 'type')

  return type === 'enabled' || type === 'adaptive'
}

const chosenTool = (request: MessagesRequest) => {
  const tools = request.tools ?? []
  const choice = stringField(request.tool_choice, 'type')

  if (tools.length === 0 || choice === 'none') {
    return undefined
  }

  const forced = choice === 'tool' ? stringField(request.tool_choice, 'name') : undefined

  return tools.find(tool => tool.name === forced) ?? tools[0]
}

/**
 * Cut the plan so its synthetic output fits `maxTokens` (about four characters per token):
 * thinking and text are cut mid-fragment, a tool call that does not fit is dropped, and the stop
 * reason becomes `max_tokens`.
 */
const fitToMaxTokens = (plan: MessagePlan, maxTokens: number): MessagePlan => {
  let budget = maxTokens * 4
  const blocks: Array<BlockPlan> = []

  for (const block of plan.blocks) {
    const size = block.fragments.join('').length

    if (size <= budget) {
      blocks.push(block)
      budget -= size

      continue
    }

    if (block.type !== 'tool_use' && budget > 0) {
      const fragments: Array<string> = []

      for (const fragment of block.fragments) {
        if (budget <= 0) break

        fragments.push(fragment.slice(0, budget))
        budget -= Math.min(fragment.length, budget)
      }

      blocks.push({ type: block.type, fragments })
    }

    return { blocks, usage: plan.usage, stopReason: 'max_tokens' }
  }

  return plan
}

const defaultPlan = (request: MessagesRequest, seq: number, maxTokens: number): MessagePlan => {
  const thinking: ReadonlyArray<BlockPlan> = thinkingRequested(request)
    ? [{ type: 'thinking', fragments: defaultThinking }]
    : []

  const tool = chosenTool(request)

  if (tool === undefined) {
    return fitToMaxTokens(
      {
        blocks: [...thinking, { type: 'text', fragments: defaultText }],
        usage: undefined,
        stopReason: 'end_turn'
      },
      maxTokens
    )
  }

  const input = JSON.stringify(
    synthesizeValue(tool.input_schema ?? { type: 'object' }, tool.name, 0)
  )

  return fitToMaxTokens(
    {
      blocks: [
        ...thinking,
        {
          type: 'tool_use',
          id: `toolu_synthetic_${seq}_0`,
          name: tool.name,
          // The real API opens the input with an empty `partial_json` fragment.
          fragments: ['', ...splitFragments(input, 3)]
        }
      ],
      usage: undefined,
      stopReason: 'tool_use'
    },
    maxTokens
  )
}

const scriptedPlan = (turn: MessagesScriptedMessage, seq: number): MessagePlan => {
  const thinking: ReadonlyArray<BlockPlan> =
    turn.thinking === undefined ? [] : [{ type: 'thinking', fragments: turn.thinking }]

  const text: ReadonlyArray<BlockPlan> =
    turn.text === undefined ? [] : [{ type: 'text', fragments: turn.text }]

  const toolUses = (turn.toolUses ?? []).map((call, index): BlockPlan => ({
    type: 'tool_use',
    id: call.id ?? `toolu_synthetic_${seq}_${index}`,
    name: call.name,
    fragments: call.inputFragments
  }))

  return {
    blocks:
      turn.order === 'text-first'
        ? [...text, ...thinking, ...toolUses]
        : [...thinking, ...text, ...toolUses],
    usage: turn.usage,
    stopReason: turn.stopReason ?? (toolUses.length > 0 ? 'tool_use' : 'end_turn')
  }
}

type PlanUsage = { readonly inputTokens: number; readonly outputTokens: number } | undefined

const planUsage = (plan: MessagePlan, requestText: string): PlanUsage => {
  if (plan.usage === null) {
    return undefined
  }

  return (
    plan.usage ?? {
      inputTokens: approximateTokens(requestText),
      outputTokens: approximateTokens(plan.blocks.flatMap(block => block.fragments).join(''))
    }
  )
}

type ResponseIdentity = { readonly id: string; readonly model: string }

// Wire shapes of the Messages responses the emulator sends.
type WireUsage = {
  readonly input_tokens: number
  readonly cache_creation_input_tokens: number
  readonly cache_read_input_tokens: number
  readonly output_tokens: number
}

type WireMessage = {
  readonly id: string
  readonly type: 'message'
  readonly role: 'assistant'
  readonly model: string
  readonly content: ReadonlyArray<Schema.JsonObject>
  readonly stop_reason: string | null
  readonly stop_sequence: null
  usage?: WireUsage
}

type WireMessageDelta = {
  readonly delta: { readonly stop_reason: string; readonly stop_sequence: null }
  usage?: { readonly output_tokens: number }
}

const wireUsage = (inputTokens: number, outputTokens: number): WireUsage => ({
  input_tokens: inputTokens,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: outputTokens
})

const sseEvent = (type: string, payload: Schema.JsonObject): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`

const blockStart = (block: BlockPlan): Schema.JsonObject => {
  switch (block.type) {
    case 'thinking':
      return { type: 'thinking', thinking: '', signature: '' }
    case 'text':
      return { type: 'text', text: '' }
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: {} }
  }
}

const blockDelta = (block: BlockPlan, fragment: string): Schema.JsonObject => {
  switch (block.type) {
    case 'thinking':
      return { type: 'thinking_delta', thinking: fragment }
    case 'text':
      return { type: 'text_delta', text: fragment }
    case 'tool_use':
      return { type: 'input_json_delta', partial_json: fragment }
  }
}

/** SSE events for a streamed message, one network chunk each, in the real API's order. */
const streamEvents = (
  plan: MessagePlan,
  identity: ResponseIdentity,
  usage: PlanUsage
): ReadonlyArray<string> => {
  const message: WireMessage = {
    id: identity.id,
    type: 'message',
    role: 'assistant',
    model: identity.model,
    content: [],
    stop_reason: null,
    stop_sequence: null
  }

  if (usage !== undefined) {
    message.usage = wireUsage(usage.inputTokens, 1)
  }

  const events: Array<string> = [sseEvent('message_start', { message })]
  const ping = sseEvent('ping', {})

  plan.blocks.forEach((block, index) => {
    events.push(sseEvent('content_block_start', { index, content_block: blockStart(block) }))

    if (index === 0) {
      events.push(ping)
    }

    for (const fragment of block.fragments) {
      events.push(sseEvent('content_block_delta', { index, delta: blockDelta(block, fragment) }))
    }

    if (block.type === 'thinking') {
      events.push(
        sseEvent('content_block_delta', {
          index,
          delta: { type: 'signature_delta', signature: syntheticSignature }
        })
      )
    }

    events.push(sseEvent('content_block_stop', { index }))
  })

  if (plan.blocks.length === 0) {
    events.push(ping)
  }

  const messageDelta: WireMessageDelta = {
    delta: { stop_reason: plan.stopReason, stop_sequence: null }
  }

  if (usage !== undefined) {
    messageDelta.usage = { output_tokens: usage.outputTokens }
  }

  events.push(sseEvent('message_delta', messageDelta))
  events.push(sseEvent('message_stop', {}))

  return events
}

/** The JSON value of a tool input; throws (answering an emulator 500) when it is not JSON. */
const toolInput = (fragments: ReadonlyArray<string>): Schema.Json => {
  const text = fragments.join('')
  const parsed = text.trim().length === 0 ? {} : parseJson(text)

  if (parsed === undefined) {
    throw new Error('scripted tool input is not JSON')
  }

  return parsed
}

/** The non-streamed `message` JSON body. */
const messageBody = (
  plan: MessagePlan,
  identity: ResponseIdentity,
  usage: PlanUsage
): WireMessage => {
  const content = plan.blocks.map((block): Schema.JsonObject => {
    switch (block.type) {
      case 'thinking':
        return {
          type: 'thinking',
          thinking: block.fragments.join(''),
          signature: syntheticSignature
        }
      case 'text':
        return { type: 'text', text: block.fragments.join('') }
      case 'tool_use':
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: toolInput(block.fragments)
        }
    }
  })

  const body: WireMessage = {
    id: identity.id,
    type: 'message',
    role: 'assistant',
    model: identity.model,
    content,
    stop_reason: plan.stopReason,
    stop_sequence: null
  }

  if (usage !== undefined) {
    body.usage = wireUsage(usage.inputTokens, usage.outputTokens)
  }

  return body
}

/** The Anthropic error envelope. */
export const messagesErrorEnvelope = (error: MessagesWireError): Schema.JsonObject => ({
  type: 'error',
  error: { type: error.type, message: error.message }
})

const errorTypeForStatus = (status: number): string => {
  switch (status) {
    case 400:
      return 'invalid_request_error'
    case 401:
      return 'authentication_error'
    case 402:
      return 'billing_error'
    case 403:
      return 'permission_error'
    case 404:
      return 'not_found_error'
    case 413:
      return 'request_too_large'
    case 429:
      return 'rate_limit_error'
    case 529:
      return 'overloaded_error'
    default:
      return 'api_error'
  }
}

const defaultFaultMessage = (status: number): string => {
  switch (status) {
    case 429:
      return 'Synthetic rate limit: too many requests.'
    case 529:
      return 'Synthetic: overloaded.'
    default:
      return `Synthetic upstream error (${status}).`
  }
}

const defaultFaultBody = (status: number): Schema.Json =>
  messagesErrorEnvelope({ type: errorTypeForStatus(status), message: defaultFaultMessage(status) })

const defaultErrorEvent: MessagesWireError = {
  type: 'overloaded_error',
  message: 'Synthetic: overloaded.'
}

type MutableLedgerEntry = KernelLedgerEntry<MessagesFaultKind> & {
  body?: Schema.Json
  model?: string
  stream?: boolean
  maxTokens?: number
  thinking?: Schema.Json
  toolChoice?: Schema.Json
  toolNames: ReadonlyArray<string>
  credentialHeader?: 'x-api-key' | 'authorization'
  anthropicVersion?: string
  anthropicBeta?: string
  scripted?: 'message' | 'error'
}

const credentialHeaderOf = (request: Request): 'x-api-key' | 'authorization' | undefined => {
  if ((request.headers.get('x-api-key') ?? '').trim().length > 0) {
    return 'x-api-key'
  }

  return bearerPattern.test(request.headers.get('authorization') ?? '')
    ? 'authorization'
    : undefined
}

const isPositiveInteger = (value: Schema.Json | undefined): value is number =>
  Predicate.isNumber(value) && Number.isSafeInteger(value) && value > 0

/**
 * Create a Messages emulator from its config. Each call has independent ledger, fault, and
 * script state.
 *
 * Precedence per request: authentication, JSON and request validation (including a positive
 * integer `max_tokens`), then the first matching fault if it is a `status` fault, then the next
 * scripted turn, then model validation and defaults; a first matching body fault then shapes the
 * body. Only the first matching fault (in insertion order) applies. Credential headers are never
 * recorded, and credential values are never checked or stored.
 */
export const makeMessagesEmulator = (config: MessagesEmulatorConfig): MessagesEmulator => {
  const knownModels = [...config.knownModels]

  const errorResponse = (status: number, error: MessagesWireError): Response =>
    jsonResponse(status, messagesErrorEnvelope(error))

  const invalidRequest = (message: string): Response =>
    errorResponse(400, { type: 'invalid_request_error', message })

  const kernel = makeEmulatorKernel({
    routes: config.routes,
    faultSchema: MessagesFault,
    turnSchema: MessagesScriptedTurn,
    newEntry: (base): MutableLedgerEntry => ({ ...base, toolNames: [] }),
    snapshotEntry: (entry): MessagesLedgerEntry => ({ ...entry, toolNames: [...entry.toolNames] }),
    unknownRoute: () =>
      errorResponse(404, { type: 'not_found_error', message: 'Synthetic: no emulated route.' }),
    stateFields: () => ({ knownModels }),
    inputInvalid: config.inputInvalid
  })

  const messages = async (
    request: Request,
    entry: MutableLedgerEntry,
    path: string
  ): Promise<Response> => {
    const credentialHeader = credentialHeaderOf(request)

    if (credentialHeader === undefined) {
      entry.status = 401

      return errorResponse(401, {
        type: 'authentication_error',
        message: 'Synthetic: an x-api-key header or a bearer credential is required.'
      })
    }

    entry.credentialHeader = credentialHeader

    const version = request.headers.get('anthropic-version')
    const beta = request.headers.get('anthropic-beta')

    if (version !== null) entry.anthropicVersion = version

    if (beta !== null) entry.anthropicBeta = beta

    const text = await readText(request)
    const json = text === undefined ? undefined : parseJson(text)

    if (text === undefined || json === undefined) {
      entry.status = 400

      return invalidRequest('Synthetic: the request body is not valid JSON.')
    }

    entry.body = json

    const decoded = decodeMessagesRequest(json)

    if (Result.isFailure(decoded) || !isJsonObject(json)) {
      entry.status = 400

      return invalidRequest('Synthetic: the request body is not a Messages request.')
    }

    const body = decoded.success
    const seq = entry.seq

    if (body.model !== undefined) entry.model = body.model

    entry.stream = body.stream === true
    entry.toolNames = (body.tools ?? []).map(tool => tool.name)

    if (Predicate.isNumber(body.max_tokens)) entry.maxTokens = body.max_tokens

    if (body.thinking !== undefined) entry.thinking = body.thinking

    if (body.tool_choice !== undefined) entry.toolChoice = body.tool_choice

    const maxTokens = jsonField(json, 'max_tokens')

    if (!isPositiveInteger(maxTokens)) {
      entry.status = 400

      return invalidRequest('Synthetic: max_tokens must be a positive integer.')
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
      entry.status = 404

      return errorResponse(404, {
        type: 'not_found_error',
        message: 'Synthetic placeholder: the requested model was not found.'
      })
    }

    if (turn !== undefined) entry.scripted = 'message'

    const plan = turn === undefined ? defaultPlan(body, seq, maxTokens) : scriptedPlan(turn, seq)
    const identity = { id: `msg_synthetic_${seq}`, model: body.model ?? 'unknown' }
    const usage = planUsage(plan, text)

    if (body.stream !== true) {
      if (errorEventFault !== undefined) {
        return cannotApply('error-event-after-chunks cannot apply to a non-streamed response')
      }

      return kernel.respondWithBody(
        entry,
        200,
        { 'content-type': 'application/json' },
        [JSON.stringify(messageBody(plan, identity, usage))],
        fault
      )
    }

    const events = streamEvents(plan, identity, usage)
    const headers = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }

    if (errorEventFault === undefined) {
      return kernel.respondWithBody(entry, 200, headers, events, fault)
    }

    const after = errorEventFault.fault.chunks

    // The error must arrive before `message_stop`, or a client rightly ignores it.
    if (after >= events.length) {
      return cannotApply(
        `error-event-after-chunks after ${after} chunk(s) cannot apply to a response with ${events.length} chunk(s)`
      )
    }

    const response = kernel.respondWithBody(
      entry,
      200,
      headers,
      [
        ...events.slice(0, after),
        sseEvent('error', { error: { ...(errorEventFault.fault.error ?? defaultErrorEvent) } })
      ],
      undefined
    )

    kernel.consumeFault(errorEventFault.state, entry)

    return response
  }

  // Every manifest route maps to its own handler; construction throws `EmulatorRouteUnmapped`
  // when a manifest route has no handler (or a handler has no manifest route).
  return kernel.serve(new Map([[emulatorRouteKey('POST', config.path), messages]]))
}
