/**
 * MCP emulator state, seed, profiles, and minted value forms (internal).
 *
 * The state holds the modern listing the seed selects and the legacy sessions minted since the
 * last reset or seed; a seed holds no session, so no seeded value can take the minted
 * `yolk-emu-session-<n>` form. The session counter and the cursor generation are runtime data
 * that never reset (`McpRuntime`).
 *
 * @experimental
 */
import { createHash } from 'node:crypto'
import { Result } from 'effect'
import * as Schema from 'effect/Schema'

/** The reserved origin both synthetic profiles answer on; another origin is not emulated. */
export const mcpEmulatorOrigin = 'https://mcp.example.test'

/** The synthetic modern server: stateless `2026-07-28`, JSON answers. */
export const mcpEmulatorModernPath = '/modern/mcp'

/** The synthetic legacy server: an `initialize` handshake, a session, and SSE answers. */
export const mcpEmulatorLegacyPath = '/legacy/mcp'

/** The emulated profiles: the two synthetic servers of the MCP conformance fixtures. */
export const McpEmulatorProfile = Schema.Literals(['synthetic-modern', 'synthetic-legacy'])

export type McpEmulatorProfile = typeof McpEmulatorProfile.Type

/** The endpoint path of each profile. */
export const mcpEmulatorProfilePaths: Readonly<Record<McpEmulatorProfile, string>> = {
  'synthetic-modern': mcpEmulatorModernPath,
  'synthetic-legacy': mcpEmulatorLegacyPath
}

/**
 * The public reserved invalid credential of the MCP auth case: the only credential value the
 * emulator compares a bearer with (through its digest), answered the recorded 401.
 */
export const mcpEmulatorReservedInvalidCredential = 'yolk-conformance-invalid-credential-0000'

/** The minted session id form (`yolk-emu-session-<n>`, `n` from a counter that never resets). */
export const mcpEmulatorSessionPrefix = 'yolk-emu-session-'

/** At most this many sessions are held; an `initialize` beyond it is refused before any fault. */
export const mcpEmulatorSessionCap = 256

/**
 * Which recorded modern listing `tools/list` answers: `one-page` (the listing every calling
 * fixture records; the default) or `two-pages` (the paged listing of `mcp.tools.list`, whose first
 * page issues a cursor). Both come from fixtures; neither is synthesised.
 */
export const McpEmulatorModernListing = Schema.Literals(['one-page', 'two-pages'])

export type McpEmulatorModernListing = typeof McpEmulatorModernListing.Type

/** A legacy session: minted by `initialize`, ready after `notifications/initialized`. */
export const McpEmulatorSession = Schema.Struct({
  id: Schema.String,
  phase: Schema.Literals(['initializing', 'ready'])
})

export type McpEmulatorSession = typeof McpEmulatorSession.Type

/** The emulator state (a JSON value the core snapshots and restores). */
export const McpEmulatorStateSchema = Schema.Struct({
  modernListing: McpEmulatorModernListing,
  sessions: Schema.Array(McpEmulatorSession)
})

export type McpEmulatorState = {
  modernListing: McpEmulatorModernListing
  sessions: ReadonlyArray<McpEmulatorSession>
}

/** The typed seed: only the modern listing; it holds no session. */
export const McpEmulatorSeed = Schema.Struct({
  modernListing: Schema.optionalKey(McpEmulatorModernListing)
})

export type McpEmulatorSeed = typeof McpEmulatorSeed.Type

const strict = { onExcessProperty: 'error' } as const

const decodeSeed = Schema.decodeUnknownResult(McpEmulatorSeed, strict)

const decodeStateSchema = Schema.decodeUnknownResult(McpEmulatorStateSchema, strict)

const issueMessage = (issue: Schema.SchemaError['issue']): string =>
  new Schema.SchemaError(issue).message

/** Build the state of a seed (no sessions), or why the seed is invalid. */
export const buildSeedState = (input: unknown): McpEmulatorState | string => {
  const decoded = decodeSeed(input)

  if (Result.isFailure(decoded)) return issueMessage(decoded.failure.issue)

  return { modernListing: decoded.success.modernListing ?? 'one-page', sessions: [] }
}

/** Decode a whole state (the core's seed validation), or why it is invalid. */
export const decodeState = (input: unknown): McpEmulatorState | string => {
  const decoded = decodeStateSchema(input)

  return Result.isFailure(decoded)
    ? issueMessage(decoded.failure.issue)
    : { modernListing: decoded.success.modernListing, sessions: decoded.success.sessions }
}

/**
 * The one-way digest routes see instead of the bearer: SHA-256 of the arrival origin, a space,
 * and the bearer (the wrapper's opt-in `bearerDigest`).
 */
export const mcpBearerDigest = (bearer: string, origin: string): string =>
  createHash('sha256').update(`${origin} ${bearer}`, 'utf8').digest('hex')

/**
 * Runtime data (never in the state): the session counter and the cursor generation never reset;
 * the cursor issued in the current generation is cleared on every reset and seed.
 */
export type McpRuntime = {
  /** The number of the next minted session (never reset). */
  nextSession: number
  /** Starts at 1; every reset and seed starts the next generation (never reset). */
  generation: number
  /** The generation that first issued the recorded cursor (never reset). */
  cursorFirstGeneration: number | undefined
  /** The cursor issued in the current generation, if any. */
  issuedCursor: string | undefined
}

export const makeMcpRuntime = (): McpRuntime => ({
  nextSession: 1,
  generation: 1,
  cursorFirstGeneration: undefined,
  issuedCursor: undefined
})
