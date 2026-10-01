/**
 * The target and seeds every MCP conformance case reads, and the era filter.
 *
 * @experimental
 */
import { Context } from 'effect'
import * as Schema from 'effect/Schema'

/**
 * The protocol era the target speaks: `modern` (stateless `2026-07-28`, chosen through
 * `server/discover`) or `legacy` (an `initialize` handshake with a session).
 */
export const McpConformanceEra = Schema.Literals(['modern', 'legacy'])

export type McpConformanceEra = typeof McpConformanceEra.Type

/**
 * The reserved invalid credential of the auth case. It is public, never valid anywhere, and the
 * only credential value a committed fixture may imply (fixtures never record `authorization`).
 */
export const mcpConformanceInvalidCredential = 'yolk-conformance-invalid-credential-0000'

/** The headers the auth case sends unless the target names its own invalid credential headers. */
export const mcpConformanceDefaultInvalidCredentialHeaders = {
  authorization: `Bearer ${mcpConformanceInvalidCredential}`
} satisfies Readonly<Record<string, string>>

/** The tool name the unknown-tool case calls unless the seeds name another. */
export const mcpConformanceDefaultAbsentToolName = 'yolk_conformance_absent'

/**
 * One MCP server under test. `headers` are sent as-is on every request (they usually carry the
 * credential, so hosts must never log them); the cases never copy header values into results.
 */
export type McpConformanceTargetSettings = {
  /** Server name: the prefix of every adapted tool name and the `server` of every `McpError`. */
  readonly name: string
  /** The MCP endpoint (`https:`; the client's default security policy applies). */
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly era: McpConformanceEra
  /**
   * The protocol version the target negotiates: the modern version `server/discover` must list,
   * or the version a legacy `initialize` must answer.
   */
  readonly protocolVersion: string
  /** Request timeout for every client operation, in milliseconds. */
  readonly timeoutMs: number
  /**
   * The headers the auth case sends INSTEAD of `headers`: the reserved invalid credential in the
   * target's credential header. Defaults to `mcpConformanceDefaultInvalidCredentialHeaders`.
   */
  readonly invalidCredentialHeaders?: Readonly<Record<string, string>>
}

/** The MCP server the cases run against. */
export class McpConformanceTarget extends Context.Service<
  McpConformanceTarget,
  McpConformanceTargetSettings
>()('@yolk-sdk/mcp/conformance/McpConformanceTarget') {}

const ToolArguments = Schema.Record(Schema.String, Schema.Json)

/**
 * Host-supplied seeds. Cases never hard-code a product's tools. A case whose required seed is
 * missing fails with a `precondition:` `ConformanceMismatch` before any request.
 */
export const McpConformanceSeeds = Schema.Struct({
  /**
   * A tool the listing marks `readOnlyHint: true`, with arguments that make it succeed. Calling it
   * reads real data, so a live run names it only when the owner opts in.
   */
  readTool: Schema.optionalKey(
    Schema.Struct({ name: Schema.NonEmptyString, arguments: ToolArguments })
  ),
  /** Arguments `readTool` rejects (for example a value of the wrong type). */
  invalidArguments: Schema.optionalKey(ToolArguments),
  /** Tool names the listing must contain. */
  expectedTools: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  /** Tool names that write: the listing must not mark them `readOnlyHint: true`. */
  notReadOnly: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  /** A tool name the server does not have. Default `yolk_conformance_absent`. */
  absentToolName: Schema.optionalKey(Schema.NonEmptyString)
})

export type McpConformanceSeeds = typeof McpConformanceSeeds.Type

export type McpConformanceSeedKey = keyof McpConformanceSeeds

/** Host-supplied seeds for the MCP conformance cases. */
export class McpConformanceConfig extends Context.Service<
  McpConformanceConfig,
  McpConformanceSeeds
>()('@yolk-sdk/mcp/conformance/McpConformanceConfig') {}

/** The era a case id requires (`mcp.modern.*` or `mcp.legacy.*`), or `undefined` for any era. */
export const mcpConformanceCaseEra = (id: string): McpConformanceEra | undefined => {
  if (id.startsWith('mcp.modern.')) {
    return 'modern'
  }

  return id.startsWith('mcp.legacy.') ? 'legacy' : undefined
}

/** A case left out of a run because the target speaks another era. */
export type McpConformanceNotApplicable = {
  readonly id: string
  readonly reason: string
}

export type McpConformanceSelection<C> = {
  /** The cases to pass to `runConformance` for this target. */
  readonly applicable: ReadonlyArray<C>
  /** The cases a dry run lists as not applicable, with the reason. */
  readonly notApplicable: ReadonlyArray<McpConformanceNotApplicable>
}

/**
 * The era filter: `mcp.modern.*` cases apply only to modern targets and `mcp.legacy.*` cases only
 * to legacy targets; every other case applies to both. Order is kept.
 */
export const selectMcpConformanceCases = <C extends { readonly id: string }>(
  cases: ReadonlyArray<C>,
  era: McpConformanceEra
): McpConformanceSelection<C> => {
  const applicable: Array<C> = []
  const notApplicable: Array<McpConformanceNotApplicable> = []

  for (const testCase of cases) {
    const caseEra = mcpConformanceCaseEra(testCase.id)

    if (caseEra === undefined || caseEra === era) {
      applicable.push(testCase)
    } else {
      notApplicable.push({
        id: testCase.id,
        reason: `needs a ${caseEra} target; this target is ${era}`
      })
    }
  }

  return { applicable, notApplicable }
}
