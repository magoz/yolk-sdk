/**
 * OpenAI Chat Completions emulator: a plain fetch handler for
 * `POST /v1/chat/completions` (origin `https://api.openai.com`), with scripted
 * turns, wire faults, a request ledger, and an `/_emulate/*` control plane.
 *
 * It never imports SDK code: its wire shapes follow the synthetic OpenAI chat
 * conformance fixtures (`chat.completion.chunk` SSE, usage chunk,
 * `data: [DONE]`, the `chat.completion` JSON body, and the
 * `{ error: { message, type, param, code } }` envelope) and are linked to
 * those conformance case ids in `openAiEmulatorRoutes`. The Chat Completions
 * machinery is shared with the Gateway emulator (`chat-completions.ts`).
 *
 * Reasoning models are not emulated yet: no default model streams reasoning,
 * and scripted turns cannot carry reasoning.
 *
 * Runtime-portable Web APIs only (`Request`, `Response`, `ReadableStream`,
 * `TextEncoder`, `URL`); no Effect runtime is required to use it.
 *
 * @experimental
 */
import { Data } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ChatFault,
  ChatFaultMatch,
  ChatScriptedError,
  ChatScriptedToolCall,
  ChatScriptedUsage,
  chatScriptedCompletionFields,
  makeChatCompletionsEmulator,
  type ChatCompletionsEmulator,
  type ChatCoverage,
  type ChatFaultKind,
  type ChatFaultState,
  type ChatLedgerEntry,
  type ChatRouteCoverage,
  type ChatWireError
} from './chat-completions.ts'
import type { EmulatorRouteEvidence } from './route-evidence.ts'

export type { EmulatorEvidence, EmulatorRouteEvidence } from './route-evidence.ts'

export { emulatorEvidenceHeader } from './route-evidence.ts'

export const openAiChatCompletionsPath = '/v1/chat/completions'

/** Synthetic-safe default model ids, including the OpenAI chat conformance defaults. */
export const openAiEmulatorDefaultModels: ReadonlyArray<string> = ['gpt-4.1-nano', 'gpt-4.1-mini']

/**
 * Route evidence manifest: every emulated OpenAI route and the conformance
 * cases whose (currently synthetic, unverified) wire shapes it follows.
 */
export const openAiEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> = [
  {
    method: 'POST',
    path: openAiChatCompletionsPath,
    kind: 'provider',
    write: false,
    caseIds: [
      'openai.chat.stream.plain-text',
      'openai.chat.stream.tool-call-deltas',
      'openai.chat.stream.error-envelope',
      'openai.chat.json.plain-text'
    ],
    evidence: 'unverified',
    observedAt: undefined
  }
]

/** Optional fault filter; an omitted field matches every request. `path` ending in `*` is a prefix. */
export const OpenAiFaultMatch = ChatFaultMatch

export type OpenAiFaultMatch = ChatFaultMatch

/**
 * Wire faults for emulated routes, the same kinds as the Gateway emulator:
 * `status` (the body defaults to an OpenAI error envelope),
 * `error-after-chunks`, and `truncate-after-chunks`. Statuses that cannot
 * carry a body and redirects are rejected, as are invalid headers and
 * `location`. A chunk fault that cannot take effect answers 500 and is not
 * consumed.
 */
export const OpenAiFault = ChatFault

export type OpenAiFault = ChatFault

export type OpenAiFaultKind = ChatFaultKind

/** Usage for a scripted turn (sent as the wire `usage` object). */
export const OpenAiScriptedUsage = ChatScriptedUsage

export type OpenAiScriptedUsage = ChatScriptedUsage

/** One scripted tool call; its JSON arguments stream as these fragments. */
export const OpenAiScriptedToolCall = ChatScriptedToolCall

export type OpenAiScriptedToolCall = ChatScriptedToolCall

/**
 * A scripted completion. Every field is exact (nothing is filled in) except:
 * `usage` omitted is synthesized when the request asks for usage, and `null`
 * drops it; `finishReason` omitted is `tool_calls` with tool calls, else
 * `stop`. Reasoning is not emulated: reasoning fields are rejected.
 */
export const OpenAiScriptedCompletion = Schema.Struct(chatScriptedCompletionFields)

export type OpenAiScriptedCompletion = typeof OpenAiScriptedCompletion.Type

/** A scripted error response: status, body (a string is sent as is), and optional headers. */
export const OpenAiScriptedError = ChatScriptedError

export type OpenAiScriptedError = ChatScriptedError

/** A turn queued for the next chat completion request. */
export const OpenAiScriptedTurn = Schema.Union([OpenAiScriptedError, OpenAiScriptedCompletion])

export type OpenAiScriptedTurn = typeof OpenAiScriptedTurn.Type

/** Thrown by the JS API (`faults.add`, `script.enqueue`) for invalid input; a programmer error. */
export class OpenAiEmulatorInputInvalid extends Data.TaggedError('OpenAiEmulatorInputInvalid')<{
  readonly input: 'fault' | 'turn'
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid OpenAI emulator ${this.input}: ${this.reason}`
  }
}

export type OpenAiLedgerEntry = ChatLedgerEntry

export type OpenAiFaultState = ChatFaultState

export type OpenAiRouteCoverage = ChatRouteCoverage

export type OpenAiCoverage = ChatCoverage

export type OpenAiEmulatorOptions = {
  /** Model ids that exist. Defaults to `openAiEmulatorDefaultModels`. */
  readonly knownModels?: ReadonlyArray<string>
}

export type OpenAiEmulator = ChatCompletionsEmulator<OpenAiScriptedTurn>

const openAiErrorEnvelope = (error: ChatWireError): Schema.Json => ({
  error: { message: error.message, type: error.type, param: null, code: error.code }
})

/**
 * Create an OpenAI Chat Completions emulator. Each call has independent
 * ledger, fault, and script state.
 *
 * Without a script, `POST /v1/chat/completions` answers a known model with
 * synthetic text deltas (`stream: true`: `chat.completion.chunk` SSE, a finish
 * chunk, a usage chunk when `stream_options.include_usage` is set, and
 * `data: [DONE]`; `stream: false`: one `chat.completion` JSON body). A request
 * with `tools` gets one tool call whose arguments are synthesized from the
 * tool's JSON Schema and streamed in fragments, finishing with `tool_calls`.
 * Unknown models get the OpenAI error envelope (404, `model_not_found`); a
 * missing bearer credential gets a 401 envelope (`invalid_api_key`); unknown
 * routes get a 404 JSON error. The ledger records the
 * `max_completion_tokens` limit as `maxCompletionTokens`.
 *
 * Precedence per chat request matches the Gateway emulator: authentication and
 * JSON validation, then the first matching `status` fault, then the next
 * scripted turn, then model validation and defaults; a first matching chunk
 * fault then shapes the body. Credential headers are never recorded, and the
 * bearer value is never checked or stored.
 */
export const makeOpenAiEmulator = (options: OpenAiEmulatorOptions = {}): OpenAiEmulator =>
  makeChatCompletionsEmulator({
    path: openAiChatCompletionsPath,
    routes: openAiEmulatorRoutes,
    knownModels: options.knownModels ?? openAiEmulatorDefaultModels,
    reasoningModels: undefined,
    errorEnvelope: openAiErrorEnvelope,
    // Copied data shape of the synthetic OpenAI error-envelope fixture (unknown model id).
    unknownModel: {
      status: 404,
      error: {
        message: 'Synthetic placeholder: the requested model does not exist.',
        type: 'invalid_request_error',
        code: 'model_not_found'
      }
    },
    auth: {
      unauthorized: {
        message: 'Synthetic: missing or invalid API key.',
        type: 'invalid_request_error',
        code: 'invalid_api_key'
      }
    },
    completionTokenField: 'max_completion_tokens',
    responseIdPrefix: 'chatcmpl-synthetic',
    defaultText: ['Hello', ' from the', ' synthetic OpenAI emulator.'],
    turnSchema: OpenAiScriptedTurn,
    inputInvalid: (input, reason) => new OpenAiEmulatorInputInvalid({ input, reason })
  })
