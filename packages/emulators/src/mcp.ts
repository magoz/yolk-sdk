/**
 * Stateful MCP emulator (the two synthetic servers of the MCP conformance fixtures: profile
 * `synthetic-modern` on `https://mcp.example.test/modern/mcp`, stateless `2026-07-28` with JSON
 * answers, and profile `synthetic-legacy` on `https://mcp.example.test/legacy/mcp`, an
 * `initialize` handshake with sessions and SSE answers; and profile `afloat` on the provider
 * endpoint `https://useafloat.com/mcp`, stateless `2026-07-28` with JSON answers and no session),
 * built on the upstream `@emulators/core` custom runtime, with a request ledger, status and
 * truncation faults, and an `/_emulate/*` control plane.
 *
 * It never imports SDK code: its answers are the sixteen synthetic `@yolk-sdk/mcp/conformance`
 * fixtures copied as data (`src/mcp/recordings.ts`) and the eight derived
 * `@yolk-sdk/connectors/afloat/conformance` fixtures copied as data
 * (`src/mcp/afloat-recordings.ts`; derived from the provider's source, not recorded live, all
 * unverified; one listing page of the published tool subset, the read call of `list-invoices`, its
 * tool error, the absent tool, and the 401; answering those two derived `tools/call` fixtures, not
 * only recorded calls, is in scope by the owner's decision), and every manifest row names the
 * conformance cases whose fixtures it answers (`mcpEmulatorRoutes`: one
 * `RPC <origin><path>#<method>` row per recorded JSON-RPC method of each profile, plus the legacy
 * `GET` row; no row writes anything in a real service). Response behaviour comes only from the
 * fixtures, byte for byte: a JSON-RPC POST is answered only when it equals a recorded request
 * within the latitude below, with the recorded answer, the request id substituted at exactly the
 * recorded place (the top-level `id` of a JSON answer, or the `id` of the SSE response event's
 * payload; notification events and SSE `id:` lines stay byte for byte; an answer that does not
 * carry the recorded request id, such as the legacy era probe's `id: null` error, is unchanged).
 * The legacy `initialize` mints a session `yolk-emu-session-<n>` (`n` from a counter that never
 * resets, a form no seed holds), answered in the recorded `mcp-session-id` header;
 * `notifications/initialized` on that session answers the recorded 202 and makes it ready; on a
 * ready session `tools/list`, `tools/call`, and the standing `GET` (the recorded 405) answer the
 * recordings with the session's id. At most 256 sessions are held: another `initialize` is refused
 * before any fault. `reset` and `seed` clear the sessions. The seed only selects which recorded
 * modern listing `tools/list` answers (`modernListing`: `one-page`, the default, or `two-pages`,
 * whose first page issues the recorded cursor in the generation that first issues it, and
 * `<cursor>.g<generation>` after a reset or seed; the second page answers only the cursor issued in
 * the current generation). Every plan prepares its answer before anything is written; its commit
 * (minting a session, readying one, issuing a cursor) runs only when no fault answers the request.
 * Status faults (400-599) and `truncate-after-chunks` faults apply only after a request is admitted
 * and planned, and a faulted request writes nothing: a truncation sends the prepared answer cut
 * short and never runs the commit, so a truncated `initialize` holds no session and leaves the
 * counter and the cap where they were, and a truncated first page issues no cursor. `match.route`
 * selects one manifest row (a value naming no row is rejected when the fault is added);
 * `match.method` is the HTTP method. Anything else answers one 400 not-emulated, ledgered with
 * constant text only (`/<unrecognised>`, a standard method or `<other>`, an empty query, no headers
 * or body, a constant reason, and the route template or row), that writes nothing and uses up no
 * fault.
 *
 * Not emulated: `DELETE` (the client never sends it), `ping`, `resources/*`, `prompts/*`,
 * `logging/*`, `completion/*`, `tasks/*`, JSON-RPC batches and client-sent responses, a JSON body
 * repeating a key (the wrapper's opt-in `uniqueJsonKeys`), `mcp-*` headers no recording carries
 * (such as `mcp-param-*`), cursors this emulator did not issue, any other tool or arguments, any
 * other origin or path, and a missing `Authorization` (no fixture records the answer to one).
 *
 * Fail closed, on the shared wrapper's fail-closed mode as `/github`, `/google`, and
 * `/linkedin-search` use it, with its opt-in `constantRefusals`, `guardAllHeaders`, and
 * `guardOutput`: a request is recognised only on an emulated route shape, and any `Authorization`
 * header is exactly `Bearer <token>` with a recognisable bearer (the RFC 6750 `b64token` syntax, at
 * least 8 characters, a first character in `[G-Zg-z\-._~+/]` other than `n`, `r`, `t`, `u`, and a
 * character outside `[0-9.eE+-]`). The Afloat rule (the wrapper's opt-in `bearerPrefixes`, the
 * Telegram precedent): on `https://useafloat.com` a bearer is recognised only as
 * `afloat_<remainder>`, and the remainder, not the key, must be recognisable (an Afloat key starts
 * with the hex digit `a`, which fails the first-character rule); the remainder is the guarded
 * secret below and what the digest takes, and a bearer without `afloat_` there, or with it on the
 * synthetic origin, is unrecognisable. A recognised request that repeats the bearer anywhere (its
 * raw path, the raw query or any query key or value, any request header name or value other than
 * `Authorization`, or its body, through the wrapper's fixpoint closure of tolerant percent-decoding
 * and JSON-unescaping, capped, where a cap refuses) is ledgered with constant text only. The
 * prepared output is checked the same way before any fault is decided or anything is committed: an
 * answer (every header and chunk) or a minted session id or cursor that would repeat the bearer is
 * refused with the constant credential-repeat entry, no fault used and nothing written, so a bearer
 * such as `yolk-emu-session-1`, or `synthetic-mcp` (inside the recorded `yolk-synthetic-mcp`),
 * never reaches a response, the state, or `/_emulate/*`. The bearer is never stored, forwarded,
 * ledgered, or echoed: routes see only its digest (the wrapper's opt-in `bearerDigest`; SHA-256 of
 * the origin, a space, and the bearer), which they compare only with the digest of the public
 * reserved invalid credential `yolk-conformance-invalid-credential-0000` (itself a recognisable
 * bearer), or on the Afloat profile of the remainder of `afloat_yolkconformanceinvalid0000`, to
 * answer its recorded 401 byte for byte. Scope: the bearer is never copied from the request into a
 * response, the state, or `/_emulate/*`; the output guard also refuses a prepared fixture answer,
 * minted session id, or cursor that happens to contain it, but the emulator's other constants
 * (state values such as `initializing`, wrapper headers such as `x-emulator-evidence`) and
 * host-configured control-plane data (a fault body) may coincidentally equal a bearer and are not
 * checked. `makeMcpEmulator` also throws when a copied recording is not canonical JSON (every JSON
 * body and SSE `data:` payload equal to `JSON.stringify(JSON.parse(text))`), which id substitution
 * relies on.
 *
 * Request-shape latitude (`/mcp`, the only accepted deviations): any bearer value in the RFC 6750
 * `b64token` syntax (`[A-Za-z0-9\-._~+/]+=*`) of at least 8 characters, starting with a character
 * in `[G-Zg-z\-._~+/]` other than `n`, `r`, `t`, `u`, with at least one outside `[0-9.eE+-]` (on
 * the Afloat profile, `afloat_` followed by such a value: an Afloat key starts with the hex digit
 * `a`, so its remainder after `afloat_` is the value checked, guarded, and digested), that occurs
 * nowhere else in the request (any header name or value included) and in no answer or value the
 * request would store (never stored or ledgered; only its digest is compared, with the digest of
 * the public reserved invalid credential `yolk-conformance-invalid-credential-0000`, or on the
 * Afloat profile of the remainder of `afloat_yolkconformanceinvalid0000`, each answering the
 * recorded 401 on its profile's era probe); extra request headers, except `mcp-*` headers other
 * than `mcp-method`, `mcp-name`, `mcp-protocol-version`, and `mcp-session-id`; a recorded header
 * value sent as several headers that the HTTP layer joins into the recorded value; JSON key order;
 * any JSON-RPC request id that is an integer from 0 to 2^53 - 1 or 1 to 64 printable ASCII
 * characters where the recording has an id; any non-empty `name` and `version` (and no other key)
 * in the `_meta` client info (`io.modelcontextprotocol/clientInfo`) of a modern request; a session
 * id this emulator minted since the last reset or seed where the recording sends `mcp-session-id`
 * (initializing for `notifications/initialized`, ready otherwise); and, with the seed's `two-pages`
 * listing, the cursor this emulator issued in the current generation on the second page.
 * `Authorization` must be exactly `Bearer <token>` (that spelling, one space). Everything else
 * (another origin or path, any query, other HTTP methods such as `DELETE` or a `GET` on the modern
 * or Afloat profile, a bearer without `afloat_` on the Afloat profile or with it on the synthetic
 * profiles, an Afloat key whose remainder fails the rule above (such as one starting with a hex
 * digit), JSON-RPC methods no fixture of the profile records such as `ping`, `resources/*`, or
 * `prompts/*`, batches and client-sent responses, other members, a JSON body repeating a key
 * (compared after unescaping), a `null`, negative, or fractional id, other params (other tools,
 * arguments, protocol versions, or capabilities, extra client-info keys, a cursor on the Afloat
 * listing, and a legacy `initialize` client info other than the recorded one), the MCP headers
 * `accept`, `content-type`, `mcp-method`, `mcp-protocol-version`, `mcp-name`, and `last-event-id`
 * other than the recorded values or present where none is recorded, any other `mcp-*` header (such
 * as `mcp-param-*`), `mcp-session-id` missing where recorded or present where not, an unknown
 * session or one in the wrong phase, a cursor not issued in the current generation, a reserved
 * invalid credential on anything but its profile's era probe, a bearer repeated anywhere in the
 * request, and a bearer an answer or a minted session id or cursor would repeat) is not emulated.
 *
 * Node-only: `@emulators/core` imports Node builtins, so the core is loaded lazily by
 * `makeMcpEmulator` (importing this module has no side effects).
 *
 * @experimental
 */
import { Data, Predicate } from 'effect'
import {
  mcpApiRoutes,
  mcpEmulatorDrillKnobs,
  mcpRecordingProblems,
  type McpApiEnv,
  type McpEmulatorDrills
} from './mcp/api.ts'
import { mcpEmulatorAfloatFixtures } from './mcp/afloat-recordings.ts'
import { mcpEmulatorFixtures } from './mcp/recordings.ts'
import {
  buildSeedState,
  decodeState,
  makeMcpRuntime,
  mcpBearerDigest,
  mcpEmulatorAfloatKeyPrefix,
  mcpEmulatorAfloatOrigin,
  mcpEmulatorAfloatReservedInvalidCredential,
  mcpEmulatorOrigin,
  mcpEmulatorReservedInvalidCredential,
  type McpEmulatorSeed,
  type McpEmulatorState
} from './mcp/state.ts'
import type { EmulatorRouteEvidence } from './route-evidence.ts'
import {
  StatefulFaultMatch,
  StatefulStreamFault,
  checkBooleanDrills,
  makeChunkedStatefulEmulator,
  routeManifest,
  type StatefulCoverage,
  type StatefulEmulatorApi,
  type StatefulFaultState,
  type StatefulInputKind,
  type StatefulLedgerEntry
} from './stateful-emulator.ts'
import { statefulCoreRuntime } from './stateful-core.ts'
import { isRecognisableBearerValue } from './stateful-secrets.ts'

export type { EmulatorEvidence, EmulatorRouteEvidence } from './route-evidence.ts'

export { emulatorEvidenceHeader } from './route-evidence.ts'

export { isMcpEmulatedRequestId, mcpEmulatorDrillKnobs, type McpEmulatorDrills } from './mcp/api.ts'

export {
  McpEmulatorModernListing,
  McpEmulatorSeed,
  McpEmulatorSession,
  McpEmulatorStateSchema,
  mcpEmulatorAfloatKeyPrefix,
  mcpEmulatorAfloatOrigin,
  mcpEmulatorAfloatPath,
  mcpEmulatorAfloatReservedInvalidCredential,
  mcpEmulatorLegacyPath,
  mcpEmulatorModernPath,
  mcpEmulatorOrigin,
  mcpEmulatorReservedInvalidCredential,
  mcpEmulatorSessionCap,
  mcpEmulatorSessionPrefix,
  type McpEmulatorState
} from './mcp/state.ts'

export { mcpEmulatorAfloatFixtures } from './mcp/afloat-recordings.ts'

export {
  mcpEmulatorFixtures,
  type McpRecordedExchange,
  type McpRecordedFixture,
  type McpRecordedRequest,
  type McpRecordedResponse
} from './mcp/recordings.ts'

/**
 * Route evidence manifest: one `RPC <origin><path>#<method>` row per recorded JSON-RPC method of
 * each profile, plus the legacy `GET` row, with the conformance cases whose (synthetic,
 * unverified) fixtures each answers. No row writes anything. Kept in sync with the handlers by
 * construction (both come from one route table).
 */
export const mcpEmulatorRoutes: ReadonlyArray<EmulatorRouteEvidence> =
  mcpApiRoutes.flatMap(routeManifest)

/**
 * Optional fault filter; an omitted field matches every request. `method` is the HTTP method
 * (`POST` or `GET`, never a row's `RPC`); `path` is the raw request path (ending in `*`, a
 * prefix); `route` is a manifest row path (for example
 * `https://mcp.example.test/legacy/mcp#tools/list`), and a value naming no row is rejected when
 * the fault is added.
 */
export const McpFaultMatch = StatefulFaultMatch

export type McpFaultMatch = typeof StatefulFaultMatch.Type

/**
 * A status fault (400-599), or a `truncate-after-chunks` fault that sends the first `chunks`
 * chunks of the prepared answer and then ends it cleanly (an SSE answer has two chunks, a JSON
 * answer one). Only a request the emulator would answer reaches a fault: a request that is not
 * emulated, by its shape or by the state, never uses one up. A faulted request writes nothing (a
 * truncated `initialize` mints no session; a truncated first page issues no cursor). A truncation
 * that cannot apply answers 500 and is not used up.
 */
export const McpFault = StatefulStreamFault

export type McpFault = StatefulStreamFault

export type McpFaultState = StatefulFaultState<McpFault>

export type McpLedgerEntry = StatefulLedgerEntry

export type McpCoverage = StatefulCoverage

/** Invalid emulator input from the JS API: a seed, a fault, or an option. A programmer error. */
export class McpEmulatorInputInvalid extends Data.TaggedError('McpEmulatorInputInvalid')<{
  readonly input: StatefulInputKind
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid MCP emulator ${this.input}: ${this.reason}`
  }
}

export type McpEmulatorOptions = {
  /** Typed seed; defaults to the one-page modern listing (sessions are never seeded). */
  readonly seed?: McpEmulatorSeed
  /** Drill knobs (tests only): make the emulator disagree with one conformance claim. */
  readonly drills?: McpEmulatorDrills
}

export type McpEmulator = StatefulEmulatorApi<McpEmulatorState, McpEmulatorSeed, McpFault>

const inputInvalid = (input: StatefulInputKind, reason: string) =>
  new McpEmulatorInputInvalid({ input, reason })

/** The constant reason of a request on no emulated route shape. */
const unrecognisedReason = 'no emulated MCP route for this method and path'

/** The constant reason of a request whose `Authorization` header is not one recognisable bearer. */
const unrecognisedAuthorizationReason = 'an unrecognisable Authorization header is not emulated'

/**
 * Create a stateful MCP emulator on the `@emulators/core` custom runtime. Each call has its own
 * state, ledger, faults, and session counter. Rejects with `McpEmulatorInputInvalid` for an
 * invalid seed or option. See `src/stateful-emulator.ts` for the request precedence.
 */
export const makeMcpEmulator = async (options: McpEmulatorOptions = {}): Promise<McpEmulator> => {
  const initial = buildSeedState(options.seed ?? {})

  if (Predicate.isString(initial)) {
    throw inputInvalid('seed', initial)
  }

  checkBooleanDrills(options.drills, mcpEmulatorDrillKnobs, inputInvalid)

  // The reserved invalid credential must reach the routes as a recognisable bearer's digest; a
  // value the bearer rule refused would never be answered its recorded 401.
  if (!isRecognisableBearerValue(mcpEmulatorReservedInvalidCredential)) {
    throw new Error('the reserved invalid MCP credential is not a recognisable bearer')
  }

  // The Afloat profile guards the remainder after `afloat_`: it must be recognisable instead.
  const afloatReservedRemainder = mcpEmulatorAfloatReservedInvalidCredential.slice(
    mcpEmulatorAfloatKeyPrefix.length
  )

  if (
    !mcpEmulatorAfloatReservedInvalidCredential.startsWith(mcpEmulatorAfloatKeyPrefix) ||
    !isRecognisableBearerValue(afloatReservedRemainder)
  ) {
    throw new Error('the reserved invalid Afloat credential has no recognisable remainder')
  }

  // Id substitution re-serialises the response message: a recording copied in a non-canonical
  // JSON form would answer other bytes, so it fails here, loudly.
  const recordingProblems = mcpRecordingProblems([
    ...mcpEmulatorFixtures,
    ...mcpEmulatorAfloatFixtures
  ])

  if (recordingProblems.length > 0) {
    throw new Error(`non-canonical MCP recordings: ${recordingProblems.join('; ')}`)
  }

  const drills = options.drills ?? {}
  const runtime = makeMcpRuntime()

  const env: McpApiEnv = {
    drills: {
      discoverCarriesErrorResponse: drills.discoverCarriesErrorResponse === true,
      discoverWithoutResultType: drills.discoverWithoutResultType === true,
      sessionIdNotVisibleAscii: drills.sessionIdNotVisibleAscii === true,
      discoverAnsweredTwice: drills.discoverAnsweredTwice === true,
      writeToolMarkedReadOnly: drills.writeToolMarkedReadOnly === true,
      readCallAnswersToolError: drills.readCallAnswersToolError === true,
      invalidCallAnswersRpcError: drills.invalidCallAnswersRpcError === true,
      absentCallAnswersResult: drills.absentCallAnswersResult === true,
      unauthorizedWithoutChallenge: drills.unauthorizedWithoutChallenge === true
    },
    reservedDigest: mcpBearerDigest(mcpEmulatorReservedInvalidCredential, mcpEmulatorOrigin),
    afloatReservedDigest: mcpBearerDigest(afloatReservedRemainder, mcpEmulatorAfloatOrigin),
    runtime
  }

  return makeChunkedStatefulEmulator<McpEmulatorState, McpApiEnv, McpEmulatorSeed>(
    {
      routes: mcpApiRoutes,
      env,
      initial,
      buildSeed: buildSeedState,
      recordHeaders: [
        { name: 'accept', json: false },
        { name: 'content-type', json: false },
        { name: 'mcp-method', json: false },
        { name: 'mcp-name', json: false },
        { name: 'mcp-protocol-version', json: false },
        { name: 'mcp-session-id', json: false }
      ],
      failClosed: {
        unrecognised: unrecognisedReason,
        unrecognisedAuthorization: unrecognisedAuthorizationReason
      },
      bearerDigest: mcpBearerDigest,
      bearerPrefixes: { [mcpEmulatorAfloatOrigin]: mcpEmulatorAfloatKeyPrefix },
      constantRefusals: true,
      guardAllHeaders: true,
      guardOutput: true,
      uniqueJsonKeys: true,
      // Every reset and seed starts a cursor generation; the session counter never resets.
      clearRuntime: () => {
        runtime.generation += 1
        runtime.issuedCursor = undefined
      },
      runtimeState: () => ({
        nextSession: runtime.nextSession,
        cursorGeneration: runtime.generation,
        issuedCursor: runtime.issuedCursor ?? null
      }),
      seedSummary: state => ({ modernListing: state.modernListing }),
      inputInvalid
    },
    statefulCoreRuntime({ name: 'mcp', initial, decodeState, inputInvalid })
  )
}
