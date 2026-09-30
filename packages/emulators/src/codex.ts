/**
 * OpenAI Codex (ChatGPT subscription) Responses emulator: a plain fetch handler for
 * `POST /backend-api/codex/responses` (origin `https://chatgpt.com`), with scripted turns, wire
 * faults, a request ledger, and an `/_emulate/*` control plane.
 *
 * It never imports SDK code: its wire shapes follow the synthetic Codex Responses conformance
 * fixtures (Responses SSE with typed `event:` names, the `response` JSON body, and the
 * `{ error: { message, type, param, code } }` envelope) and are linked to those conformance case
 * ids in `codexEmulatorRoutes`. The Responses machinery lives in the internal `responses.ts` core
 * and is shared with the xAI Grok emulator.
 *
 * Requests authenticate with a non-empty `Authorization: Bearer` credential (a ChatGPT OAuth
 * access token), never checked or stored. The ChatGPT Codex endpoint does not take an output
 * limit, so a request with `max_output_tokens` answers 400 `unsupported_parameter`. The
 * `originator` header is recorded in the ledger; `ChatGPT-Account-Id` is neither required nor
 * recorded.
 *
 * The same fetch handler also answers the Codex subscription-usage route
 * (`GET /backend-api/wham/usage`, `emulator.usage`) with its own manifest
 * (`codexSubscriptionUsageEmulatorRoutes`), ledger, faults, and turns; see `makeCodexEmulator`.
 *
 * Runtime-portable Web APIs only (`Request`, `Response`, `ReadableStream`, `TextEncoder`, `URL`);
 * no Effect runtime is required to use it.
 *
 * @experimental
 */
import { Data } from 'effect'
import type * as Schema from 'effect/Schema'
import { withSubscriptionUsage } from './emulator-compose.ts'
import type {
  EmulatorCoverage,
  EmulatorFaultState,
  EmulatorRouteCoverage
} from './emulator-kernel.ts'
import { EmulatorFaultMatch, EmulatorScriptedError } from './emulator-kernel.ts'
import {
  makeResponsesEmulator,
  ResponsesErrorEventFault,
  ResponsesFault,
  ResponsesScriptedFunctionCall,
  ResponsesScriptedResponse,
  ResponsesScriptedTurn,
  ResponsesScriptedUsage,
  ResponsesStreamError,
  type ResponsesEmulator,
  type ResponsesFaultKind,
  type ResponsesLedgerEntry,
  type ResponsesWireError
} from './responses.ts'
import type { EmulatorRouteEvidence } from './route-evidence.ts'
import {
  makeSubscriptionUsageEmulator,
  recordedUsageBody,
  SubscriptionUsageFault,
  type SubscriptionUsageEmulator,
  type SubscriptionUsageLedgerEntry,
  type SubscriptionUsageScriptedTurn
} from './subscription-usage.ts'
import { codexUsageRecording } from './subscription-usage-recordings.ts'

export type { EmulatorEvidence, EmulatorRouteEvidence } from './route-evidence.ts'

export { emulatorEvidenceHeader } from './route-evidence.ts'

export const codexResponsesPath = '/backend-api/codex/responses'

/** The Codex subscription-usage path (`openAiCodexSubscriptionUsageUrl` in the SDK). */
export const codexSubscriptionUsagePath = '/backend-api/wham/usage'

/**
 * Route evidence manifest of the Codex subscription-usage route (served by the same fetch handler
 * as the Responses route, with its own ledger and coverage). Synthetic, unverified.
 */
export const codexSubscriptionUsageEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> = [
  {
    method: 'GET',
    path: codexSubscriptionUsagePath,
    kind: 'provider',
    write: false,
    caseIds: ['openai.codex.usage.snapshot'],
    evidence: 'unverified',
    observedAt: undefined
  }
]

/**
 * The recorded Codex usage body (the synthetic `openai.codex.usage.snapshot` fixture, copied as
 * data): `rate_limit.primary_window` and `secondary_window` as
 * `{ used_percent, limit_window_seconds, reset_after_seconds, reset_at }`.
 */
export const codexSubscriptionUsageDefault: Schema.Json = recordedUsageBody(codexUsageRecording)

/** Synthetic-safe default model ids, including the Codex conformance defaults. */
export const codexEmulatorDefaultModels: ReadonlyArray<string> = ['gpt-5.4', 'gpt-5.5']

/**
 * Route evidence manifest: every emulated Codex route and the conformance cases whose (currently
 * synthetic, unverified) wire shapes it follows.
 */
export const codexEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> = [
  {
    method: 'POST',
    path: codexResponsesPath,
    kind: 'provider',
    write: false,
    caseIds: [
      'openai.codex.stream.plain-text',
      'openai.codex.stream.function-call-arguments',
      'openai.codex.stream.error-envelope',
      'openai.codex.stream.terminal-event'
    ],
    evidence: 'unverified',
    observedAt: undefined
  }
]

/** Optional fault filter; an omitted field matches every request. `path` ending in `*` is a prefix. */
export const CodexFaultMatch = EmulatorFaultMatch

export type CodexFaultMatch = typeof EmulatorFaultMatch.Type

/** A mid-stream Responses error (`{ code, message }`). */
export const CodexStreamError = ResponsesStreamError

export type CodexStreamError = ResponsesStreamError

/** A mid-stream `error` or `response.failed` event fault, streamed responses only. */
export const CodexErrorEventFault = ResponsesErrorEventFault

export type CodexErrorEventFault = typeof ResponsesErrorEventFault.Type

/**
 * Wire faults:
 *
 * - `status`: answer with this status, headers, and body (for example 429 with `retry-after`).
 *   The body defaults to the OpenAI error envelope for the status.
 * - `error-after-chunks`: send N body chunks, then error the body stream (a dropped connection).
 * - `truncate-after-chunks`: send N body chunks, then close cleanly (no `response.completed`).
 * - `error-event-after-chunks`: send N SSE events, then one `error` (default) or
 *   `response.failed` event and close.
 *
 * Statuses that cannot carry a body and redirects are rejected, as are invalid headers and
 * `location`. A fault that cannot take effect answers 500 and is not consumed.
 */
export const CodexFault = ResponsesFault

export type CodexFault = ResponsesFault

export type CodexFaultKind = ResponsesFaultKind

/** Usage for a scripted turn (sent in `response.completed` or the JSON body). */
export const CodexScriptedUsage = ResponsesScriptedUsage

export type CodexScriptedUsage = ResponsesScriptedUsage

/** One scripted `function_call` item; its arguments stream as these fragments. */
export const CodexScriptedFunctionCall = ResponsesScriptedFunctionCall

export type CodexScriptedFunctionCall = ResponsesScriptedFunctionCall

/**
 * A scripted response: `reasoning` (summary fragments), `text`, `functionCalls`, `order`,
 * `usage` (`null` drops it), and `format` (`sse` or `json`, default: the request's `stream`).
 */
export const CodexScriptedResponse = ResponsesScriptedResponse

export type CodexScriptedResponse = ResponsesScriptedResponse

/** A scripted error response: status, body (a string is sent as is), and optional headers. */
export const CodexScriptedError = EmulatorScriptedError

export type CodexScriptedError = typeof EmulatorScriptedError.Type

/** A turn queued for the next Codex request. */
export const CodexScriptedTurn = ResponsesScriptedTurn

export type CodexScriptedTurn = ResponsesScriptedTurn

/** Thrown by the JS API (`faults.add`, `script.enqueue`) for invalid input; a programmer error. */
export class CodexEmulatorInputInvalid extends Data.TaggedError('CodexEmulatorInputInvalid')<{
  readonly input: 'fault' | 'turn'
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid Codex emulator ${this.input}: ${this.reason}`
  }
}

export type CodexLedgerEntry = ResponsesLedgerEntry

export type CodexFaultState = EmulatorFaultState<CodexFault>

export type CodexRouteCoverage = EmulatorRouteCoverage

export type CodexCoverage = EmulatorCoverage

/** A usage-route fault (`status`, `error-after-chunks`, `truncate-after-chunks`). */
export const CodexUsageFault = SubscriptionUsageFault

export type CodexUsageFault = SubscriptionUsageFault

/** A usage turn: `{ usage }` (a body with the recorded JSON shape) or `{ error }`. */
export type CodexUsageScriptedTurn = SubscriptionUsageScriptedTurn

export type CodexUsageLedgerEntry = SubscriptionUsageLedgerEntry

export type CodexUsageEmulator = SubscriptionUsageEmulator

export type CodexEmulatorOptions = {
  /** Model ids that exist. Defaults to `codexEmulatorDefaultModels`. */
  readonly knownModels?: ReadonlyArray<string>
  /**
   * Replacement usage-route body; must have the recorded JSON shape (same keys and value kinds).
   * Defaults to the recorded body (`codexSubscriptionUsageDefault`).
   */
  readonly subscriptionUsage?: Schema.Json
}

/** The Responses emulator, plus `usage`: the subscription-usage route's own emulator API. */
export type CodexEmulator = ResponsesEmulator & { readonly usage: CodexUsageEmulator }

const openAiErrorEnvelope = (error: ResponsesWireError): Schema.Json => ({
  error: {
    message: error.message,
    type: error.type,
    param: error.param ?? null,
    code: error.code
  }
})

/**
 * Create a Codex Responses emulator. Each call has independent ledger, fault, and script state.
 *
 * Without a script, `POST /backend-api/codex/responses` answers a known model with synthetic
 * output: `stream: true` streams `response.created`, `response.in_progress`, the output items
 * (`response.output_item.added`, their parts and deltas, `response.output_item.done`), and
 * `response.completed` with usage; `stream: false` returns one `response` JSON body. A request
 * whose `reasoning` asks for a `summary` (the Codex provider always does) gets a reasoning item
 * first. A request with function `tools` gets one `function_call` item whose arguments are
 * synthesized from the tool's JSON Schema and streamed as `response.function_call_arguments.delta`
 * fragments; `tool_choice: { type: 'function', name }` picks that tool (otherwise the first) and
 * `tool_choice: 'none'` answers with text. Unknown models get 400 `model_not_found`; a request
 * without a bearer credential gets 401 `invalid_api_key`; `max_output_tokens` gets 400
 * `unsupported_parameter`; unknown routes get a 404 envelope. Not enforced: `store: false`,
 * `stream: true`, `instructions`, `originator`, and `ChatGPT-Account-Id`.
 *
 * `GET /backend-api/wham/usage` is fixture-only: a request with a non-empty bearer credential and
 * a non-empty `ChatGPT-Account-Id` (neither checked or recorded), `accept: application/json`, and
 * no query gets the recorded body (`codexSubscriptionUsageDefault`, or a same-shaped
 * `options.subscriptionUsage` / scripted `{ usage }`); anything else answers 400 not-emulated.
 * Its ledger, faults, turns, and coverage are `emulator.usage` (control plane
 * `/_emulate/usage/*`); `reset()` and `POST /_emulate/reset` reset both routes.
 */
export const makeCodexEmulator = (options: CodexEmulatorOptions = {}): CodexEmulator =>
  withSubscriptionUsage(
    makeCodexResponsesEmulator(options),
    makeCodexUsageEmulator(options),
    codexSubscriptionUsagePath
  )

const makeCodexUsageEmulator = (options: CodexEmulatorOptions): CodexUsageEmulator =>
  makeSubscriptionUsageEmulator({
    path: codexSubscriptionUsagePath,
    routes: codexSubscriptionUsageEmulatorRoutes,
    recording: codexUsageRecording,
    headers: [{ name: 'chatgpt-account-id', record: false }],
    subscriptionUsage: options.subscriptionUsage,
    inputInvalid: (input, reason) => new CodexEmulatorInputInvalid({ input, reason })
  })

const makeCodexResponsesEmulator = (options: CodexEmulatorOptions): ResponsesEmulator =>
  makeResponsesEmulator({
    path: codexResponsesPath,
    routes: codexEmulatorRoutes,
    knownModels: options.knownModels ?? codexEmulatorDefaultModels,
    errorEnvelope: openAiErrorEnvelope,
    // Copied data shape of the synthetic Codex error-envelope fixture (unknown model id).
    unknownModel: {
      status: 400,
      error: {
        message: 'Synthetic placeholder: the requested model is not supported.',
        type: 'invalid_request_error',
        code: 'model_not_found',
        param: 'model'
      }
    },
    unauthorized: {
      message: 'Synthetic: missing or invalid bearer credential.',
      type: 'invalid_request_error',
      code: 'invalid_api_key'
    },
    headers: [{ name: 'originator', record: true }],
    outputTokenLimit: 'rejected',
    defaultText: ['Hello', ' from the', ' synthetic Codex emulator.'],
    inputInvalid: (input, reason) => new CodexEmulatorInputInvalid({ input, reason })
  })
