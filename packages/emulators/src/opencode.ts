/**
 * OpenCode Go emulator: one plain fetch handler for the origin `https://opencode.ai`, serving the
 * routes the OpenCode Go provider and usage fetcher call under `/zen/go/v1`:
 *
 * - `POST /zen/go/v1/chat/completions` (Bearer, `max_tokens`, streamed with usage);
 * - `POST /zen/go/v1/messages` (`x-api-key`, `anthropic-version: 2023-06-01`, streamed);
 * - `POST /zen/go/v1/responses` (Bearer, `max_output_tokens`, streamed; plain text or a replayed
 *   tool turn with commentary-tagged text);
 * - `GET /zen/go/v1/usage` (Bearer).
 *
 * Fixture-only (the owner rule for new routes; `fixture-route.ts`): a request matching a recorded
 * request shape, within the documented request-shape latitude, gets that Go conformance fixture's
 * recorded response, copied as data (`opencode-recordings.ts`); everything else (unknown routes,
 * missing credentials or headers, other models, non-streamed modes, tools other than the recorded
 * replay, reasoning, extra fields) answers one ledgered 400 not-emulated.
 *
 * Each route keeps its own ledger, faults, scripted turns, and control plane (`emulator.chat`,
 * `emulator.messages`, `emulator.responses`, `emulator.usage`; over HTTP `/_emulate/<part>/*`);
 * `emulator.coverage()` and `GET /_emulate/coverage` combine them, and `emulator.reset()` and
 * `POST /_emulate/reset` reset all four. Requests on no route are ledgered by the chat part.
 *
 * It never imports SDK code. All routes are `unverified` (the fixtures are synthetic).
 *
 * Runtime-portable Web APIs only (`Request`, `Response`, `ReadableStream`, `TextEncoder`, `URL`);
 * no Effect runtime is required to use it.
 *
 * @experimental
 */
import { Data } from 'effect'
import type * as Schema from 'effect/Schema'
import { combinedCoverage, composeFetch, type ComposedPart } from './emulator-compose.ts'
import { jsonResponse, stringField, type EmulatorCoverage } from './emulator-kernel.ts'
import {
  makeFixtureRouteEmulator,
  type FixtureRecording,
  type FixtureRouteEmulator
} from './fixture-route.ts'
import { openCodeGoRecordings } from './opencode-recordings.ts'
import type { EmulatorRouteEvidence } from './route-evidence.ts'
import { makeSubscriptionUsageEmulator, recordedUsageBody } from './subscription-usage.ts'

export type { EmulatorEvidence, EmulatorRouteEvidence } from './route-evidence.ts'

export { emulatorEvidenceHeader } from './route-evidence.ts'

export type {
  FixtureRouteFault as OpenCodeGoFault,
  FixtureRouteLedgerEntry as OpenCodeGoLedgerEntry,
  FixtureRouteScriptedTurn as OpenCodeGoScriptedTurn
} from './fixture-route.ts'

export const openCodeGoChatCompletionsPath = '/zen/go/v1/chat/completions'

export const openCodeGoMessagesPath = '/zen/go/v1/messages'

export const openCodeGoResponsesPath = '/zen/go/v1/responses'

/** The Go subscription-usage path (`openCodeGoSubscriptionUsageUrl` in the SDK). */
export const openCodeGoUsagePath = '/zen/go/v1/usage'

const recordingsFor = (path: string): ReadonlyArray<FixtureRecording> =>
  openCodeGoRecordings.filter(recording => recording.request.path === path)

const [usageRecording] = recordingsFor(openCodeGoUsagePath)

/**
 * The model ids the Go fixtures record, one per protocol (synthetic placeholders). A protocol
 * route answers only its recorded model; any other model is not emulated.
 */
export const openCodeGoEmulatorDefaultModels: ReadonlyArray<string> = [
  ...new Set(
    openCodeGoRecordings.flatMap(recording => {
      const model = stringField(recording.request.body, 'model')

      return model === undefined ? [] : [model]
    })
  )
]

/**
 * Route evidence manifest: every emulated OpenCode Go route and the conformance cases whose
 * (synthetic, unverified) fixtures it answers from.
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
 * The recorded Go usage body (the synthetic `opencode.go.usage.snapshot` fixture, copied as
 * data): `usage.rolling`, `usage.weekly`, and `usage.monthly` as `{ percent, resetsAt }`.
 */
export const openCodeGoUsageDefault: Schema.Json =
  usageRecording === undefined ? null : recordedUsageBody(usageRecording)

/** Thrown by the JS API (`faults.add`, `script.enqueue`) and at construction for invalid input. */
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
  /**
   * Replacement usage-route body; must have the recorded JSON shape (same keys and value kinds).
   * Defaults to the recorded body (`openCodeGoUsageDefault`).
   */
  readonly subscriptionUsage?: Schema.Json
}

/** One Go route: a fixture-only emulator API (ledger, faults, scripted turns, coverage). */
export type OpenCodeGoRouteEmulator = FixtureRouteEmulator

export type OpenCodeGoEmulator = {
  /** The fetch handler for every route and the `/_emulate/*` control plane. Never rejects. */
  readonly fetch: (request: Request) => Promise<Response>
  /** Reset every part (ledgers, faults, and scripted turns). */
  readonly reset: () => void
  /** Every route's coverage, in manifest order. */
  readonly coverage: () => EmulatorCoverage
  /** `POST /zen/go/v1/chat/completions` (control plane `/_emulate/chat/*`). */
  readonly chat: OpenCodeGoRouteEmulator
  /** `POST /zen/go/v1/messages` (control plane `/_emulate/messages/*`). */
  readonly messages: OpenCodeGoRouteEmulator
  /** `POST /zen/go/v1/responses` (control plane `/_emulate/responses/*`). */
  readonly responses: OpenCodeGoRouteEmulator
  /** `GET /zen/go/v1/usage` (control plane `/_emulate/usage/*`). */
  readonly usage: OpenCodeGoRouteEmulator
}

const routesFor = (path: string): ReadonlyArray<EmulatorRouteEvidence> =>
  openCodeGoEmulatorRoutes.filter(route => route.path === path)

/**
 * Create an OpenCode Go emulator. Each call has independent state for every part. Throws
 * `OpenCodeGoEmulatorInputInvalid` when `subscriptionUsage` does not have the recorded shape.
 *
 * Per route, a request carrying the credential and headers the Go provider or usage fetcher sends
 * (Bearer for chat, Responses, and usage; `x-api-key` and `anthropic-version: 2023-06-01` for
 * Messages), the recorded `accept` and `content-type`, and a body matching a recorded request
 * shape gets the recorded response; anything else answers 400 not-emulated. Test controls per
 * part: the shared kernel faults and scripted error turns (and, on usage, a scripted same-shaped
 * `{ usage }` body).
 */
export const makeOpenCodeGoEmulator = (
  options: OpenCodeGoEmulatorOptions = {}
): OpenCodeGoEmulator => {
  const inputInvalid =
    (protocol: OpenCodeGoEmulatorInputInvalid['protocol']) =>
    (input: 'fault' | 'turn', reason: string) =>
      new OpenCodeGoEmulatorInputInvalid({ protocol, input, reason })

  const chat = makeFixtureRouteEmulator({
    method: 'POST',
    path: openCodeGoChatCompletionsPath,
    routes: routesFor(openCodeGoChatCompletionsPath),
    recordings: recordingsFor(openCodeGoChatCompletionsPath),
    credential: 'bearer',
    headers: [],
    inputInvalid: inputInvalid('chat-completions')
  })

  const messages = makeFixtureRouteEmulator({
    method: 'POST',
    path: openCodeGoMessagesPath,
    routes: routesFor(openCodeGoMessagesPath),
    recordings: recordingsFor(openCodeGoMessagesPath),
    credential: 'x-api-key',
    headers: [
      { name: 'anthropic-version', record: true, accepts: value => value === '2023-06-01' }
    ],
    inputInvalid: inputInvalid('messages')
  })

  const responses = makeFixtureRouteEmulator({
    method: 'POST',
    path: openCodeGoResponsesPath,
    routes: routesFor(openCodeGoResponsesPath),
    recordings: recordingsFor(openCodeGoResponsesPath),
    credential: 'bearer',
    headers: [],
    inputInvalid: inputInvalid('responses')
  })

  if (usageRecording === undefined) {
    throw inputInvalid('usage')('turn', 'no recorded Go usage fixture')
  }

  const usage = makeSubscriptionUsageEmulator({
    path: openCodeGoUsagePath,
    routes: routesFor(openCodeGoUsagePath),
    recording: usageRecording,
    headers: [],
    subscriptionUsage: options.subscriptionUsage,
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
