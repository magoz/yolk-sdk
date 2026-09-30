/**
 * OpenCode Go emulator: one plain fetch handler for the origin `https://opencode.ai`, serving the
 * three protocols the OpenCode Go provider speaks under `/zen/go/v1` plus the Go
 * subscription-usage route:
 *
 * - `POST /zen/go/v1/chat/completions`: OpenAI-compatible Chat Completions (the shared Chat
 *   Completions core; `max_tokens`, plain OpenAI framing, `reasoning_content` for scripted
 *   reasoning), Bearer auth;
 * - `POST /zen/go/v1/messages`: Anthropic Messages (the shared Messages core), `x-api-key` auth
 *   only (the Go provider never sends Claude OAuth) and `anthropic-version: 2023-06-01`;
 * - `POST /zen/go/v1/responses`: OpenAI Responses (the shared Responses core), Bearer auth,
 *   optional positive `max_output_tokens`;
 * - `GET /zen/go/v1/usage`: `{ usage: { rolling, weekly, monthly } }` windows as
 *   `{ percent, resetsAt }`, Bearer auth.
 *
 * Each route keeps its own ledger, faults, scripted turns, and control plane (`emulator.chat`,
 * `emulator.messages`, `emulator.responses`, `emulator.usage`; over HTTP `/_emulate/<part>/*`);
 * `emulator.coverage()` and `GET /_emulate/coverage` combine them, and `emulator.reset()` and
 * `POST /_emulate/reset` reset all four. Unknown API routes fail closed through the chat part (404,
 * written to its ledger).
 *
 * It never imports SDK code: its wire shapes follow the synthetic OpenCode Go conformance fixtures
 * and are linked to those case ids in `openCodeGoEmulatorRoutes` (all `unverified`).
 *
 * Runtime-portable Web APIs only (`Request`, `Response`, `ReadableStream`, `TextEncoder`, `URL`);
 * no Effect runtime is required to use it.
 *
 * @experimental
 */
import { Data } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  ChatScriptedReasoningTurn,
  makeChatCompletionsEmulator,
  type ChatCompletionsEmulator,
  type ChatWireError
} from './chat-completions.ts'
import { combinedCoverage, composeFetch, type ComposedPart } from './emulator-compose.ts'
import { jsonResponse, type EmulatorCoverage } from './emulator-kernel.ts'
import { makeMessagesEmulator, type MessagesEmulator } from './messages.ts'
import {
  makeResponsesEmulator,
  type ResponsesEmulator,
  type ResponsesWireError
} from './responses.ts'
import type { EmulatorRouteEvidence } from './route-evidence.ts'
import {
  makeSubscriptionUsageEmulator,
  type SubscriptionUsageEmulator
} from './subscription-usage.ts'

export type { EmulatorEvidence, EmulatorRouteEvidence } from './route-evidence.ts'

export { emulatorEvidenceHeader } from './route-evidence.ts'

export type { ChatScriptedReasoningTurn as OpenCodeGoChatScriptedTurn } from './chat-completions.ts'

export type { MessagesScriptedTurn as OpenCodeGoMessagesScriptedTurn } from './messages.ts'

export type { ResponsesScriptedTurn as OpenCodeGoResponsesScriptedTurn } from './responses.ts'

export type { SubscriptionUsageScriptedTurn as OpenCodeGoUsageScriptedTurn } from './subscription-usage.ts'

export const openCodeGoChatCompletionsPath = '/zen/go/v1/chat/completions'

export const openCodeGoMessagesPath = '/zen/go/v1/messages'

export const openCodeGoResponsesPath = '/zen/go/v1/responses'

/** The Go subscription-usage path (`openCodeGoSubscriptionUsageUrl` in the SDK). */
export const openCodeGoUsagePath = '/zen/go/v1/usage'

/**
 * Synthetic-safe default model ids (the Go conformance defaults), accepted on every protocol. Go
 * model ids are opaque and unprefixed; the emulator does not tie a model to a protocol.
 */
export const openCodeGoEmulatorDefaultModels: ReadonlyArray<string> = [
  'synthetic-go-chat',
  'synthetic-go-messages',
  'synthetic-go-responses'
]

/**
 * Route evidence manifest: every emulated OpenCode Go route and the conformance cases whose
 * (synthetic, unverified) wire shapes it follows.
 */
export const openCodeGoEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> = [
  {
    method: 'POST',
    path: openCodeGoChatCompletionsPath,
    kind: 'provider',
    write: false,
    caseIds: ['opencode.go.chat.stream.plain-text'],
    evidence: 'unverified',
    observedAt: undefined
  },
  {
    method: 'POST',
    path: openCodeGoMessagesPath,
    kind: 'provider',
    write: false,
    caseIds: ['opencode.go.messages.stream.plain-text'],
    evidence: 'unverified',
    observedAt: undefined
  },
  {
    method: 'POST',
    path: openCodeGoResponsesPath,
    kind: 'provider',
    write: false,
    caseIds: [
      'opencode.go.responses.stream.plain-text',
      'opencode.go.responses.stream.commentary-replay'
    ],
    evidence: 'unverified',
    observedAt: undefined
  },
  {
    method: 'GET',
    path: openCodeGoUsagePath,
    kind: 'provider',
    write: false,
    caseIds: ['opencode.go.usage.snapshot'],
    evidence: 'unverified',
    observedAt: undefined
  }
]

/**
 * Default Go usage body: `usage.rolling`, `usage.weekly`, and `usage.monthly` as
 * `{ percent, resetsAt }`, with synthetic values.
 */
export const openCodeGoUsageDefault: Schema.Json = {
  usage: {
    rolling: { percent: 12.5, resetsAt: '2026-10-01T03:00:00.000Z' },
    weekly: { percent: 40, resetsAt: '2026-10-05T00:00:00.000Z' },
    monthly: { percent: 55, resetsAt: '2026-10-31T00:00:00.000Z' }
  }
}

/** Thrown by the JS API (`faults.add`, `script.enqueue`) for invalid input; a programmer error. */
export class OpenCodeGoEmulatorInputInvalid extends Data.TaggedError(
  'OpenCodeGoEmulatorInputInvalid'
)<{
  readonly protocol: 'chat-completions' | 'messages' | 'responses' | 'usage'
  readonly input: 'fault' | 'turn'
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid OpenCode Go ${this.protocol} emulator ${this.input}: ${this.reason}`
  }
}

export type OpenCodeGoEmulatorOptions = {
  /** Model ids that exist (on every protocol). Defaults to `openCodeGoEmulatorDefaultModels`. */
  readonly knownModels?: ReadonlyArray<string>
  /** Default usage-route body. Defaults to `openCodeGoUsageDefault`. */
  readonly usage?: Schema.Json
}

export type OpenCodeGoChatEmulator = ChatCompletionsEmulator<ChatScriptedReasoningTurn>

export type OpenCodeGoEmulator = {
  /** The fetch handler for every route and the `/_emulate/*` control plane. Never rejects. */
  readonly fetch: (request: Request) => Promise<Response>
  /** Reset every part (ledgers, faults, and scripted turns). */
  readonly reset: () => void
  /** Every route's coverage, in manifest order. */
  readonly coverage: () => EmulatorCoverage
  /** `POST /zen/go/v1/chat/completions` (control plane `/_emulate/chat/*`). */
  readonly chat: OpenCodeGoChatEmulator
  /** `POST /zen/go/v1/messages` (control plane `/_emulate/messages/*`). */
  readonly messages: MessagesEmulator
  /** `POST /zen/go/v1/responses` (control plane `/_emulate/responses/*`). */
  readonly responses: ResponsesEmulator
  /** `GET /zen/go/v1/usage` (control plane `/_emulate/usage/*`). */
  readonly usage: SubscriptionUsageEmulator
}

const routesFor = (path: string): ReadonlyArray<EmulatorRouteEvidence> =>
  openCodeGoEmulatorRoutes.filter(route => route.path === path)

const openAiErrorEnvelope = (error: ChatWireError | ResponsesWireError): Schema.Json => ({
  error: {
    message: error.message,
    type: error.type,
    param: 'param' in error && error.param !== undefined ? error.param : null,
    code: error.code
  }
})

const unauthorized = {
  message: 'Synthetic: missing or invalid API key.',
  type: 'invalid_request_error',
  code: 'invalid_api_key'
} as const

const unknownModel = {
  message: 'Synthetic placeholder: the requested model is not available on OpenCode Go.',
  type: 'invalid_request_error',
  code: 'model_not_found'
} as const

/**
 * Create an OpenCode Go emulator. Each call has independent state for every part.
 *
 * Without a script: chat answers a known model with plain OpenAI `chat.completion.chunk` SSE
 * (usage in a trailing chunk when `stream_options.include_usage` is set) or a JSON body; Messages
 * streams `message_start` ... `message_stop` (or a `message` body); Responses streams
 * `response.created` ... `response.completed` (or a `response` body); usage answers
 * `openCodeGoUsageDefault`. Unknown models get 404 (chat, Messages) or 400 (Responses); missing
 * credentials get 401 (a bearer for chat, Responses, and usage; `x-api-key` for Messages, where
 * a bearer alone is refused). Credential values are never checked or stored. Scripted turns,
 * faults, and ledgers are per part: `emulator.chat.script.enqueue(...)`,
 * `emulator.responses.faults.add(...)`, `emulator.usage.script.enqueue({ usage })`, and so on.
 */
export const makeOpenCodeGoEmulator = (
  options: OpenCodeGoEmulatorOptions = {}
): OpenCodeGoEmulator => {
  const knownModels = options.knownModels ?? openCodeGoEmulatorDefaultModels

  const inputInvalid =
    (protocol: OpenCodeGoEmulatorInputInvalid['protocol']) =>
    (input: 'fault' | 'turn', reason: string) =>
      new OpenCodeGoEmulatorInputInvalid({ protocol, input, reason })

  const chat = makeChatCompletionsEmulator({
    path: openCodeGoChatCompletionsPath,
    routes: routesFor(openCodeGoChatCompletionsPath),
    knownModels,
    reasoningModels: [],
    errorEnvelope: openAiErrorEnvelope,
    unknownModel: { status: 404, error: unknownModel },
    auth: { unauthorized },
    completionTokenField: 'max_tokens',
    responseIdPrefix: 'chatcmpl-synthetic-go',
    defaultText: ['Hello', ' from the', ' synthetic OpenCode Go emulator.'],
    turnSchema: ChatScriptedReasoningTurn,
    inputInvalid: inputInvalid('chat-completions')
  })

  const messages = makeMessagesEmulator({
    path: openCodeGoMessagesPath,
    routes: routesFor(openCodeGoMessagesPath),
    knownModels,
    credentials: 'x-api-key',
    inputInvalid: inputInvalid('messages')
  })

  const responses = makeResponsesEmulator({
    path: openCodeGoResponsesPath,
    routes: routesFor(openCodeGoResponsesPath),
    knownModels,
    errorEnvelope: openAiErrorEnvelope,
    unknownModel: { status: 400, error: { ...unknownModel, param: 'model' } },
    unauthorized,
    headers: [],
    outputTokenLimit: 'optional',
    defaultText: ['Hello', ' from the', ' synthetic OpenCode Go emulator.'],
    inputInvalid: inputInvalid('responses')
  })

  const usage = makeSubscriptionUsageEmulator({
    path: openCodeGoUsagePath,
    routes: routesFor(openCodeGoUsagePath),
    usage: options.usage ?? openCodeGoUsageDefault,
    errorEnvelope: openAiErrorEnvelope,
    unauthorized,
    headers: [],
    query: [],
    inputInvalid: inputInvalid('usage')
  })

  const parts: ReadonlyArray<ComposedPart> = [chat, messages, responses, usage]
  const coverage = () => combinedCoverage(parts)

  const reset = () => {
    for (const part of parts) part.reset()
  }

  const fetch = composeFetch({
    routes: [
      { name: 'chat', paths: [openCodeGoChatCompletionsPath], part: chat },
      { name: 'messages', paths: [openCodeGoMessagesPath], part: messages },
      { name: 'responses', paths: [openCodeGoResponsesPath], part: responses },
      { name: 'usage', paths: [openCodeGoUsagePath], part: usage }
    ],
    fallback: chat,
    control: async (request, path) =>
      path === '/_emulate/coverage' && request.method === 'GET'
        ? jsonResponse(200, coverage())
        : jsonResponse(404, {
            error: {
              message:
                'unknown control-plane route: use /_emulate/{chat,messages,responses,usage}/*, GET /_emulate/coverage, or POST /_emulate/reset',
              type: 'emulator_error'
            }
          })
  })

  return { fetch, reset, coverage, chat, messages, responses, usage }
}
