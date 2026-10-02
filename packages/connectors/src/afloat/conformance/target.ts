/**
 * The Afloat MCP conformance target: built from the output of the REAL `afloat.mcp_auth` action,
 * never from hand-written connection data.
 *
 * Its shape is the `McpConformanceTargetSettings` of `@yolk-sdk/mcp/conformance` (this package
 * never imports `@yolk-sdk/mcp`; hosts pass the value to `McpConformanceTarget`).
 *
 * @experimental
 */
import { Data, Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { makeCredentialBinding } from '../../credential.ts'
import { makeIntegration } from '../../integration.ts'
import {
  afloatApiKeySlotId,
  afloatConnectorId,
  afloatMcpAuthAction,
  AfloatMcpAuthOutput
} from '../index.ts'

/** The credential ref the conformance integration binds the Afloat API key slot to. */
export const afloatMcpConformanceCredentialRef = 'afloat.conformance'

/** The integration the conformance target runs `afloat.mcp_auth` with. */
export const afloatMcpConformanceIntegration = makeIntegration({
  connectorId: afloatConnectorId,
  credentialBindings: [
    makeCredentialBinding({
      slotId: afloatApiKeySlotId,
      credentialRef: afloatMcpConformanceCredentialRef
    })
  ]
})

/**
 * The reserved invalid Afloat credential of the auth case (`mcp.auth.rejected`): an `afloat_` key
 * that is public, never valid anywhere, and never recorded (fixtures drop `authorization`).
 */
export const afloatMcpConformanceInvalidCredential = 'afloat_yolkconformanceinvalid0000'

/** The request headers for an Afloat API key: Afloat reads `Authorization: Bearer <key>`. */
export const afloatMcpConformanceRequestHeaders = (apiKey: string) => ({
  authorization: `Bearer ${apiKey}`
})

/** The structural `McpConformanceTargetSettings` of an Afloat target (always the modern era). */
export type AfloatMcpConformanceTargetSettings = {
  readonly name: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly era: 'modern'
  readonly protocolVersion: string
  readonly timeoutMs: number
  readonly invalidCredentialHeaders: Readonly<Record<string, string>>
}

/** The default request timeout of an Afloat target, in milliseconds. */
export const afloatMcpConformanceTimeoutMs = 30_000

/**
 * The target for the output of `afloat.mcp_auth`: server `afloat`, the action's `serverUrl` and
 * `protocolVersion` (`2026-07-28`, so the modern era), the API key as `Authorization: Bearer`, and
 * the reserved invalid credential in the same header for the auth case.
 */
export const afloatMcpConformanceTarget = (
  output: AfloatMcpAuthOutput,
  options: { readonly timeoutMs?: number } = {}
): AfloatMcpConformanceTargetSettings => ({
  name: afloatConnectorId,
  url: output.serverUrl,
  headers: afloatMcpConformanceRequestHeaders(output.apiKey),
  era: 'modern',
  protocolVersion: output.protocolVersion,
  timeoutMs: options.timeoutMs ?? afloatMcpConformanceTimeoutMs,
  invalidCredentialHeaders: afloatMcpConformanceRequestHeaders(
    afloatMcpConformanceInvalidCredential
  )
})

/**
 * `afloat.mcp_auth` answered a provider failure (its `code`), or an output that does not decode as
 * `AfloatMcpAuthOutput` (`invalid_output`), where the target needed its output.
 */
export class AfloatMcpConformanceAuthFailed extends Data.TaggedError(
  'AfloatMcpConformanceAuthFailed'
)<{
  readonly code: string
}> {
  override get message(): string {
    return `afloat.mcp_auth failed (${this.code})`
  }
}

/**
 * Run the real `afloat.mcp_auth` action over the host's `CredentialResolver` (for example
 * `staticCredentialResolverLayer` of `@yolk-sdk/connectors/conformance`) and build the target from
 * its output. Fails with the action's `ConnectorError` for a missing or non-`afloat_` key.
 */
export const makeAfloatMcpConformanceTarget = (options: { readonly timeoutMs?: number } = {}) =>
  Effect.gen(function* () {
    const result = yield* afloatMcpAuthAction.execute({
      integration: afloatMcpConformanceIntegration,
      input: {}
    })

    if (Predicate.isTagged(result, 'Failure')) {
      return yield* new AfloatMcpConformanceAuthFailed({ code: result.error.code })
    }

    // The dynamic `execute` answers an undecoded value: decode it before trusting it.
    const output = yield* Schema.decodeUnknownEffect(AfloatMcpAuthOutput)(result.value).pipe(
      Effect.mapError(() => new AfloatMcpConformanceAuthFailed({ code: 'invalid_output' }))
    )

    return afloatMcpConformanceTarget(output, options)
  })
