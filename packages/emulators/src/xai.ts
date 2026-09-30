/**
 * xAI Grok CLI proxy Responses emulator: a plain fetch handler for `POST /v1/responses` (origin
 * `https://cli-chat-proxy.grok.com`), with scripted turns, wire faults, a request ledger, and an
 * `/_emulate/*` control plane.
 *
 * It never imports SDK code: its wire shapes follow the synthetic Grok Responses conformance
 * fixtures (Responses SSE with typed `event:` names, the `response` JSON body, and the
 * `{ error: { message, type, param, code } }` envelope) and are linked to those conformance case
 * ids in `xAiGrokEmulatorRoutes`. The Responses machinery lives in the internal `responses.ts`
 * core and is shared with the Codex emulator.
 *
 * Requests authenticate with a non-empty `Authorization: Bearer` credential (a Grok OAuth access
 * token) and must also send, in this order, a non-empty `X-XAI-Token-Auth` (401 without it; never
 * recorded or checked), `x-grok-client-version` (426 without it: the proxy version-gates
 * requests), and `x-grok-model-override` (400 without it). The client version and model override
 * are recorded in the ledger; the version value itself is not checked.
 *
 * Runtime-portable Web APIs only (`Request`, `Response`, `ReadableStream`, `TextEncoder`, `URL`);
 * no Effect runtime is required to use it.
 *
 * @experimental
 */
import { Data } from 'effect'
import type * as Schema from 'effect/Schema'
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

export type { EmulatorEvidence, EmulatorRouteEvidence } from './route-evidence.ts'

export { emulatorEvidenceHeader } from './route-evidence.ts'

export const xAiGrokResponsesPath = '/v1/responses'

/** Synthetic-safe default model ids, including the Grok conformance defaults. */
export const xAiGrokEmulatorDefaultModels: ReadonlyArray<string> = ['grok-build', 'grok-4.6']

/**
 * Route evidence manifest: every emulated Grok route and the conformance cases whose (currently
 * synthetic, unverified) wire shapes it follows.
 */
export const xAiGrokEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> = [
  {
    method: 'POST',
    path: xAiGrokResponsesPath,
    kind: 'provider',
    write: false,
    caseIds: [
      'xai.grok.stream.plain-text',
      'xai.grok.stream.function-call-arguments',
      'xai.grok.stream.error-envelope',
      'xai.grok.stream.terminal-event'
    ],
    evidence: 'unverified',
    observedAt: undefined
  }
]

/** Optional fault filter; an omitted field matches every request. `path` ending in `*` is a prefix. */
export const XAiGrokFaultMatch = EmulatorFaultMatch

export type XAiGrokFaultMatch = typeof EmulatorFaultMatch.Type

/** A mid-stream Responses error (`{ code, message }`). */
export const XAiGrokStreamError = ResponsesStreamError

export type XAiGrokStreamError = ResponsesStreamError

/** A mid-stream `error` or `response.failed` event fault, streamed responses only. */
export const XAiGrokErrorEventFault = ResponsesErrorEventFault

export type XAiGrokErrorEventFault = typeof ResponsesErrorEventFault.Type

/**
 * Wire faults: `status` (for example 429 with `retry-after`; the body defaults to the error
 * envelope for the status), `error-after-chunks` (a dropped connection),
 * `truncate-after-chunks` (a clean close, for example before `response.completed`), and
 * `error-event-after-chunks` (a mid-stream `error` or `response.failed` event). Statuses that
 * cannot carry a body and redirects are rejected, as are invalid headers and `location`. A fault
 * that cannot take effect answers 500 and is not consumed.
 */
export const XAiGrokFault = ResponsesFault

export type XAiGrokFault = ResponsesFault

export type XAiGrokFaultKind = ResponsesFaultKind

/** Usage for a scripted turn (sent in `response.completed` or the JSON body). */
export const XAiGrokScriptedUsage = ResponsesScriptedUsage

export type XAiGrokScriptedUsage = ResponsesScriptedUsage

/** One scripted `function_call` item; its arguments stream as these fragments. */
export const XAiGrokScriptedFunctionCall = ResponsesScriptedFunctionCall

export type XAiGrokScriptedFunctionCall = ResponsesScriptedFunctionCall

/**
 * A scripted response: `reasoning` (summary fragments), `text`, `functionCalls`, `order`,
 * `usage` (`null` drops it), and `format` (`sse` or `json`, default: the request's `stream`).
 */
export const XAiGrokScriptedResponse = ResponsesScriptedResponse

export type XAiGrokScriptedResponse = ResponsesScriptedResponse

/** A scripted error response: status, body (a string is sent as is), and optional headers. */
export const XAiGrokScriptedError = EmulatorScriptedError

export type XAiGrokScriptedError = typeof EmulatorScriptedError.Type

/** A turn queued for the next Grok request. */
export const XAiGrokScriptedTurn = ResponsesScriptedTurn

export type XAiGrokScriptedTurn = ResponsesScriptedTurn

/** Thrown by the JS API (`faults.add`, `script.enqueue`) for invalid input; a programmer error. */
export class XAiGrokEmulatorInputInvalid extends Data.TaggedError('XAiGrokEmulatorInputInvalid')<{
  readonly input: 'fault' | 'turn'
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid xAI Grok emulator ${this.input}: ${this.reason}`
  }
}

export type XAiGrokLedgerEntry = ResponsesLedgerEntry

export type XAiGrokFaultState = EmulatorFaultState<XAiGrokFault>

export type XAiGrokRouteCoverage = EmulatorRouteCoverage

export type XAiGrokCoverage = EmulatorCoverage

export type XAiGrokEmulatorOptions = {
  /** Model ids that exist. Defaults to `xAiGrokEmulatorDefaultModels`. */
  readonly knownModels?: ReadonlyArray<string>
}

export type XAiGrokEmulator = ResponsesEmulator

const errorEnvelope = (error: ResponsesWireError): Schema.Json => ({
  error: {
    message: error.message,
    type: error.type,
    param: error.param ?? null,
    code: error.code
  }
})

/**
 * Create a Grok CLI proxy Responses emulator. Each call has independent ledger, fault, and script
 * state.
 *
 * Without a script, `POST /v1/responses` answers a known model with synthetic output: `stream:
 * true` streams `response.created`, `response.in_progress`, the output items
 * (`response.output_item.added`, their parts and deltas, `response.output_item.done`), and
 * `response.completed` with usage; `stream: false` returns one `response` JSON body. A request
 * whose `reasoning` asks for a `summary` gets a reasoning item first. A request with function
 * `tools` gets one `function_call` item whose arguments are synthesized from the tool's JSON
 * Schema and streamed as `response.function_call_arguments.delta` fragments. Unknown models get
 * 400 `model_not_found`; a request without a bearer credential gets 401 `invalid_api_key`,
 * without `X-XAI-Token-Auth` 401, without `x-grok-client-version` 426, and without
 * `x-grok-model-override` 400; a non-positive `max_output_tokens` gets 400; unknown routes get a
 * 404 envelope. Not enforced: that `x-grok-model-override` matches the body `model`, the client
 * version value, and the output limit itself (recorded as `maxOutputTokens`).
 */
export const makeXAiGrokEmulator = (options: XAiGrokEmulatorOptions = {}): XAiGrokEmulator =>
  makeResponsesEmulator({
    path: xAiGrokResponsesPath,
    routes: xAiGrokEmulatorRoutes,
    knownModels: options.knownModels ?? xAiGrokEmulatorDefaultModels,
    errorEnvelope,
    // Copied data shape of the synthetic Grok error-envelope fixture (unknown model id).
    unknownModel: {
      status: 400,
      error: {
        message: 'Synthetic placeholder: the requested model does not exist.',
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
    headers: [
      {
        name: 'x-xai-token-auth',
        record: false,
        required: {
          status: 401,
          error: {
            message: 'Synthetic: the X-XAI-Token-Auth header is required.',
            type: 'invalid_request_error',
            code: 'missing_token_auth'
          }
        }
      },
      {
        name: 'x-grok-client-version',
        record: true,
        required: {
          status: 426,
          error: {
            message: 'Synthetic: a supported x-grok-client-version header is required.',
            type: 'invalid_request_error',
            code: 'upgrade_required'
          }
        }
      },
      {
        name: 'x-grok-model-override',
        record: true,
        required: {
          status: 400,
          error: {
            message: 'Synthetic: the x-grok-model-override header is required.',
            type: 'invalid_request_error',
            code: 'missing_model_override'
          }
        }
      }
    ],
    outputTokenLimit: 'optional',
    defaultText: ['Hello', ' from the', ' synthetic Grok emulator.'],
    inputInvalid: (input, reason) => new XAiGrokEmulatorInputInvalid({ input, reason })
  })
