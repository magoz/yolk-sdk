/**
 * Vercel AI Gateway emulator: a plain fetch handler for the OpenAI-compatible
 * `POST /v1/chat/completions` endpoint, with scripted turns, wire faults, a
 * request ledger, and an `/_emulate/*` control plane.
 *
 * It never imports SDK code: its wire shapes follow the synthetic Gateway
 * conformance fixtures (`chat.completion.chunk` SSE, usage chunk,
 * `data: [DONE]`, and the `{ error: { message, type, code } }` envelope) and
 * are linked to those conformance case ids in `gatewayEmulatorRoutes`. The
 * Chat Completions machinery is shared with the OpenAI emulator
 * (`chat-completions.ts`); this module supplies the Gateway's paths, models,
 * envelope, and reasoning.
 *
 * Runtime-portable Web APIs only (`Request`, `Response`, `ReadableStream`,
 * `TextEncoder`, `URL`); no Effect runtime is required to use it.
 *
 * @experimental
 */
import { Data } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  ChatFault,
  ChatFaultMatch,
  ChatScriptedReasoningCompletion,
  ChatScriptedError,
  ChatScriptedToolCall,
  ChatScriptedReasoningTurn,
  ChatScriptedUsage,
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

/** Optional fault filter; an omitted field matches every request. `path` ending in `*` is a prefix. */
export const GatewayFaultMatch = ChatFaultMatch

export type GatewayFaultMatch = ChatFaultMatch

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
export const GatewayFault = ChatFault

export type GatewayFault = ChatFault

export type GatewayFaultKind = ChatFaultKind

/** Usage for a scripted turn (sent as the wire `usage` object). */
export const GatewayScriptedUsage = ChatScriptedUsage

export type GatewayScriptedUsage = ChatScriptedUsage

/** One scripted tool call; its JSON arguments stream as these fragments. */
export const GatewayScriptedToolCall = ChatScriptedToolCall

export type GatewayScriptedToolCall = ChatScriptedToolCall

/**
 * A scripted completion. Every field is exact (nothing is filled in) except:
 * `usage` omitted is synthesized when the request asks for usage, and `null`
 * drops it; `finishReason` omitted is `tool_calls` with tool calls, else
 * `stop`. `order` defaults to `reasoning-first`; `reasoningField` defaults to
 * `reasoning_content` (the Gateway-normalized alternative is `reasoning`).
 */
export const GatewayScriptedCompletion = ChatScriptedReasoningCompletion

export type GatewayScriptedCompletion = ChatScriptedReasoningCompletion

/** A scripted error response: status, body (a string is sent as is), and optional headers. */
export const GatewayScriptedError = ChatScriptedError

export type GatewayScriptedError = ChatScriptedError

/** A turn queued for the next chat completion request. */
export const GatewayScriptedTurn = ChatScriptedReasoningTurn

export type GatewayScriptedTurn = ChatScriptedReasoningTurn

/** Thrown by the JS API (`faults.add`, `script.enqueue`) for invalid input; a programmer error. */
export class GatewayEmulatorInputInvalid extends Data.TaggedError('GatewayEmulatorInputInvalid')<{
  readonly input: 'fault' | 'turn'
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid Gateway emulator ${this.input}: ${this.reason}`
  }
}

export type GatewayLedgerEntry = ChatLedgerEntry

export type GatewayFaultState = ChatFaultState

export type GatewayRouteCoverage = ChatRouteCoverage

export type GatewayCoverage = ChatCoverage

export type GatewayEmulatorOptions = {
  /** Model ids that exist. Defaults to `gatewayEmulatorDefaultModels`. */
  readonly knownModels?: ReadonlyArray<string>
  /** Model ids that stream reasoning. Defaults to `gatewayEmulatorDefaultReasoningModels`. */
  readonly reasoningModels?: ReadonlyArray<string>
}

export type GatewayEmulator = ChatCompletionsEmulator<GatewayScriptedTurn>

const gatewayErrorEnvelope = (error: ChatWireError): Schema.Json => ({
  error: { message: error.message, type: error.type, code: error.code }
})

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
 * The ledger records the `max_tokens` limit as `maxCompletionTokens`.
 *
 * Precedence per chat request: authentication and JSON validation, then the
 * first matching fault if it is a `status` fault, then the next scripted
 * turn, then model validation and defaults; a first matching chunk fault then
 * shapes the body. Only the first matching fault (in insertion order) applies. Credential headers are never
 * recorded, and the bearer value is never checked or stored.
 */
export const makeGatewayEmulator = (options: GatewayEmulatorOptions = {}): GatewayEmulator =>
  makeChatCompletionsEmulator({
    path: gatewayChatCompletionsPath,
    routes: gatewayEmulatorRoutes,
    knownModels: options.knownModels ?? gatewayEmulatorDefaultModels,
    reasoningModels: options.reasoningModels ?? gatewayEmulatorDefaultReasoningModels,
    errorEnvelope: gatewayErrorEnvelope,
    // Copied data shape of the synthetic Gateway error-envelope fixture (unknown model id).
    unknownModel: {
      status: 400,
      error: {
        message: 'Synthetic placeholder: the requested model is not available.',
        type: 'invalid_request_error',
        code: 'model_not_found'
      }
    },
    auth: {
      unauthorized: {
        message: 'Synthetic: missing or invalid authorization.',
        type: 'authentication_error',
        code: 'unauthorized'
      }
    },
    completionTokenField: 'max_tokens',
    responseIdPrefix: 'gen-synthetic',
    defaultText: ['Hello', ' from the', ' synthetic gateway.'],
    turnSchema: GatewayScriptedTurn,
    inputInvalid: (input, reason) => new GatewayEmulatorInputInvalid({ input, reason })
  })
