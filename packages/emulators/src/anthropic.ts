/**
 * Anthropic Messages emulator: a plain fetch handler for `POST /v1/messages` (origin
 * `https://api.anthropic.com`), with scripted turns, wire faults, a request ledger, and an
 * `/_emulate/*` control plane.
 *
 * It never imports SDK code: its wire shapes follow the synthetic Anthropic Messages conformance
 * fixtures (`message_start` / `content_block_*` / `message_delta` / `message_stop` SSE with
 * `text_delta`, `thinking_delta`, and `input_json_delta`, the `message` JSON body, and the
 * `{ type: 'error', error: { type, message } }` envelope) and are linked to those conformance
 * case ids in `anthropicEmulatorRoutes`. The Messages machinery lives in the internal
 * `messages.ts` core; faults, the ledger, and the control plane are shared with the Chat
 * Completions emulators.
 *
 * Requests authenticate with a non-empty `x-api-key` (native API keys) or `Authorization:
 * Bearer` (Claude OAuth) credential. Neither value is ever checked or stored.
 *
 * The same fetch handler also answers the Claude subscription-usage route
 * (`GET /api/oauth/usage`, `emulator.usage`) with its own manifest
 * (`anthropicSubscriptionUsageEmulatorRoutes`), ledger, faults, and turns; see
 * `makeAnthropicEmulator`.
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
  MessagesErrorEventFault,
  MessagesFault,
  MessagesScriptedMessage,
  MessagesScriptedToolUse,
  MessagesScriptedTurn,
  MessagesScriptedUsage,
  MessagesWireError,
  makeMessagesEmulator,
  type MessagesEmulator,
  type MessagesFaultKind,
  type MessagesLedgerEntry
} from './messages.ts'
import type { EmulatorRouteEvidence } from './route-evidence.ts'
import {
  makeSubscriptionUsageEmulator,
  recordedUsageBody,
  SubscriptionUsageFault,
  type SubscriptionUsageEmulator,
  type SubscriptionUsageLedgerEntry,
  type SubscriptionUsageScriptedTurn
} from './subscription-usage.ts'
import { anthropicClaudeUsageRecording } from './subscription-usage-recordings.ts'

export type { EmulatorEvidence, EmulatorRouteEvidence } from './route-evidence.ts'

export { emulatorEvidenceHeader } from './route-evidence.ts'

export const anthropicMessagesPath = '/v1/messages'

/** The Claude subscription-usage path (`anthropicClaudeSubscriptionUsageUrl` in the SDK). */
export const anthropicSubscriptionUsagePath = '/api/oauth/usage'

/** The `anthropic-beta` value the Claude usage fetcher sends for OAuth credentials. */
export const anthropicOAuthBeta = 'oauth-2025-04-20'

/**
 * Route evidence manifest of the Claude subscription-usage route (served by the same fetch
 * handler as the Messages route, with its own ledger and coverage). Synthetic, unverified.
 */
export const anthropicSubscriptionUsageEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> = [
  {
    method: 'GET',
    path: anthropicSubscriptionUsagePath,
    kind: 'provider',
    write: false,
    caseIds: ['anthropic.claude.usage.snapshot'],
    evidence: 'unverified',
    observedAt: undefined
  }
]

/**
 * The recorded Claude usage body (the synthetic `anthropic.claude.usage.snapshot` fixture, copied
 * as data): `five_hour` and `seven_day` as `{ utilization, resets_at }`.
 */
export const anthropicSubscriptionUsageDefault: Schema.Json = recordedUsageBody(
  anthropicClaudeUsageRecording
)

/** Synthetic-safe default model ids, including the Anthropic Messages conformance defaults. */
export const anthropicEmulatorDefaultModels: ReadonlyArray<string> = [
  'claude-haiku-4-5',
  'claude-sonnet-4-5'
]

/**
 * Route evidence manifest: every emulated Anthropic route and the conformance cases whose
 * (currently synthetic, unverified) wire shapes it follows.
 */
export const anthropicEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> = [
  {
    method: 'POST',
    path: anthropicMessagesPath,
    kind: 'provider',
    write: false,
    caseIds: [
      'anthropic.messages.stream.plain-text',
      'anthropic.messages.stream.tool-use-input-deltas',
      'anthropic.messages.stream.thinking-before-text',
      'anthropic.messages.stream.error-envelope',
      'anthropic.messages.stream.max-tokens'
    ],
    evidence: 'unverified',
    observedAt: undefined
  }
]

/** Optional fault filter; an omitted field matches every request. `path` ending in `*` is a prefix. */
export const AnthropicFaultMatch = EmulatorFaultMatch

export type AnthropicFaultMatch = typeof EmulatorFaultMatch.Type

/** An Anthropic wire error (`{ type, message }`), as sent inside the error envelope. */
export const AnthropicWireError = MessagesWireError

export type AnthropicWireError = MessagesWireError

/** A mid-stream `error` event fault (default `overloaded_error`), streamed responses only. */
export const AnthropicErrorEventFault = MessagesErrorEventFault

export type AnthropicErrorEventFault = typeof MessagesErrorEventFault.Type

/**
 * Wire faults:
 *
 * - `status`: answer with this status, headers, and body (for example 429 with `retry-after`,
 *   or 529). The body defaults to the Anthropic error envelope for the status
 *   (`rate_limit_error` for 429, `overloaded_error` for 529, `api_error` for other 5xx).
 * - `error-after-chunks`: send N body chunks, then error the body stream (a dropped connection).
 * - `truncate-after-chunks`: send N body chunks, then close cleanly (no `message_stop`).
 * - `error-event-after-chunks`: send N SSE events, then one `event: error` event and close.
 *
 * Statuses that cannot carry a body and redirects are rejected, as are invalid headers and
 * `location`. A fault that cannot take effect answers 500 and is not consumed.
 */
export const AnthropicFault = MessagesFault

export type AnthropicFault = MessagesFault

export type AnthropicFaultKind = MessagesFaultKind

/** Usage for a scripted turn (sent in `message_start` and `message_delta`). */
export const AnthropicScriptedUsage = MessagesScriptedUsage

export type AnthropicScriptedUsage = MessagesScriptedUsage

/** One scripted `tool_use` block; its JSON input streams as these fragments. */
export const AnthropicScriptedToolUse = MessagesScriptedToolUse

export type AnthropicScriptedToolUse = MessagesScriptedToolUse

/**
 * A scripted message. Every field is exact except: a block is sent only when its field is
 * present; `usage` omitted is synthesized and `null` drops it; `stopReason` omitted is
 * `tool_use` with tool uses, else `end_turn`; `order` defaults to `thinking-first`.
 */
export const AnthropicScriptedMessage = MessagesScriptedMessage

export type AnthropicScriptedMessage = MessagesScriptedMessage

/** A scripted error response: status, body (a string is sent as is), and optional headers. */
export const AnthropicScriptedError = EmulatorScriptedError

export type AnthropicScriptedError = typeof EmulatorScriptedError.Type

/** A turn queued for the next Messages request. */
export const AnthropicScriptedTurn = MessagesScriptedTurn

export type AnthropicScriptedTurn = MessagesScriptedTurn

/** Thrown by the JS API (`faults.add`, `script.enqueue`) for invalid input; a programmer error. */
export class AnthropicEmulatorInputInvalid extends Data.TaggedError(
  'AnthropicEmulatorInputInvalid'
)<{
  readonly input: 'fault' | 'turn'
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid Anthropic emulator ${this.input}: ${this.reason}`
  }
}

export type AnthropicLedgerEntry = MessagesLedgerEntry

export type AnthropicFaultState = EmulatorFaultState<AnthropicFault>

export type AnthropicRouteCoverage = EmulatorRouteCoverage

export type AnthropicCoverage = EmulatorCoverage

/** A usage-route fault (`status`, `error-after-chunks`, `truncate-after-chunks`). */
export const AnthropicUsageFault = SubscriptionUsageFault

export type AnthropicUsageFault = SubscriptionUsageFault

/** A usage turn: `{ usage }` (a body with the recorded JSON shape) or `{ error }`. */
export type AnthropicUsageScriptedTurn = SubscriptionUsageScriptedTurn

export type AnthropicUsageLedgerEntry = SubscriptionUsageLedgerEntry

export type AnthropicUsageEmulator = SubscriptionUsageEmulator

export type AnthropicEmulatorOptions = {
  /** Model ids that exist. Defaults to `anthropicEmulatorDefaultModels`. */
  readonly knownModels?: ReadonlyArray<string>
  /**
   * Replacement usage-route body; must have the recorded JSON shape (same keys and value kinds).
   * Defaults to the recorded body (`anthropicSubscriptionUsageDefault`).
   */
  readonly subscriptionUsage?: Schema.Json
}

/** The Messages emulator, plus `usage`: the subscription-usage route's own emulator API. */
export type AnthropicEmulator = MessagesEmulator & { readonly usage: AnthropicUsageEmulator }

/**
 * Create an Anthropic Messages emulator. Each call has independent ledger, fault, and script
 * state.
 *
 * Without a script, `POST /v1/messages` answers a known model with synthetic content: `stream:
 * true` streams `message_start`, the content blocks (`content_block_start`, deltas,
 * `content_block_stop`, with a `ping` after the first block starts), `message_delta` (stop reason
 * and usage), and `message_stop`; `stream: false` returns one `message` JSON body. A request with
 * `thinking` enabled (`enabled` or `adaptive`) gets a thinking block before the answer. A request
 * with `tools` gets one `tool_use` block whose input is synthesized from the tool's `input_schema`
 * and streamed as `input_json_delta` fragments, stopping with `tool_use`; `tool_choice: { type:
 * 'tool', name }` picks that tool (otherwise the first) and `tool_choice: { type: 'none' }`
 * answers with text. An answer that would exceed `max_tokens` is cut and stops with `max_tokens`.
 * Unknown models get 404 `not_found_error`; a request with neither a non-empty `x-api-key` nor a
 * bearer credential gets 401 `authentication_error`; a missing or unsupported `anthropic-version`
 * (only `2023-06-01` is accepted), a missing or non-positive `max_tokens`, or `thinking` with a
 * forced `tool_choice` (`tool` or `any`) gets 400 `invalid_request_error`; unknown routes get a
 * 404 envelope. The OAuth `anthropic-beta` header and `budget_tokens` limits are not enforced. The
 * ledger records which header carried the credential, `anthropic-version`, and `anthropic-beta`,
 * never a credential value.
 *
 * `GET /api/oauth/usage` is fixture-only: a request with a non-empty bearer credential (never
 * checked or stored), an `anthropic-beta` header listing `oauth-2025-04-20`, `accept:
 * application/json`, and no query gets the recorded body (`anthropicSubscriptionUsageDefault`,
 * or a same-shaped `options.subscriptionUsage` / scripted `{ usage }`); anything else answers 400
 * not-emulated. Throws `AnthropicEmulatorInputInvalid` for a differently shaped
 * `subscriptionUsage`. Its ledger, faults, turns, and coverage are
 * `emulator.usage` (control plane `/_emulate/usage/*`); `emulator.faults` and the other top-level
 * APIs stay the Messages route's. `reset()` and `POST /_emulate/reset` reset both.
 */
export const makeAnthropicEmulator = (options: AnthropicEmulatorOptions = {}): AnthropicEmulator =>
  withSubscriptionUsage(
    makeMessagesEmulator({
      path: anthropicMessagesPath,
      routes: anthropicEmulatorRoutes,
      knownModels: options.knownModels ?? anthropicEmulatorDefaultModels,
      inputInvalid: (input, reason) => new AnthropicEmulatorInputInvalid({ input, reason })
    }),
    makeSubscriptionUsageEmulator({
      path: anthropicSubscriptionUsagePath,
      routes: anthropicSubscriptionUsageEmulatorRoutes,
      recording: anthropicClaudeUsageRecording,
      headers: [
        {
          name: 'anthropic-beta',
          record: true,
          accepts: value =>
            value
              .split(',')
              .map(beta => beta.trim())
              .includes(anthropicOAuthBeta)
        }
      ],
      subscriptionUsage: options.subscriptionUsage,
      inputInvalid: (input, reason) => new AnthropicEmulatorInputInvalid({ input, reason })
    }),
    anthropicSubscriptionUsagePath
  )
